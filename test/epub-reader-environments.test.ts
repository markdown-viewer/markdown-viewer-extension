/**
 * EPUB reader environment matrix.
 *
 * Renders the REAL EPUB content pipeline (HTML export content root + the
 * collected EPUB stylesheet) inside a 500px reader-like container under
 * three reader environments and asserts the FULL style matrix on each one:
 *
 *   A. screen media            (Calibre-like readers)
 *   B. print media             (print-layout readers, e.g. Apple Books)
 *   C. print media + var()     (readers without custom properties)
 *      declarations stripped
 *
 * Every assertion mirrors the Web-preview baseline (browser-baseline.test.ts)
 * semantics: exact computed values (font-size / line-height / weight) plus
 * symmetry/zero-value geometry — no absolute pixels, fixed theme params.
 * If a reader environment drops any shared style, the corresponding fixture
 * assertion fails here.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
  type BrowserLayoutMeasurement,
  type EpubReaderEnvironment,
} from './helpers/browser-render-harness.ts';

const LAYOUT_DIR = path.resolve('test/fixtures/layout');

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  timeoutMs: 180_000,
} as const;

const CENTER = { tableLayout: 'center', imageLayout: 'center', diagramLayout: 'center' } as const;

const ENVIRONMENTS: Array<{ name: string; env: EpubReaderEnvironment }> = [
  { name: 'screen media', env: { media: 'screen', stripVar: false } },
  { name: 'print media', env: { media: 'print', stripVar: false } },
  { name: 'print media, no custom properties', env: { media: 'print', stripVar: true } },
];

function px(value: string): number {
  return parseFloat(value);
}

function firstOf(measurements: BrowserLayoutMeasurement[], selector: string) {
  const item = measurements.find((m) => m.selector === selector);
  assert.ok(item, `No measurement for selector "${selector}"`);
  assert.ok(item.elements.length > 0, `Selector "${selector}" matched no elements`);
  return item.elements[0];
}

describe('EPUB reader environment matrix (full style suite)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(LAYOUT_DIR, 'image-center.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  async function matrix(env: EpubReaderEnvironment, label: string) {
    const ctx = (name: string) => `[${label}] ${name}`;

    // --- images ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'image-center.md'), ['#markdown-content img'], env, { ...FIXED_PARAMS, ...CENTER });
      const img = firstOf(m, '#markdown-content img');
      assert.equal(img.display, 'block', ctx('centered image should be block'));
      assert.equal(img.marginLeft, img.marginRight, ctx('centered image needs symmetric margins'));
      assert.ok(px(img.marginLeft) > 0, ctx('centered image needs a positive centering margin'));
    }
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'image-left.md'), ['#markdown-content img'], env, { ...FIXED_PARAMS, ...CENTER, imageLayout: 'left' });
      const img = firstOf(m, '#markdown-content img');
      assert.equal(img.marginLeft, '0px', ctx('left image must have zero margin-left'));
      assert.equal(img.display, 'block', ctx('left image should be block'));
    }

    // --- diagrams ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'diagram-center.md'), ['.diagram-block'], env, { ...FIXED_PARAMS, ...CENTER });
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, block.marginRight, ctx('centered diagram needs symmetric margins'));
      assert.ok(px(block.marginLeft) > 0, ctx('centered diagram needs a positive centering margin'));
    }
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'diagram-left.md'), ['.diagram-block'], env, { ...FIXED_PARAMS, ...CENTER, diagramLayout: 'left' });
      const block = firstOf(m, '.diagram-block');
      assert.equal(block.marginLeft, '0px', ctx('left diagram must have zero margin-left'));
      assert.equal(block.textAlign, 'left', ctx('left diagram container should be text-align:left'));
    }

    // --- tables ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'table-center.md'), ['#markdown-content table'], env, { ...FIXED_PARAMS, ...CENTER });
      const table = firstOf(m, '#markdown-content table');
      assert.ok(Math.abs(px(table.marginLeft) - px(table.marginRight)) < 1, ctx('centered table margins symmetric within 1px'));
      assert.ok(px(table.marginLeft) > 0, ctx('centered table needs a positive centering margin'));
    }
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'table-left.md'), ['#markdown-content table'], env, { ...FIXED_PARAMS, ...CENTER, tableLayout: 'left' });
      const table = firstOf(m, '#markdown-content table');
      assert.equal(table.marginLeft, '0px', ctx('left table must have zero margin-left'));
    }
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'table-full.md'), ['#markdown-content table'], env, { ...FIXED_PARAMS, ...CENTER, tableLayout: 'center-full-width' });
      const table = firstOf(m, '#markdown-content table');
      assert.equal(table.display, 'table', ctx('full-width table should be a real table layout box'));
      // 500px reader page: the wide table must compress to the content width
      // (max-width: 100%), not overflow the page.
      assert.ok(table.width > 400 && table.width <= 500, ctx(`full-width table should span the reader width (got ${table.width}px)`));
    }
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'table-cells.md'), ['table th', 'table td'], env, { ...FIXED_PARAMS, ...CENTER });
      const th = firstOf(m, 'table th');
      const td = firstOf(m, 'table td');
      assert.equal(th.fontWeight, '700', ctx('table header should be bold'));
      assert.equal(td.fontWeight, '400', ctx('table body cells should be regular'));
      assert.notEqual(th.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('table header should have a background'));
      assert.ok(px(td.paddingTop) > 0 && px(td.paddingLeft) > 0, ctx('cells should keep padding'));
      assert.ok(px(td.borderTopWidth) > 0 && px(td.borderLeftWidth) > 0, ctx('cells should keep borders'));
    }

    // --- blockquote ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'blockquote-body.md'), ['blockquote'], env, { ...FIXED_PARAMS, ...CENTER });
      const quote = firstOf(m, 'blockquote');
      assert.ok(px(quote.borderLeftWidth) > 0, ctx('blockquote should keep a left border'));
      assert.ok(px(quote.paddingLeft) > 0, ctx('blockquote should keep left padding'));
      assert.notEqual(quote.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('blockquote should keep a themed background'));
    }

    // --- body typography ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'body-text.md'), ['#markdown-content p'], env, { ...FIXED_PARAMS, ...CENTER });
      const p = firstOf(m, '#markdown-content p');
      // 14pt body theme (db81b3c): 14pt = 18.6667px, line-height 1.5 = 28px.
      assert.equal(p.fontSize, '18.6667px', ctx('body font size should stay 18.6667px'));
      assert.equal(p.lineHeight, '28px', ctx('body line-height should stay 1.5 (28px)'));
      assert.equal(p.marginTop, '0px', ctx('body paragraph margin-top should stay 0'));
      assert.equal(p.marginBottom, '0px', ctx('body paragraph margin-bottom should stay 0'));
      assert.notEqual(p.color, 'rgba(0, 0, 0, 0)', ctx('body text color should be set'));
      assert.ok(p.fontFamily.includes('FangSong'), ctx('body font stack should keep FangSong first'));
    }

    // --- headings ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'headings.md'), ['#markdown-content h1', '#markdown-content h2'], env, { ...FIXED_PARAMS, ...CENTER });
      const h1 = firstOf(m, '#markdown-content h1');
      const h2 = firstOf(m, '#markdown-content h2');
      assert.ok(px(h1.marginTop) > 0 && px(h1.marginBottom) > 0, ctx('h1 should keep block spacing'));
      assert.ok(px(h2.marginTop) > 0 && px(h2.marginBottom) > 0, ctx('h2 should keep block spacing'));
      // 14pt body theme (db81b3c): h1 20pt = 26.6667px, h2 18pt = 24px.
      assert.equal(h1.fontSize, '26.6667px', ctx('h1 should stay 26.6667px'));
      assert.equal(h2.fontSize, '24px', ctx('h2 should stay 24px'));
      assert.equal(h1.textAlign, 'center', ctx('h1 should stay centered'));
    }

    // --- hr ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'hr.md'), ['hr'], env, { ...FIXED_PARAMS, ...CENTER });
      const hr = firstOf(m, 'hr');
      assert.ok(px(hr.marginTop) > 0 && px(hr.marginBottom) > 0, ctx('hr should keep vertical margins'));
      assert.notEqual(hr.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('hr should render a visible rule'));
    }

    // --- inline formatting ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'text-format.md'), ['strong', 'em', 'del', 'a', '#markdown-content code'], env, { ...FIXED_PARAMS, ...CENTER });
      assert.equal(firstOf(m, 'strong').fontWeight, '700', ctx('strong should render bold'));
      assert.equal(firstOf(m, 'em').fontStyle, 'italic', ctx('em should render italic'));
      assert.equal(firstOf(m, 'del').textDecorationLine, 'line-through', ctx('del should render struck through'));
      const link = firstOf(m, 'a');
      assert.notEqual(link.color, 'rgb(23, 23, 23)', ctx('links should use an accent color, not body color'));
      assert.equal(link.textDecorationLine, 'none', ctx('links should not be underlined'));
      const code = firstOf(m, '#markdown-content code');
      assert.notEqual(code.backgroundColor, 'rgba(0, 0, 0, 0)', ctx('inline code should have a background'));
      assert.ok(px(code.paddingLeft) > 0, ctx('inline code should keep horizontal padding'));
      assert.ok(px(code.fontSize) < 18.6667, ctx('inline code should be smaller than the 14pt body text'));
    }

    // --- lists ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'list.md'), ['ul', 'ol', 'ul li'], env, { ...FIXED_PARAMS, ...CENTER });
      assert.ok(px(firstOf(m, 'ul').paddingLeft) > 0, ctx('unordered list should keep indentation padding'));
      assert.ok(px(firstOf(m, 'ol').paddingLeft) > 0, ctx('ordered list should keep indentation padding'));
      const li = firstOf(m, 'ul li');
      assert.equal(li.fontSize, '18.6667px', ctx('list items should use the body font size'));
      assert.ok(px(li.marginBottom) > 0, ctx('list items should keep bottom spacing'));
    }

    // --- footnotes & math ---
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'footnotes.md'), ['section.footnotes', 'sup'], env, { ...FIXED_PARAMS, ...CENTER });
      const section = firstOf(m, 'section.footnotes');
      assert.ok(px(section.fontSize) > 0, ctx('footnotes section should have typography'));
      firstOf(m, 'sup');
    }
    {
      const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, 'math.md'), ['.katex-display', '.katex'], env, { ...FIXED_PARAMS, ...CENTER });
      const display = firstOf(m, '.katex-display');
      assert.ok(px(display.marginTop) > 0 && px(display.marginBottom) > 0, ctx('display math should keep block margins'));
      assert.equal(firstOf(m, '.katex').fontSize, '18.6667px', ctx('KaTeX should follow the body font size'));
    }
  }

  for (const { name, env } of ENVIRONMENTS) {
    it(`renders the full style matrix under ${name}`, async () => {
      await matrix(env, name);
    });
  }

  it('keeps typography and centering identical across all reader environments', async () => {
    const fixtures = [
      { fixture: 'body-text.md', selector: '#markdown-content p', fields: ['fontSize', 'lineHeight', 'marginTop', 'color'] as const },
      { fixture: 'table-center.md', selector: '#markdown-content table', fields: ['marginLeft', 'marginRight'] as const },
      { fixture: 'diagram-center.md', selector: '.diagram-block', fields: ['marginLeft', 'marginRight'] as const },
    ];
    for (const { fixture, selector, fields } of fixtures) {
      const values: Array<Record<string, string>> = [];
      for (const { env } of ENVIRONMENTS) {
        const m = await harness.measureEpubReader(path.join(LAYOUT_DIR, fixture), [selector], env, { ...FIXED_PARAMS, ...CENTER });
        const el = firstOf(m, selector);
        values.push(Object.fromEntries(fields.map((f) => [f, el[f]])) as Record<string, string>);
      }
      for (const field of fields) {
        assert.equal(
          values[1][field], values[0][field],
          `${fixture} ${field} must be identical between screen and print media`,
        );
        assert.equal(
          values[2][field], values[0][field],
          `${fixture} ${field} must survive var() stripping`,
        );
      }
    }
  });
});
