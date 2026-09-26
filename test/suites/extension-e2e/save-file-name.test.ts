/**
 * Toolbar → "Save File" keeps the document's own name.
 *
 * The bytes the action saves are the document's *source*: markdown for a
 * markdown file, the raw text for a code/diagram file. Renaming a `.txt`,
 * `.json` or `.mermaid` document to `.md` claims a conversion that never
 * happened — the file is byte-identical to the original, only its extension
 * lied about the format. Markdown documents keep the long-standing
 * normalisation (`.markdown` → `.md`), and an HTML page converted by
 * "View as Markdown" is markdown content, so it saves as `.md` too.
 *
 * Each fixture is served over http so the content-script viewer takes the page
 * over exactly like it does for a remote file, then the menu item is clicked
 * and the real download is inspected (name + bytes).
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { type Page, type Worker } from 'playwright-core';

import {
  FIXED_SETTINGS,
  SET_STORAGE_JS,
  VIEWER_EMBED_READY_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  waitFor,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

interface Fixture {
  /** Route served by the fixture server. */
  route: string;
  /** Content type the fixture is served with. */
  contentType: string;
  /** Body on the wire, i.e. what the viewer has to save back out. */
  body: string;
  /** Name the "Save File" download must carry. */
  saveName: string;
}

/**
 * One row per format family the reader can take over: plain text, data,
 * diagram source, and both markdown spellings.
 */
const FIXTURES: Fixture[] = [
  {
    route: '/logs/job-logs.txt',
    contentType: 'text/plain; charset=utf-8',
    body: "2026-09-26T01:41:26.0567726Z Current runner version: '2.337.0'\n"
      + '2026-09-26T01:41:26.0604124Z ##[group]Runner Image Provisioner\n'
      + '2026-09-26T01:41:26.0611990Z ##[endgroup]\n',
    saveName: 'job-logs.txt',
  },
  {
    route: '/data/config.json',
    // Served as text/plain: Chrome's own JSON viewer answers
    // `application/json` with an HTML page, which the reader deliberately
    // leaves alone — the fixture has to reach the viewer as a raw file.
    contentType: 'text/plain; charset=utf-8',
    body: '{\n  "name": "demo",\n  "count": 3\n}\n',
    saveName: 'config.json',
  },
  {
    route: '/diagrams/flow.mermaid',
    contentType: 'text/plain; charset=utf-8',
    body: 'graph TD;\n  A-->B;\n',
    saveName: 'flow.mermaid',
  },
  {
    route: '/notes/guide.md',
    contentType: 'text/markdown; charset=utf-8',
    body: '# Guide\n\nBody.\n',
    saveName: 'guide.md',
  },
  {
    route: '/notes/legacy.markdown',
    contentType: 'text/markdown; charset=utf-8',
    body: '# Legacy\n\nBody.\n',
    // The reader normalises the .markdown spelling, and always has.
    saveName: 'legacy.md',
  },
];

/** Label of the export-menu item under test (English UI is pinned below). */
const SAVE_MENU_ITEM = 'button.mv-action-menu-item:has-text("Save File")';

/**
 * An HTML page is not taken over on its own; it becomes markdown content only
 * through "View as Markdown". Its saved bytes *are* converted markdown, so the
 * download must be named `.md` — the counter-case to the raw-file rule above.
 */
const HTML_FIXTURE = {
  route: '/site/page.html',
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html><html><head><title>Converted page</title></head>'
    + '<body><main><h1>Converted page</h1><p>Body text.</p></main></body></html>',
  saveName: 'page.md',
} as const;

describe('installed Chrome extension — "Save File" naming', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let server: http.Server | undefined;
  let origin = '';
  let downloadsDir = '';

  const urlFor = (fixture: Fixture) => `${origin}${fixture.route}`;

  before(async () => {
    const byRoute = new Map<string, { contentType: string; body: string }>([
      ...FIXTURES.map((fixture) => [fixture.route, fixture] as const),
      [HTML_FIXTURE.route, HTML_FIXTURE] as const,
    ]);
    server = http.createServer((request, response) => {
      const route = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      const fixture = byRoute.get(route);
      if (!fixture) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': fixture.contentType, 'cache-control': 'no-store' });
      response.end(fixture.body);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-save-name-dl-'));
    harness = await launchExtensionContext('save-file-name-', { acceptDownloads: true });
    page = await harness.context.newPage();

    // Settings live in chrome.storage, which only an extension page can write.
    // The UI locale is pinned so the menu label below is deterministic.
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();
  });

  after(async () => {
    await harness?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  /** Open the export menu and run "Save File", returning the real download. */
  async function saveFromToolbar(): Promise<{ filename: string; body: string }> {
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.click('#download-btn');
    await page.waitForSelector(SAVE_MENU_ITEM, { timeout: 10000 });
    await page.click(SAVE_MENU_ITEM);

    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    const target = path.join(downloadsDir, filename);
    await download.saveAs(target);
    return { filename, body: fs.readFileSync(target, 'utf8') };
  }

  /**
   * The extension's service worker, addressed by identity: other workers
   * (component extensions, pages) can be registered first, and evaluating
   * inside one of those has no `chrome.scripting`.
   */
  const extensionWorker = (): Worker => {
    const workers = harness.context.serviceWorkers();
    const mine = workers.find((worker) =>
      worker.url().startsWith(`chrome-extension://${harness.extensionId}/`),
    );
    assert.ok(mine, `no service worker for extension ${harness.extensionId}`);
    return mine;
  };

  /**
   * Run the "View as Markdown" injection the context menu performs: the
   * converter first (it self-detects HTML and bails out on raw files), then the
   * shared styles and the viewer.
   */
  async function viewAsMarkdown(target: Page): Promise<void> {
    const worker = extensionWorker();
    const tabId = await worker.evaluate(`((url) => chrome.tabs.query({}).then((tabs) => {
      const tab = tabs.find((entry) => entry.url === url);
      return tab && tab.id !== undefined ? tab.id : -1;
    }))(${JSON.stringify(target.url())})`) as number;
    assert.ok(tabId >= 0, `no tab id for ${target.url()}`);

    await worker.evaluate(`((id) => (async () => {
      for (const file of ['core/html-to-markdown.js', 'core/inject-styles.js', 'core/main.js']) {
        await chrome.scripting.executeScript({ target: { tabId: id }, files: [file] });
      }
    })())(${tabId})`);
  }

  for (const fixture of FIXTURES) {
    it(`saves ${fixture.route} as ${fixture.saveName} with its source intact`, async () => {
      await page.goto(urlFor(fixture), { waitUntil: 'load' });
      await waitFor(page, WAIT_STANDALONE_READY_JS);

      const download = await saveFromToolbar();

      assert.strictEqual(
        download.filename,
        fixture.saveName,
        `expected the download to be named ${fixture.saveName}`,
      );
      // The saved bytes are the document's own source, not the rendered view.
      assert.strictEqual(
        download.body.replace(/\r\n/g, '\n').trimEnd(),
        fixture.body.replace(/\r\n/g, '\n').trimEnd(),
        'expected the saved file to hold the original source',
      );
    });
  }

  it(`saves a converted HTML page as ${HTML_FIXTURE.saveName}`, async () => {
    await page.goto(urlFor(HTML_FIXTURE), { waitUntil: 'load' });
    await viewAsMarkdown(page);
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(
      page,
      `() => (document.querySelector('#markdown-content h1')?.textContent || '') === 'Converted page'`,
    );

    const download = await saveFromToolbar();

    // Converted markdown content, markdown name — the rule for raw files must
    // not leak into the reading-mode flow.
    assert.strictEqual(download.filename, HTML_FIXTURE.saveName);
    assert.ok(
      download.body.includes('# Converted page'),
      `expected converted markdown, got: ${download.body.slice(0, 200)}`,
    );
  });
});
