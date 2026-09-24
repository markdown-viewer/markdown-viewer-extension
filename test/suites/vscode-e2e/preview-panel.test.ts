/**
 * VS Code extension E2E: the preview panel, end to end.
 *
 * Loads the REAL built extension (dist/vscode) into the REAL installed VS Code
 * and asserts what a user sees: the contributed commands are available on a
 * Markdown file, the preview renders the fixture inside its webview, and
 * previewing a second document reuses the single panel instead of stacking
 * another one.
 *
 * The assertions deliberately mix the two layers that regress independently:
 *   - workbench layer (command palette, editor tab, panel title) — proves the
 *     host half (contributes + activation + panel lifecycle) is intact;
 *   - webview layer (rendered DOM, computed styles, image decoding) — proves
 *     the webview half, which no extension-host test can see.
 *
 * The three cases share one VS Code launch on purpose (a launch costs ~15s and
 * the panel lifecycle is the subject under test), so they must stay in order
 * within this describe block.
 *
 * Run: `npm run test:e2e:vscode` (needs `npm run build:vscode` first).
 * Skip: MV_SKIP_VSCODE_TESTS=1. Point at another build with
 * MV_VSCODE_EXECUTABLE=/path/to/Code.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  COMMANDS,
  CURSOR_BOTTOM_SHORTCUT,
  PREVIEW_TAB_LABELS_JS,
  captureWorkbench,
  closePalette,
  describePaletteState,
  evalJs,
  focusEditorTab,
  launchVSCode,
  openFileFromQuickOpen,
  paletteRowsFor,
  previewFile,
  resetWorkbench,
  runExtensionCommand,
  vscodeUnavailableReason,
  waitFor,
  waitForPreviewFrame,
  type VSCodeHarness,
} from '../../helpers/vscode-launch.ts';

const FIXTURE_DIR = path.resolve('test/fixtures/vscode');
const WORKSPACE = FIXTURE_DIR;

/** Body line-height ratio from the shared reading baseline (docs: 1.7). */
const BODY_LINE_HEIGHT = 1.7;

const PREVIEW_COMMAND = COMMANDS.preview.label;
const PREVIEW_SIDE_COMMAND = COMMANDS.previewToSide.label;

/** Text typed into the editor by the live-update case. */
const LIVE_EDIT_MARKER = 'LIVE-EDIT-UPDATE-MARKER';

/** Everything the fixture promises to render, read back from the live DOM. */
const MEASURE_JS = `() => {
  const content = document.getElementById('markdown-content');
  const paragraph = content?.querySelector('p');
  const image = content?.querySelector('img');
  const paragraphStyle = paragraph ? getComputedStyle(paragraph) : null;
  const ratio = paragraphStyle && paragraphStyle.fontSize
    ? parseFloat(paragraphStyle.lineHeight) / parseFloat(paragraphStyle.fontSize)
    : 0;
  return {
    paragraphs: content?.querySelectorAll('p').length || 0,
    headings: Array.from(content?.querySelectorAll('h1, h2, h3') || []).map((h) => h.textContent.trim()),
    tables: content?.querySelectorAll('table').length || 0,
    dataRows: content?.querySelectorAll('table tbody tr').length || 0,
    codeBlocks: content?.querySelectorAll('pre code').length || 0,
    codeText: content?.querySelector('pre code')?.textContent || '',
    listItems: content?.querySelectorAll('li').length || 0,
    blockquotes: content?.querySelectorAll('blockquote').length || 0,
    links: Array.from(content?.querySelectorAll('a') || []).map((a) => a.textContent.trim()),
    mathNodes: content?.querySelectorAll('.katex').length || 0,
    imageSrc: image?.getAttribute('src') || '',
    imageComplete: Boolean(image && image.complete && image.naturalWidth > 0),
    lineHeightRatio: Math.round(ratio * 100) / 100,
    fontSize: paragraphStyle?.fontSize || '',
    lineHeight: paragraphStyle?.lineHeight || '',
    themeCssLength: document.getElementById('theme-dynamic-style')?.textContent?.length || 0,
    styleSheetCount: document.styleSheets.length,
    themeStyleApplied: Boolean(document.getElementById('theme-dynamic-style')?.textContent),
  };
}`;

const PANEL_TITLE_JS = `() => document.querySelector('.tabs-container')?.textContent || ''`;

/** Shape of MEASURE_JS, so the assertions stay typed. */
interface PreviewMeasures {
  paragraphs: number;
  headings: string[];
  tables: number;
  dataRows: number;
  codeBlocks: number;
  codeText: string;
  listItems: number;
  blockquotes: number;
  links: string[];
  mathNodes: number;
  imageSrc: string;
  imageComplete: boolean;
  lineHeightRatio: number;
  fontSize: string;
  lineHeight: string;
  themeCssLength: number;
  styleSheetCount: number;
  themeStyleApplied: boolean;
}

const reason = vscodeUnavailableReason();

describe('VS Code extension: preview panel', { skip: reason ?? false }, () => {
  let harness: VSCodeHarness;

  before(async () => {
    harness = await launchVSCode({ workspaceFolder: WORKSPACE });
  });

  // Every case starts from the same clean window: no open editors, no preview
  // panel, one editor group. Cases also open what they need themselves, so this
  // only removes state coupling — it is not a substitute for setup.
  beforeEach(async () => {
    await resetWorkbench(harness.page);
  });

  after(async () => {
    await captureWorkbench(harness.page, 'vscode-preview-panel').catch(() => undefined);
    await harness.close();
  });

  it('contributes both preview commands for a Markdown file', async () => {
    const { page } = harness;

    await openFileFromQuickOpen(page, 'smoke.md');

    // Both commands come from the same contribution point, and the read waits
    // for both labels to be offered. The query is the command ID: a label query
    // reorders under "recently used".
    const labels = await paletteRowsFor(page, COMMANDS.preview.id, {
      expect: (rows) =>
        rows.some((row) => row.includes(PREVIEW_COMMAND) && !row.includes('to the Side')) &&
        rows.some((row) => row.includes(PREVIEW_SIDE_COMMAND)),
      timeoutMs: 20000,
    });

    assert.ok(
      labels.some((label) => label.includes(PREVIEW_COMMAND) && !label.includes('to the Side')),
      `palette is missing "${PREVIEW_COMMAND}" (got: ${JSON.stringify(labels)})`,
    );
    assert.ok(
      labels.some((label) => label.includes(PREVIEW_SIDE_COMMAND)),
      `palette is missing "${PREVIEW_SIDE_COMMAND}" (got: ${JSON.stringify(labels)})` +
        ` | palette state: ${await describePaletteState(page)}`,
    );

    await closePalette(page);
  });

  it('renders the fixture inside the webview panel', async () => {
    const { page } = harness;

    await openFileFromQuickOpen(page, 'smoke.md');
    await runExtensionCommand(page, 'preview');

    // The viewer boots, then the markdown pass lands, then the fixture image
    // decodes — wait for the whole chain before measuring.
    const frame = await waitForPreviewFrame(page, `() => {
      const content = document.getElementById('markdown-content');
      const image = content?.querySelector('img');
      return Boolean(content && content.children.length > 0 && image && image.complete && image.naturalWidth > 0);
    }`);

    const measures = await evalJs<PreviewMeasures>(frame, MEASURE_JS);

    assert.equal(measures.headings[0], 'VS Code Preview Smoke', 'first heading');
    assert.ok(measures.paragraphs >= 3, `paragraph count: ${measures.paragraphs}`);
    assert.equal(measures.tables, 1, 'table count');
    assert.equal(measures.dataRows, 4, 'table body rows');
    assert.equal(measures.codeBlocks, 1, 'code block count');
    assert.match(measures.codeText, /const answer = 42;/, 'code block content');
    assert.equal(measures.blockquotes, 1, 'blockquote count');
    assert.ok(measures.listItems >= 3, `list item count: ${measures.listItems}`);
    assert.ok(measures.links.includes('sibling link'), `link text: ${JSON.stringify(measures.links)}`);
    assert.ok(measures.mathNodes >= 1, 'inline math rendered as KaTeX');
    assert.equal(measures.imageComplete, true, `fixture image decoded (src: ${measures.imageSrc})`);
    assert.ok(
      /^(https|vscode-)/.test(measures.imageSrc) && !measures.imageSrc.startsWith('file:'),
      `image src is rewritten through the webview resource scheme (got: ${measures.imageSrc})`,
    );

    // Stylesheet contract: the shared content stylesheet must be live in the
    // panel, not just linked — a silently dropped stylesheet is invisible to
    // every non-visual assertion (the Chrome suite exists because of exactly
    // this class of bug).
    assert.equal(
      measures.lineHeightRatio,
      BODY_LINE_HEIGHT,
      `body line-height ratio (font-size ${measures.fontSize}, line-height ${measures.lineHeight},` +
        ` theme css ${measures.themeCssLength} chars)`,
    );
    assert.ok(measures.styleSheetCount >= 4, `stylesheet count: ${measures.styleSheetCount}`);
    assert.equal(measures.themeStyleApplied, true, 'theme CSS injected by the webview bundle');

    // Workbench layer: the panel title is the document basename contract.
    await waitFor(page, `() => (${PANEL_TITLE_JS})().includes('Preview: smoke.md')`, 20000);
    assert.deepEqual(
      await evalJs<string[]>(page, PREVIEW_TAB_LABELS_JS),
      ['Preview: smoke.md'],
      'exactly one preview tab is open',
    );
  });

  it('reuses the single preview panel when another document is previewed', async () => {
    const { page } = harness;

    await previewFile(page, 'smoke.md');
    await openFileFromQuickOpen(page, 'second.md');
    await runExtensionCommand(page, 'preview');
    // The frame identity may or may not survive the content swap, so wait for
    // the output rather than for a specific frame object.
    const frame = await waitForPreviewFrame(
      page,
      `() => (document.getElementById('markdown-content')?.textContent || '')
        .includes('REUSED-PANEL-MARKER')`,
    );

    assert.deepEqual(
      await evalJs<string[]>(page, PREVIEW_TAB_LABELS_JS),
      ['Preview: second.md'],
      'the existing preview tab was retitled instead of a second one being opened',
    );
    await waitFor(page, `() => (${PANEL_TITLE_JS})().includes('Preview: second.md')`, 20000);
    await waitFor(page, `() => !(${PANEL_TITLE_JS})().includes('Preview: smoke.md')`, 20000);

    const headings = await evalJs<string[]>(
      frame,
      `() => Array.from(document.querySelectorAll('#markdown-content h1, #markdown-content h2'))
        .map((h) => h.textContent.trim())`,
    );
    assert.equal(headings[0], 'Second Document', 'panel now renders the second document');
  });

  it('follows the editor buffer without a save', async () => {
    const { page } = harness;

    // Quick open is the reliable way to bring the source editor back: while the
    // panel tab is active the editor is unmounted, so there is no text area to
    // click. The panel stays alive as the hidden tab (retainContextWhenHidden),
    // which is exactly the situation under test.
    await previewFile(page, 'second.md');
    await openFileFromQuickOpen(page, 'second.md');
    await waitFor(
      page,
      `() => (document.querySelector('.tabs-container .tab.active')?.textContent || '').includes('second.md')`,
      20000,
    );

    // Checkpoint 1: the source editor is active AND focused. Quick open brings
    // the tab forward but leaves focus on the webview panel, so the tab itself
    // is clicked — the step a user takes before typing. The tab match is exact:
    // a substring match would hit `Preview: second.md` and send the keystrokes
    // into the panel instead.
    await focusEditorTab(page, 'second.md');
    await page.keyboard.press(CURSOR_BOTTOM_SHORTCUT);
    await page.keyboard.press('Enter');
    await page.keyboard.type(`\n${LIVE_EDIT_MARKER}`);

    // Checkpoint 2: an unsaved change shows up as a dirty tab. Without this,
    // a stalled preview could be blamed for keystrokes that never reached the
    // editor at all.
    await waitFor(
      page,
      `() => Boolean(document.querySelector('.tabs-container .tab.dirty'))`,
      10000,
    ).catch(async (error: Error) => {
      throw new Error(
        `the editor never became dirty, so the keys did not reach it (${error.message})`,
      );
    });

    // Checkpoint 3: show the preview again, the way a writer does after
    // editing, and the rendered output must have followed the unsaved buffer —
    // no save, no re-open, no manual refresh.
    await page
      .locator('.tabs-container .tab', { hasText: 'Preview: second.md' })
      .first()
      .click();
    await waitForPreviewFrame(
      page,
      `() => (document.getElementById('markdown-content')?.textContent || '')
        .includes(${JSON.stringify(LIVE_EDIT_MARKER)})`,
      30000,
    );
  });
});