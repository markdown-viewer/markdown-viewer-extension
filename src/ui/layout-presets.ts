/**
 * Layout width presets for the browser page card.
 *
 * `READING_MAX_WIDTH_PX` is the single source of truth for the standalone page
 * width: the wide reading card the browser renders (1360px), re-stated by the
 * HTML export for its standalone document. It is a *spread*, not a column — on
 * a narrower window the window is the cap, so line length there is the
 * reader's window, not a fixed measure.
 *
 * `FOCUS_MAX_WIDTH_PX` is the 窄屏布局 focus column, and the width the
 * typographic reading band (Butterick 45–90, Tailwind prose 65ch) governs: the
 * D7 check in test/gates/theme-design.js measures characters per line against
 * it (680px minus the 48px gutters ≈ 73 Latin chars at 16px).
 *
 * Both numbers are mirrored by `#markdown-page { max-width }` in
 * src/ui/styles.css and by test/gates/theme-design.js;
 * test/suites/project-gates/reading-measure.test.ts pins all copies together,
 * so they cannot drift silently again. They did, twice: the toolbar hard-coded
 * 1360px and overrode the stylesheet, and the follow-up that unified them
 * capped the card at the 820px measure — which narrowed the default reading
 * width the product wanted wide.
 */
export const READING_MAX_WIDTH_PX = 1360;

/** Focus column (窄屏布局) — the width D7 audits as a reading measure. */
export const FOCUS_MAX_WIDTH_PX = 680;

/**
 * Widths behind the toolbar layout control (正常布局 / 满屏布局 / 窄屏布局).
 * `normal` is the wide reading card, `fullscreen` fills the window, `narrow` is
 * the focus column. Code view ignores all three — the code surface is
 * full-bleed (a reading measure is a prose rule, not a code rule).
 */
export const LAYOUT_MAX_WIDTHS = {
  normal: `${READING_MAX_WIDTH_PX}px`,
  fullscreen: '100%',
  narrow: `${FOCUS_MAX_WIDTH_PX}px`,
} as const;
