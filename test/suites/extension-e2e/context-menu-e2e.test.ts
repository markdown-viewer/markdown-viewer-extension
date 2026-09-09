/**
 * Installed-extension e2e: right-click context menus on rendered content.
 *
 * Covers BOTH menu families that share the `#markdown-content` container:
 *
 *  1. Table menu (new, `src/ui/table-context-menu.ts`)
 *     - right-click on a table cell shows "Copy table" + "Save as Excel";
 *     - "Copy table" must write text/html (Excel pastes real cells) plus a
 *       text/plain TSV fallback. Both are built from the SAME rectangular
 *       dense grid — smart-merged display rows are expanded with empty
 *       cells and NO rowspan/colspan, so every paste engine (Excel/WPS/
 *       Sheets/Numbers variants, several of which ignore span attributes in
 *       clipboard HTML) keeps each value in its own column instead of
 *       shifting the following rows;
 *     - "Save as Excel" downloads a real .xlsx — captured through the real
 *       Playwright download event, then unzipped with JSZip to assert the
 *       sheet XML (numbers as <v>, codes like "007" as text, merged-cell
 *       refs from smart merging — real merges live in the .xlsx, not in the
 *       copy fragment).
 *
 *  2. Image/diagram menu (existing, `src/ui/image-context-menu.ts`) —
 *     regression coverage that was missing: plain images expose
 *     Save/Copy-as-PNG, diagrams additionally expose Save-as-SVG.
 *
 * Test doubles (all in-page, documented):
 *  - Clipboard: navigator.clipboard.write is wrapped lazily AFTER the first
 *    user gesture (Chromium only exposes the API post-gesture in headless)
 *    so tests can assert the exact ClipboardItem payloads.
 *  - Downloads: blob: <a download> anchors are intercepted by patching
 *    HTMLAnchorElement.prototype.click, which captures filename + bytes.
 *    Headless Chromium only surfaces a Playwright "download" event for some
 *    MIME types (xlsx yes; image/png and image/svg+xml no), so the xlsx
 *    cases use the real event AND the anchor payload; png/svg cases assert
 *    the anchor payload (filename + magic bytes / markup).
 *
 * Runs headless against the REAL built extension (dist/chrome). Skip with
 * MV_SKIP_EXT_TESTS=1. Run `node chrome/build.js` first.
 *
 * IMPORTANT: all page-executed code is passed as STRINGS with arguments
 * inlined — extension pages block unsafe-eval, so compiled functions
 * cannot be serialized into the page.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { chromium, type BrowserContext, type Page } from 'playwright-core';
import JSZip from 'jszip';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';
const EXT_DIR = path.resolve('dist/chrome');

// 1×1 red PNG so data-URI images are decodable without file access.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FIXED_SETTINGS = {
  themeId: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
} as const;

const SET_STORAGE_JS = `(settings) => chrome.storage.local.set({ markdownViewerSettings: settings })`;
const POST_OPEN_DOCUMENT_JS = `(msg) => window.postMessage(msg, '*')`;

/**
 * In-page instrumentation (installed at test time via evaluate — NOT via
 * addInitScript, which produced an obscure per-navigation pageerror in this
 * headless setup):
 *  - window.__mvClipboardWrites — ClipboardItem payloads our menus write;
 *  - window.__mvAnchorDownloads — { filename, base64 } of every blob: anchor
 *    download the viewer triggers (bytes fetched before the URL is revoked).
 *
 * The clipboard patch is applied lazily right after the right-click gesture,
 * because headless Chromium only materializes navigator.clipboard once a
 * user gesture happened. installInstruments() is therefore re-run after each
 * openDocument() and after each openMenuOn().
 */
const INSTALL_INSTRUMENT_JS = `() => {
  window.__mvClipboardWrites = [];
  window.__mvAnchorDownloads = [];
  window.__mvClipPatched = false;

  const toBase64 = (bytes) => {
    let binary = '';
    const sliceSize = 0x8000;
    for (let i = 0; i < bytes.length; i += sliceSize) {
      const slice = bytes.subarray(i, Math.min(i + sliceSize, bytes.length));
      binary += String.fromCharCode.apply(null, Array.from(slice));
    }
    return btoa(binary);
  };

  window.__mvPatchClipboard = () => {
    if (window.__mvClipPatched) return;
    const cb = navigator.clipboard;
    if (!cb || typeof cb.write !== 'function' || typeof ClipboardItem === 'undefined') return;
    const original = cb.write.bind(cb);
    try {
      Object.defineProperty(cb, 'write', {
        configurable: true,
        writable: true,
        value: async (items) => {
          const records = [];
          for (const item of items) {
            const record = [];
            for (const type of item.types) {
              let text = '';
              try {
                text = await (await item.getType(type)).text();
              } catch { /* blob read failed — keep the type only */ }
              record.push([type, text]);
            }
            records.push(record);
          }
          window.__mvClipboardWrites.push(records);
          try { return await original(items); } catch { /* native write may fail headless */ }
        },
      });
      window.__mvClipPatched = true;
    } catch { /* clipboard object not extensible — skip */ }
  };

  window.__mvPatchAnchor = () => {
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const filename = this.getAttribute('download');
      const href = this.href || '';
      if (filename && href.startsWith('blob:')) {
        fetch(href)
          .then((response) => response.arrayBuffer())
          .then((buffer) => {
            window.__mvAnchorDownloads.push({
              filename,
              base64: toBase64(new Uint8Array(buffer)),
            });
          })
          .catch(() => { /* blob already revoked — ignore */ });
      }
      return origClick.apply(this, arguments);
    };
  };

  window.__mvPatchClipboard();
  window.__mvPatchAnchor();
}`;

const WAIT_RENDERED_JS = `() => {
  const c = document.getElementById('markdown-content');
  return Boolean(c && c.children.length > 0);
}`;

const WAIT_IMAGES_JS = `() => {
  const images = Array.from(document.querySelectorAll('#markdown-content img'));
  return Promise.all(images.map((img) => {
    if (typeof img.decode === 'function') return img.decode().catch(() => undefined);
    return new Promise((resolve) => {
      if (img.complete) { resolve(); return; }
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  })).then(() => true);
}`;

async function evalJs<T>(page: Page, jsBody: string, arg?: unknown): Promise<T> {
  const src = arg === undefined ? `(${jsBody})()` : `(${jsBody})(${JSON.stringify(arg)})`;
  return page.evaluate(src) as Promise<T>;
}

async function waitFor(page: Page, jsBody: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evalJs<boolean>(page, jsBody)) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out (${timeoutMs}ms): ${jsBody.slice(0, 80)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForExtensionId(context: BrowserContext): Promise<string> {
  const deadline = Date.now() + 40000;
  for (;;) {
    const id = context.serviceWorkers().map((w) => w.url().split('/')[2]).find(Boolean);
    if (id) return id;
    if (Date.now() >= deadline) {
      throw new Error('extension service worker not registered (timeout)');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('installed Chrome extension — table & image/diagram context menus', { skip: SKIP_EXT }, () => {
  let context: BrowserContext;
  let page: Page;
  let extensionId = '';
  let userDataDir = '';
  let downloadsDir = '';

  before(async () => {
    await fs.promises.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
      throw new Error('dist/chrome missing — run "node chrome/build.js" first');
    });

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-context-menu-'));
    downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-context-menu-dl-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--no-first-run',
        '--disable-default-apps',
        '--allow-file-access-from-files',
      ],
    });
    extensionId = await waitForExtensionId(context);

    page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        // eslint-disable-next-line no-console
        console.log('[page error]', msg.text().slice(0, 400));
      }
    });
    page.on('pageerror', (err) => {
      const text = process.env.MV_DEBUG_PAGEERR ? (err.stack || String(err)) : String(err).slice(0, 400);
      // eslint-disable-next-line no-console
      console.log('[pageerror]', text.split('\n').slice(0, 6).join('\n  '));
    });
  });

  after(async () => {
    await context?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    if (downloadsDir) fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  // ── Plumbing ─────────────────────────────────────────────────────────────

  const openDocument = async (markdown: string, settings: Record<string, unknown> = {}) => {
    const url = `chrome-extension://${extensionId}/ui/workspace/viewer-embed.html?embed=1`;
    // chrome.storage only exists on extension pages — never evaluate the
    // settings write on about:blank (first navigation).
    if (!page.url().startsWith('chrome-extension://')) {
      await page.goto(url, { waitUntil: 'load' });
    }
    await evalJs(page, SET_STORAGE_JS, { ...FIXED_SETTINGS, ...settings });
    // Reload so the viewer bootstraps with the just-written settings.
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(600); // viewer runtime bootstrap
    await evalJs(page, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT',
      content: markdown,
      filename: 'context-menu-fixture.md',
      fileDir: '',
    });
    await waitFor(page, WAIT_RENDERED_JS);
    await evalJs(page, WAIT_IMAGES_JS);
    await page.waitForTimeout(350); // let async re-render passes settle
    await evalJs(page, INSTALL_INSTRUMENT_JS);
  };

  /** Right-click the center of the element matching `selector` + `hasText`. */
  const openMenuOn = async (selector: string, hasText: string) => {
    const locator = hasText
      ? page.locator(selector, { hasText })
      : page.locator(selector);
    await locator.first().waitFor({ state: 'visible', timeout: 30000 });
    const box = await locator.first().boundingBox();
    assert.ok(box, `no bounding box for ${selector} containing "${hasText}"`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.locator('.mv-action-menu').waitFor({ state: 'visible', timeout: 10000 });
    // Clipboard only materializes after a real gesture — install the wrapper now.
    await evalJs(page, INSTALL_INSTRUMENT_JS);
  };

  const menuLabels = async (): Promise<string[]> => {
    await page.locator('.mv-action-menu-item').first().waitFor({ state: 'visible' });
    return page.locator('.mv-action-menu-item').allTextContents();
  };

  const clickMenuItem = async (label: string) => {
    const item = page.locator('.mv-action-menu-item', { hasText: label }).first();
    await item.waitFor({ state: 'visible' });
    await item.click();
    await page.locator('.mv-action-menu').waitFor({ state: 'detached', timeout: 10000 });
  };

  /** Wait until the clipboard wrapper recorded at least one write. */
  const waitForClipWrites = async (): Promise<Array<Array<[string, string]>>> => {
    await waitFor(page, `() => (window.__mvClipboardWrites || []).length > 0`, 15000);
    return evalJs<Array<Array<[string, string]>>>(page, `() => window.__mvClipboardWrites || []`);
  };

  /** Wait until an anchor download with `filename` substring was captured. */
  const waitForAnchorDownload = async (namePart: string): Promise<{ filename: string; base64: string }> => {
    await waitFor(
      page,
      `() => (window.__mvAnchorDownloads || []).some((d) => d.filename.includes(${JSON.stringify(namePart)}))`,
      15000,
    );
    const list = await evalJs<Array<{ filename: string; base64: string }>>(
      page,
      `() => window.__mvAnchorDownloads || []`,
    );
    const entry = list.find((d) => d.filename.includes(namePart));
    assert.ok(entry, `no captured anchor download for ${namePart}`);
    return entry;
  };

  /** Real Playwright download event (fires for xlsx blobs in headless). */
  const downloadAfter = async (action: () => Promise<void>): Promise<{ filename: string; bytes: Buffer }> => {
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await action();
    const download = await downloadPromise;
    const target = path.join(downloadsDir, download.suggestedFilename());
    await download.saveAs(target);
    return { filename: download.suggestedFilename(), bytes: fs.readFileSync(target) };
  };

  const openSheetXml = async (bytes: Buffer): Promise<{ sheet: string; files: Record<string, unknown> }> => {
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await (zip.files['xl/worksheets/sheet1.xml'] as any).async('string');
    return { sheet, files: zip.files };
  };

  const clickRecord = (writes: Array<Array<[string, string]>>, mime: string): string | undefined =>
    writes
      .flat(2)
      .find(([type]) => type === mime)?.[1];

  const bytesFromBase64 = (base64: string): Buffer => Buffer.from(base64, 'base64');

  /** Parse our own clipboard <table> fragment into a text grid (row-major). */
  const htmlRowsText = (html: string): string[][] => {
    const decode = (node: string): string =>
      node
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\u00a0/g, ' ')
        .trim();
    const rows: string[][] = [];
    const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(decode(cellMatch[1]));
      }
      rows.push(cells);
    }
    return rows;
  };

  // ── Table menu: copy ─────────────────────────────────────────────────────

  const PLAIN_TABLE_MD = [
    '# Sales report',
    '',
    '| Product | Units | Price |',
    '| --- | --- | --- |',
    '| A | 3 | 1.5 |',
    '| B | 007 | 2.0 |',
    '',
  ].join('\n');

  it('table: right-click menu offers Copy table / Save as Excel (.xlsx)', async () => {
    await openDocument(PLAIN_TABLE_MD);
    await openMenuOn('#markdown-content td', '007');

    const labels = await menuLabels();
    assert.equal(labels.length, 2, `expected 2 items, got: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => l.includes('Copy table')), `missing Copy table: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => l.includes('Excel')), `missing Excel item: ${JSON.stringify(labels)}`);
  });

  it('table: "Copy table" writes text/html (Excel cells) + text/plain TSV', async () => {
    await openDocument(PLAIN_TABLE_MD);
    await openMenuOn('#markdown-content td', '3');
    await clickMenuItem('Copy table');

    const writes = await waitForClipWrites();
    const html = clickRecord(writes, 'text/html') ?? '';
    assert.ok(html.includes('<table'), 'text/html must carry a <table> fragment');
    assert.ok(html.includes('<th') && html.includes('Product'), 'header row must survive into HTML');
    assert.ok(html.includes('border:1px solid'), 'inline border styles must be present for Excel');
    assert.ok(html.includes('007</td>'), 'body text must survive into HTML');
    // Span-free rectangular grid: every paste target keeps 3 columns.
    assert.ok(!html.includes('rowspan') && !html.includes('colspan'), 'clipboard HTML must be span-free');
    for (const row of htmlRowsText(html)) {
      assert.equal(row.length, 3, 'every pasted row must keep all 3 columns');
    }

    const tsv = clickRecord(writes, 'text/plain') ?? '';
    assert.equal(
      tsv,
      'Product\tUnits\tPrice\nA\t3\t1.5\nB\t007\t2.0',
      'TSV fallback must be the exact tab-separated grid (Excel splits into cells)',
    );
  });

  it('table: "Copy table" keeps merged (smart-merged) rows in the HTML fragment', async () => {
    const mergedMd = [
      '# Org chart',
      '',
      '| Name | Dept | Role |',
      '| --- | --- | --- |',
      '| Ann | R&D | Lead |',
      '| | | Dev |',
      '| Bob | Ops | Lead |',
      '',
    ].join('\n');
    await openDocument(mergedMd, { tableMergeEmpty: true });
    // Smart merging must materialize as a real rowspan in the DOM.
    await waitFor(page, `() => Boolean(document.querySelector('#markdown-content td[rowspan]'))`);
    await openMenuOn('#markdown-content td', 'Dev');
    await clickMenuItem('Copy table');

    const writes = await waitForClipWrites();
    const html = clickRecord(writes, 'text/html') ?? '';
    // Smart-merged display must copy as a RECTANGULAR grid: the covered
    // columns become empty cells (no rowspan), so span-ignoring paste
    // engines (Excel/WPS/Sheets/Numbers variants) still align "Dev" into
    // the Role column instead of shifting it to column 1.
    assert.ok(
      !html.includes('rowspan') && !html.includes('colspan'),
      'clipboard HTML must be span-free for smart-merged tables',
    );
    assert.deepEqual(
      htmlRowsText(html),
      [
        ['Name', 'Dept', 'Role'],
        ['Ann', 'R&D', 'Lead'],
        ['', '', 'Dev'],
        ['Bob', 'Ops', 'Lead'],
      ],
      'pasted HTML grid must equal the on-screen logical grid (values in own columns)',
    );
    const tsv = clickRecord(writes, 'text/plain') ?? '';
    assert.ok(
      tsv.split('\n').includes('\t\tDev'),
      'TSV must blank the covered columns (Excel re-merge semantics)',
    );
  });

  // ── Table menu: Save as Excel (.xlsx) ────────────────────────────────────

  it('table: "Save as Excel" downloads a real .xlsx with numbers, text and the right name', async () => {
    await openDocument(PLAIN_TABLE_MD);
    await openMenuOn('#markdown-content td', '3');
    const { bytes } = await downloadAfter(async () => {
      await clickMenuItem('Excel');
    });

    // Filename is asserted from the captured anchor (headless Chromium names
    // blob downloads after the blob UUID in the Playwright download event).
    const anchor = await waitForAnchorDownload('Sales report');
    assert.equal(anchor.filename, 'Sales report.xlsx');

    const { sheet, files } = await openSheetXml(bytes);
    for (const required of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
      assert.ok(files[required], `downloaded xlsx must contain ${required}`);
    }
    assert.ok(sheet.includes('<dimension ref="A1:C3"/>'), 'dimension must cover 3×3 grid');
    assert.ok(sheet.includes('<v>3</v>') && sheet.includes('<v>1.5</v>'), 'numbers must be real <v> cells');
    assert.ok(sheet.includes('007</t>'), 'codes with leading zeros must stay text');
    assert.ok(!sheet.includes('<mergeCells'), 'plain table must not declare merges');
  });

  it('table: merged smart-merge rows are exported as Excel merge ranges', async () => {
    const mergedMd = [
      '# Org chart',
      '',
      '| Name | Dept | Role |',
      '| --- | --- | --- |',
      '| Ann | R&D | Lead |',
      '| | | Dev |',
      '| Bob | Ops | Lead |',
      '',
    ].join('\n');
    await openDocument(mergedMd, { tableMergeEmpty: true });
    await waitFor(page, `() => Boolean(document.querySelector('#markdown-content td[rowspan]'))`);
    await openMenuOn('#markdown-content td', 'Dev');
    const { bytes } = await downloadAfter(async () => {
      await clickMenuItem('Excel');
    });

    const anchor = await waitForAnchorDownload('Org chart');
    assert.equal(anchor.filename, 'Org chart.xlsx');

    const { sheet } = await openSheetXml(bytes);
    assert.ok(
      sheet.includes('<mergeCell ref="A2:A3"/>') && sheet.includes('<mergeCell ref="B2:B3"/>'),
      'merged ranges must be exported as Excel merges (thead shifts data rows to 2+)',
    );
    assert.ok(sheet.includes('Dev</t>'), 'visible cell text must survive');
  });

  // ── Image menu (regression coverage that was missing) ────────────────────

  const IMAGE_MD = [
    '# Picture',
    '',
    `![Centered image](data:image/png;base64,${PNG_BASE64})`,
    '',
  ].join('\n');

  it('image: right-click on a plain image shows Save/Copy PNG and Copy writes an image/png item', async () => {
    await openDocument(IMAGE_MD);
    await openMenuOn('#markdown-content img', '');

    const labels = await menuLabels();
    assert.ok(labels.some((l) => l.includes('Save Image As')), `missing Save Image As: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => l.includes('Copy as PNG')), `missing Copy as PNG: ${JSON.stringify(labels)}`);

    await clickMenuItem('Copy as PNG');
    const writes = await waitForClipWrites();
    assert.ok(
      writes.flat(2).some(([type]) => type === 'image/png'),
      'clipboard must carry an image/png ClipboardItem',
    );
  });

  it('image: "Save Image As" downloads the PNG file', async () => {
    await openDocument(IMAGE_MD);
    await openMenuOn('#markdown-content img', '');
    await clickMenuItem('Save Image As');

    const anchor = await waitForAnchorDownload('image');
    assert.equal(anchor.filename, 'image.png');
    const bytes = bytesFromBase64(anchor.base64);
    // PNG magic bytes: 89 50 4E 47.
    assert.deepEqual(
      Array.from(bytes.subarray(0, 4)),
      [0x89, 0x50, 0x4e, 0x47],
      'downloaded file must be a real PNG',
    );
  });

  // ── Diagram menu (charts) ────────────────────────────────────────────────

  const DIAGRAM_MD = [
    '# Diagram',
    '',
    '```mermaid',
    'graph TD',
    '  A[Start] --> B[End]',
    '```',
    '',
  ].join('\n');

  it('diagram: right-click offers PNG/SVG save + PNG copy; SVG download is a real SVG', async () => {
    await openDocument(DIAGRAM_MD);
    await waitFor(page, `() => Boolean(document.querySelector('#markdown-content .diagram-block img'))`);
    await openMenuOn('#markdown-content .diagram-block img', '');

    const labels = await menuLabels();
    assert.ok(labels.some((l) => l.includes('Save as PNG')), `missing Save as PNG: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => l.includes('Save as SVG')), `missing Save as SVG: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => l.includes('Copy as PNG')), `missing Copy as PNG: ${JSON.stringify(labels)}`);

    await clickMenuItem('Save as SVG');
    const anchor = await waitForAnchorDownload('.svg');
    assert.ok(anchor.filename.endsWith('.svg'), `expected .svg filename, got "${anchor.filename}"`);
    const text = bytesFromBase64(anchor.base64).toString('utf8');
    assert.ok(text.includes('<svg'), 'downloaded diagram must be a real SVG document');
  });
});
