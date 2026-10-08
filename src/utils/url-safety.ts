/**
 * URL policy shared by the HTML sanitizers.
 *
 * One definition of "a URL we are willing to keep in rendered markup":
 * fragment and document-relative references, the schemes the viewer actually
 * needs (http/https/file/mailto/tel/blob), and inline images/PDFs. Everything
 * else — `javascript:`, `vbscript:`, `data:text/javascript`, unknown schemes —
 * is rejected here and nowhere else, so no sanitizer grows its own idea of what
 * is dangerous.
 */

import { isDocumentRelativeUrl } from './document-url';

/** Schemes the viewer legitimately links to or loads from. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'file:', 'mailto:', 'tel:', 'blob:']);

/** `name:` prefix of an absolute URL, including unknown/obfuscated ones. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** `C:\path` / `C:/path` — a filesystem path, not a `c:` URL scheme. */
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/**
 * Validate URL values and block javascript-style protocols
 * @param url - URL to validate
 * @returns True when URL is considered safe
 */
export function isSafeUrl(url: string | null | undefined): boolean {
  if (!url) return true;

  // Match browser URL parsing: tabs/newlines are removed, and leading/trailing
  // C0 controls are ignored. Validate the protocol after that normalization.
  const trimmed = url.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  if (!trimmed || trimmed.startsWith('#')) return true;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text/javascript')) {
    return false;
  }

  if (lower.startsWith('data:')) {
    return lower.startsWith('data:image/') || lower.startsWith('data:application/pdf');
  }

  // Allow document-relative URLs via shared URL policy.
  if (WINDOWS_DRIVE.test(trimmed) || isDocumentRelativeUrl(trimmed)) {
    return true;
  }

  try {
    const parsed = new URL(trimmed, resolveBaseUri());
    return SAFE_SCHEMES.has(parsed.protocol);
  } catch {
    // Without a base URI a relative URL cannot be parsed, which is fine; an
    // absolute URL that does not parse is not something to keep around.
    const scheme = trimmed.match(URL_SCHEME);
    return scheme ? SAFE_SCHEMES.has(`${scheme[1].toLowerCase()}:`) : true;
  }
}

/**
 * Validate that every URL candidate in a srcset attribute is safe
 * @param value - Raw srcset value
 * @returns True when every entry is safe
 */
export function isSafeSrcset(value: string | null | undefined): boolean {
  if (!value) return true;
  return value.split(',').every((candidate) => {
    const urlPart = candidate.trim().split(/\s+/)[0];
    return isSafeUrl(urlPart);
  });
}

/**
 * Base URI for parsing relative URLs. The viewer always has one (the
 * extension/CLI page); the fallback keeps sanitizing usable in tests and in
 * DOM-less environments instead of throwing.
 */
function resolveBaseUri(): string | undefined {
  try {
    return typeof document !== 'undefined' ? document.baseURI : undefined;
  } catch {
    return undefined;
  }
}
