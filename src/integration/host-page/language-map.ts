/**
 * Host-page diagram language mapping
 *
 * Maps language identifiers found in third-party web pages (GitHub, GitLab,
 * generic markdown renderers, etc.) to our internal renderer types.
 *
 * The mapping is sourced from the central format registry (formats.json →
 * formats.ts) so adding a new diagram type only requires updating one file.
 *
 * Web pages expose code-block languages through several DOM conventions:
 *   - GitHub README:     <div class="highlight highlight-source-<lang>">
 *   - GitHub issue/PR:   <pre lang="<lang>"><code>...</code></pre>
 *   - Generic renderers: <pre><code class="language-<lang>">...</code></pre>
 *   - GitLab:            <pre class="code highlight"><code lang="<lang>">
 *
 * This module normalizes all of them to our renderer registry keys.
 */

import {
  CODE_BLOCK_LANGUAGE_MAP,
  DIAGRAM_CODE_BLOCK_LANGUAGE_SET,
} from '../../types/formats';

/**
 * Resolve a page-side language identifier to our internal render type.
 * Returns null if the language is not a supported diagram type.
 *
 * @param lang - Language identifier from DOM (e.g. 'plantuml', 'wsd', 'vega-lite')
 * @returns Internal render type (e.g. 'plantuml', 'vega-lite') or null
 */
export function resolveRenderType(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const normalized = lang.trim().toLowerCase();
  return CODE_BLOCK_LANGUAGE_MAP[normalized] ?? null;
}

/**
 * Set of all supported page-side language identifiers (lowercased).
 * Used for quick membership checks.
 */
export const SUPPORTED_HOST_PAGE_LANGUAGES: ReadonlySet<string> =
  DIAGRAM_CODE_BLOCK_LANGUAGE_SET;

/**
 * Build a CSS selector that matches all known diagram code-block shapes
 * on third-party pages.
 *
 * The selector covers:
 *   1. GitHub README:    div.highlight.highlight-source-<lang>
 *   2. GitHub issue/PR:  pre[lang="<lang>"]
 *   3. Generic:          pre > code.language-<lang>  (and code.language-<lang> alone)
 *
 * The selector is intentionally broad; the scanner re-validates each match
 * and extracts the actual code text.
 */
export function buildDiagramBlockSelector(): string {
  const langs = Array.from(SUPPORTED_HOST_PAGE_LANGUAGES);
  const parts: string[] = [];

  // GitHub README style: <div class="highlight highlight-source-plantuml">
  // Also covers <div class="highlight highlight-source-<lang>">
  for (const lang of langs) {
    parts.push(`div.highlight.highlight-source-${lang}`);
  }

  // GitHub issue/PR style: <pre lang="plantuml">
  // Also covers GitLab and other renderers that set lang on <pre>.
  for (const lang of langs) {
    parts.push(`pre[lang="${lang}"]`);
  }

  // Generic markdown style: <pre><code class="language-plantuml">
  // We select the <code> element; the scanner walks up to its <pre> parent.
  for (const lang of langs) {
    parts.push(`pre code.language-${lang}`);
  }

  // Bare <code class="language-plantuml"> (not wrapped in <pre>) — rare but
  // some renderers produce inline code blocks this way.
  for (const lang of langs) {
    parts.push(`code.language-${lang}:not(pre > code)`);
  }

  return parts.join(', ');
}
