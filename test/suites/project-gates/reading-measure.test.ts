/**
 * Reading-measure drift guard.
 *
 * The browser card width lives in three places that must agree:
 *   1. `READING_MAX_WIDTH_PX` (src/ui/layout-presets.ts) — the toolbar's
 *      `normal` layout writes it inline on `#markdown-page`, and the HTML
 *      exporter re-states it for the shared standalone document;
 *   2. `#markdown-page { max-width }` in src/ui/styles.css — the fallback for
 *      surfaces without the toolbar;
 *   3. `READING_MAX_WIDTH` / `READING_GUTTER` in test/gates/theme-design.js —
 *      the D7 line-length check.
 *
 * They drifted once: the toolbar hard-coded `1360px` and silently overrode the
 * stylesheet, so the browser rendered ~150 characters per line while the design
 * gate measured 820. This test is what makes that impossible to repeat.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { LAYOUT_MAX_WIDTHS, READING_MAX_WIDTH_PX } from '../../../src/ui/layout-presets.ts';
import { READING_GUTTER, READING_MAX_WIDTH } from '../../gates/theme-design.js';

const css = fs.readFileSync(path.resolve('src/ui/styles.css'), 'utf8');

/** Declarations of the first `#markdown-page { … }` rule in the stylesheet. */
function markdownPageRule(): string {
  const match = css.match(/(?:^|\n)#markdown-page\s*\{([^}]*)\}/);
  assert.ok(match, 'src/ui/styles.css must define #markdown-page');
  return match[1];
}

describe('reading measure is a single number', () => {
  it('stylesheet, layout preset and D7 gate agree', () => {
    const rule = markdownPageRule();
    const maxWidth = rule.match(/max-width:\s*(\d+)px/);
    const padding = rule.match(/padding:\s*(\d+)px\s+(\d+)px/);
    assert.ok(maxWidth, '#markdown-page must cap the measure in px');
    assert.ok(padding, '#markdown-page must declare the card gutter');

    assert.equal(Number(maxWidth[1]), READING_MAX_WIDTH_PX, 'styles.css vs layout-presets.ts');
    assert.equal(Number(maxWidth[1]), READING_MAX_WIDTH, 'styles.css vs theme-design.js (D7)');
    assert.equal(Number(padding[2]), READING_GUTTER, 'card gutter vs theme-design.js (D7)');
    assert.equal(LAYOUT_MAX_WIDTHS.normal, `${READING_MAX_WIDTH_PX}px`, 'toolbar normal layout width');
  });

  it('keeps the measure inside the researched reading band', () => {
    // cpl = (measure - gutters) / (bodyPx * 0.5) — the D7 formula, asserted here
    // so a width change cannot silently leave Butterick's 45–90 char band.
    const cpl = (READING_MAX_WIDTH_PX - 2 * READING_GUTTER) / (16 * 0.5);
    assert.ok(cpl >= 45 && cpl <= 105, `expected 45–105 Latin chars per line at 16px, got ${cpl}`);
  });
});
