/**
 * Code view (source view + code/text files) — frame geometry and toolbar state.
 *
 * Two regressions are pinned here:
 *
 *   1. **One frame, not two.** In code view the code block *is* the document,
 *      so the page card (theme page colour + paper shadow + 48px gutter) only
 *      painted a second frame around it. Code view now drops the card chrome
 *      *and* the reading measure (a line-length cap is a prose rule), i.e. the
 *      code surface is full-bleed — which is why the layout (width) control
 *      hides while code view is active.
 *   2. **The source toggle follows the file.** Workspace mode reuses one toolbar
 *      across files; the button used to be decided when the toolbar was built,
 *      so opening any non-markdown file first left every later `.md` without a
 *      source toggle. The icon/title also used to stay stale after clicking
 *      (the mode switch is async).
 *
 * It also pins the reading measure end to end (820px card), the number the
 * toolbar writes inline and test/suites/project-gates/reading-measure.test.ts
 * guards against drift.
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { type Page } from 'playwright-core';

import {
  FIXED_SETTINGS,
  MOCK_DIRECTORY_PICKER_JS,
  SET_STORAGE_JS,
  VIEWER_EMBED_READY_JS,
  WAIT_RENDERED_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  waitFor,
  type E2ETarget,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

/** Reading measure owned by READING_MAX_WIDTH_PX (src/ui/layout-presets.ts). */
const READING_MAX_WIDTH = 820;

const TEXT_LINES = [
  'plain text line 1',
  'plain text line 2',
  'plain text line 3',
  'plain text line 4',
];

const MARKDOWN_BODY = '# Standalone doc\n\nBody text.\n';

/** Code view is decorated once the block has been split into lines. */
const CODE_VIEW_READY_JS = `() => Boolean(document.querySelector('#markdown-content pre code[data-code-view-decorated="1"]'))`;

/**
 * Click the source toggle and wait for the mode to actually change.
 *
 * Deliberately not wrapped in a retry: a click used to be swallowed while the
 * initial render was still streaming (the best-effort scroll-anchor report
 * rejected and aborted the toggle chain before it switched the mode), and this
 * assertion is what pins that fix — a retry would hide the regression again.
 */
async function toggleSourceView(target: E2ETarget): Promise<void> {
  await evalJs(target, `() => { document.getElementById('toggle-source-view-btn').click(); return true; }`);
  await waitFor(target, `() => document.documentElement.dataset.codeView === '1'`, 10000);
  await waitFor(target, CODE_VIEW_READY_JS);
}

/** The toolbar's per-document state, as the user sees it. */
const TOOLBAR_STATE_JS = `() => {
  const visible = (id) => {
    const el = document.getElementById(id);
    return Boolean(el) && getComputedStyle(el).display !== 'none';
  };
  const sourceBtn = document.getElementById('toggle-source-view-btn');
  const card = document.getElementById('markdown-page');
  return {
    sourceToggleVisible: visible('toggle-source-view-btn'),
    sourceToggleTitle: sourceBtn ? sourceBtn.title : null,
    layoutVisible: visible('layout-toggle-btn'),
    cardWidth: card ? Math.round(card.getBoundingClientRect().width) : null,
    codeView: document.documentElement.dataset.codeView,
  };
}`;

describe('installed Chrome extension — code view frame & source toggle', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let workspacePage: Page;
  let fixtureDir = '';

  const fileUrl = (name: string) => pathToFileURL(path.join(fixtureDir, name)).href;

  before(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-code-view-'));
    fs.writeFileSync(path.join(fixtureDir, 'notes.txt'), `${TEXT_LINES.join('\n')}\n`, 'utf8');
    fs.writeFileSync(path.join(fixtureDir, 'doc.md'), MARKDOWN_BODY, 'utf8');

    harness = await launchExtensionContext('mv-code-view-');
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

    // Workspace page: a .txt and a .md behind the mocked directory picker.
    workspacePage = await harness.context.newPage();
    await workspacePage.addInitScript(
      `(${MOCK_DIRECTORY_PICKER_JS})(${JSON.stringify({ 'notes.txt': TEXT_LINES.join('\n'), 'README.md': MARKDOWN_BODY })})`,
    );
    await workspacePage.goto(
      `chrome-extension://${harness.extensionId}/ui/workspace/workspace.html`,
      { waitUntil: 'load' },
    );
  });

  after(async () => {
    await harness?.close();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('renders a text file as one full-bleed code surface (no page card)', async () => {
    await page.goto(fileUrl('notes.txt'), { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, CODE_VIEW_READY_JS);

    const report = await evalJs<{
      codeView: string | undefined;
      cardBackground: string;
      cardShadow: string;
      cardPadding: string;
      codeBackground: string;
      codeX: number;
      codeWidth: number;
      viewportWidth: number;
      lineCount: number;
    }>(page, `() => {
      const card = document.getElementById('markdown-page');
      const code = document.querySelector('#markdown-content pre');
      const cardStyle = getComputedStyle(card);
      const codeRect = code.getBoundingClientRect();
      return {
        codeView: document.documentElement.dataset.codeView,
        cardBackground: cardStyle.backgroundColor,
        cardShadow: cardStyle.boxShadow,
        cardPadding: cardStyle.padding,
        codeBackground: getComputedStyle(code).backgroundColor,
        codeX: Math.round(codeRect.x),
        codeWidth: Math.round(codeRect.width),
        viewportWidth: window.innerWidth,
        lineCount: document.querySelectorAll('#markdown-content .mv-code-line-content').length,
      };
    }`);

    assert.equal(report.codeView, '1', 'expected the code-view presentation');
    assert.equal(report.lineCount, TEXT_LINES.length, 'every line must keep its own code line');

    // Single frame: the card is gone, the code surface is the page.
    assert.equal(report.cardShadow, 'none', 'the page card must not paint a paper shadow');
    assert.equal(report.cardBackground, 'rgba(0, 0, 0, 0)', 'the page card must be transparent');
    assert.equal(report.cardPadding, '0px', 'the page card must not inset the code surface');
    assert.equal(report.codeX, 0, 'the code surface starts at the window edge');
    assert.equal(report.codeWidth, report.viewportWidth, 'the code surface is full-bleed');
    // The theme's code surface survives — it *is* the frame now.
    assert.notEqual(report.codeBackground, 'rgba(0, 0, 0, 0)', 'the code surface must keep its theme colour');
  });

  it('keeps the reading measure for markdown and toggles to source view', async () => {
    await page.goto(fileUrl('doc.md'), { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);

    const rendered = await evalJs<{
      cardWidth: number | null;
      sourceToggleVisible: boolean;
      sourceToggleTitle: string | null;
      layoutVisible: boolean;
      codeView: string | undefined;
    }>(page, TOOLBAR_STATE_JS);

    assert.equal(rendered.cardWidth, READING_MAX_WIDTH, 'markdown keeps the reading measure');
    assert.equal(rendered.layoutVisible, true, 'the width control is available while reading');
    assert.equal(rendered.sourceToggleVisible, true, 'markdown offers the source toggle');
    assert.equal(rendered.sourceToggleTitle, 'Source Mode');
    assert.equal(rendered.codeView, undefined);

    await toggleSourceView(page);

    const source = await evalJs<{
      sourceToggleTitle: string | null;
      layoutVisible: boolean;
      hasSourceText: boolean;
      codeWidth: number;
      viewportWidth: number;
    }>(page, `() => {
      const state = (${TOOLBAR_STATE_JS})();
      return {
        ...state,
        hasSourceText: (document.querySelector('#markdown-content pre code')?.textContent || '').includes('# Standalone doc'),
        codeWidth: Math.round(document.querySelector('#markdown-content pre').getBoundingClientRect().width),
        viewportWidth: window.innerWidth,
      };
    }`);

    assert.equal(source.hasSourceText, true, 'source view shows the raw markdown');
    assert.equal(source.sourceToggleTitle, 'Preview Mode', 'the toggle must flip once source view is active');
    assert.equal(source.layoutVisible, false, 'the width control hides in the full-bleed code view');
    assert.equal(source.codeWidth, source.viewportWidth, 'source view is full-bleed like any code view');
  });

  it('offers the source toggle per file in workspace mode', async () => {
    await evalJs(workspacePage, `() => { document.querySelector('#pick-directory').click(); return true; }`);
    await workspacePage.waitForSelector('.tree-item', { timeout: 30000 });

    const openFile = async (name: string) => {
      await evalJs(workspacePage, `() => {
        const item = Array.from(document.querySelectorAll('.tree-item')).find((el) => el.textContent.includes(${JSON.stringify(name)}));
        if (!item) return false;
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }`);

      let frame = null;
      for (let attempt = 0; attempt < 60 && !frame; attempt += 1) {
        await workspacePage.waitForTimeout(250);
        frame = workspacePage.frames().find((candidate) => candidate.url().includes('viewer-embed')) ?? null;
      }
      assert.ok(frame, 'workspace preview iframe not found');
      await waitFor(frame, `() => document.documentElement.dataset.viewerFilename === ${JSON.stringify(name)}`, 30000);
      // The workspace viewer is an extension page (styles come from the
      // stylesheet link), so it never grows the content-script style element
      // WAIT_STANDALONE_READY_JS looks for.
      await waitFor(frame, WAIT_RENDERED_JS);
      return frame;
    };

    // A text file first: that is what used to freeze the toggle as "missing"
    // for the rest of the session.
    const txtFrame = await openFile('notes.txt');
    const txtState = await evalJs<{ sourceToggleVisible: boolean; codeView: string | undefined }>(txtFrame, TOOLBAR_STATE_JS);
    assert.equal(txtState.codeView, '1', 'the .txt renders as a code surface');
    assert.equal(txtState.sourceToggleVisible, false, 'a code file has no source toggle');

    const mdFrame = await openFile('README.md');
    const mdState = await evalJs<{ sourceToggleVisible: boolean; sourceToggleTitle: string | null; codeView: string | undefined }>(
      mdFrame,
      TOOLBAR_STATE_JS,
    );
    assert.equal(mdState.codeView, undefined, 'the .md renders as markdown');
    assert.equal(mdState.sourceToggleVisible, true, 'the .md must offer the source toggle after a non-markdown file');
    assert.equal(mdState.sourceToggleTitle, 'Source Mode');

    await toggleSourceView(mdFrame);

    const toggled = await evalJs<{ sourceToggleTitle: string | null; hasSourceText: boolean }>(mdFrame, `() => {
      const state = (${TOOLBAR_STATE_JS})();
      return {
        ...state,
        hasSourceText: (document.querySelector('#markdown-content pre code')?.textContent || '').includes('# Standalone doc'),
      };
    }`);
    assert.equal(toggled.hasSourceText, true, 'workspace source view shows the raw markdown');
    assert.equal(toggled.sourceToggleTitle, 'Preview Mode', 'the workspace toggle flips to preview as well');
  });
});
