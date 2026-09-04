import type { DocumentService } from '../types/platform';
import { ResourceEmbedder } from './resource-embedder';
import { collectContentCss } from './export-styles';

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

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function preserveContentRootState(root: HTMLElement): void {
  const liveContent = document.getElementById('markdown-content') as HTMLElement | null;
  const exportedContent = root.querySelector('#markdown-content') as HTMLElement | null;
  if (!liveContent || !exportedContent) {
    return;
  }

  exportedContent.className = liveContent.className;

  const liveStyle = liveContent.getAttribute('style');
  if (liveStyle && liveStyle.trim().length > 0) {
    exportedContent.setAttribute('style', liveStyle);
  } else {
    exportedContent.removeAttribute('style');
  }
}

async function inlineImages(
  root: HTMLElement,
  embedder: ResourceEmbedder,
  onItemDone?: () => void,
): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'));
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
    // Single-document exports serialize the live #markdown-page, whose content
    // root carries the viewer state (layout classes, inline style). Whole-book
    // chapter exports serialize .book-chapter containers inside
    // #book-print-root — their content roots already carry their own classes
    // and must NOT be overwritten by the live page's state.
    if (container.closest('#markdown-page')) {
      preserveContentRootState(clonedContainer);
    }
    reportStep();

    const embedder = new ResourceEmbedder({ documentService });
    await inlineImages(clonedContainer, embedder, reportStep);
    reportStep();

    const styles = collectContentCss();
    reportStep();
    const katexLink = includeKatexCdn
      ? `<link rel="stylesheet" href="${KATEX_CDN_URL}">`
      : '';

    const html = `<!doctype html>
<html lang="${document.documentElement.lang || 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtmlText(title)}</title>
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
