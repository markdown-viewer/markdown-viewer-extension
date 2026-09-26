/**
 * Shared export stylesheet collection.
 *
 * Collects the viewer's content-scoped CSS rules from the live document so
 * exported artifacts (standalone HTML, EPUB ebooks) mirror the on-screen
 * appearance. Two flavors:
 *
 * - `collectContentCss()` — strips every `@font-face` rule. Used by the
 *   single-file HTML export, which references KaTeX fonts via a CDN link
 *   instead.
 * - `collectEpubCss()` — keeps `@font-face` rules and embeds the referenced
 *   font files as data URLs (EPUBs are offline containers; no CDN). Font
 *   faces whose files cannot be fetched are dropped so the reader falls
 *   back to system fonts.
 *
 * The collected CSS is the RAW shared content CSS — the shared styles are
 * authored within the EPUB compatibility boundary (no :is() / color-mix() /
 * each-line / fit-content), so exporters must NOT rewrite or special-case
 * them per format. See plans/export-style-architecture-refactor.md.
 */

const CONTENT_SELECTOR_TOKENS = [
  '#markdown-content',
  '#markdown-page',
  '.katex',
  '.hljs',
  '.mermaid',
  '.markmap',
  '.graphviz',
  '.plantuml',
  '.diagram',
];

const HOST_STATE_TOKENS = [
  // Host-environment modes (<markdown-viewer> elements, iframe embeds, editor
  // panels — .mv-panel only ever rides on .mv-embed) and live-viewer state
  // attributes. Exported documents are always plain Web documents with no such
  // host and no such state, so those rules must not leak into HTML / EPUB
  // stylesheets: the embed card-strip would zero out the EPUB content gutter,
  // and the code-view rules would strip the exported card's max-width.
  '.mv-embed',
  'html[data-code-view]',
];

function shouldKeepSelector(selector: string): boolean {
  const lower = selector.toLowerCase();
  if (HOST_STATE_TOKENS.some((token) => lower.includes(token))) return false;
  return CONTENT_SELECTOR_TOKENS.some((token) => lower.includes(token));
}

function serializeFilteredRule(rule: CSSRule, keepFontFaces: boolean): string {
  if (rule.type === CSSRule.STYLE_RULE) {
    const styleRule = rule as CSSStyleRule;
    return shouldKeepSelector(styleRule.selectorText) ? styleRule.cssText : '';
  }

  if (rule.type === CSSRule.FONT_FACE_RULE) {
    // Standalone HTML: skip host/webview font-face bundles; the exporter adds
    // its own KaTeX CDN stylesheet. EPUB: keep so fonts can be embedded.
    return keepFontFaces ? rule.cssText : '';
  }

  if (rule.type === CSSRule.MEDIA_RULE) {
    const mediaRule = rule as CSSMediaRule;
    // Environment media rules adapt the stylesheet to its host environment
    // (print paging/limits, responsive viewport widths). Exported content
    // stylesheets must NOT carry them:
    //  - EPUB readers have no print paging and an unknown viewport width;
    //    @media print rules (e.g. `--print-max-media-height`, `width: auto`)
    //    only make sense in the browser print pipeline, which applies
    //    styles.css directly at runtime and never goes through collection.
    //  - Standalone HTML has no live viewport to respond to.
    // Keep the shared content CSS identical across Web / HTML / EPUB exports.
    if (/print|min-width|max-width|\(width/.test(mediaRule.conditionText)) {
      return '';
    }
    const inner = Array.from(mediaRule.cssRules)
      .map((child) => serializeFilteredRule(child, keepFontFaces))
      .filter((text) => text.length > 0)
      .join('\n');
    return inner ? `@media ${mediaRule.conditionText} {\n${inner}\n}` : '';
  }

  const maybeGrouped = rule as CSSRule & { cssRules?: CSSRuleList };
  if (maybeGrouped.cssRules && maybeGrouped.cssRules.length > 0) {
    const inner = Array.from(maybeGrouped.cssRules)
      .map((child) => serializeFilteredRule(child, keepFontFaces))
      .filter((text) => text.length > 0)
      .join('\n');
    if (!inner) {
      return '';
    }

    const ruleHeader = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
    return `${ruleHeader} {\n${inner}\n}`;
  }

  return '';
}

function stripPreloadHidingRules(css: string): string {
  // Defensive filtering for extension preload styles that hide body to prevent FOUC.
  // These rules must never be embedded into exported content.
  return css
    .replace(/(^|\n)\s*body\s*\{[^{}]*opacity\s*:\s*0\s*!important[^{}]*\}\s*(\n|$)/gi, '\n')
    .replace(/(^|\n)\s*body\s*\{[^{}]*overflow\s*:\s*hidden\s*!important[^{}]*\}\s*(\n|$)/gi, '\n')
    .replace(/(^|\n)\s*body\s*\{[^{}]*opacity\s*:\s*0\s*!important[^{}]*overflow\s*:\s*hidden\s*!important[^{}]*\}\s*(\n|$)/gi, '\n')
    .replace(/(^|\n)\s*:root\s*\{[^{}]*color-scheme\s*:\s*light\s+dark[^{}]*\}\s*(\n|$)/gi, '\n');
}

/**
 * Collect content CSS from every reachable stylesheet plus the dynamically
 * generated theme styles (`theme-dynamic-style`), filtered to the selectors
 * that matter for exported content.
 *
 * @param keepFontFaces - Whether `@font-face` rules are kept (EPUB) or
 *                        stripped (standalone HTML).
 */
function collectFilteredCss(keepFontFaces: boolean): string {
  const chunks: string[] = [];
  for (const stylesheet of Array.from(document.styleSheets)) {
    const owner = (stylesheet.ownerNode || null) as HTMLElement | null;
    if (owner?.id === 'markdown-viewer-preload') {
      continue;
    }

    try {
      const rules = Array.from(stylesheet.cssRules);
      if (rules.length === 0) {
        continue;
      }
      const filteredCss = rules
        .map((rule) => serializeFilteredRule(rule, keepFontFaces))
        .filter((text) => text.length > 0)
        .join('\n');
      if (filteredCss) {
        chunks.push(filteredCss);
      }
    } catch {
      // Ignore inaccessible stylesheets (cross-origin or browser restrictions).
    }
  }

  const themeStyle = document.getElementById('theme-dynamic-style') as HTMLStyleElement | null;
  if (themeStyle?.textContent) {
    chunks.push(themeStyle.textContent);
  }

  return stripPreloadHidingRules(chunks.join('\n'));
}

/**
 * Collect content CSS for standalone HTML export. `@font-face` rules are
 * stripped (fonts come from the exporter's CDN stylesheet link).
 */
export function collectContentCss(): string {
  return collectFilteredCss(false);
}

const FONT_FACE_RE = /@font-face\s*\{[^{}]*\}/gi;
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return blobToDataUrl(blob);
  } catch {
    return null;
  }
}

/**
 * Collect content CSS for EPUB export, keeping `@font-face` rules with the
 * referenced font files embedded as base64 data URLs (KaTeX math fonts etc.).
 * A font face whose file cannot be fetched is dropped entirely so readers
 * fall back to system fonts instead of failing.
 */
export async function collectEpubCss(): Promise<string> {
  const css = collectFilteredCss(true);

  const faces: { start: number; end: number; text: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = FONT_FACE_RE.exec(css)) !== null) {
    faces.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  if (faces.length === 0) {
    return css;
  }

  // Process back-to-front so slice indices stay valid when faces are dropped.
  let result = css;
  for (let i = faces.length - 1; i >= 0; i--) {
    const face = faces[i];
    const urls = Array.from(face.text.matchAll(URL_RE));
    const dataUrls: string[] = [];
    let resolvable = true;
    for (const urlMatch of urls) {
      const dataUrl = await fetchAsDataUrl(urlMatch[2]);
      if (!dataUrl) {
        resolvable = false;
        break;
      }
      dataUrls.push(dataUrl);
    }

    if (!resolvable) {
      result = result.slice(0, face.start) + result.slice(face.end);
      continue;
    }

    let newFace = face.text;
    urls.forEach((urlMatch, index) => {
      newFace = newFace.replace(urlMatch[0], `url("${dataUrls[index]}")`);
    });
    result = result.slice(0, face.start) + newFace + result.slice(face.end);
  }

  return result;
}

