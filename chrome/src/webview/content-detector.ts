// Lightweight content script for detecting Markdown files
// This script runs on all pages to check if they are Markdown files
// Supports both Chrome (chrome.*) and Firefox (browser.*) APIs

// Use browser API if available (Firefox), otherwise use chrome API
const runtime = typeof browser !== 'undefined' ? browser : chrome;

/**
 * Supported file extensions configuration
 */
interface SupportedExtensions {
  mermaid: boolean;
  vega: boolean;
  vegaLite: boolean;
  dot: boolean;
  infographic: boolean;
}

/**
 * Map file extension to settings key
 */
function getExtensionSettingsKey(ext: string): keyof SupportedExtensions | null {
  const map: Record<string, keyof SupportedExtensions> = {
    '.mermaid': 'mermaid',
    '.vega': 'vega',
    '.vl': 'vegaLite',
    '.vega-lite': 'vegaLite',    '.gv': 'dot',    '.dot': 'dot',
    '.infographic': 'infographic',
  };
  return map[ext] || null;
}

/**
 * Check if file extension requires settings check (non-markdown extensions)
 */
function getMatchedExtension(path: string): string | null {
  const lowerPath = path.toLowerCase();
  const extensions = [
    '.md', '.markdown',
    '.mermaid',
    '.vega',
    '.vl', '.vega-lite',
    '.gv', '.dot',
    '.infographic',
    '.html'
  ];
  
  for (const ext of extensions) {
    if (lowerPath.endsWith(ext)) {
      return ext;
    }
  }
  return null;
}

/**
 * Check if this is a processable file based on content type and structure
 */
function isProcessableContent(): boolean {
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
  // This prevents the flash of plain text before the extension renders
  const style = document.createElement('style');
  style.id = 'markdown-viewer-preload';
  style.textContent = `
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
  const sendPromise = runtime.runtime.sendMessage(request);
  if (sendPromise && typeof sendPromise.then === 'function') {
    sendPromise.catch(() => {
      // Ignore errors - fire and forget
    });
  }
}

/**
 * Main detection and injection logic
 */
async function detectAndInject(): Promise<void> {
  const path = document.location.pathname;
  const matchedExt = getMatchedExtension(path);

  // Not a supported extension
  if (!matchedExt) {
    return;
  }

  // Check if content is processable
  if (!isProcessableContent()) {
    return;
  }

  // Markdown files are always supported
  if (matchedExt === '.md' || matchedExt === '.markdown') {
    injectContentScript();
    return;
  }

  // HTML files are never supported (would interfere with normal browsing)
  if (matchedExt === '.html') {
    return;
  }

  // For other extensions, check settings
  const settingsKey = getExtensionSettingsKey(matchedExt);
  if (!settingsKey) {
    return;
  }

  try {
    const result = await runtime.storage.local.get(['markdownViewerSettings']);
    const settings = result.markdownViewerSettings as { supportedExtensions?: SupportedExtensions } | undefined;
    
    // Default settings if not configured
    const defaultExtensions: SupportedExtensions = {
      mermaid: true,
      vega: true,
      vegaLite: true,
      dot: true,
      infographic: true,
    };

    const extensions = settings?.supportedExtensions || defaultExtensions;
    
    if (extensions[settingsKey]) {
      injectContentScript();
    }
  } catch (error) {
    // On error, use default behavior (inject)
    injectContentScript();
  }
}

// Run detection
detectAndInject();