/**
 * Inject the shared content CSS into pages hosting <markdown-viewer> elements
 * in inline mode. See chrome/src/webview/inject-element-styles.ts for the
 * rationale: a FILTERED copy of ui/styles.css (content selectors + .mv-embed
 * modes only) is injected so inline rendering gets the shared content styles
 * without restyling the host page itself.
 */

// Firefox WebExtension API — available as a global in content scripts.
declare const browser: {
  runtime: {
    getURL: (path: string) => string;
  };
};
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
      const css = await fetch(browser.runtime.getURL('ui/styles.css')).then((r) => {
        if (!r.ok) throw new Error(`Unable to fetch ui/styles.css (${r.status})`);
        return r.text();
      });
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
