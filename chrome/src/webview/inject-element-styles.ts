/**
 * Inject the shared content CSS into pages hosting <markdown-viewer> elements
 * in inline mode.
 *
 * The element runtime renders INLINE into the host page DOM (mode="inline"),
 * so it needs the shared content styles (diagram centering, image sizing,
 * tables, KaTeX, ...). The FULL ui/styles.css must NOT be injected there —
 * its global rules (`* { box-sizing }`, `body { height:100vh; overflow:
 * hidden }`, `#page-shell { position: fixed }`) would restyle the host page
 * itself. This script therefore injects a filtered copy that keeps only the
 * content-scoped selectors (same semantics as the export CSS collectors in
 * export-styles.ts) plus the .mv-embed/.mv-panel mode rules.
 *
 * iframe mode (mode="iframe" / embed) does not need this: the iframe loads
 * viewer-embed.html which references ui/styles.css directly.
 */
const CONTENT_SELECTOR_TOKENS = [
  '#markdown-content',
  '#markdown-page',
  '.markdown-viewer-content',
  '.mv-embed',
  '.katex',
  '.hljs',
  '.mermaid',
  '.markmap',
  '.graphviz',
  '.plantuml',
  '.diagram',
];

function shouldKeepSelector(selector: string): boolean {
  const lower = selector.toLowerCase();
  return CONTENT_SELECTOR_TOKENS.some((token) => lower.includes(token));
}

function serializeFilteredRule(rule: CSSRule): string {
  if (rule.type === CSSRule.STYLE_RULE) {
    const styleRule = rule as CSSStyleRule;
    return shouldKeepSelector(styleRule.selectorText) ? styleRule.cssText : '';
  }
  if (rule.type === CSSRule.MEDIA_RULE) {
    const mediaRule = rule as CSSMediaRule;
    // Environment media rules (print paging, responsive viewport widths) make
    // no sense on a host page; skip them like the export collectors do.
    if (/print|min-width|max-width|\(width/.test(mediaRule.conditionText)) {
      return '';
    }
    const inner = Array.from(mediaRule.cssRules)
      .map((child) => serializeFilteredRule(child))
      .filter((text) => text.length > 0)
      .join('\n');
    return inner ? `@media ${mediaRule.conditionText} {\n${inner}\n}` : '';
  }
  const maybeGrouped = rule as CSSRule & { cssRules?: CSSRuleList };
  if (maybeGrouped.cssRules && maybeGrouped.cssRules.length > 0) {
    const inner = Array.from(maybeGrouped.cssRules)
      .map((child) => serializeFilteredRule(child))
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

function injectElementContentStyles(): void {
  if (document.getElementById('mv-content-styles')) {
    return;
  }
  void (async () => {
    try {
      const css = await fetch(chrome.runtime.getURL('ui/styles.css')).then((r) => {
        if (!r.ok) throw new Error(`Unable to fetch ui/styles.css (${r.status})`);
        return r.text();
      });
      // Parse the fetched text through a temporary <style> so cssRules are
      // available for selector filtering.
      const probe = document.createElement('style');
      probe.textContent = css;
      (document.head || document.documentElement).appendChild(probe);
      let kept = '';
      try {
        kept = Array.from(probe.sheet?.cssRules || [])
          .map((rule) => serializeFilteredRule(rule))
          .filter((text) => text.length > 0)
          .join('\n');
      } finally {
        probe.remove();
      }
      if (!kept) {
        return;
      }
      const style = document.createElement('style');
      style.id = 'mv-content-styles';
      style.textContent = kept;
      (document.head || document.documentElement).appendChild(style);
    } catch {
      // Non-extension host (or fetch failure): keep the previous behavior
      // (no injected stylesheet) rather than breaking the page.
    }
  })();
}

injectElementContentStyles();

export {};
