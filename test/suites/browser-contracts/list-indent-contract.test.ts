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
import fs from 'node:fs';
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

/**
 * GFM task items render a checkbox instead of a bullet/number (GitHub
 * convention). The box must hang in the marker gutter, so the label text keeps
 * the same left edge as a plain list item — a mixed bullet/task list must not
 * look ragged — and the box must not stick out of the list box.
 */
const TASK_LIST_FIXTURE = path.resolve('test/fixtures/layout/task-list.md');

describe('Task-list marker contract (web preview)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: TASK_LIST_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  it('hangs the box in the marker gutter and keeps the label on the list text edge', async () => {
    await harness.measureLayout(TASK_LIST_FIXTURE, [ROOT_SELECTOR], { ...FIXED_PARAMS, firstLineIndent: 0 });

    // Measured in-page: geometry of a plain bullet item vs the tight and loose
    // task items, plus the first text character of each item (via a Range, so
    // the marker — not the li box — is what we compare).
    const metrics = await harness.evaluateInPage(() => {
      const content = document.getElementById('markdown-content');
      if (!content) throw new Error('#markdown-content is missing');

      const textLeft = (root: Element): number | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !/\S/.test(node.textContent ?? '')) node = walker.nextNode();
        if (!node) return null;
        const text = node.textContent ?? '';
        const index = text.search(/\S/);
        const range = document.createRange();
        range.setStart(node as Text, index);
        range.setEnd(node as Text, index + 1);
        return range.getBoundingClientRect().left;
      };

      const topLists = Array.from(content.querySelectorAll('ul')).filter((ul) => !ul.closest('li'));
      const plainItem = topLists
        .flatMap((ul) => Array.from(ul.children))
        .find((li) => !li.classList.contains('task-list-item'));
      const taskItem = (kind: 'tight' | 'loose'): Element | undefined =>
        topLists
          .flatMap((ul) => Array.from(ul.children))
          .find((li) => {
            if (!li.classList.contains('task-list-item')) return false;
            return kind === 'tight'
              ? Boolean(li.querySelector(':scope > input[type="checkbox"]'))
              : Boolean(li.querySelector(':scope > p > input[type="checkbox"]'));
          });

      const describeItem = (li: Element | undefined, kind: 'plain' | 'tight' | 'loose') => {
        if (!li) return null;
        const box = li.querySelector('input[type="checkbox"]');
        const boxRect = box?.getBoundingClientRect();
        return {
          kind,
          marker: getComputedStyle(li).listStyleType,
          liLeft: li.getBoundingClientRect().left,
          textLeft: textLeft(li),
          boxLeft: boxRect ? boxRect.left : null,
          boxRight: boxRect ? boxRect.right : null,
          boxWidth: boxRect ? boxRect.width : null,
          listLeft: li.parentElement ? li.parentElement.getBoundingClientRect().left : null,
        };
      };

      return {
        bodyFontPx: parseFloat(getComputedStyle(content).fontSize),
        plain: describeItem(plainItem, 'plain'),
        tight: describeItem(taskItem('tight'), 'tight'),
        loose: describeItem(taskItem('loose'), 'loose'),
      };
    });

    const { plain, tight, loose, bodyFontPx } = metrics;
    assert.ok(plain?.textLeft != null, 'fixture must contain a plain bullet item');
    assert.ok(tight?.textLeft != null && tight.boxLeft != null, 'fixture must contain a tight task item');
    assert.ok(loose?.textLeft != null && loose.boxLeft != null, 'fixture must contain a loose task item');

    const tolerance = 1.5;
    for (const item of [tight, loose]) {
      assert.equal(item.marker, 'none', `task item (${item.kind}) must not paint a bullet/number marker`);
      assert.ok(
        Math.abs(item.textLeft! - plain.textLeft!) <= tolerance,
        `task item (${item.kind}) label starts at ${item.textLeft}, plain list item at ${plain.textLeft} — ` +
          `the box must hang in the marker gutter, not push the text right`,
      );
      assert.ok(
        item.boxRight! <= item.textLeft! + tolerance,
        `task item (${item.kind}) box must end before its label starts`,
      );
      assert.ok(
        item.boxLeft! >= item.listLeft! - tolerance,
        `task item (${item.kind}) box must not overhang the list's left edge`,
      );
    }

    // Box metrics come from the theme CSS: a 0.75em square pulled by exactly
    // the 1em top-level marker gutter — its left edge sits on the gutter's
    // left edge (where a "10." marker starts) and the label keeps the list's
    // text edge.
    assert.ok(
      Math.abs(tight.boxWidth! - 0.75 * bodyFontPx) <= 1,
      `box width ${tight.boxWidth} should be 0.75em of ${bodyFontPx}px body text`,
    );
    assert.ok(
      Math.abs(tight.boxLeft! - tight.listLeft!) <= 1.5,
      `box left ${tight.boxLeft} should sit on the list's left edge ${tight.listLeft}`,
    );
  });

  it('nested task items keep the same gutter behaviour', async () => {
    await harness.measureLayout(TASK_LIST_FIXTURE, [ROOT_SELECTOR], { ...FIXED_PARAMS, firstLineIndent: 0 });

    const nested = await harness.evaluateInPage(() => {
      const content = document.getElementById('markdown-content');
      if (!content) throw new Error('#markdown-content is missing');

      // Second level in the mixed list: a plain bullet and a task item sit in
      // the same level, so the task label must line up with the bullet's.
      const items = Array.from(content.querySelectorAll('li li'));
      const nestedTask = items.find((li) => li.classList.contains('task-list-item'));
      const nestedPlain = items.find((li) => !li.classList.contains('task-list-item'));
      const box = nestedTask?.querySelector('input[type="checkbox"]');
      if (!nestedTask || !nestedPlain || !box) return null;

      const textLeft = (root: Element): number | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !/\S/.test(node.textContent ?? '')) node = walker.nextNode();
        if (!node) return null;
        const text = node.textContent ?? '';
        const index = text.search(/\S/);
        const range = document.createRange();
        range.setStart(node as Text, index);
        range.setEnd(node as Text, index + 1);
        return range.getBoundingClientRect().left;
      };

      return {
        marker: getComputedStyle(nestedTask).listStyleType,
        textLeft: textLeft(nestedTask),
        plainTextLeft: textLeft(nestedPlain),
        boxLeft: box.getBoundingClientRect().left,
        boxRight: box.getBoundingClientRect().right,
        listLeft: nestedTask.parentElement ? nestedTask.parentElement.getBoundingClientRect().left : null,
      };
    });

    assert.ok(nested, 'fixture must contain a nested task item next to a plain bullet');
    assert.equal(nested!.marker, 'none', 'nested task item must not paint a marker either');
    assert.ok(
      Math.abs(nested!.textLeft! - nested!.plainTextLeft!) <= 1.5,
      `nested task label starts at ${nested!.textLeft}, plain nested bullet at ${nested!.plainTextLeft}`,
    );
    assert.ok(
      nested!.boxLeft! >= nested!.listLeft! - 1.5,
      'nested box must not overhang its own (2em) list gutter',
    );
    assert.ok(
      nested!.boxLeft! < nested!.textLeft! && nested!.boxRight! <= nested!.textLeft! + 1.5,
      'nested box must hang left of its label text',
    );
  });
});

/**
 * Task-list marker contract (docx export).
 *
 * Word has no stylesheet to reach into: the box is a text symbol (▣/☐) in a
 * paragraph. Two things must therefore hold, mirroring the web preview:
 *  - the paragraph carries NO numbering reference — otherwise Word paints a
 *    bullet next to the box, where the web shows the box alone (GitHub
 *    convention: the box replaces the marker);
 *  - the symbol takes the theme colours — the accent when checked, and the body
 *    ink mixed 28% into the page colour when unchecked, the same tone the
 *    stylesheet paints the box outline with.
 * The box hangs in the marker gutter: the first line starts at the bullet
 * marker's indent, wrapped lines land on the list's text edge, and the whole
 * block follows the body first-line indent — the same grid as the numbering
 * levels.
 */
describe('Task-list marker contract (docx export)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: TASK_LIST_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  /** Body ink mixed `weightPercent` into the page colour (the stylesheet's mix). */
  function mixInk(ink: string, weightPercent: number, page: string): string {
    const channels = (hex: string): number[] => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = channels(ink);
    const [pageR, pageG, pageB] = channels(page);
    const weight = weightPercent / 100;
    const mix = (top: number, bottom: number): string =>
      Math.round(top * weight + bottom * (1 - weight))
        .toString(16)
        .padStart(2, '0');
    return `${mix(r, pageR)}${mix(g, pageG)}${mix(b, pageB)}`;
  }

  /** The colour scheme the `default` theme binds to, as hex without '#'. */
  function defaultScheme(): { accent: string; ink: string; page: string } {
    const theme = JSON.parse(
      fs.readFileSync(path.resolve('src/themes/presets/default.json'), 'utf8'),
    ) as { colorScheme: string };
    const scheme = JSON.parse(
      fs.readFileSync(path.resolve(`src/themes/color-schemes/${theme.colorScheme}.json`), 'utf8'),
    ) as { accent: { link: string }; text: { primary: string }; background: { page: string } };
    const hex = (value: string): string => value.replace('#', '').toLowerCase();
    return {
      accent: hex(scheme.accent.link),
      ink: hex(scheme.text.primary),
      page: hex(scheme.background.page),
    };
  }

  /** Paragraph XML of a rendered DOCX (one render per call). */
  async function paragraphs(firstLineIndent: number): Promise<string[]> {
    const { base64 } = await harness.renderDocx(TASK_LIST_FIXTURE, { ...FIXED_PARAMS, firstLineIndent });
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const xml = await zip.files['word/document.xml'].async('string');
    return xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  }

  /** Task-item paragraphs: marker, indent and box colour (the only coloured run). */
  function taskItems(all: string[]) {
    return all
      .filter((paragraph) => paragraph.includes('☐') || paragraph.includes('▣'))
      .map((paragraph) => ({
        checked: paragraph.includes('▣'),
        numbered: paragraph.includes('<w:numPr>'),
        left: Number(paragraph.match(/<w:ind[^>]*w:left="(\d+)"/)?.[1]),
        hanging: Number(paragraph.match(/<w:ind[^>]*w:hanging="(\d+)"/)?.[1]),
        color: (paragraph.match(/<w:color w:val="([0-9A-Fa-f]{6})"/)?.[1] ?? '').toLowerCase(),
      }));
  }

  it('drops the bullet and hangs the box on the theme list grid', async () => {
    // The default theme's body is 14pt: 2em per level = 560 twips, and the
    // 1em marker gutter = 280 twips.
    const step = 2 * 14 * 20;
    const gutter = 14 * 20;

    for (const [firstLineIndent, blockOffset] of [
      [0, 0],
      [2, 2 * 14 * 20],
    ] as const) {
      const all = await paragraphs(firstLineIndent);
      const items = taskItems(all);
      assert.ok(items.length >= 2, `fixture must render task items (got ${items.length})`);

      assert.deepEqual(
        items.filter((item) => item.numbered).length,
        0,
        'a task item must carry no numbering reference — Word would draw a bullet next to the box',
      );
      assert.deepEqual(
        [...new Set(items.map((item) => item.hanging))],
        [gutter],
        'the box must hang by exactly the 1em marker gutter',
      );
      // Level 0 sits at half a step (the bullet marker's indent) plus the gutter
      // the box occupies, plus the block offset when the body is indented; the
      // nested level keeps the constant 2em step.
      assert.deepEqual(
        [...new Set(items.map((item) => item.left))].sort((a, b) => a - b),
        [gutter + gutter + blockOffset, step + gutter + gutter + blockOffset],
        'task items must land on the same grid as the numbering levels',
      );

      const bullet = all.find((paragraph) => paragraph.includes('Plain bullet item'));
      assert.ok(bullet?.includes('<w:numPr>'), 'a plain bullet item must keep its numbering');
    }
  });

  it('paints the box from the theme: accent when checked, ink mix when unchecked', async () => {
    const scheme = defaultScheme();
    const box = mixInk(scheme.ink, 28, scheme.page);
    const items = taskItems(await paragraphs(0));

    assert.ok(items.some((item) => item.checked), 'fixture must render a checked task item');
    assert.ok(items.some((item) => !item.checked), 'fixture must render an unchecked task item');
    for (const item of items) {
      assert.equal(
        item.color,
        item.checked ? scheme.accent : box,
        `a ${item.checked ? 'checked' : 'unchecked'} box must take the theme colour`,
      );
    }
    assert.notEqual(box, scheme.accent, 'the two states must not collapse onto one colour');
  });
});
