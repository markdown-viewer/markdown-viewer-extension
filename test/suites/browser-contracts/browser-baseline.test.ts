/**
 * Baseline suite: fixed-theme layout & style measurements.
 *
 * Every baseline renders with an EXPLICIT theme ('default') and explicit
 * layout parameters — no user settings, no theme drift. The assertions are
 * semantic (centered == symmetric margins, left == zero margin-left) plus
 * fixed-theme style expectations (font size / line-height / blockquote
 * chrome), so a CSS refactor can re-run this suite to prove the rendered
 * result did not move.
 *
 * Fixtures live in test/fixtures/layout/*.md — each one targets a single
 * expected layout (image / diagram / table / blockquote / typography).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
  type BrowserLayoutMeasurement,
} from '../../helpers/browser-render-harness.ts';

const LAYOUT_DIR = path.resolve('test/fixtures/layout');

/**
 * Fixed render parameters. Every baseline must pass these explicitly so the
 * expected values stay stable regardless of user theme/settings.
 */
const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  timeoutMs: 120_000,
} as const;

const CENTER = { tableLayout: 'center', imageLayout: 'center', diagramLayout: 'center' } as const;

function px(value: string): number {
  return parseFloat(value);
}

function firstOf(measurements: BrowserLayoutMeasurement[], selector: string) {
  const item = measurements.find((m) => m.selector === selector);
  assert.ok(item, `No measurement for selector "${selector}"`);
  assert.ok(item.elements.length > 0, `Selector "${selector}" matched no elements`);
  return item.elements[0];
}

function maxFontSize(measurements: BrowserLayoutMeasurement[], selector: string): number {
  const item = measurements.find((m) => m.selector === selector);
  assert.ok(item, `No measurement for selector "${selector}"`);
  assert.ok(item.elements.length > 0, `Selector "${selector}" matched no elements`);
  return Math.max(...item.elements.map((el) => px(el.fontSize)));
}

describe('Baseline: fixed theme "default"', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(LAYOUT_DIR, 'image-center.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  // ==========================================================================
  // Image layout
  // ==========================================================================

  describe('image layout', () => {
    it('imageLayout=center centers an image-only paragraph (symmetric margins, block)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'image-center.md'),
        ['#markdown-content p', '#markdown-content img'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const img = firstOf(m, '#markdown-content img');
      assert.equal(img.display, 'block', 'Centered image should be a block element');
      assert.equal(img.marginLeft, img.marginRight, 'Centered image needs symmetric margins');
      assert.ok(px(img.marginLeft) > 0, 'Centered image needs a positive centering margin');
    });

    it('imageLayout=left left-aligns an image-only paragraph (zero margin-left)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'image-left.md'),
        ['#markdown-content p', '#markdown-content img'],
        { ...FIXED_PARAMS, ...CENTER, imageLayout: 'left' },
      );
      const img = firstOf(m, '#markdown-content img');
      assert.equal(img.marginLeft, '0px', 'Left-aligned image must not have a centering margin');
      // Target behavior (baseline observation #5): standalone images are
      // block-level in BOTH layout modes; only the centering margin differs.
      assert.equal(img.display, 'block', 'Left-aligned image should be a block element');
    });

    it('imageLayout=center vs left produce different image positions', async () => {
      const center = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'image-center.md'),
        ['#markdown-content img'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const left = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'image-left.md'),
        ['#markdown-content img'],
        { ...FIXED_PARAMS, ...CENTER, imageLayout: 'left' },
      );
      const centerImg = firstOf(center, '#markdown-content img');
      const leftImg = firstOf(left, '#markdown-content img');
      assert.ok(centerImg.left > leftImg.left, 'Centered image must sit further right than a left-aligned one');
    });
  });

  // ==========================================================================
  // Diagram layout
  // ==========================================================================

  describe('diagram layout', () => {
    it('diagramLayout=center centers .diagram-block (symmetric margins)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'diagram-center.md'),
        ['.diagram-block'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, block.marginRight, 'Centered diagram needs symmetric margins');
      assert.ok(px(block.marginLeft) > 0, 'Centered diagram needs a positive centering margin');
    });

    it('diagramLayout=left left-aligns .diagram-block (zero margin-left)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'diagram-left.md'),
        ['.diagram-block'],
        { ...FIXED_PARAMS, ...CENTER, diagramLayout: 'left' },
      );
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, '0px', 'Left-aligned diagram must not have a centering margin');
      assert.equal(block.textAlign, 'left', 'Left-aligned diagram container should be text-align:left');
    });
  });

  // ==========================================================================
  // Table layout
  // ==========================================================================

  describe('table layout', () => {
    it('tableLayout=center centers the table (symmetric margins, within 1px)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'table-center.md'),
        ['#markdown-content table'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const table = firstOf(m, '#markdown-content table');
      assert.ok(Math.abs(px(table.marginLeft) - px(table.marginRight)) < 1,
        'Centered table margins should be symmetric within 1px');
      assert.ok(px(table.marginLeft) > 0, 'Centered table needs a positive centering margin');
    });

    it('tableLayout=left left-aligns the table (zero margin-left)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'table-left.md'),
        ['#markdown-content table'],
        { ...FIXED_PARAMS, ...CENTER, tableLayout: 'left' },
      );
      const table = firstOf(m, '#markdown-content table');
      assert.equal(table.marginLeft, '0px', 'Left-aligned table must not have a centering margin');
    });

    it('tableLayout=center-full-width stretches the table to the content width', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'table-full.md'),
        ['#markdown-content table'],
        { ...FIXED_PARAMS, ...CENTER, tableLayout: 'center-full-width' },
      );
      const table = firstOf(m, '#markdown-content table');
      assert.equal(table.display, 'table', 'Full-width table should be a real table layout box');
      assert.ok(table.width > 800, `Full-width table should span the content width (got ${table.width}px)`);
      assert.equal(table.marginLeft, '0px', 'Full-width table must not have centering margins');
    });
  });

  // ==========================================================================
  // Blockquote
  // ==========================================================================

  describe('blockquote styling (default theme)', () => {
    it('blockquote keeps left border, padding and background', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'blockquote-body.md'),
        ['blockquote'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const quote = firstOf(m, 'blockquote');
      assert.ok(px(quote.borderLeftWidth) > 0, 'Blockquote should keep a left border');
      assert.ok(px(quote.paddingLeft) > 0, 'Blockquote should keep left padding');
      assert.notEqual(quote.backgroundColor, 'rgba(0, 0, 0, 0)',
        'Blockquote should keep a themed background');
    });
  });

  // ==========================================================================
  // Block spacing & typography (default theme)
  // ==========================================================================

  describe('block spacing (default theme)', () => {
    it('paragraphs keep their theme margins and color', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'body-text.md'),
        ['#markdown-content p'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const paragraph = firstOf(m, '#markdown-content p');
      // Default theme drives paragraph spacing through line-height (margin 0);
      // a refactor that silently changes either dimension fails here.
      // 14pt body (db81b3c): 14pt = 18.6667px, line-height 1.5 = 28px.
      assert.equal(paragraph.fontSize, '18.6667px');
      assert.equal(paragraph.lineHeight, '28px');
      assert.equal(paragraph.marginTop, '0px');
      assert.equal(paragraph.marginBottom, '0px');
      assert.notEqual(paragraph.color, 'rgba(0, 0, 0, 0)', 'Body text color should be set');
    });

    it('headings keep positive spacing and the h1/h2 size steps', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'headings.md'),
        ['#markdown-content h1', '#markdown-content h2'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const h1 = firstOf(m, '#markdown-content h1');
      const h2 = firstOf(m, '#markdown-content h2');
      assert.ok(px(h1.marginTop) > 0 && px(h1.marginBottom) > 0, 'h1 should keep block spacing');
      assert.ok(px(h2.marginTop) > 0 && px(h2.marginBottom) > 0, 'h2 should keep block spacing');
      // 14pt body theme (db81b3c): h1 20pt = 26.6667px, h2 18pt = 24px.
      assert.equal(h1.fontSize, '26.6667px', 'Default theme h1 should stay 26.6667px');
      assert.equal(h2.fontSize, '24px', 'Default theme h2 should stay 24px');
    });

    it('hr keeps vertical margins and a visible rule color', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'hr.md'),
        ['hr'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const hr = firstOf(m, 'hr');
      assert.ok(px(hr.marginTop) > 0 && px(hr.marginBottom) > 0, 'hr should keep vertical margins');
      assert.notEqual(hr.backgroundColor, 'rgba(0, 0, 0, 0)', 'hr should render a visible rule');
    });
  });

  // ==========================================================================
  // Inline formatting
  // ==========================================================================

  describe('inline formatting (default theme)', () => {
    it('strong is bold, em is italic, del is struck through', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'text-format.md'),
        ['strong', 'em', 'del', 'a', '#markdown-content code'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const strong = firstOf(m, 'strong');
      assert.equal(strong.fontWeight, '700', 'strong should render bold');
      const em = firstOf(m, 'em');
      assert.equal(em.fontStyle, 'italic', 'em should render italic');
      const del = firstOf(m, 'del');
      assert.equal(del.textDecorationLine, 'line-through', 'del should render struck through');
    });

    it('links keep the theme accent color without underline', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'text-format.md'),
        ['a'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const link = firstOf(m, 'a');
      assert.notEqual(link.color, 'rgb(23, 23, 23)', 'Links should use an accent color, not body color');
      assert.equal(link.textDecorationLine, 'none', 'Links should not be underlined');
    });

    it('inline code keeps a background, padding and smaller size', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'text-format.md'),
        ['#markdown-content code'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const code = firstOf(m, '#markdown-content code');
      assert.notEqual(code.backgroundColor, 'rgba(0, 0, 0, 0)', 'Inline code should have a background');
      assert.ok(px(code.paddingLeft) > 0, 'Inline code should keep horizontal padding');
      assert.ok(px(code.fontSize) < 16, 'Inline code should be smaller than body text');
    });
  });

  // ==========================================================================
  // Table cells
  // ==========================================================================

  describe('table cells (default theme)', () => {
    it('header cells are bold with a background; body cells are not', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'table-cells.md'),
        ['table th', 'table td'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const th = firstOf(m, 'table th');
      const td = firstOf(m, 'table td');
      assert.equal(th.fontWeight, '700', 'Table header should be bold');
      assert.equal(td.fontWeight, '400', 'Table body cells should be regular');
      assert.notEqual(th.backgroundColor, 'rgba(0, 0, 0, 0)', 'Table header should have a background');
    });

    it('cells keep padding and borders', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'table-cells.md'),
        ['table td'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const td = firstOf(m, 'table td');
      assert.ok(px(td.paddingTop) > 0 && px(td.paddingLeft) > 0, 'Cells should keep padding');
      assert.ok(px(td.borderTopWidth) > 0 && px(td.borderLeftWidth) > 0, 'Cells should keep borders');
    });
  });

  // ==========================================================================
  // Lists
  // ==========================================================================

  describe('lists (default theme)', () => {
    it('list containers keep indentation padding', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'list.md'),
        ['ul', 'ol'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const ul = firstOf(m, 'ul');
      const ol = firstOf(m, 'ol');
      assert.ok(px(ul.paddingLeft) > 0, 'Unordered list should keep indentation padding');
      assert.ok(px(ol.paddingLeft) > 0, 'Ordered list should keep indentation padding');
    });

    it('list items keep item spacing and body typography', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'list.md'),
        ['ul li', 'ol li'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const ulItem = firstOf(m, 'ul li');
      const olItem = firstOf(m, 'ol li');
      assert.ok(px(ulItem.marginBottom) > 0, 'List items should keep bottom spacing');
      // 14pt body theme (db81b3c): 14pt = 18.6667px.
      assert.equal(ulItem.fontSize, '18.6667px', 'List items should use the body font size');
      assert.equal(olItem.fontSize, '18.6667px');
    });
  });

  // ==========================================================================
  // First-line indent
  // ==========================================================================

  describe('code blocks (default theme)', () => {
    it('code blocks keep padding, monospace font and a background', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'code-block.md'),
        ['#markdown-content pre'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const pre = firstOf(m, '#markdown-content pre');
      assert.ok(px(pre.paddingTop) > 0 && px(pre.paddingLeft) > 0, 'pre should keep padding');
      assert.ok(
        pre.fontFamily.includes('Monaco') || pre.fontFamily.includes('monospace'),
        'pre should use a monospace font',
      );
      assert.notEqual(pre.backgroundColor, 'rgba(0, 0, 0, 0)', 'pre should have a background');
    });

    it('code blocks are not scroll containers (pagination-compatible overflow)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'code-block.md'),
        ['#markdown-content pre'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const pre = firstOf(m, '#markdown-content pre');
      // overflow: auto on <pre> makes EPUB readers (e.g. Apple Books) treat
      // the block as a scroll container: when the block spans a page break,
      // the overflowed content is clipped instead of flowing to the next
      // page, so the second page shows an empty code block.
      assert.equal(pre.overflowX, 'visible', 'pre must not clip content horizontally across pages');
      assert.equal(pre.overflowY, 'visible', 'pre must not clip content vertically across pages');
    });
  });

  // ==========================================================================
  // First-line indent
  // ==========================================================================

  describe('first-line indent (default theme)', () => {
    it('applies firstLineIndent=2 as a plain 2em text-indent (no each-line)', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'body-text.md'),
        ['#markdown-content p'],
        { ...FIXED_PARAMS, ...CENTER, firstLineIndent: 2 },
      );
      const paragraph = firstOf(m, '#markdown-content p');
      // Plain text-indent only: the each-line keyword is not EPUB-compatible.
      // 2em of the 14pt (18.6667px) body = 37.3333px.
      assert.equal(paragraph.textIndent, '37.3333px', 'First-line indent should be a plain 2em (37.3333px) text-indent');
    });

    it('keeps no text-indent when firstLineIndent is 0', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'body-text.md'),
        ['#markdown-content p'],
        { ...FIXED_PARAMS, ...CENTER, firstLineIndent: 0 },
      );
      const paragraph = firstOf(m, '#markdown-content p');
      assert.equal(paragraph.textIndent, '0px', 'Disabled indent should leave text-indent at 0');
    });
  });

  // ==========================================================================
  // Footnotes & math
  // ==========================================================================

  describe('footnotes & math (default theme)', () => {    it('footnote definitions render as a footnotes section', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'footnotes.md'),
        ['section.footnotes', 'sup'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      // NOTE (baseline observation): footnote references render as
      // sup.footnote-ref elements produced by the footnote postprocessor
      // (src/core/footnote-postprocessor.ts), not by the remark pipeline.
      // firstOf() already asserts both selectors match; asserting the section
      // typography here keeps the baseline stable across pipeline changes.
      const section = firstOf(m, 'section.footnotes');
      assert.ok(px(section.fontSize) > 0, 'Footnotes section should have typography');
      firstOf(m, 'sup');
    });

    it('display math keeps block margins and KaTeX sizing', async () => {
      const m = await harness.measureLayout(
        path.join(LAYOUT_DIR, 'math.md'),
        ['.katex-display', '.katex'],
        { ...FIXED_PARAMS, ...CENTER },
      );
      const display = firstOf(m, '.katex-display');
      assert.ok(px(display.marginTop) > 0 && px(display.marginBottom) > 0,
        'Display math should keep block margins');
      const inline = firstOf(m, '.katex');
      // 14pt body theme (db81b3c): KaTeX follows the body font size.
      assert.equal(inline.fontSize, '18.6667px', 'KaTeX should follow the body font size');
    });
  });
});
