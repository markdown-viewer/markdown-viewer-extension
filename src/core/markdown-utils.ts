/**
 * Lightweight markdown-related helpers that should stay dependency-free.
 * Keep this module small so UI/runtime entrypoints don't pull in the full
 * markdown processing pipeline.
 */

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Heading information for TOC
 */
export interface HeadingInfo {
  level: number;
  text: string;
  id: string;
}

/**
 * Extract headings for TOC generation (from DOM)
 */
export function extractHeadings(container: Element): HeadingInfo[] {
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const result: HeadingInfo[] = [];

  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName[1], 10);
    const text = heading.textContent || '';
    const id = heading.id || `heading-${index}`;

    if (!heading.id) {
      heading.id = id;
    }

    result.push({ level, text, id });
  });

  return result;
}