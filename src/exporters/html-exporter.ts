import type { DocumentService } from '../types/platform';
import { ResourceEmbedder } from './resource-embedder';

export interface HtmlExportOptions {
  container: HTMLElement;
  filename: string;
  title?: string;
  documentService?: DocumentService;
  includeKatexCdn?: boolean;
  onProgress?: (completed: number, total: number) => void;
}

export interface HtmlExportResult {
  success: boolean;
  html?: string;
  filename?: string;
  error?: string;
}

const KATEX_CDN_URL = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';

const EXPORT_LAYOUT_CSS = `
html, body {
  margin: 0 !important;
  padding: 0 !important;
  height: auto !important;
  min-height: 100% !important;
  overflow: auto !important;
  background-color: var(--color-bg-body, #f5f5f5) !important;
}

#markdown-page {
  width: 100%;
  max-width: 1360px !important;
  margin: 0 auto !important;
  padding: 0 !important;
}

#markdown-content {
  margin: 0 auto !important;
  padding: 40px !important;
  box-shadow: 0 0 20px rgba(0, 0, 0, 0.1) !important;
}
`;

function toHtmlFilename(filename: string): string {
  let htmlFilename = filename || 'document.html';
  if (htmlFilename.toLowerCase().endsWith('.md')) {
    htmlFilename = htmlFilename.slice(0, -3) + '.html';
  } else if (htmlFilename.toLowerCase().endsWith('.markdown')) {
    htmlFilename = htmlFilename.slice(0, -9) + '.html';
  } else if (!htmlFilename.toLowerCase().endsWith('.html')) {
    htmlFilename = htmlFilename + '.html';
  }
  return htmlFilename;
}

function stripKatexFontFace(css: string): string {
  return css.replace(/@font-face\s*\{[^{}]*KaTeX[^{}]*\}\s*/gi, '');
}

function stripPreloadHidingRules(css: string): string {
  // Defensive filtering for extension preload styles that hide body to prevent FOUC.
  // These rules must never be embedded into exported standalone HTML.
  return css
    .replace(/(^|\n)\s*body\s*\{[^{}]*opacity\s*:\s*0\s*!important[^{}]*\}\s*(\n|$)/gi, '\n')
    .replace(/(^|\n)\s*body\s*\{[^{}]*overflow\s*:\s*hidden\s*!important[^{}]*\}\s*(\n|$)/gi, '\n')
    .replace(/(^|\n)\s*body\s*\{[^{}]*opacity\s*:\s*0\s*!important[^{}]*overflow\s*:\s*hidden\s*!important[^{}]*\}\s*(\n|$)/gi, '\n')
    .replace(/(^|\n)\s*:root\s*\{[^{}]*color-scheme\s*:\s*light\s+dark[^{}]*\}\s*(\n|$)/gi, '\n');
}

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

function shouldKeepSelector(selector: string): boolean {
  const lower = selector.toLowerCase();
  return CONTENT_SELECTOR_TOKENS.some((token) => lower.includes(token));
}

function serializeFilteredRule(rule: CSSRule): string {
  if (rule.type === CSSRule.STYLE_RULE) {
    const styleRule = rule as CSSStyleRule;
    return shouldKeepSelector(styleRule.selectorText) ? styleRule.cssText : '';
  }

  // Skip host/webview font-face bundles in exported standalone HTML.
  if (rule.type === CSSRule.FONT_FACE_RULE) {
    return '';
  }

  if (rule.type === CSSRule.MEDIA_RULE) {
    const mediaRule = rule as CSSMediaRule;
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

function collectStylesheetCss(): string {
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
        .map((rule) => serializeFilteredRule(rule))
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

  return stripPreloadHidingRules(stripKatexFontFace(chunks.join('\n')));
}

function removeEphemeralUi(root: HTMLElement): void {
  root.querySelectorAll('mark.vscode-search-highlight').forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    const text = document.createTextNode(el.textContent || '');
    parent.replaceChild(text, el);
    parent.normalize();
  });
  // Remove non-functional copy buttons that only make sense in the live preview
  root.querySelectorAll('.mv-code-copy-btn').forEach((btn) => btn.remove());
}

function stripRuntimeWrappers(root: HTMLElement): void {
  // Exported HTML must be static. Keep content, remove runtime custom-element wrappers
  // to avoid extension re-injection on opened .html files.
  const wrappers = Array.from(root.querySelectorAll('markdown-viewer'));
  wrappers.forEach((wrapper) => {
    const fragment = document.createDocumentFragment();
    while (wrapper.firstChild) {
      fragment.appendChild(wrapper.firstChild);
    }
    wrapper.replaceWith(fragment);
  });
}

async function inlineImages(
  root: HTMLElement,
  embedder: ResourceEmbedder,
  onItemDone?: () => void,
): Promise<void> {
  const images = Array.from(root.querySelectorAll('img[src]'));
  const tasks = images.map(async (img) => {
    const srcAttr = img.getAttribute('src') || '';
    const src = srcAttr || img.src || '';
    if (!src || src.startsWith('data:')) {
      onItemDone?.();
      return;
    }

    try {
      const dataUrl = await embedder.toDataUrl(src);
      img.setAttribute('src', dataUrl);
      img.removeAttribute('srcset');
    } catch {
      // Keep original src if embedding fails for this image.
    } finally {
      onItemDone?.();
    }
  });

  await Promise.all(tasks);
}

export async function exportToHtml(options: HtmlExportOptions): Promise<HtmlExportResult> {
  const {
    container,
    filename,
    title = document.title || filename || 'Markdown Viewer',
    documentService,
    includeKatexCdn = true,
    onProgress,
  } = options;

  try {
    const htmlFilename = toHtmlFilename(filename);
    const imageCount = container.querySelectorAll('img[src]').length;
    const totalSteps = 4 + imageCount;
    let completedSteps = 0;
    const reportStep = () => {
      completedSteps += 1;
      onProgress?.(completedSteps, totalSteps);
    };

    const clonedContainer = container.cloneNode(true) as HTMLElement;
    removeEphemeralUi(clonedContainer);
    stripRuntimeWrappers(clonedContainer);
    reportStep();

    const embedder = new ResourceEmbedder({ documentService });
    await inlineImages(clonedContainer, embedder, reportStep);
    reportStep();

    const styles = collectStylesheetCss();
    reportStep();
    const katexLink = includeKatexCdn
      ? `<link rel="stylesheet" href="${KATEX_CDN_URL}">`
      : '';

    const html = `<!doctype html>
<html lang="${document.documentElement.lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${katexLink}
  <style>${styles}\n${EXPORT_LAYOUT_CSS}</style>
</head>
<body>
${clonedContainer.outerHTML}
</body>
</html>`;

  reportStep();

    return {
      success: true,
      html,
      filename: htmlFilename,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { toHtmlFilename };
