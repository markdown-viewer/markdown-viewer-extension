/**
 * Geometry shared by the toolbar's two progress rings.
 *
 * The render indicator next to the file name and the export ring that replaces
 * the download icon are the same drawing (r = 7 in an 18x18 viewBox), so both
 * read their stroke offset from here instead of carrying their own copy of the
 * circumference and the clamping.
 */

/** Ring circumference of the 18px progress icon (2 * PI * 7). */
export const PROGRESS_RING_CIRCUMFERENCE = 43.98;

/**
 * `stroke-dashoffset` for a completion ratio: the full circumference while the
 * ring is empty, 0 at completion. A batch with nothing to report stays empty
 * (rather than producing `NaN`).
 */
export function ringOffsetFor(completed: number, total: number): number {
  const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  return PROGRESS_RING_CIRCUMFERENCE * (1 - ratio);
}
