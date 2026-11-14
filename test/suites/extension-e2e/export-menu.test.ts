/**
 * Toolbar → export menu → Export to DOCX / EPUB / HTML.
 *
 * The export menu is the reader's only way to turn a rendered document into a
 * file, and it is the one place where three different pipelines share a single
 * click target: DOCX parses the markdown again, EPUB serializes the rendered
 * container, HTML serializes the same container with its resources embedded.
 * Until this suite existed, installed-extension E2E only covered "Save File"
 * (the document's own source) — the three format exports were untested here,
 * so a click that never finishes had no test that could notice.
 *
 * Each case drives the real toolbar, waits for the real download Playwright
 * surfaces for the blob the viewer builds, and inspects the bytes: a DOCX and
 * an EPUB are ZIP containers with specific entries, an HTML export is a
 * self-contained page carrying the rendered text.
 *
 * The first three cases serve the fixture over http on purpose: a remote
 * document is the host where the toolbar first asks the background for the
 * optional "downloads" permission, which is the step the export awaits before
 * it does any work. The last case opens a document from local disk whose image
 * never finishes loading — the reported hang that had no deadline in the image
 * loader.
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

import JSZip from 'jszip';
import { type Page } from 'playwright-core';

import {
  FIXED_SETTINGS,
  SET_STORAGE_JS,
  VIEWER_EMBED_READY_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  retryInteraction,
  waitFor,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

const ROUTE = '/docs/export-fixture.md';

/**
 * An image URL that goes nowhere: `10.255.255.1` is outside every local route,
 * so the SYN is dropped and the request hangs — the browser-side shape of a
 * black-holed proxy, where the `<img>` neither loads nor errors. A host that
 * answers "unreachable" instead makes the export merely faster; both outcomes
 * are inside the deadline either way.
 */
const STALLED_IMAGE_URL = 'http://10.255.255.1/stalled.png';

/**
 * Small on purpose: every block type the exporters special-case adds another
 * resource fetch to the export, and the assertions here are about the click
 * completing and the file landing — not about DOCX/EPUB fidelity, which the
 * export-contract suites already own.
 *
 * The reference-style link stays: it is the shape that used to degrade to
 * literal text, and its destination proves the DOCX relationship was written.
 */
const FIXTURE = [
  '# Export Fixture',
  '',
  'A paragraph with a [reference link][docs] and **bold** text.',
  '',
  '| Column A | Column B |',
  '|----------|----------|',
  '| one      | two      |',
  '',
  '[docs]: https://example.com/docs',
  '',
].join('\n');

/** How long a single export may take before the click is treated as hung. */
const EXPORT_TIMEOUT_MS = 60_000;

describe('installed Chrome extension — export menu', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let server: http.Server | undefined;
  let origin = '';
  let downloadsDir = '';
  let localDir = '';

  const url = () => `${origin}${ROUTE}`;

  before(async () => {
    server = http.createServer((request, response) => {
      const route = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (route !== ROUTE) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-export-menu-dl-'));
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-export-menu-src-'));

    harness = await launchExtensionContext('export-menu-', { acceptDownloads: true });
    page = await harness.context.newPage();

    // The UI locale is pinned so the menu labels below are deterministic, and
    // the settings live in chrome.storage, which only an extension page writes.
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS, preferredLocale: 'en' });
    await bootstrap.close();

    await page.goto(url(), { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
  });

  after(async () => {
    await harness?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    fs.rmSync(downloadsDir, { recursive: true, force: true });
    fs.rmSync(localDir, { recursive: true, force: true });
  });

  /**
   * Click one export-menu entry and return the file the viewer produced.
   *
   * The download promise is armed first: the export disables the toolbar
   * button while it runs, so a click that starts the work and a download that
   * follows it are two separate events and only pre-arming keeps them in the
   * same observation window.
   */
  async function exportViaMenu(
    label: string,
    whileExporting?: () => Promise<void>,
  ): Promise<{ filename: string; bytes: Buffer }> {
    const item = `button.mv-action-menu-item:has-text("${label}")`;
    const downloadPromise = page.waitForEvent('download', { timeout: EXPORT_TIMEOUT_MS });

    // The toolbar wires its listeners a moment after the viewer renders, so a
    // click that lands in that window opens nothing. Repeat the interaction
    // (TESTING.md allows a retry for a race, never for an assertion).
    await retryInteraction({
      label: `export menu: open (${label})`,
      attempt: async () => {
        await page.click('#download-btn');
      },
      check: async () => {
        await page.waitForSelector(item, { timeout: 3000 });
      },
    });
    await page.click(item);
    await whileExporting?.();

    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    const dest = path.join(downloadsDir, `${Date.now()}-${filename}`);
    await download.saveAs(dest);
    return { filename, bytes: fs.readFileSync(dest) };
  }

  /** Read the ring's stroke offset (circumference at 0%, 0 at 100%). */
  async function readRingOffset(): Promise<number | null> {
    const offset = await page.evaluate(`(() => {
      const circle = document.querySelector('#download-btn .download-progress-circle');
      if (!circle) return null;
      // The markup carries the offset as an SVG attribute; updates go through
      // the inline style. Either is the value the reader sees.
      const raw = circle.style.strokeDashoffset || circle.getAttribute('stroke-dashoffset') || '';
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    })()`);
    return typeof offset === 'number' ? offset : null;
  }

  /** Wait until the toolbar button is usable again for the next export. */
  async function waitForToolbarIdle(): Promise<void> {
    await page.waitForSelector('#download-btn:not([disabled])', { timeout: EXPORT_TIMEOUT_MS });
  }

  it('exports DOCX as a Word document with the rendered text and the reference link', async () => {
    const download = await exportViaMenu('Export to DOCX');
    await waitForToolbarIdle();

    assert.strictEqual(download.filename, 'export-fixture.docx');
    assert.strictEqual(download.bytes.subarray(0, 2).toString('latin1'), 'PK', 'a .docx is a ZIP container');

    const zip = await JSZip.loadAsync(download.bytes);
    const documentXml = await zip.files['word/document.xml']?.async('string');
    assert.ok(documentXml, 'the DOCX must contain word/document.xml');
    assert.match(documentXml, /Export Fixture/, 'the heading text must reach the document body');
    assert.match(documentXml, /Column A/, 'table cells must reach the document body');
    assert.ok(
      !documentXml.includes('][docs]'),
      'resolved references must not leak their markdown markup into the document',
    );

    const relsXml = await zip.files['word/_rels/document.xml.rels']?.async('string');
    assert.ok(relsXml, 'the DOCX must contain its relationship part');
    assert.match(relsXml, /https:\/\/example\.com\/docs/, 'the reference destination must be a real hyperlink');
  });

  it('exports EPUB as a valid EPUB container with the chapter text', async () => {
    const download = await exportViaMenu('Export to EPUB');
    await waitForToolbarIdle();

    // Unlike DOCX and HTML, EPUB keeps the source extension and appends
    // (`toEpubFilename` is append-only by design — pinned by its own unit
    // test), so the name here is `.md.epub`.
    assert.strictEqual(download.filename, 'export-fixture.md.epub');
    assert.strictEqual(download.bytes.subarray(0, 2).toString('latin1'), 'PK', 'an .epub is a ZIP container');

    const zip = await JSZip.loadAsync(download.bytes);
    const mimetype = await zip.file('mimetype')?.async('string');
    assert.strictEqual(mimetype, 'application/epub+zip', 'the container must declare the EPUB media type');

    const chapterNames = Object.keys(zip.files).filter((name) => /^OEBPS\/.*\.xhtml$/.test(name));
    assert.ok(chapterNames.length > 0, 'the EPUB must contain at least one chapter document');
    const chapters = await Promise.all(chapterNames.map((name) => zip.files[name].async('string')));
    assert.ok(
      chapters.some((chapter) => chapter.includes('Export Fixture')),
      'the rendered heading must reach a chapter',
    );
  });

  it('exports HTML as a self-contained page with the rendered text', async () => {
    const download = await exportViaMenu('Export to HTML');
    await waitForToolbarIdle();

    assert.strictEqual(download.filename, 'export-fixture.html');
    const html = download.bytes.toString('utf8');
    assert.match(html, /^<!doctype html>/i, 'the export must be a complete HTML document');
    assert.match(html, /Export Fixture/, 'the rendered heading must reach the page');
    assert.match(html, /href="https:\/\/example\.com\/docs"/, 'the reference link must stay a link');
    assert.ok(
      !html.includes('][docs]'),
      'resolved references must not leak their markdown markup into the page',
    );
  });

  /**
   * The reported hang: a document opened from local disk whose remote image
   * never finishes loading. Every export format reads images through the same
   * `<img>` + canvas loader, and that loader used to have no deadline — a
   * stalled request fired neither `load` nor `error`, so the toolbar spinner
   * sat at 0% and no file was ever produced. The timeout is what this pins;
   * the fixture's other assertions just prove the export really ran.
   */
  it('finishes a local document whose image never finishes loading', async () => {
    const localDocument = path.join(localDir, 'local-stalled-image.md');
    fs.writeFileSync(
      localDocument,
      [
        '# Local Export',
        '',
        `![stalled image](${STALLED_IMAGE_URL})`,
        '',
        'The paragraph after the stalled image must still be exported.',
        '',
      ].join('\n'),
    );

    // `domcontentloaded`, not `load`: the page's `load` event waits for the
    // stalled image and would never fire.
    await page.goto(`file://${localDocument}`, { waitUntil: 'domcontentloaded' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);

    // DOCX is the slowest reader (it fetches every image's bytes); HTML and
    // EPUB inline images through the same `ResourceEmbedder.fetchImageAsBuffer`
    // chain, so one format is enough to pin the deadline. Each stalled image
    // costs the two deadlines (10s for the <img>, 8s for the platform read) and
    // then the export must continue.
    const ringOffsets: number[] = [];
    const docx = await exportViaMenu('Export to DOCX', async () => {
      // The click closes the menu; from then on the ring is the only feedback.
      // Sample it the way a reader would see it: it must start at 0 and keep
      // moving while the export waits on the stalled image — a frozen ring is
      // the bug this guards against.
      for (let sample = 0; sample < 12; sample += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const offset = await readRingOffset();
        if (offset !== null) {
          ringOffsets.push(offset);
        }
      }
    });
    await waitForToolbarIdle();

    assert.ok(ringOffsets.length >= 6, `the ring must be visible during the export (saw ${ringOffsets.length} samples)`);
    const firstOffset = ringOffsets[0];
    const lastOffset = ringOffsets[ringOffsets.length - 1];
    assert.ok(
      lastOffset < firstOffset,
      `the ring must advance while the export runs (first ${firstOffset}, last ${lastOffset})`,
    );

    assert.strictEqual(docx.filename, 'local-stalled-image.docx');
    const zip = await JSZip.loadAsync(docx.bytes);
    assert.match(
      await zip.files['word/document.xml']!.async('string'),
      /The paragraph after the stalled image/,
      'the export must run past the stalled image instead of stopping at it',
    );
  });
});
