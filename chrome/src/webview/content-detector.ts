// Lightweight content script for detecting Markdown files and registering element runtime
// This script runs on all pages to check if they are Markdown files or HTML pages
// Supports both Chrome (chrome.*) and Firefox (browser.*) APIs

import { getWebExtensionApi } from '../../../src/utils/platform-info';

import {
  ALL_SUPPORTED_EXTENSIONS,
} from '../../../src/types/formats';
import { getCodePreviewMatchedExtension } from '../../../src/utils/code-preview';
import { buildDiagramBlockSelector } from '../../../src/integration/host-page/language-map';

const webExtensionApi = getWebExtensionApi();

/**
 * Check if file extension requires settings check (non-markdown extensions)
 */
function getMatchedExtension(path: string): string | null {
  const lowerPath = path.toLowerCase();
  // Check format registry extensions + .html
  for (const ext of ALL_SUPPORTED_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return ext;
    }
  }
  if (lowerPath.endsWith('.html')) {
    return '.html';
  }
  if (lowerPath.endsWith('.htm')) {
    return '.html';
  }

  const codePreviewExt = getCodePreviewMatchedExtension(lowerPath);
  if (codePreviewExt) return codePreviewExt;

  return null;
}

/**
 * Check if this is a processable file based on content type and structure
 */
function isProcessableContent(): boolean | null {
  // Check content type from document if available
  interface DocumentWithContentType {
    contentType?: string;
    mimeType?: string;
  }
  const contentType = (document as unknown as DocumentWithContentType).contentType || (document as unknown as DocumentWithContentType).mimeType;

  if (contentType) {
    // If content type is HTML, this page has already been processed
    if (contentType.includes('text/html')) {
      return false;
    }
    // Only process if content type is plain text or unknown
    if (contentType.includes('text/plain') || contentType.includes('application/octet-stream')) {
      return true;
    }
  }

  // At document_start (notably in Firefox), metadata/body can be unavailable.
  // Defer detection instead of assuming processable to avoid false positives.
  if (!document.body) {
    return null;
  }

  // For local files or when content type is not available, check if body contains raw content
  const bodyText = document.body ? document.body.textContent : '';
  const bodyHTML = document.body ? document.body.innerHTML : '';

  // If the body is already heavily structured HTML (not just pre-wrapped text), 
  // it's likely already processed
  if (bodyHTML.includes('<div') || bodyHTML.includes('<p>') || bodyHTML.includes('<h1') ||
    bodyHTML.includes('<nav') || bodyHTML.includes('<header') || bodyHTML.includes('<footer')) {
    return false;
  }

  // If body text looks like raw markdown (contains markdown syntax), process it
  if (bodyText && (bodyText.includes('# ') || bodyText.includes('## ') || bodyText.includes('```') ||
    bodyText.includes('- ') || bodyText.includes('* ') || (bodyText.includes('[') && bodyText.includes('](')))) {
    return true;
  }

  // If it's a supported file with plain text content, assume it should be processed
  return true;
}

/**
 * Hide the page content immediately to prevent flash of unstyled content
 */
function hidePageContent(): void {
  // Add inline style to hide content immediately
  // This prevents the flash of plain text before the extension renders.
  // Also declare `color-scheme` so when the OS/browser is in dark mode the
  // default UA background is dark — otherwise the raw <pre> page paints a
  // bright white rectangle before the theme CSS arrives.
  const style = document.createElement('style');
  style.id = 'markdown-viewer-preload';
  style.textContent = `
    :root { color-scheme: light dark; }
    html, body { background: Canvas; }
    body {
      opacity: 0 !important;
      overflow: hidden !important;
    }
  `;
  // Insert at the beginning of head (or create head if it doesn't exist)
  if (!document.head) {
    const head = document.createElement('head');
    document.documentElement.insertBefore(head, document.body);
  }
  document.head.insertBefore(style, document.head.firstChild);
}

/**
 * Inject the main content script
 */
function injectContentScript(): void {
  // If user explicitly marked this session to view as raw, abort.
  try {
    if (sessionStorage.getItem('markdownViewerRawOverride') === '1') {
      return;
    }
  } catch (e) {
    // sessionStorage access denied
  }

  // Hide content immediately before injection to prevent flashing
  hidePageContent();

  const url = document.location.href;
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const request = {
    id,
    type: 'INJECT_CONTENT_SCRIPT',
    payload: { url },
    timestamp: Date.now(),
    source: 'content-detector',
  };

  // Use Promise-based API for Firefox, callback for Chrome
  const sendPromise = webExtensionApi.runtime.sendMessage(request);
  if (sendPromise && typeof sendPromise.then === 'function') {
    sendPromise.catch(() => {
      // Ignore errors - fire and forget
    });
  }
}

/**
 * Detect <markdown-viewer> elements or diagram code blocks on an HTML page
 * and request element-runtime injection if found.
 *
 * Used for:
 *   - .html files that may contain <markdown-viewer> tags
 *   - Any URL whose content type is text/html (e.g. GitHub blob pages where
 *     the URL ends in .md but the page is rendered as HTML by the host site)
 *
 * Injection is lazy: if no target is found immediately, a MutationObserver
 * watches for late-added elements.
 */
function detectHtmlPageContent(): void {
  let injected = false;
  const requestInject = (): void => {
    if (injected) return;
    injected = true;
    const request = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: 'INJECT_ELEMENT_RUNTIME',
      payload: {},
      timestamp: Date.now(),
      source: 'content-detector',
    };
    const sendPromise = webExtensionApi.runtime.sendMessage(request);
    if (sendPromise && typeof sendPromise.then === 'function') {
      sendPromise.catch(() => {
        // Ignore errors - fire and forget
      });
    }
  };

  const hasMarkdownViewer = (): boolean => Boolean(document.querySelector('markdown-viewer'));

  // Check if the page contains any diagram code block (PlantUML, Mermaid,
  // Vega, DOT, etc.) that we can render. Uses the same selector as the
  // scanner so detection stays in sync with rendering coverage.
  const diagramSelector = buildDiagramBlockSelector();
  const hasDiagramCodeBlock = (): boolean => Boolean(document.querySelector(diagramSelector));

  const shouldInject = (): boolean => hasMarkdownViewer() || hasDiagramCodeBlock();

  if (shouldInject()) {
    requestInject();
    return;
  }

  // Watch for late-added <markdown-viewer> elements or diagram code blocks;
  // inject lazily.
  const startObserver = (): void => {
    if (!document.body) {
      // body not ready yet — wait for DOMContentLoaded
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
      return;
    }
    if (shouldInject()) {
      requestInject();
      return;
    }
    const observer = new MutationObserver(() => {
      if (shouldInject()) {
        observer.disconnect();
        requestInject();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  startObserver();
}

/**
 * Main detection and injection logic
 */
async function detectAndInject(): Promise<void> {
  const path = document.location.pathname;
  const matchedExt = getMatchedExtension(path);

  // Not a supported extension — still check for diagram blocks on HTML pages.
  // GitLab issue/merge-request/wiki pages (e.g. /group/project/-/issues/2)
  // have no file extension but may contain diagram code blocks.
  if (!matchedExt) {
    const contentType = (document as unknown as DocumentWithContentType).contentType
      || (document as unknown as DocumentWithContentType).mimeType;
    if (contentType && contentType.includes('text/html')) {
      detectHtmlPageContent();
    }
    return;
  }

  // HTML files: only request element-runtime injection if the page actually
  // contains a <markdown-viewer> tag or diagram code blocks. Otherwise
  // injecting CSS+JS would have global side effects (e.g. ui/styles.css
  // sets body{overflow:hidden}) and break unrelated websites.
  if (matchedExt === '.html') {
    detectHtmlPageContent();
    return;
  }

  // Check if content is processable
  const processable = isProcessableContent();
  if (processable === null) {
    document.addEventListener('DOMContentLoaded', () => {
      void detectAndInject();
    }, { once: true });
    return;
  }
  if (!processable) {
    // Page is HTML (e.g. GitHub blob page where URL ends in .md but content
    // type is text/html). Fall back to HTML page detection so diagram code
    // blocks on host sites can still be rendered.
    detectHtmlPageContent();
    return;
  }

  // Markdown files (including .slides.md) are always supported
  if (matchedExt === '.md' || matchedExt === '.markdown' || matchedExt === '.slides.md') {
    injectContentScript();
    return;
  }

  // Common text/code files should preview directly in reader mode.
  if (getCodePreviewMatchedExtension(matchedExt)) {
    injectContentScript();
    return;
  }

  // All other recognized non-HTML formats are now always previewed.
  injectContentScript();
}

// Run detection
detectAndInject();