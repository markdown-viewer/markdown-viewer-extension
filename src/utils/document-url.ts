/**
 * Utilities for normalizing document-relative URLs consistently across plugins.
 */

/**
 * True when URL points to an absolute/special scheme and should not be prefixed.
 */
export function isSpecialAbsoluteUrl(url: string): boolean {
  if (!url) return false;

  const lower = url.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vscode-webview-resource:') ||
    lower.startsWith('vscode-resource:') ||
    lower.startsWith('//')
  ) {
    return true;
  }

  // Generic scheme detection, e.g. mailto:, tel:, custom-scheme:
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/**
 * True when URL should be opened externally (http/https/mailto/tel/custom schemes).
 */
export function isExternalUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();

  // Explicitly not "external navigation".
  if (
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vscode-webview-resource:') ||
    lower.startsWith('vscode-resource:')
  ) {
    return false;
  }

  return isSpecialAbsoluteUrl(url);
}

/**
 * True when URL is a network URL (http/https or protocol-relative //).
 */
export function isNetworkUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//');
}

/**
 * True when URL is document-relative and may need a leading ./.
 */
export function isDocumentRelativeUrl(url: string): boolean {
  if (!url) return false;
  if (isSpecialAbsoluteUrl(url)) return false;
  if (url.startsWith('#') || url.startsWith('?')) return false;
  return true;
}

/**
 * Ensure relative URL starts with ./ or ../ (or absolute /).
 */
export function ensureRelativeDotSlash(url: string): string {
  if (!isDocumentRelativeUrl(url)) {
    return url;
  }

  if (url.startsWith('./') || url.startsWith('../') || url.startsWith('/')) {
    return url;
  }

  return `./${url}`;
}

/**
 * Split href into path and hash fragment (without leading '#').
 */
export function splitPathAndFragment(href: string): { path: string; fragment?: string } {
  const hashIndex = href.indexOf('#');
  if (hashIndex < 0) {
    return { path: href };
  }

  const path = href.slice(0, hashIndex);
  const fragment = href.slice(hashIndex + 1);
  return fragment ? { path, fragment } : { path };
}

/**
 * Remove a leading ./ when joining with a base URI.
 */
export function stripLeadingDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * Check whether a path is an absolute filesystem path.
 */
export function isAbsoluteFilesystemPath(path: string): boolean {
  return path.startsWith('file://') || path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
}
