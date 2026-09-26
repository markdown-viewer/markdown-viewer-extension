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
 * True when a path belongs to the root of the location hosting the document,
 * e.g. `/assets/logo.png` (and the protocol-relative `//host/logo.png`).
 *
 * Such a path is not necessarily a filesystem path: the root it belongs to is
 * the disk for a local document but the site for a remote one, so callers must
 * let the platform document service decide how to read it.
 */
export function isRootRelativeUrl(url: string): boolean {
  return url.startsWith('/');
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

/** Schemes whose URLs are hierarchical, so a trailing query/hash is not content. */
const HIERARCHICAL_URL = /^(?:https?|file):\/\//i;

/**
 * Drop a URL's query string and hash so callers can match the file name.
 *
 * Remote URLs routinely carry a query *after* the file name — a SAS token
 * (`.../job-logs.txt?sv=2025-11-05&sig=…`), a cache buster, tracking params —
 * which defeats every `endsWith('.txt')`-style extension check on the full
 * URL even though the path clearly names a .txt file.
 *
 * Only hierarchical URLs (`http:`, `https:`, `file:`, protocol-relative
 * `//host/...`) are cut: '?' and '#' are legal characters in a plain
 * filesystem path, and `data:`/`blob:` payloads may contain them verbatim, so
 * everything else is returned unchanged.
 */
export function stripUrlQueryAndHash(url: string): string {
  if (!url || (!HIERARCHICAL_URL.test(url) && !url.startsWith('//'))) {
    return url;
  }

  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}
