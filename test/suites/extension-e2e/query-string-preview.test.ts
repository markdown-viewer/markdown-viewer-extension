/**
 * Query-string document URLs.
 *
 * A remote file URL routinely carries its query *after* the file name — an
 * Azure blob SAS token (`.../job-logs.txt?rsct=text%2Fplain&sv=…&sig=…`), a
 * cache buster, tracking params. The page is taken over because the detector
 * matches `location.pathname`, so the viewer must resolve the *format* the
 * same way: matching the full `href` missed `.txt` and handed the whole log to
 * the markdown parser, which collapsed every line into one paragraph.
 *
 * Both shapes are pinned here:
 *   - `job-logs.txt?…` → plain-text code view, lines intact, no markdown reflow
 *   - `doc.md?…`       → rendered markdown with TOC and the source toggle
 *     (the query also used to disable the TOC and hide the toggle, because the
 *     `.md` check ran on the full URL)
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { type Page } from 'playwright-core';

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

/** Shaped like a GitHub Actions job log, `##[group]` markers included. */
const LOG_LINES = [
  "2026-09-26T01:41:26.0567726Z Current runner version: '2.337.0'",
  '2026-09-26T01:41:26.0604124Z ##[group]Runner Image Provisioner',
  '2026-09-26T01:41:26.0605349Z Hosted Compute Agent',
  '2026-09-26T01:41:26.0606241Z Version: 20260828.587',
  '2026-09-26T01:41:26.0611990Z ##[endgroup]',
  '2026-09-26T01:41:26.0613952Z ##[group]Operating System',
];

const MARKDOWN_BODY = '# Remote document\n\nA query string must not change how this renders.\n';

const CODE_VIEW_READY_JS = `() => Boolean(document.querySelector('#markdown-content [data-block-id="mv-code-view"] pre code[data-code-view-decorated="1"]'))`;

describe('installed Chrome extension — query-string document URLs', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let server: http.Server | undefined;
  let origin = '';

  const txtUrl = () => `${origin}/logs/job-logs.txt?rsct=text%2Fplain&sv=2025-11-05&sig=abc%3D`;
  const mdUrl = () => `${origin}/notes/doc.md?sv=2025-11-05`;

  before(async () => {
    server = http.createServer((request, response) => {
      const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (path === '/logs/job-logs.txt') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`${LOG_LINES.join('\n')}\n`);
        return;
      }
      if (path === '/notes/doc.md') {
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
        response.end(MARKDOWN_BODY);
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    harness = await launchExtensionContext('query-string-preview-');
    page = await harness.context.newPage();

    // Settings live in chrome.storage, which only an extension page can write.
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS });
    await bootstrap.close();
  });

  after(async () => {
    await harness?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('renders a .txt URL with a query string as a plain-text code view', async () => {
    await page.goto(txtUrl(), { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, CODE_VIEW_READY_JS);

    const report = await evalJs<{
      codeView: string | undefined;
      lines: string[];
      paragraphCount: number;
      fileName: string;
    }>(page, `() => {
      const root = document.getElementById('markdown-content');
      return {
        codeView: document.documentElement.dataset.codeView,
        lines: Array.from(root.querySelectorAll('.mv-code-line-content')).map((line) => line.textContent || ''),
        paragraphCount: root.querySelectorAll('p').length,
        fileName: document.getElementById('file-name')?.textContent || '',
      };
    }`);

    assert.strictEqual(report.codeView, '1', 'expected the code-view presentation to be active');
    assert.deepStrictEqual(
      report.lines,
      LOG_LINES,
      'expected the log lines to survive verbatim, one code-view line each',
    );
    assert.strictEqual(report.paragraphCount, 0, 'the log must not be reflowed into markdown paragraphs');
    // The query is part of the URL, never part of the displayed file name.
    assert.strictEqual(report.fileName, 'job-logs.txt');
  });

  it('keeps a .md URL with a query string in markdown mode', async () => {
    await page.goto(mdUrl(), { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(
      page,
      `() => (document.querySelector('#markdown-content h1')?.textContent || '') === 'Remote document'`,
    );

    const report = await evalJs<{
      codeView: string | undefined;
      tocDisabled: string | undefined;
      heading: string;
      sourceToggle: boolean;
      fileName: string;
    }>(page, `() => {
      return {
        codeView: document.documentElement.dataset.codeView,
        tocDisabled: document.documentElement.dataset.tocDisabled,
        heading: document.querySelector('#markdown-content h1')?.textContent || '',
        sourceToggle: Boolean(document.getElementById('toggle-source-view-btn')),
        fileName: document.getElementById('file-name')?.textContent || '',
      };
    }`);

    assert.strictEqual(report.codeView, undefined, 'markdown files are not rendered as code');
    assert.strictEqual(report.heading, 'Remote document');
    assert.notStrictEqual(report.tocDisabled, '1', 'a .md URL keeps its TOC when it carries a query');
    assert.strictEqual(report.sourceToggle, true, 'a .md URL keeps the source toggle');
    assert.strictEqual(report.fileName, 'doc.md');
  });
});
