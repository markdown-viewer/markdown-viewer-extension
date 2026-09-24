/**
 * Checkbox paint contract (web preview).
 *
 * A live checkbox must be drawn from the theme, not from the UA control
 * palette — the fix for #131, where a dark-mode OS painted GFM task boxes as
 * near-black squares whose check mark was invisible. `appearance: none` is the
 * discriminator (a UA-painted control cannot report it), and the checked fill
 * must be the accent of the theme in use, which is what the reporter asked for
 * on #131: "no matter which style I switch to, this checkbox's colour never
 * changes".
 *
 * Scope: the boxes that live in the document DOM, i.e. GFM task items. A
 * checkbox inside a raw HTML *block* is not styled by the theme CSS — the html
 * plugin rasterizes such blocks into figures, so those boxes are painted by
 * whatever renders the figure (see HtmlRenderer), not by this stylesheet.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
} from '../../helpers/browser-render-harness.ts';

const FIXTURE = path.resolve('test/fixtures/layout/task-list.md');

const FIXED_PARAMS = {
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
  timeoutMs: 240_000,
} as const;

/** The accent the color scheme bound to `themeId` paints links and controls with. */
function themeAccent(themeId: string): string {
  const theme = JSON.parse(
    fs.readFileSync(path.resolve(`src/themes/presets/${themeId}.json`), 'utf8'),
  ) as { colorScheme: string };
  const scheme = JSON.parse(
    fs.readFileSync(path.resolve(`src/themes/color-schemes/${theme.colorScheme}.json`), 'utf8'),
  ) as { accent: { link: string } };
  const value = parseInt(scheme.accent.link.replace('#', ''), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/** The paint of one box, as the browser resolved it. */
interface PaintedBox {
  checked: boolean;
  appearance: string;
  background: string;
  borderColor: string;
  borderWidth: string;
  width: number;
  checkMark: string;
}

describe('Checkbox paint (web preview)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  /** Render the fixture in one theme and read back how each box is painted. */
  async function paintedBoxes(theme: string): Promise<{ bodyFontPx: number; boxes: PaintedBox[] }> {
    await harness.measureLayout(FIXTURE, ['#markdown-content'], { ...FIXED_PARAMS, theme });
    return harness.evaluateInPage(() => {
      const content = document.getElementById('markdown-content');
      if (!content) throw new Error('#markdown-content is missing');
      const bodyFontPx = parseFloat(getComputedStyle(content).fontSize);
      const boxes = Array.from(content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).map((box) => {
        const style = getComputedStyle(box);
        const checkMark = style.getPropertyValue('background-image');
        return {
          checked: box.checked,
          appearance: style.getPropertyValue('appearance'),
          background: style.backgroundColor,
          borderColor: style.borderColor,
          borderWidth: style.borderTopWidth,
          width: parseFloat(style.width),
          checkMark: checkMark.startsWith('url("data:image/svg+xml') ? 'svg' : checkMark,
        };
      });
      return { bodyFontPx, boxes };
    });
  }

  it('draws both checkbox states from the theme instead of the UA palette', async () => {
    const { bodyFontPx, boxes } = await paintedBoxes('default');
    const accent = themeAccent('default');

    const checked = boxes.filter((box) => box.checked);
    const unchecked = boxes.filter((box) => !box.checked);
    assert.ok(checked.length >= 1, 'fixture must render a checked task item');
    assert.ok(unchecked.length >= 1, 'fixture must render an unchecked task item');

    for (const box of boxes) {
      assert.equal(box.appearance, 'none', 'the box must be drawn by the theme, not by the UA');
      assert.equal(box.borderWidth, '1px', 'the box must take the theme border');
      assert.ok(
        Math.abs(box.width - 0.75 * bodyFontPx) <= 1,
        `box width ${box.width} should be 0.75em of ${bodyFontPx}px body text`,
      );
    }
    for (const box of checked) {
      assert.equal(box.background, accent, 'a checked box must take the theme accent');
      assert.equal(box.checkMark, 'svg', 'a checked box must carry the inline check mark');
    }
    for (const box of unchecked) {
      assert.equal(box.background, 'rgba(0, 0, 0, 0)', 'an unchecked box must stay unfilled');
      assert.notEqual(box.borderColor, 'rgba(0, 0, 0, 0)', 'an unchecked box needs a visible border');
    }
  });

  it('moves the checked fill to the accent of the theme in use', async () => {
    const { boxes } = await paintedBoxes('forest');
    const accent = themeAccent('forest');
    assert.notEqual(accent, themeAccent('default'), 'the two themes must use different accents');

    const checked = boxes.filter((box) => box.checked);
    assert.ok(checked.length >= 1, 'fixture must render a checked task item');
    for (const box of checked) {
      assert.equal(box.background, accent, 'a checked box must follow the active theme');
    }
  });
});
