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
 *          When the body uses a first-line indent, the TOP-LEVEL list shifts
 *          as a whole by the same amount (margin-left on ul/ol), so the
 *          marker starts at the body's first-line position instead of
 *          hanging to its left. Without first-line indent the marker hangs
 *          at the body's left edge (GitHub convention).
 *  - docx: numbering level step = 2em of the body font in twips
 *          (2 × 14pt × 20 = 560 twips for the default "standard" theme);
 *          with first-line indent every level shifts by the same offset
 *          (whole-block move, step unchanged); blockquote lists stay flush.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import JSZip from 'jszip';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
  type BrowserLayoutMeasurement,
} from '../../helpers/browser-render-harness.ts';

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
 * 2em (body font based), i.e. the indent step is constant, and that the
 * first level starts at `expectedBaseEm` ems (2em marker gutter, plus the
 * first-line-indent block offset when the body is indented).
 */
function assertConstantTwoEmStep(offsets: number[], bodyFontPx: number, expectedBaseEm: number, tolerancePx = 2): void {
  assert.ok(offsets.length >= 2, `Need at least two levels to measure the indent step (got ${offsets.length})`);
  const expectedStep = 2 * bodyFontPx;
  const expectedBase = expectedBaseEm * bodyFontPx;
  assert.ok(
    Math.abs(offsets[0] - expectedBase) <= tolerancePx,
    `First level starts at ${offsets[0].toFixed(1)}px, expected ${expectedBase.toFixed(1)}px` +
      ` (${expectedBaseEm}em) — the list block must follow the body first-line indent`,
  );
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

  it('web preview: with first-line indent the marker starts at the body first-line', async () => {
    const m = await harness.measureLayout(LIST_FIXTURE, [ROOT_SELECTOR, ITEM_SELECTOR], {
      ...FIXED_PARAMS,
      firstLineIndent: 2, // default: first-line indent ON
    });
    const li = m.find((x) => x.selector === ITEM_SELECTOR)!.elements[0];
    const bodyFontPx = px(li.fontSize);
    // 1em marker gutter + 2em first-line block offset → first level at 3em,
    // step stays a constant 2em.
    assertConstantTwoEmStep(levelOffsets(m), bodyFontPx, 3);
  });

  it('web preview: without first-line indent the marker starts at the body left edge', async () => {
    const m = await harness.measureLayout(LIST_FIXTURE, [ROOT_SELECTOR, ITEM_SELECTOR], {
      ...FIXED_PARAMS,
      firstLineIndent: 0,
    });
    const li = m.find((x) => x.selector === ITEM_SELECTOR)!.elements[0];
    const bodyFontPx = px(li.fontSize);
    // 1em marker gutter only → first level at 1em, step stays a constant 2em.
    assertConstantTwoEmStep(levelOffsets(m), bodyFontPx, 1);
  });

  it('web preview: block offset lives on top-level lists, not on nested ones or items', async () => {
    const m = await harness.measureLayout(LIST_FIXTURE, [ITEM_SELECTOR, '#markdown-content ul, #markdown-content ol'], {
      ...FIXED_PARAMS,
      firstLineIndent: 2,
    });
    const items = m.find((x) => x.selector === ITEM_SELECTOR)!.elements;
    const lists = m.find((x) => x.selector === '#markdown-content ul, #markdown-content ol')!.elements;
    const topLevel = lists.filter((list) => list.marginLeft !== '0px');
    const nested = lists.filter((list) => list.marginLeft === '0px');
    assert.ok(topLevel.length >= 1, 'Expected at least one top-level list with the 2em block offset');
    assert.ok(nested.length >= 1, 'Expected nested lists without the block offset');
    for (const list of topLevel) {
      assert.equal(list.marginLeft, '37.3333px', 'Top-level list carries the 2em block offset');
      assert.equal(list.paddingLeft, '18.6667px', 'Top-level list keeps the 1em marker gutter');
    }
    for (const list of nested) {
      assert.equal(list.paddingLeft, '37.3333px', 'Nested lists keep the 2em step');
    }
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
    assertConstantTwoEmStep(levelOffsets(m), bodyFontPx, 3);
  });

  it('docx export: numbering levels step by 2em with a 1em marker gutter', async () => {
    const { base64 } = await harness.renderDocx(LIST_FIXTURE, { ...FIXED_PARAMS, firstLineIndent: 0 });
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const numberingXml = await zip.files['word/numbering.xml'].async('string');

    const lists = parseIndentTwips(numberingXml);
    assert.ok(lists.length >= 2, 'Expected exporter-owned numbering definitions (default + blockquote)');

    // Default "standard" theme body font is 14pt → 2em = 560 twips,
    // 1em marker gutter = 280 twips. Level 0 sits at the gutter (280 twips),
    // then steps 2em per level.
    const expectedStep = 2 * 14 * 20;
    const tolerance = 24; // half a point
    for (const indents of lists) {
      assert.ok(
        Math.abs(indents[0] - expectedStep / 2) <= tolerance,
        `Level 0 left is ${indents[0]} twips, expected the 1em marker gutter (${expectedStep / 2} twips)`,
      );
      for (let i = 1; i < indents.length; i++) {
        const step = indents[i] - indents[i - 1];
        assert.ok(
          Math.abs(step - expectedStep) <= tolerance,
          `Numbering level ${i} indent step is ${step} twips, expected 2em (${expectedStep} twips)`,
        );
      }
    }
  });

  it('docx export: with first-line indent the whole list block shifts right', async () => {
    const { base64 } = await harness.renderDocx(LIST_FIXTURE, { ...FIXED_PARAMS, firstLineIndent: 2 });
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const numberingXml = await zip.files['word/numbering.xml'].async('string');

    const lists = parseIndentTwips(numberingXml);
    const expectedStep = 2 * 14 * 20; // 560 twips
    const tolerance = 24;
    // Default lists carry the 2em block offset (level 0 at 1em gutter + 2em
    // offset = 3em = 840 twips); blockquote-internal lists do not (level 0 at
    // 1em = 280 twips). Both keep the constant 2em step.
    const shifted = lists.filter((indents) => Math.abs(indents[0] - 3 * 14 * 20) <= tolerance);
    const flush = lists.filter((indents) => Math.abs(indents[0] - 14 * 20) <= tolerance);
    assert.ok(shifted.length >= 1, `Expected default lists shifted by 2em (got bases ${lists.map((l) => l[0]).join(', ')})`);
    assert.ok(flush.length >= 1, 'Expected blockquote lists without the block offset');
    for (const indents of [...shifted, ...flush]) {
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
