/**
 * Installed-extension tests: load the REAL built Chrome extension
 * (dist/chrome) in a persistent Chromium context and verify the export
 * stylesheet collection contract + the FULL fixture matrix across the
 * three file-opening modes:
 *
 *   standalone — file:// direct browse (content-script takeover)
 *   workspace  — workspace.html directory picker + file tree + iframe preview
 *   embed      — viewer-embed.html?embed=1 fed via OPEN_DOCUMENT postMessage
 *
 * Assertions mirror the Web baseline semantics (exact computed values,
 * symmetry/zero geometry, fixed params). On top of that, each mode must
 * expose the shared content stylesheet to the export CSS collectors
 * (document.styleSheets enumeration) — this is the regression guard for the
 * insertCSS bug that silently dropped every structural rule (diagram
 * centering etc.) from exported HTML/EPUB on file:// pages.
 *
 * Runs headless via Playwright's new headless mode (chromium channel + MV3
 * extension loading are supported since the headed/new-headless merge;
 * verified against channel 'chromium' + --load-extension). Skip with
 * MV_SKIP_EXT_TESTS=1. Run `node chrome/build.js` first so dist/chrome is
 * up to date.
 *
 * IMPORTANT: all page-executed code is passed as STRINGS and arguments are
 * inlined via JSON — tsx/esbuild injects a `__name` helper into compiled
 * functions, so serializing compiled functions into the browser page fails,
 * and Playwright rejects strings with arguments.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { chromium, type BrowserContext, type Page, type Frame } from 'playwright-core';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

const EXT_DIR = path.resolve('dist/chrome');
const LAYOUT_DIR = path.resolve('test/fixtures/layout');

const FIXED_SETTINGS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
} as const;

type Target = Page | Frame;

function px(value: string): number {
  return parseFloat(value);
}

function firstOf(measurements: Array<{ selector: string; elements: any[] }>, selector: string) {
  const item = measurements.find((m) => m.selector === selector);
  assert.ok(item, `No measurement for selector "${selector}"`);
  assert.ok(item.elements.length > 0, `Selector "${selector}" matched no elements`);
  return item.elements[0];
}

/**
 * Evaluate a JS function BODY string. Playwright treats an evaluate string
 * as a function BODY, so `() => {}` would just create a function object and
 * serialize to undefined — always invoke the body explicitly (IIFE form).
 */
async function evalJs<T>(target: Target, jsBody: string, arg?: unknown): Promise<T> {
  const src = arg === undefined ? `(${jsBody})()` : `(${jsBody})(${JSON.stringify(arg)})`;
  return target.evaluate(src) as Promise<T>;
}

/**
 * Poll-wait for a JS BODY string to return truthy. Uses evaluate() (function
 * body semantics) instead of waitForFunction — the latter evaluates strings
 * via eval, which extension pages block with CSP (unsafe-eval).
 */
async function waitFor(target: Target, jsBody: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evalJs<boolean>(target, jsBody)) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out (${timeoutMs}ms): ${jsBody.slice(0, 80)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const MEASURE_JS = `(selectors) => selectors.map((selector) => {
  const nodes = Array.from(document.querySelectorAll(selector));
  return {
    selector,
    count: nodes.length,
    elements: nodes.map((node) => {
      const element = node;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        marginTop: style.marginTop, marginRight: style.marginRight,
        marginBottom: style.marginBottom, marginLeft: style.marginLeft,
        paddingTop: style.paddingTop, paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft,
        borderTopWidth: style.borderTopWidth, borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth, borderLeftWidth: style.borderLeftWidth,
        fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
        fontWeight: style.fontWeight, fontStyle: style.fontStyle, color: style.color,
        textDecorationLine: style.textDecorationLine, textAlign: style.textAlign,
        textIndent: style.textIndent, display: style.display,
        backgroundColor: style.backgroundColor, overflowX: style.overflowX, overflowY: style.overflowY,
      };
    }),
  };
})`;

const COLLECT_CSS_JS = `() => {
  const CONTENT_TOKENS = ['#markdown-content', '#markdown-page', '.katex', '.hljs', '.mermaid', '.markmap', '.graphviz', '.plantuml', '.diagram'];
  const shouldKeep = (sel) => CONTENT_TOKENS.some((t) => sel.toLowerCase().includes(t));
  const chunks = [];
  for (const ss of Array.from(document.styleSheets)) {
    const owner = ss.ownerNode;
    if (owner && owner.id === 'markdown-viewer-preload') continue;
    try {
      const text = Array.from(ss.cssRules)
        .filter((r) => (r.type === 1 && shouldKeep(r.selectorText)) || r.type === 5 /* FONT_FACE_RULE */)
        .map((r) => r.cssText)
        .join('\\n');
      if (text) chunks.push(text);
    } catch { /* skip inaccessible sheets — like the exporter collector */ }
  }
  const theme = document.getElementById('theme-dynamic-style')?.textContent || '';
  if (theme) chunks.push(theme);
  return chunks.join('\\n');
}`;

const waitImagesJs = (rootSel: string) => `() => {
  const images = Array.from(document.querySelectorAll('${rootSel} img'));
  return Promise.all(images.map((img) => {
    if (typeof img.decode === 'function') return img.decode().catch(() => undefined);
    return new Promise((resolve) => {
      if (img.complete) { resolve(); return; }
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  })).then(() => true);
}`;
const WAIT_IMAGES_JS = waitImagesJs('#markdown-content');

const WAIT_RENDERED_JS = `() => {
  const c = document.getElementById('markdown-content');
  return Boolean(c && c.children.length > 0);
}`;

// standalone: content render + the async style injection (inject-styles
// fetches ui/styles.css) must BOTH be complete before collection.
const WAIT_STANDALONE_READY_JS = `() => {
  const c = document.getElementById('markdown-content');
  return Boolean(c && c.children.length > 0 && document.getElementById('mv-content-styles'));
}`;

const SET_STORAGE_JS = `(settings) => chrome.storage.local.set({ markdownViewerSettings: settings })`;

const POST_OPEN_DOCUMENT_JS = `(msg) => window.postMessage(msg, '*')`;

/**
 * Resolve the extension id from the background service worker. Polling is
 * more reliable than waitForEvent('serviceworker') — on cold starts the
 * worker registration event can be missed while the profile is being
 * created.
 */
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

const MOCK_PICKER_JS = `(fixtures) => {
  const handles = {};
  for (const [name, content] of Object.entries(fixtures)) {
    handles[name] = { name, kind: 'file', getFile: async () => new File([content], name) };
  }
  window.showDirectoryPicker = async () => ({
    name: 'fixtures',
    kind: 'directory',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async (name) => {
      if (!handles[name]) throw new DOMException('Not found', 'NotFoundError');
      return handles[name];
    },
    getDirectoryHandle: async () => { throw new DOMException('Not a directory', 'NotFoundError'); },
    [Symbol.asyncIterator]: async function* () {
      for (const [name, handle] of Object.entries(handles)) yield [name, handle];
    },
  });
}`;

describe('installed Chrome extension (three open modes × full fixture matrix)', { skip: SKIP_EXT }, () => {
  let context: BrowserContext;
  let extensionId = '';
  let userDataDir = '';
  let standalonePage: Page;
  let embedPage: Page;
  let workspacePage: Page;
  let inlinePage: Page;

  before(async () => {
    await fs.promises.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
      throw new Error('dist/chrome missing — run "node chrome/build.js" first');
    });

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-installed-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--no-first-run',
        '--disable-default-apps',
        // Let content scripts fetch file:// resources (fixture images).
        '--allow-file-access-from-files',
      ],
    });

    extensionId = await waitForExtensionId(context);

    standalonePage = await context.newPage();
    embedPage = await context.newPage();

    // Inline <markdown-viewer> element mode: the demo page hosts the element;
    // the background injects the element runtime after content detection.
    inlinePage = await context.newPage();
    await inlinePage.goto('file://' + path.resolve('demo/demo.html'), { waitUntil: 'load' });
    await waitFor(inlinePage, `() => Boolean(customElements.get('markdown-viewer'))`);
    await inlinePage.waitForTimeout(800);

    // Workspace page: mock the directory picker with ALL layout fixtures so
    // the tree contains every fixture and tests switch files by clicking.
    const fixtureContents: Record<string, string> = {};
    for (const name of fs.readdirSync(LAYOUT_DIR)) {
      if (name.endsWith('.md')) {
        fixtureContents[name] = fs.readFileSync(path.join(LAYOUT_DIR, name), 'utf8');
      }
    }
    workspacePage = await context.newPage();
    await workspacePage.addInitScript(`(${MOCK_PICKER_JS})(${JSON.stringify(fixtureContents)})`);

    // Pin the settings used by every render.
    await embedPage.goto(`chrome-extension://${extensionId}/ui/workspace/viewer-embed.html?embed=1`);
    await evalJs(embedPage, SET_STORAGE_JS, { ...FIXED_SETTINGS });
  });

  after(async () => {
    await context?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  // ── Mode plumbing ────────────────────────────────────────────────────────

  const ensureSettings = async (overrides: Record<string, unknown> = {}) => {
    await evalJs(embedPage, SET_STORAGE_JS, { ...FIXED_SETTINGS, ...overrides });
  };

  const openStandalone = async (fixtureName: string) => {
    await standalonePage.goto('file://' + path.join(LAYOUT_DIR, fixtureName), { waitUntil: 'load' });
    await waitFor(standalonePage, WAIT_STANDALONE_READY_JS);
    await evalJs(standalonePage, WAIT_IMAGES_JS);
  };

  const openEmbed = async (fixtureName: string) => {
    const content = fs.readFileSync(path.join(LAYOUT_DIR, fixtureName), 'utf8');
    await embedPage.goto(`chrome-extension://${extensionId}/ui/workspace/viewer-embed.html?embed=1`, { waitUntil: 'load' });
    await embedPage.waitForTimeout(600); // viewer runtime bootstrap
    await evalJs(embedPage, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT',
      content,
      filename: fixtureName,
      fileDir: '',
    });
    await waitFor(embedPage, WAIT_RENDERED_JS);
    await evalJs(embedPage, WAIT_IMAGES_JS);
  };

  const workspaceFrame = (): Frame => {
    const frame = workspacePage.frames().find((f) => f.url().includes('viewer-embed'));
    assert.ok(frame, 'workspace preview iframe not found');
    return frame;
  };

  /** Wait until the preview iframe finishes navigating (frame list is Node-side). */
  const waitForWorkspaceFrame = async (): Promise<Frame> => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const frame = workspacePage.frames().find((f) => f.url().includes('viewer-embed'));
      if (frame) return frame;
      if (Date.now() >= deadline) {
        throw new Error('workspace preview iframe not found (timeout)');
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const openWorkspace = async (fixtureName: string) => {
    const treeVisible = await evalJs<boolean>(workspacePage, `() => Boolean(document.querySelector('.tree-item'))`);
    if (!treeVisible) {
      await workspacePage.goto(`chrome-extension://${extensionId}/ui/workspace/workspace.html`, { waitUntil: 'load' });
      await evalJs(workspacePage, `() => { (document.querySelector('#pick-directory')).click(); return true; }`);
      await workspacePage.waitForSelector('.tree-item', { timeout: 30000 });
    }
    await evalJs(workspacePage, `(name) => {
      const item = Array.from(document.querySelectorAll('.tree-item')).find((el) => el.textContent.includes(name));
      if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(item);
    }`, fixtureName);
    // The preview iframe is created lazily by the workspace bridge.
    const frame = await waitForWorkspaceFrame();
    await waitFor(frame, WAIT_RENDERED_JS);
    await evalJs(frame, WAIT_IMAGES_JS);
  };

  const modeTarget = (mode: string): Target => {
    if (mode === 'standalone') return standalonePage;
    if (mode === 'embed') return embedPage;
    if (mode === 'inline') return inlinePage;
    return workspaceFrame();
  };

  const openFixture = async (mode: string, fixtureName: string, overrides: Record<string, unknown> = {}) => {
    await ensureSettings(overrides);
    if (mode === 'standalone') await openStandalone(fixtureName);
    else if (mode === 'embed') await openEmbed(fixtureName);
    else if (mode === 'inline') await openInline(fixtureName);
    else await openWorkspace(fixtureName);
  };

  const openInline = async (fixtureName: string) => {
    const content = fs.readFileSync(path.join(LAYOUT_DIR, fixtureName), 'utf8');
    await evalJs(inlinePage, `(markdown) => {
      const el = document.getElementById('viewer');
      return el.render(markdown).then(() => true);
    }`, content);
    await waitFor(inlinePage, `() => {
      const c = document.querySelector('#viewer .markdown-viewer-content, #viewer #markdown-content');
      return Boolean(c && c.children.length > 0);
    }`);
    await waitFor(inlinePage, waitImagesJs('.markdown-viewer-content'));
  };

  const measure = (mode: string, selectors: string[]) => evalJs(modeTarget(mode), MEASURE_JS, selectors);

  /** Selector for the content root in the given mode. */
  const contentSel = (mode: string) => (mode === 'inline' ? '.markdown-viewer-content' : '#markdown-content');

  /** Wait until a selector exists inside the content root (async rendering). */
  const waitForContent = (mode: string, selector: string) =>
    waitFor(modeTarget(mode), `() => Boolean(document.querySelector('${contentSel(mode)} ${selector}'))`);

  const collectCss = (mode: string) => evalJs<string>(modeTarget(mode), COLLECT_CSS_JS);

  // ── Fixture matrix (same semantics as the Web baseline) ──────────────────

  const runFullMatrix = async (mode: string) => {
    const ctx = (name: string) => `[${mode}] ${name}`;

    // images (data-URL fixtures: relative resources are unresolvable in the
    // embed/workspace modes, and a broken image stretches block-level to the
    // container width, zeroing its auto margins)
    {
      await openFixture(mode, 'image-center-data.md');
      await waitForContent(mode, 'img');
      const m = await measure(mode, [`${contentSel(mode)} img`]);
      const img = firstOf(m, `${contentSel(mode)} img`);
      assert.equal(img.display, 'block', ctx('centered image should be block'));
      assert.equal(img.marginLeft, img.marginRight, ctx('centered image needs symmetric margins'));
      assert.ok(px(img.marginLeft) > 0, ctx('centered image needs a positive centering margin'));
    }
    {
      await openFixture(mode, 'image-left-data.md', { imageLayout: 'left' });
      await waitForContent(mode, 'img');
      const m = await measure(mode, [`${contentSel(mode)} img`]);
      const img = firstOf(m, `${contentSel(mode)} img`);
      assert.equal(img.marginLeft, '0px', ctx('left image must have zero margin-left'));
      assert.equal(img.display, 'block', ctx('left image should be block'));
    }

    // diagrams
    {
      await openFixture(mode, 'diagram-center.md');
      await waitForContent(mode, '.diagram-block');
      const m = await measure(mode, ['.diagram-block']);
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, block.marginRight, ctx('centered diagram needs symmetric margins'));
      assert.ok(px(block.marginLeft) > 0, ctx('centered diagram needs a positive centering margin'));
    }
    {
      await openFixture(mode, 'diagram-left.md', { diagramLayout: 'left' });
      await waitForContent(mode, '.diagram-block');
      const m = await measure(mode, ['.diagram-block']);
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, '0px', ctx('left diagram must have zero margin-left'));
      assert.equal(block.textAlign, 'left', ctx('left diagram container should be text-align:left'));
    }

    // tables
    {
      await openFixture(mode, 'table-center.md');
      await waitForContent(mode, 'table');
      const m = await measure(mode, [`${contentSel(mode)} table`]);
      const table = firstOf(m, `${contentSel(mode)} table`);
      assert.ok(Math.abs(px(table.marginLeft) - px(table.marginRight)) < 1, ctx('centered table margins symmetric within 1px'));
      assert.ok(px(table.marginLeft) > 0, ctx('centered table needs a positive centering margin'));
    }
    {
      await openFixture(mode, 'table-left.md', { tableLayout: 'left' });
      await waitForContent(mode, 'table');
      const m = await measure(mode, [`${contentSel(mode)} table`]);
      const table = firstOf(m, `${contentSel(mode)} table`);
      assert.equal(table.marginLeft, '0px', ctx('left table must have zero margin-left'));
    }
    {
      await openFixture(mode, 'table-full.md', { tableLayout: 'center-full-width' });
      await waitForContent(mode, 'table');
      const m = await measure(mode, [`${contentSel(mode)} table`]);
      const table = firstOf(m, `${contentSel(mode)} table`);
      assert.equal(table.display, 'table', ctx('full-width table should be a real table layout box'));
      // Workspace preview iframe is narrower than the 1440px baseline; the
      // semantic is "spans the content width", so require a wide table but
      // not the desktop baseline width.
      assert.ok(table.width > 400, ctx(`full-width table should span the content width (got ${table.width}px)`));
    }
    {
      await openFixture(mode, 'table-cells.md');
      await waitForContent(mode, 'table');
      const m = await measure(mode, ['table th', 'table td']);
      const th = firstOf(m, 'table th');
      const td = firstOf(m, 'table td');
      assert.equal(th.fontWeight, '700', ctx('table header should be bold'));
      assert.equal(td.fontWeight, '400', ctx('table body cells should be regular'));
      assert.notEqual(th.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('table header should have a background'));
      assert.ok(px(td.paddingTop) > 0 && px(td.paddingLeft) > 0, ctx('cells should keep padding'));
      assert.ok(px(td.borderTopWidth) > 0 && px(td.borderLeftWidth) > 0, ctx('cells should keep borders'));
    }

    // blockquote
    {
      await openFixture(mode, 'blockquote-body.md');
      await waitForContent(mode, 'blockquote');
      const m = await measure(mode, ['blockquote']);
      const quote = firstOf(m, 'blockquote');
      assert.ok(px(quote.borderLeftWidth) > 0, ctx('blockquote should keep a left border'));
      assert.ok(px(quote.paddingLeft) > 0, ctx('blockquote should keep left padding'));
      assert.notEqual(quote.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('blockquote should keep a themed background'));
    }

    // body typography
    {
      await openFixture(mode, 'body-text.md');
      await waitForContent(mode, 'p');
      const m = await measure(mode, [`${contentSel(mode)} p`]);
      const p = firstOf(m, `${contentSel(mode)} p`);
      // 14pt body theme (db81b3c): 14pt = 18.6667px, line-height 1.5 = 28px.
      assert.equal(p.fontSize, '18.6667px', ctx('body font size should stay 18.6667px'));
      assert.equal(p.lineHeight, '28px', ctx('body line-height should stay 1.5 (28px)'));
      assert.notEqual(p.color, 'rgba(0, 0, 0, 0)', ctx('body text color should be set'));
      assert.ok(p.fontFamily.includes('FangSong'), ctx('body font stack should keep FangSong first'));
    }

    // headings
    {
      await openFixture(mode, 'headings.md');
      await waitForContent(mode, 'h1');
      const m = await measure(mode, [`${contentSel(mode)} h1`, `${contentSel(mode)} h2`]);
      const h1 = firstOf(m, `${contentSel(mode)} h1`);
      const h2 = firstOf(m, `${contentSel(mode)} h2`);
      assert.ok(px(h1.marginTop) > 0 && px(h1.marginBottom) > 0, ctx('h1 should keep block spacing'));
      assert.ok(px(h2.marginTop) > 0 && px(h2.marginBottom) > 0, ctx('h2 should keep block spacing'));
      // 14pt body theme (db81b3c): h1 20pt = 26.6667px, h2 18pt = 24px.
      assert.equal(h1.fontSize, '26.6667px', ctx('h1 should stay 26.6667px'));
      assert.equal(h2.fontSize, '24px', ctx('h2 should stay 24px'));
    }

    // hr
    {
      await openFixture(mode, 'hr.md');
      await waitForContent(mode, 'hr');
      const m = await measure(mode, ['hr']);
      const hr = firstOf(m, 'hr');
      assert.ok(px(hr.marginTop) > 0 && px(hr.marginBottom) > 0, ctx('hr should keep vertical margins'));
      assert.notEqual(hr.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('hr should render a visible rule'));
    }

    // inline formatting
    {
      await openFixture(mode, 'text-format.md');
      await waitForContent(mode, 'strong');
      const m = await measure(mode, ['strong', 'em', 'del', 'a', `${contentSel(mode)} code`]);
      assert.equal(firstOf(m, 'strong').fontWeight, '700', ctx('strong should render bold'));
      assert.equal(firstOf(m, 'em').fontStyle, 'italic', ctx('em should render italic'));
      assert.equal(firstOf(m, 'del').textDecorationLine, 'line-through', ctx('del should render struck through'));
      const link = firstOf(m, 'a');
      assert.notEqual(link.color, 'rgb(23, 23, 23)', ctx('links should use an accent color, not body color'));
      assert.equal(link.textDecorationLine, 'none', ctx('links should not be underlined'));
      const code = firstOf(m, `${contentSel(mode)} code`);
      assert.notEqual(code.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('inline code should have a background'));
      assert.ok(px(code.paddingLeft) > 0, ctx('inline code should keep horizontal padding'));
      assert.ok(px(code.fontSize) < 18.6667, ctx('inline code should be smaller than the 14pt body text'));
    }

    // lists
    {
      await openFixture(mode, 'list.md');
      await waitForContent(mode, 'ul');
      const m = await measure(mode, ['ul', 'ol', 'ul li']);
      assert.ok(px(firstOf(m, 'ul').paddingLeft) > 0, ctx('unordered list should keep indentation padding'));
      assert.ok(px(firstOf(m, 'ol').paddingLeft) > 0, ctx('ordered list should keep indentation padding'));
      const li = firstOf(m, 'ul li');
      assert.equal(li.fontSize, '18.6667px', ctx('list items should use the body font size'));
      assert.ok(px(li.marginBottom) > 0, ctx('list items should keep bottom spacing'));
    }

    // code blocks (pagination compatibility: no scroll containers)
    {
      await openFixture(mode, 'code-block.md');
      await waitForContent(mode, 'pre');
      const m = await measure(mode, [`${contentSel(mode)} pre`]);
      const pre = firstOf(m, `${contentSel(mode)} pre`);
      assert.equal(pre.overflowX, 'visible', ctx('pre must not be a horizontal scroll container (pagination)'));
      assert.equal(pre.overflowY, 'visible', ctx('pre must not be a vertical scroll container (pagination)'));
      assert.notEqual(pre.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('pre should have a background'));
    }

    // footnotes & math
    {
      await openFixture(mode, 'footnotes.md');
      await waitForContent(mode, 'section.footnotes');
      const m = await measure(mode, ['section.footnotes', 'sup']);
      const section = firstOf(m, 'section.footnotes');
      assert.ok(px(section.fontSize) > 0, ctx('footnotes section should have typography'));
      firstOf(m, 'sup');
    }
    {
      await openFixture(mode, 'math.md');
      await waitForContent(mode, '.katex-display');
      const m = await measure(mode, ['.katex-display', '.katex']);
      const display = firstOf(m, '.katex-display');
      assert.ok(px(display.marginTop) > 0 && px(display.marginBottom) > 0, ctx('display math should keep block margins'));
      assert.equal(firstOf(m, '.katex').fontSize, '18.6667px', ctx('KaTeX should follow the body font size'));
    }
  };

  const runCollectionContract = async (mode: string) => {
    await openFixture(mode, 'diagram-center.md');
    const css = await collectCss(mode);

    assert.ok(
      /#markdown-content \.diagram-block[^{]*\{[^}]*margin\s*:\s*20px\s+auto/.test(css),
      `[${mode}] collected stylesheet must carry the diagram centering rule`,
    );
    assert.ok(
      /#markdown-content img\s*\{[^}]*max-width\s*:\s*100%/.test(css),
      `[${mode}] collected stylesheet must carry the shared img sizing rule`,
    );
    assert.ok(
      /#markdown-content svg\s*\{[^}]*max-width\s*:\s*100%/.test(css),
      `[${mode}] collected stylesheet must carry the shared svg sizing rule`,
    );
    assert.ok(css.includes('.katex'), `[${mode}] collected stylesheet must carry KaTeX rules`);
    assert.ok(css.includes('#markdown-page'), `[${mode}] collected stylesheet must carry page-level rules`);
    // standalone/inline host pages load a FILTERED stylesheet (no @font-face)
    // while workspace/embed load the full ui/styles.css (same-origin fonts).
    if (mode === 'workspace' || mode === 'embed') {
      assert.ok(css.includes('@font-face'), `[${mode}] collected stylesheet must keep @font-face (same-origin fonts)`);
    }
  };

  for (const mode of ['standalone', 'workspace', 'embed', 'inline']) {
    describe(mode, () => {
      it('layout classes live on the render target only (single layer)', async () => {
        await openFixture(mode, 'image-center-data.md');
        await waitForContent(mode, 'img');
        const result = await evalJs<{ targetHasLayout: boolean; holders: number; single: boolean }>(modeTarget(mode), `() => {
          const root = document.querySelector('#markdown-content, .markdown-viewer-content');
          const cls = (el) => Array.from((el.className || '').split(' ')).filter((x) => x.includes('-layout-'));
          // Hosts either render into the content root itself or into a child
          // .markdown-viewer-content (content-script takeover, embed, etc.).
          const target = root.querySelector(':scope > .markdown-viewer-content') || root;
          const holders = [root, ...Array.from(root.querySelectorAll('*'))]
            .filter((el) => cls(el).length > 0);
          return {
            targetHasLayout: cls(target).length > 0,
            holders: holders.length,
            single: holders.length === 1 && holders[0] === target,
          };
        }`);
        assert.ok(
          result.targetHasLayout,
          `[${mode}] the render target must carry the layout classes`,
        );
        assert.ok(
          result.single,
          `[${mode}] layout classes must live on the render target only (single layer; got ${result.holders} holders)`,
        );
      });

      it('collects the full shared export stylesheet (diagram rule present)', async () => {
        await runCollectionContract(mode);
      });

      it('renders the full fixture matrix', async () => {
        await runFullMatrix(mode);
      });
    });
  }

  // Inline-specific concerns on top of the shared matrix above: the host page
  // must receive the shared content stylesheet in FILTERED form only.
  it('inline mode injects a filtered content stylesheet (host page untouched)', async () => {
    await openFixture('inline', 'diagram-center.md');
    const hasStyles = await evalJs<boolean>(inlinePage, `() => {
      const style = document.getElementById('mv-content-styles');
      return Boolean(style && style.textContent.includes('.diagram-block'));
    }`);
    assert.ok(hasStyles, 'inline mode must inject the shared content styles (diagram rule present)');
    // The host page itself must not be restyled by global rules.
    const hostClean = await evalJs<boolean>(inlinePage, `() => {
      const wrap = document.querySelector('.viewer-wrap');
      return Boolean(wrap && getComputedStyle(wrap).overflowY !== 'hidden');
    }`);
    assert.ok(hostClean, 'the filtered stylesheet must not leak global body rules into the host page');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Footnote-only race (fresh <markdown-viewer> element, pre-set value)
  //
  // Regression guard for: "a document with footnotes rendered through a
  // <markdown-viewer> element sometimes shows ONLY the footnote section".
  //
  // Root cause (fixed in viewer-controller.ts): at attach time the element
  // starts the initial render (applyCurrentAttributes) while switchTheme('')
  // concurrently runs the theme apply + rerender flow. The rerender
  // (forceRender) aborts the initial render; the aborted render's streaming
  // bailed out BUT its applyFootnotes still appended the footnote section
  // into the new render's container. The new render then saw a non-empty
  // container, took the incremental path, found zero diffs (identical
  // content) and never rebuilt the body — leaving ONLY footnotes.
  //
  // Fix: aborted renders must not touch the container further (skip
  // applyFootnotes + block appends after the abort), and the incremental
  // path must fall back to a full rebuild when the container no longer
  // mirrors the document's block list.
  //
  // The fixture (test/fixtures/regression/footnote-race.md) is the original
  // repro document (temp/test.md): it is large enough that the race window
  // (settings reads + chunked streaming) reliably overlaps the attach-time
  // theme rerender. Pre-fix this failed ~60% of the time per iteration; the
  // loop below makes a regression essentially certain to fail.
  it('fresh element with pre-set value renders the body (no footnote-only state)', async () => {
    const content = fs.readFileSync(path.resolve('test/fixtures/regression/footnote-race.md'), 'utf8');
    for (let i = 0; i < 8; i++) {
      // Create a FRESH element and set value in the same task, before the
      // runtime attaches — the exact pattern that raced the initial render
      // against the attach-time theme rerender.
      await evalJs(inlinePage, `(md) => {
        const old = document.getElementById('mv-race-probe');
        if (old) old.remove();
        const probe = document.createElement('div');
        probe.id = 'mv-race-probe';
        document.body.appendChild(probe);
        const el = document.createElement('markdown-viewer');
        el.setAttribute('mode', 'inline');
        probe.appendChild(el);
        el.setAttribute('value', md);
        return true;
      }`, content);
      await waitFor(inlinePage, `() => {
        const c = document.querySelector('#mv-race-probe .markdown-viewer-content');
        return Boolean(c && c.children.length > 0);
      }`, 20000);
      // The footnote section is appended at the END of the render pipeline, so
      // its presence marks the render as settled (mid-stream samples have no
      // footnotes yet). On the buggy build it also appears — but as the ONLY
      // child (body never rebuilt) — the body assertion below catches that.
      await waitFor(inlinePage, `() => Boolean(
        document.querySelector('#mv-race-probe .md-footnotes-container')
      )`, 20000);
      // The attach-time theme switch can re-render (clear + rebuild) right
      // after the first render finishes — let the container settle before
      // sampling so a mid-rebuild snapshot is not mistaken for a bug.
      await inlinePage.waitForTimeout(800);
      const state = await evalJs<{ body: number; foot: number; blocks: number }>(inlinePage, `() => {
        const c = document.querySelector('#mv-race-probe .markdown-viewer-content');
        const blocks = Array.from(c.children).filter((n) => n.classList && n.classList.contains('md-block'));
        const foot = blocks.filter((b) => b.classList.contains('md-footnotes-container'));
        const body = blocks.filter((b) => !b.classList.contains('md-footnotes-container'));
        return { body: body.length, foot: foot.length, blocks: blocks.length };
      }`);
      assert.ok(state.foot >= 1, `iteration ${i}: footnote section must be present (blocks=${state.blocks})`);
      assert.ok(
        state.body > 0,
        `iteration ${i}: body must be rendered — footnote-only state (body=${state.body}, foot=${state.foot})`,
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Nested-directory previews (workspace mode)
//
// Regression guards: opening a file in a subdirectory of the workspace and
// previewing it must resolve relative images against THAT file's directory.
// The browser serializes non-ASCII `src` attributes percent-encoded
// (`06-01-%E8%AF%81...png`), so the File System Access lookup must decode the
// path before resolving — otherwise every Chinese-named image is "not found".
// ────────────────────────────────────────────────────────────────────────────

const NESTED_BOOK_DIR = path.resolve('test/fixtures/book-nested');

// 1x1 red PNG (base64) so `naturalWidth` assertions are meaningful.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Mock picker with a NESTED directory tree plus binary-safe PNG fixtures.
 * File content: `{ text: '...' }` for markdown, `{ base64: '...' }` for PNGs.
 */
const NESTED_PICKER_JS = `(fixtures) => {
  const decodeEntry = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value.base64 === 'string') {
      return Uint8Array.from(atob(value.base64), (c) => c.charCodeAt(0));
    }
    if (value && typeof value.text === 'string') return value.text;
    return String(value);
  };
  const makeFileHandle = (name, value) => ({
    name,
    kind: 'file',
    getFile: async () => new File([decodeEntry(value)], name),
  });
  const makeDirHandle = (name, entries) => {
    const children = {};
    for (const [childName, value] of Object.entries(entries)) {
      if (value && typeof value === 'object' && !value.base64 && !value.text && typeof value.getFileHandle !== 'function') {
        children[childName] = makeDirHandle(childName, value);
      } else {
        children[childName] = makeFileHandle(childName, value);
      }
    }
    return {
      name,
      kind: 'directory',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async (childName) => {
        const h = children[childName];
        if (!h || h.kind !== 'file') throw new DOMException('Not found', 'NotFoundError');
        return h;
      },
      getDirectoryHandle: async (childName) => {
        const h = children[childName];
        if (!h || h.kind !== 'directory') throw new DOMException('Not found', 'NotFoundError');
        return h;
      },
      [Symbol.asyncIterator]: async function* () {
        for (const [n, h] of Object.entries(children)) yield [n, h];
      },
    };
  };
  window.showDirectoryPicker = async () => makeDirHandle('book-nested', fixtures);
}`;

describe('installed Chrome extension — workspace preview of nested-directory files', { skip: SKIP_EXT }, () => {
  let context: BrowserContext;
  let extensionId = '';
  let userDataDir = '';
  let workspacePage: Page;

  before(async () => {
    await fs.promises.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
      throw new Error('dist/chrome missing — run "node chrome/build.js" first');
    });

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-nested-workspace-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
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

    const nestedFixture = {
      'SUMMARY.md': { text: fs.readFileSync(path.join(NESTED_BOOK_DIR, 'SUMMARY.md'), 'utf8') },
      'README.md': { text: fs.readFileSync(path.join(NESTED_BOOK_DIR, 'README.md'), 'utf8') },
      // Issue #123: same-directory image whose name mixes CJK and parens,
      // referenced with the angle-bracket destination syntax.
      'issue-123.md': {
        text: '# Issue 123 reproduction\n\n![alt text](<./中文图片(测试).png>)\n',
      },
      '中文图片(测试).png': { base64: PNG_BASE64 },
      chapters: {
        reference: {
          '06-identity.md': {
            text: fs.readFileSync(path.join(NESTED_BOOK_DIR, 'chapters/reference/06-identity.md'), 'utf8'),
          },
        },
      },
      assets: {
        images: {
          'logo.png': { base64: PNG_BASE64 },
          'f06-identity': {
            '06-01-证书管理.png': { base64: PNG_BASE64 },
          },
        },
      },
    };

    workspacePage = await context.newPage();
    await workspacePage.addInitScript(`(${NESTED_PICKER_JS})(${JSON.stringify(nestedFixture)})`);
    await workspacePage.goto(`chrome-extension://${extensionId}/ui/workspace/workspace.html`, { waitUntil: 'load' });
    await evalJs(workspacePage, `() => { (document.querySelector('#pick-directory')).click(); return true; }`);
    await workspacePage.waitForSelector('.tree-item', { timeout: 30000 });
  });

  after(async () => {
    await context?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const clickTreeItem = async (name: string) => {
    await evalJs(workspacePage, `(name) => {
      const item = Array.from(document.querySelectorAll('.tree-item')).find((el) => el.textContent.trim().startsWith(name));
      if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(item);
    }`, name);
  };

  it('previews images in a nested-directory file (incl. non-ASCII names)', async () => {
    // Expand chapters → reference
    await clickTreeItem('chapters');
    await workspacePage.waitForTimeout(300);
    await clickTreeItem('reference');
    await workspacePage.waitForTimeout(300);
    // Open the chapter file in the subdirectory
    await evalJs(workspacePage, `(name) => {
      const item = Array.from(document.querySelectorAll('.tree-item')).find((el) => el.textContent.includes(name));
      if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(item);
    }`, '06-identity.md');

    const frame = await (async () => {
      const deadline = Date.now() + 30000;
      for (;;) {
        const f = workspacePage.frames().find((fr) => fr.url().includes('viewer-embed'));
        if (f) return f;
        if (Date.now() >= deadline) throw new Error('workspace preview iframe not found (timeout)');
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    await waitFor(frame, WAIT_RENDERED_JS);
    // Wait until the image resolution round-trip replaced src with a blob URL.
    await waitFor(frame, `() => {
      const img = document.querySelector('#markdown-content img');
      return Boolean(img && img.getAttribute('src') && img.getAttribute('src').startsWith('blob:'));
    }`, 15000);

    const report = await evalJs<Array<{ src: string; naturalWidth: number }>>(frame, `() => {
      return Array.from(document.querySelectorAll('#markdown-content img')).map((img) => ({
        src: (img.getAttribute('src') || '').slice(0, 60),
        naturalWidth: img.naturalWidth,
      }));
    }`);
    assert.ok(report.length >= 2, `nested chapter must render both images (got ${report.length})`);
    for (const img of report) {
      assert.ok(img.src.startsWith('blob:'), `workspace preview must resolve relative images to blob URLs (got "${img.src}")`);
      assert.ok(img.naturalWidth > 0, `resolved image must be decodable (got naturalWidth=${img.naturalWidth})`);
    }
  });

  it('previews a same-directory image with CJK + parens in its name (issue #123)', async () => {
    // https://github.com/markdown-viewer/markdown-viewer-extension/issues/123
    // `![alt text](<./中文图片(测试).png>)` in a top-level workspace file must
    // resolve through the File System Access API like any ASCII-named image.
    await clickTreeItem('issue-123.md');
    await workspacePage.waitForTimeout(300);

    const frame = await (async () => {
      const deadline = Date.now() + 30000;
      for (;;) {
        const f = workspacePage.frames().find((fr) => fr.url().includes('viewer-embed'));
        if (f) return f;
        if (Date.now() >= deadline) throw new Error('workspace preview iframe not found (timeout)');
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    await waitFor(frame, WAIT_RENDERED_JS);

    // Wait for the RESOLVE_IMAGE round-trip to swap in a blob URL. When the
    // bug reproduces, the img keeps its unresolved relative src (or stays
    // broken) and this times out.
    let observedSrc = '';
    const resolved = await (async () => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const state = await evalJs<{ src: string; naturalWidth: number }>(frame, `() => {
          const img = document.querySelector('#markdown-content img');
          return img ? { src: img.getAttribute('src') || '', naturalWidth: img.naturalWidth } : { src: '', naturalWidth: -1 };
        }`);
        observedSrc = state.src;
        if (state.src.startsWith('blob:')) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    assert.ok(resolved, `image with CJK+paren filename must resolve to a blob URL (last src="${observedSrc.slice(0, 120)}")`);
    const state = await evalJs<{ src: string; naturalWidth: number }>(frame, `() => {
      const img = document.querySelector('#markdown-content img');
      return img ? { src: img.getAttribute('src') || '', naturalWidth: img.naturalWidth } : { src: '', naturalWidth: 0 };
    }`);
    assert.ok(state.naturalWidth > 0, `resolved image must be decodable (got naturalWidth=${state.naturalWidth})`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY (GitBook panel) preview of nested-directory chapters
//
// Clicking a chapter in the summary panel navigates IN PAGE (the page URL
// stays on SUMMARY.md), so relative images inside subdirectory chapters must
// be absolutized against the chapter's own URL before rendering — otherwise
// `../../assets/...` resolves against the SUMMARY directory and every image
// breaks.
// ────────────────────────────────────────────────────────────────────────────

describe('installed Chrome extension — SUMMARY panel preview of nested chapters', { skip: SKIP_EXT }, () => {
  let context: BrowserContext;
  let extensionId = '';
  let userDataDir = '';
  let summaryPage: Page;

  before(async () => {
    await fs.promises.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
      throw new Error('dist/chrome missing — run "node chrome/build.js" first');
    });

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-nested-summary-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
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

    summaryPage = await context.newPage();
    await summaryPage.goto('file://' + path.join(NESTED_BOOK_DIR, 'SUMMARY.md'), { waitUntil: 'load' });
    // Wait for the viewer takeover AND the gitbook panel with chapter links.
    await waitFor(summaryPage, WAIT_STANDALONE_READY_JS);
    await waitFor(summaryPage, `() => Boolean(document.querySelector('#gitbook-panel a[data-href*="06-identity"]'))`);
  });

  after(async () => {
    await context?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('loads relative images of a subdirectory chapter clicked in the panel', async () => {
    // Click the chapter link in the summary panel (in-page navigation).
    await evalJs(summaryPage, `() => {
      const link = document.querySelector('#gitbook-panel a[data-href*="06-identity"]');
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }`);
    await waitFor(summaryPage, `() => {
      const img = document.querySelector('#markdown-content img');
      return Boolean(img && img.naturalWidth > 0);
    }`, 20000);

    const report = await evalJs<Array<{ src: string; naturalWidth: number }>>(summaryPage, `() => {
      return Array.from(document.querySelectorAll('#markdown-content img')).map((img) => ({
        src: (img.getAttribute('src') || '').slice(0, 120),
        naturalWidth: img.naturalWidth,
      }));
    }`);
    assert.ok(report.length >= 2, `chapter must render both images (got ${report.length})`);
    for (const img of report) {
      assert.ok(img.naturalWidth > 0, `image must load against the chapter directory (got "${img.src}" naturalWidth=${img.naturalWidth})`);
    }
  });

  it('keeps responding when further chapters are clicked after the first one', async () => {
    // Regression guard: clicking a chapter must never leave the panel dead —
    // every subsequent click has to re-render the preview. Covers both
    // subdirectories and a second pass over an already-opened chapter.
    const chapters = [
      { needle: '06-identity', text: '证书' },
      { needle: 'README.md', text: '首页' },
      { needle: '06-identity', text: '证书' },
    ];

    for (const { needle, text } of chapters) {
      const clicked = await evalJs<boolean>(summaryPage, `(needle) => {
        const link = Array.from(document.querySelectorAll('#gitbook-panel a')).find(
          (a) => (a.getAttribute('data-href') || '').includes(needle),
        );
        if (!link) return false;
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }`, needle);
      assert.ok(clicked, `panel must contain a link for "${needle}"`);

      await waitFor(summaryPage, `() => {
        const c = document.getElementById('markdown-content');
        return Boolean(c && c.textContent && c.textContent.includes('${text}'));
      }`, 20000);
    }
  });

  it('navigates markdown links INSIDE the rendered content in place (no page reload)', async () => {
    // Regression guard: chapter-internal relative links are absolutized
    // against the chapter URL, so clicking one natively would reload the
    // whole page (janky). The viewer must intercept them and re-render in
    // place — the page URL stays on SUMMARY.md.
    const summaryUrl = 'file://' + path.join(NESTED_BOOK_DIR, 'SUMMARY.md');

    // Open the chapter that contains a cross-chapter link.
    await evalJs(summaryPage, `() => {
      const link = Array.from(document.querySelectorAll('#gitbook-panel a')).find(
        (a) => (a.getAttribute('data-href') || '').includes('06-identity'),
      );
      if (link) link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return Boolean(link);
    }`);
    await waitFor(summaryPage, `() => {
      const c = document.getElementById('markdown-content');
      return Boolean(c && c.textContent && c.textContent.includes('证书'));
    }`, 20000);

    // Click the in-content link to the tutorial chapter.
    const clicked = await evalJs<boolean>(summaryPage, `() => {
      const link = Array.from(document.querySelectorAll('#markdown-content a')).find(
        (a) => (a.getAttribute('href') || '').includes('t01-tutorial'),
      );
      if (!link) return false;
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }`);
    assert.ok(clicked, 'rendered chapter must contain the cross-chapter link');

    await waitFor(summaryPage, `() => {
      const c = document.getElementById('markdown-content');
      return Boolean(c && c.textContent && c.textContent.includes('教程正文内容'));
    }`, 20000);

    // The page must NOT have navigated — in-place switch keeps the URL.
    assert.equal(
      summaryPage.url().split('#')[0],
      summaryUrl,
      `in-content link navigation must stay in place (URL unchanged)`,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SUMMARY panel started from a CHAPTER file (not SUMMARY.md)
//
// Regression guard for the double file:// prefix bug: gitbook navigation
// calls document.setDocumentPath(chapterUrl) with a FULL file:// URL, and the
// Chrome document service used to derive `_baseUrl = file://<dir>` from the
// URL — producing `file://file:///...`, an invalid base. The first panel
// click still worked (baseUrl from page init was intact), but every later
// click threw "Invalid base URL" in readRelativeFile, and on browsers where
// fetch(file://) fails the panel fell back to a full page navigation.
// ────────────────────────────────────────────────────────────────────────────

describe('installed Chrome extension — SUMMARY panel started from a chapter file', { skip: SKIP_EXT }, () => {
  let context: BrowserContext;
  let extensionId = '';
  let userDataDir = '';
  let chapterPage: Page;

  before(async () => {
    await fs.promises.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
      throw new Error('dist/chrome missing — run "node chrome/build.js" first');
    });

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-chapter-start-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
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

    chapterPage = await context.newPage();
    chapterPage.on('console', (msg) => {
      if (msg.text().includes('Invalid base URL')) {
        console.log('[chapter-start] console:', msg.text().slice(0, 200));
      }
    });
    // Open a CHAPTER inside a subdirectory — the panel discovers SUMMARY.md
    // by walking up from the page URL (the user's tpbaas scenario).
    await chapterPage.goto(
      'file://' + path.join(NESTED_BOOK_DIR, 'chapters/reference/06-identity.md'),
      { waitUntil: 'load' },
    );
    await waitFor(chapterPage, WAIT_STANDALONE_READY_JS);
    await waitFor(chapterPage, `() => document.querySelectorAll('#gitbook-panel a').length >= 3`);
  });

  after(async () => {
    await context?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('keeps navigating in place on the SECOND panel click (no Invalid base URL)', async () => {
    const startUrl = 'file://' + path.join(NESTED_BOOK_DIR, 'chapters/reference/06-identity.md');
    const errors: string[] = [];
    const onConsole = (msg: { text: string }) => {
      const t = msg.text();
      if (t.includes('Invalid base URL') || t.includes('Failed to construct')) {
        errors.push(t.slice(0, 200));
      }
    };
    chapterPage.on('console', onConsole);
    try {
      // First click (works even with the old bug: baseUrl survived page init).
      await evalJs(chapterPage, `(needle) => {
        const link = Array.from(document.querySelectorAll('#gitbook-panel a')).find(
          (a) => (a.getAttribute('data-href') || '').includes(needle),
        );
        if (link) link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return Boolean(link);
      }`, 't01-tutorial');
      await waitFor(chapterPage, `() => {
        const c = document.getElementById('markdown-content');
        return Boolean(c && c.textContent && c.textContent.includes('教程正文内容'));
      }`, 20000);
      assert.equal(
        chapterPage.url().split('#')[0],
        startUrl,
        'first click must stay in place',
      );

      // Second click — the bug corrupted _baseUrl after the first navigation.
      await evalJs(chapterPage, `(needle) => {
        const link = Array.from(document.querySelectorAll('#gitbook-panel a')).find(
          (a) => (a.getAttribute('data-href') || '').includes('README'),
        );
        if (link) link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return Boolean(link);
      }`, 'README.md');
      await waitFor(chapterPage, `() => {
        const c = document.getElementById('markdown-content');
        return Boolean(c && c.textContent && c.textContent.includes('首页'));
      }`, 20000);

      assert.equal(
        chapterPage.url().split('#')[0],
        startUrl,
        'second click must also stay in place (no full page navigation)',
      );
      assert.deepEqual(
        errors,
        [],
        `readRelativeFile must not throw "Invalid base URL" on the second click (got: ${errors.join(' | ')})`,
      );
    } finally {
      chapterPage.off('console', onConsole);
    }
  });
});
