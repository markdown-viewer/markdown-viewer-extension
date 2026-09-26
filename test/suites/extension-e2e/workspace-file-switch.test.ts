/**
 * Workspace file switching — the reading area must follow the selection.
 *
 * The workspace reuses ONE viewer (one toolbar, one session) for every file, so
 * each switch has to reset everything that is per-document: rendered content,
 * the code-view presentation (`data-code-view`), the card chrome, the TOC, and
 * the toolbar's per-file controls. Both switch directions are covered because
 * they take different paths in the viewer:
 *
 *   - same extension (`.md` → `.md`, code → code) — the format never changes,
 *     only the content;
 *   - cross extension (`.md` ⇄ code/text) — the resolved mode flips between
 *     `rendered` and `code-reading`, which also flips the card chrome
 *     (full-bleed code surface vs 820px reading card) and the toolbar buttons.
 *
 * The source-view variants are the ones that used to look wrong: leaving a file
 * in source view and opening another one must render the *new* file in its own
 * mode, not keep the previous presentation.
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { type Frame, type Page } from 'playwright-core';

import {
  FIXED_SETTINGS,
  MOCK_DIRECTORY_PICKER_JS,
  SET_STORAGE_JS,
  VIEWER_EMBED_READY_JS,
  WAIT_RENDERED_JS,
  evalJs,
  installPageDiagnostics,
  launchExtensionContext,
  waitFor,
  waitForFrame,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

/** Reading measure owned by READING_MAX_WIDTH_PX (src/ui/layout-presets.ts). */
const READING_MAX_WIDTH = 820;

const FILES: Record<string, string | Record<string, string>> = {
  'alpha.md': '# Alpha doc\n\nAlpha body.\n',
  'bravo.md': '# Bravo doc\n\nBravo body.\n',
  'notes.txt': 'plain text line 1\nplain text line 2\nplain text line 3\n',
  'script.js': 'const answer = 42;\nconsole.log(answer);\n',
  // Nested folder: the tree has to expand it and the path has to survive the
  // switch (the preview resolves relative images against it).
  docs: {
    'guide.md': '# Guide doc\n\nGuide body.\n',
  },
  // HTML previews render in a sandboxed iframe (a different document in the
  // same frame), so switching in and out of one has to re-establish the viewer.
  'page.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>HTML page</h1><img src="logo.png"></body></html>',
  'style.css': 'h1 { color: rebeccapurple; }\n',
  'logo.png': 'not-really-a-png',
  // Big enough that reading + rewriting it takes long enough for a click to
  // land in the middle of it.
  'huge.html': `<!doctype html><html><body>${'<p>filler paragraph for the rewrite</p>'.repeat(12000)}<img src="logo.png"></body></html>`,
};

/** Flat lookup used by the assertions (nested fixtures are flattened). */
const CONTENT: Record<string, string> = {
  'alpha.md': '# Alpha doc\n\nAlpha body.\n',
  'bravo.md': '# Bravo doc\n\nBravo body.\n',
  'notes.txt': 'plain text line 1\nplain text line 2\nplain text line 3\n',
  'script.js': 'const answer = 42;\nconsole.log(answer);\n',
  'guide.md': '# Guide doc\n\nGuide body.\n',
};

/** Everything a switch has to get right, as the user sees it. */
interface ViewerState {
  fileName: string;
  codeView: string | undefined;
  tocDisabled: string | undefined;
  headings: string[];
  codeText: string;
  hasPre: boolean;
  cardMaxWidth: string;
  cardShadow: string;
  cardBackground: string;
  sourceToggleDisplay: string | null;
  sourceToggleTitle: string | null;
  layoutDisplay: string | null;
}

const READ_STATE_JS = `() => {
  const content = document.getElementById('markdown-content');
  const card = document.getElementById('markdown-page');
  const code = content.querySelector('pre code');
  const sourceBtn = document.getElementById('toggle-source-view-btn');
  const layoutBtn = document.getElementById('layout-toggle-btn');
  return {
    fileName: document.getElementById('file-name')?.textContent || '',
    codeView: document.documentElement.dataset.codeView,
    tocDisabled: document.documentElement.dataset.tocDisabled,
    headings: Array.from(content.querySelectorAll('h1')).map((el) => el.textContent || ''),
    codeText: code ? code.textContent || '' : '',
    hasPre: Boolean(content.querySelector('pre')),
    cardMaxWidth: getComputedStyle(card).maxWidth,
    cardShadow: getComputedStyle(card).boxShadow,
    cardBackground: getComputedStyle(card).backgroundColor,
    sourceToggleDisplay: sourceBtn ? getComputedStyle(sourceBtn).display : null,
    sourceToggleTitle: sourceBtn ? sourceBtn.title : null,
    layoutDisplay: layoutBtn ? getComputedStyle(layoutBtn).display : null,
  };
}`;

/** A markdown document: reading card, TOC allowed, source toggle offered. */
function assertMarkdownState(state: ViewerState, heading: string, label: string): void {
  assert.equal(state.fileName, label.split(':')[0], `${label}: toolbar name`);
  assert.equal(state.codeView, undefined, `${label}: markdown is not rendered as code`);
  assert.equal(state.tocDisabled, undefined, `${label}: markdown keeps its TOC`);
  assert.deepEqual(state.headings, [heading], `${label}: rendered heading`);
  assert.equal(state.hasPre, false, `${label}: no code block in the rendered view`);
  assert.equal(state.cardMaxWidth, `${READING_MAX_WIDTH}px`, `${label}: reading measure`);
  assert.notEqual(state.cardShadow, 'none', `${label}: the reading card keeps its shadow`);
  assert.notEqual(state.cardBackground, 'rgba(0, 0, 0, 0)', `${label}: the reading card keeps its surface`);
  assert.equal(state.sourceToggleDisplay, 'flex', `${label}: source toggle offered`);
  assert.equal(state.sourceToggleTitle, 'Source Mode', `${label}: toggle offers source`);
  assert.equal(state.layoutDisplay, 'flex', `${label}: width control available`);
}

/** A code/text document: full-bleed code surface, no card, no TOC, no toggle. */
function assertCodeState(state: ViewerState, firstLine: string, label: string): void {
  assert.equal(state.fileName, label.split(':')[0], `${label}: toolbar name`);
  assert.equal(state.codeView, '1', `${label}: code-view presentation`);
  assert.equal(state.tocDisabled, '1', `${label}: code view has no TOC`);
  assert.deepEqual(state.headings, [], `${label}: nothing is rendered as markdown`);
  assert.ok(state.hasPre, `${label}: code block rendered`);
  assert.ok(
    state.codeText.replace(/\s+/g, ' ').includes(firstLine.replace(/\s+/g, ' ')),
    `${label}: code text is the file's own (got "${state.codeText.slice(0, 60)}")`,
  );
  assert.equal(state.cardMaxWidth, 'none', `${label}: code surface is full-bleed`);
  assert.equal(state.cardShadow, 'none', `${label}: no card shadow in code view`);
  assert.equal(state.cardBackground, 'rgba(0, 0, 0, 0)', `${label}: no card surface in code view`);
  assert.equal(state.sourceToggleDisplay, 'none', `${label}: a code file has no source toggle`);
  assert.equal(state.layoutDisplay, 'none', `${label}: width control hidden in code view`);
}

describe('installed Chrome extension — workspace file switching', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let workspacePage: Page;

  before(async () => {
    harness = await launchExtensionContext('mv-ws-switch-');
    workspacePage = await harness.context.newPage();
    // Viewer/frame errors (including a failed document open) must reach the
    // test output — a silent drop is what made this bug hard to see.
    installPageDiagnostics(workspacePage, 'workspace-file-switch');
    await workspacePage.addInitScript(`(${MOCK_DIRECTORY_PICKER_JS})(${JSON.stringify(FILES)})`);

    // Settings live in chrome.storage, which only an extension page can write.
    const bootstrap = await harness.context.newPage();
    await bootstrap.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`,
      { waitUntil: 'load' },
    );
    await waitFor(bootstrap, VIEWER_EMBED_READY_JS);
    await evalJs(bootstrap, SET_STORAGE_JS, { ...FIXED_SETTINGS });
    await bootstrap.close();

    await workspacePage.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/workspace.html`,
      { waitUntil: 'load' },
    );
    await evalJs(workspacePage, `() => { document.querySelector('#pick-directory').click(); return true; }`);
    await workspacePage.waitForSelector('.tree-item', { timeout: 30000 });
    // Expand the nested folder so its file is clickable.
    await evalJs(workspacePage, `() => {
      const folder = Array.from(document.querySelectorAll('.tree-item')).find((el) => el.textContent.includes('docs'));
      if (folder) folder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(folder);
    }`);
    await workspacePage.waitForTimeout(500);
  });

  after(async () => {
    await harness?.close();
  });

  const previewFrame = async (): Promise<Frame> => {
    let frame: Frame | null = null;
    for (let attempt = 0; attempt < 60 && !frame; attempt += 1) {
      await workspacePage.waitForTimeout(200);
      frame = workspacePage.frames().find((candidate) => candidate.url().includes('viewer-embed')) ?? null;
    }
    assert.ok(frame, 'workspace preview iframe not found');
    return frame;
  };

  /**
   * Click a file in the tree and wait until the preview shows *that* file:
   * the toolbar name follows the selection, then the content itself has to
   * match (a stale render of the previous file must not satisfy the wait).
   */
  const clickTreeItem = async (name: string): Promise<void> => {
    await evalJs(workspacePage, `() => {
      const item = Array.from(document.querySelectorAll('.tree-item')).find((el) => el.textContent.includes(${JSON.stringify(name)}));
      if (!item) throw new Error('tree item not found: ${name}');
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }`);
  };

  const waitForViewerFile = async (name: string): Promise<{ frame: Frame; state: ViewerState }> => {
    const frame = await previewFrame();
    await waitFor(frame, `() => document.documentElement.dataset.viewerFilename === ${JSON.stringify(name)}`, 30000);
    await waitFor(frame, WAIT_RENDERED_JS);

    const expected = CONTENT[name];
    const firstLine = expected.split('\n').find((line) => line.trim().length > 0) || '';
    const isMarkdown = name.endsWith('.md');
    await waitFor(frame, isMarkdown
      ? `() => (document.querySelector('#markdown-content h1')?.textContent || '') === ${JSON.stringify(firstLine.replace(/^#\s*/, ''))}`
      : `() => (document.querySelector('#markdown-content pre code')?.textContent || '').includes(${JSON.stringify(firstLine)})`, 30000);

    const state = await evalJs<ViewerState>(frame, READ_STATE_JS);
    return { frame, state };
  };

  const openFile = async (name: string): Promise<{ frame: Frame; state: ViewerState }> => {
    await clickTreeItem(name);
    return waitForViewerFile(name);
  };

  /** Put the current document into source view (idempotent per test). */
  const enterSourceView = async (frame: Frame): Promise<void> => {
    await evalJs(frame, `() => { document.getElementById('toggle-source-view-btn').click(); return true; }`);
    await waitFor(frame, `() => document.documentElement.dataset.codeView === '1'`, 10000);
    await waitFor(frame, `() => Boolean(document.querySelector('#markdown-content pre code[data-code-view-decorated="1"]'))`, 10000);
  };

  it('switches between two markdown files (same extension)', async () => {
    const alpha = await openFile('alpha.md');
    assertMarkdownState(alpha.state, 'Alpha doc', 'alpha.md');

    const bravo = await openFile('bravo.md');
    assertMarkdownState(bravo.state, 'Bravo doc', 'bravo.md');

    // …and back, so the switch is proven in both directions.
    const back = await openFile('alpha.md');
    assertMarkdownState(back.state, 'Alpha doc', 'alpha.md');
  });

  it('switches between two code files (same extension)', async () => {
    const notes = await openFile('notes.txt');
    assertCodeState(notes.state, 'plain text line 1', 'notes.txt');

    const script = await openFile('script.js');
    assertCodeState(script.state, 'const answer = 42;', 'script.js');

    const back = await openFile('notes.txt');
    assertCodeState(back.state, 'plain text line 1', 'notes.txt');
  });

  it('switches markdown → code file (cross extension)', async () => {
    const alpha = await openFile('alpha.md');
    assertMarkdownState(alpha.state, 'Alpha doc', 'alpha.md');

    const notes = await openFile('notes.txt');
    assertCodeState(notes.state, 'plain text line 1', 'notes.txt');

    const script = await openFile('script.js');
    assertCodeState(script.state, 'const answer = 42;', 'script.js');
  });

  it('switches code file → markdown (cross extension)', async () => {
    const notes = await openFile('notes.txt');
    assertCodeState(notes.state, 'plain text line 1', 'notes.txt');

    // The card chrome has to come back: measure, shadow, surface, TOC, toggles.
    const alpha = await openFile('alpha.md');
    assertMarkdownState(alpha.state, 'Alpha doc', 'alpha.md');

    const script = await openFile('script.js');
    assertCodeState(script.state, 'const answer = 42;', 'script.js');

    const bravo = await openFile('bravo.md');
    assertMarkdownState(bravo.state, 'Bravo doc', 'bravo.md');
  });

  it('leaves source view when switching to another markdown file (same extension)', async () => {
    const alpha = await openFile('alpha.md');
    await enterSourceView(alpha.frame);

    const bravo = await openFile('bravo.md');
    assertMarkdownState(bravo.state, 'Bravo doc', 'bravo.md');
  });

  it('leaves source view when switching to a code file (cross extension)', async () => {
    const bravo = await openFile('bravo.md');
    await enterSourceView(bravo.frame);

    const notes = await openFile('notes.txt');
    assertCodeState(notes.state, 'plain text line 1', 'notes.txt');

    const back = await openFile('bravo.md');
    assertMarkdownState(back.state, 'Bravo doc', 'bravo.md');
  });

  it('switches files inside a nested folder', async () => {
    const guide = await openFile('guide.md');
    assertMarkdownState(guide.state, 'Guide doc', 'guide.md');

    // …and back out of the folder to a root file.
    const notes = await openFile('notes.txt');
    assertCodeState(notes.state, 'plain text line 1', 'notes.txt');

    const again = await openFile('guide.md');
    assertMarkdownState(again.state, 'Guide doc', 'guide.md');
  });

  it('lets the last click win when files are switched quickly', async () => {
    // Two clicks inside the first render's window: the preview must end on the
    // second file (the earlier one's render must not land last).
    const alpha = await openFile('alpha.md');
    assertMarkdownState(alpha.state, 'Alpha doc', 'alpha.md');

    await evalJs(workspacePage, `() => {
      const items = Array.from(document.querySelectorAll('.tree-item'));
      const byName = (name) => items.find((el) => el.textContent.includes(name));
      byName('script.js').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }`);
    await workspacePage.waitForTimeout(80);
    await evalJs(workspacePage, `() => {
      const items = Array.from(document.querySelectorAll('.tree-item'));
      items.find((el) => el.textContent.includes('bravo.md')).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    }`);

    const frame = await previewFrame();
    await waitFor(frame, `() => document.documentElement.dataset.viewerFilename === 'bravo.md'`, 30000);
    await waitFor(frame, `() => (document.querySelector('#markdown-content h1')?.textContent || '') === 'Bravo doc'`, 30000);
    // Give the losing render time to land, then re-check that it did not.
    await workspacePage.waitForTimeout(1500);
    const state = await evalJs<ViewerState>(frame, READ_STATE_JS);
    assertMarkdownState(state, 'Bravo doc', 'bravo.md');
  });

  it('comes back to the viewer after an HTML preview', async () => {
    await clickTreeItem('page.html');
    // The HTML file is rendered by the sandbox page, i.e. by a *different*
    // document inside the same iframe.
    await waitForFrame(workspacePage, 'html-preview-sandbox', 30000);

    const notes = await openFile('notes.txt');
    assertCodeState(notes.state, 'plain text line 1', 'notes.txt');

    const alpha = await openFile('alpha.md');
    assertMarkdownState(alpha.state, 'Alpha doc', 'alpha.md');
  });

  it('lets a file clicked while an HTML preview is preparing win', async () => {
    // huge.html takes long enough to read + rewrite that the markdown click
    // lands in the middle of it: the preview must not switch the pane away
    // afterwards, and the next switch must still reach the viewer.
    await clickTreeItem('huge.html');
    await workspacePage.waitForTimeout(30);
    await clickTreeItem('alpha.md');

    const alpha = await waitForViewerFile('alpha.md');
    assertMarkdownState(alpha.state, 'Alpha doc', 'alpha.md');

    const notes = await openFile('notes.txt');
    assertCodeState(notes.state, 'plain text line 1', 'notes.txt');

    // No HTML preview may have taken the pane over in the meantime.
    await workspacePage.waitForTimeout(1000);
    const frameUrls = workspacePage.frames().map((candidate) => candidate.url());
    assert.ok(
      frameUrls.some((url) => url.includes('viewer-embed')),
      `the preview pane must still host the viewer (frames: ${frameUrls.join(', ')})`,
    );
    assert.ok(
      !frameUrls.some((url) => url.includes('html-preview-sandbox')),
      `no HTML preview may be left in the pane (frames: ${frameUrls.join(', ')})`,
    );
  });
});
