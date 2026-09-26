/**
 * Layout width presets for the browser page card.
 *
 * `READING_MAX_WIDTH_PX` is the single source of truth for the standalone page
 * width. It caps the *line length*: at 820px minus the 48px gutters the text
 * measure lands ~68–90 Latin chars (CJK ~34–45) across the reading themes —
 * Butterick's 45–90 range and close to Tailwind prose's 65ch.
 *
 * The same number is mirrored by `#markdown-page { max-width }` in
 * src/ui/styles.css and by the D7 reading-measure check in
 * test/gates/theme-design.js; test/suites/project-gates/reading-measure.test.ts
 * pins all three together, so the value cannot drift silently again (it did:
 * the toolbar hard-coded 1360px and overrode the stylesheet, so the browser
 * card was ~150 chars wide while the design gate measured 820).
 */
export const READING_MAX_WIDTH_PX = 820;

/**
 * Widths behind the toolbar layout control (正常布局 / 满屏布局 / 窄屏布局).
 * `normal` is the reading measure, `fullscreen` fills the window, `narrow` is
 * the focus mode. Code view ignores all three — the code surface is full-bleed
 * (a reading measure is a prose rule, not a code rule).
 */
export const LAYOUT_MAX_WIDTHS = {
  normal: `${READING_MAX_WIDTH_PX}px`,
  fullscreen: '100%',
  narrow: '680px',
} as const;
