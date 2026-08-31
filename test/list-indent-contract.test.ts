/**
 * List indentation contract tests (E2E).
 *
 * Verifies the per-level indentation step of nested lists stays CONSTANT
 * (~2em per level, matching GitHub / VS Code markdown conventions) across
 * every rendering surface:
 *  1. live web preview        (measureLayout  → getBoundingClientRect)
 *  2. exported standalone HTML(measureHtmlLayout → single CSS source)
 *  3. DOCX export             (renderDocx → numbering.xml w:ind steps)
 *
 * Target contract (see docs/notes on list-indent tuning):
 *  - web:  ul/ol padding-left = 2em per level; li must NOT compound
 *          extra margin-left (no first-line-indent stacking per level).
 *  - docx: numbering level step = 2em of the body font in twips
 *          (2 × 14pt × 20 = 560 twips for the default "standard" theme).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import JSZip from 'jszip';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
  type BrowserLayoutMeasurement,
} from './helpers/browser-render-harness.ts';

const LIST_FIXTURE = path.resolve('test/fixtures/layout/list.md');

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
  timeoutMs: 240_000,
} as const;

const ROOT_SELECTOR = '#markdown-content';
const ITEM_SELECTOR = '#markdown-content li';

function px(value: string): number {
  return parseFloat(value);
}

/**
 * Collect the distinct left offsets of list items relative to the content
 * root. Items on the same visual nesting level share the same offset, so the
 * sorted unique offsets are the per-level indent positions.
 */
function levelOffsets(m: BrowserLayoutMeasurement[]): number[] {
  const root = m.find((x) => x.selector === ROOT_SELECTOR)?.elements[0];
  const items = m.find((x) => x.selector === ITEM_SELECTOR)?.elements ?? [];
  assert.ok(root, `Missing measurement for ${ROOT_SELECTOR}`);
  assert.ok(items.length > 0, `No items matched ${ITEM_SELECTOR}`);
  const offsets = items.map((item) => item.left - root.left);
  return [...new Set(offsets.map((o) => Math.round(o)))].sort((a, b) => a - b);
}

/**
 * Assert that the distance between every adjacent pair of levels equals
 * 2em (body font based), i.e. the indent step is constant.
 */
function assertConstantTwoEmStep(offsets: number[], bodyFontPx: number, tolerancePx = 2): void {
  assert.ok(offsets.length >= 2, `Need at least two levels to measure the indent step (got ${offsets.length})`);
  const expectedStep = 2 * bodyFontPx;
  for (let i = 1; i < offsets.length; i++) {
    const step = offsets[i] - offsets[i - 1];
    assert.ok(
      Math.abs(step - expectedStep) <= tolerancePx,
      `Level ${i + 1} indent step is ${step.toFixed(1)}px, expected 2em (${expectedStep.toFixed(1)}px)` +
        ` — likely the li margin-left/first-line-indent compounding per level`,
    );
  }
}

/**
 * Parse every abstract numbering definition and return the per-level
 * w:left twips values for the levels WITHOUT w:hanging (those are the
 * exporter-owned definitions; the docx library built-in ones carry hanging).
 */
function parseIndentTwips(numberingXml: string): number[][] {
  const abstractNums = [...numberingXml.matchAll(/<w:abstractNum w:abstractNumId="\d+"[\s\S]*?<\/w:abstractNum>/g)];
  const lists: number[][] = [];
  for (const match of abstractNums) {
    const lvls = [...match[0].matchAll(/<w:lvl w:ilvl="(\d+)"[\s\S]*?<w:ind[^/]*\/>/g)];
    const indents: Array<{ level: number; left: number; hanging: boolean }> = [];
    for (const lvl of lvls) {
      const indTag = lvl[0].match(/<w:ind[^/]*\/>/)?.[0] ?? '';
      indents.push({
        level: Number(lvl[1]),
        left: Number(indTag.match(/w:left="(\d+)"/)?.[1] ?? NaN),
        hanging: indTag.includes('w:hanging'),
      });
    }
    if (
      indents.length >= 2 &&
      indents.every((i) => Number.isFinite(i.left)) &&
      indents.every((i) => !i.hanging)
    ) {
      lists.push(indents.sort((a, b) => a.level - b.level).map((i) => i.left));
    }
  }
  return lists;
}

describe('List indentation contract (E2E)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: LIST_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  it('web preview: every nesting level steps a constant 2em', async () => {
    const m = await harness.measureLayout(LIST_FIXTURE, [ROOT_SELECTOR, ITEM_SELECTOR], {
      ...FIXED_PARAMS,
      firstLineIndent: 2, // default: first-line indent ON
    });
    const li = m.find((x) => x.selector === ITEM_SELECTOR)!.elements[0];
    const bodyFontPx = px(li.fontSize);
    assertConstantTwoEmStep(levelOffsets(m), bodyFontPx);
  });

  it('web preview: indent step stays constant without first-line indent too', async () => {
    const m = await harness.measureLayout(LIST_FIXTURE, [ROOT_SELECTOR, ITEM_SELECTOR], {
      ...FIXED_PARAMS,
      firstLineIndent: 0,
    });
    const li = m.find((x) => x.selector === ITEM_SELECTOR)!.elements[0];
    const bodyFontPx = px(li.fontSize);
    assertConstantTwoEmStep(levelOffsets(m), bodyFontPx);
  });

  it('web preview: list items do not compound extra left margins', async () => {
    const m = await harness.measureLayout(LIST_FIXTURE, [ITEM_SELECTOR], {
      ...FIXED_PARAMS,
      firstLineIndent: 2,
    });
    const items = m[0].elements;
    assert.ok(items.length >= 3, 'Expected a nested list fixture');
    for (const item of items) {
      assert.equal(
        item.marginLeft,
        '0px',
        `li must not carry a per-level margin-left (got ${item.marginLeft}) — ` +
          `this compounds with ul/ol padding into a 3em+ indent step`,
      );
    }
  });

  it('exported standalone HTML keeps the same constant indent step (single CSS source)', async () => {
    const m = await harness.measureHtmlLayout(LIST_FIXTURE, [ROOT_SELECTOR, ITEM_SELECTOR], {
      ...FIXED_PARAMS,
      firstLineIndent: 2,
    });
    const li = m.find((x) => x.selector === ITEM_SELECTOR)!.elements[0];
    const bodyFontPx = px(li.fontSize);
    assertConstantTwoEmStep(levelOffsets(m), bodyFontPx);
  });

  it('docx export: numbering levels step by 2em of the body font', async () => {
    const { base64 } = await harness.renderDocx(LIST_FIXTURE, FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const numberingXml = await zip.files['word/numbering.xml'].async('string');

    const lists = parseIndentTwips(numberingXml);
    assert.ok(lists.length >= 2, 'Expected exporter-owned numbering definitions (default + blockquote)');

    // Default "standard" theme body font is 14pt → 2em = 2 × 14 × 20 = 560 twips.
    const expectedStep = 2 * 14 * 20;
    const tolerance = 24; // half a point
    for (const indents of lists) {
      for (let i = 1; i < indents.length; i++) {
        const step = indents[i] - indents[i - 1];
        assert.ok(
          Math.abs(step - expectedStep) <= tolerance,
          `Numbering level ${i} indent step is ${step} twips, expected 2em (${expectedStep} twips)`,
        );
      }
    }
  });
});
