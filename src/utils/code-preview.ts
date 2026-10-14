/**
 * Code-reading routing shared by every host.
 *
 * This module answers two questions and nothing else:
 *   - is this path a file we read as code, and which language is it?
 *   - how do we wrap content in a fence for hosts that render *markdown*
 *     (panel hosts, the toolbar's raw-markdown fallback)?
 *
 * Presenting source is not one of them: the browser/workspace viewer renders
 * the independent source surface (`src/core/viewer/source-view.ts`), and the
 * panels show the host editor.
 */

import { EXT_LANG_MAP, CODE_PREVIEW_EXTENSIONS } from './extension-categories';
import { stripUrlQueryAndHash } from './document-url';

export function getCodePreviewMatchedExtension(path: string): string | null {
  // Match on the file name: a remote URL keeps its query (`.../logs.txt?sv=…`)
  // and hash *after* the extension, which would never match the plain suffix.
  const lowerPath = stripUrlQueryAndHash(path).toLowerCase();
  for (const ext of CODE_PREVIEW_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return ext;
    }
  }
  return null;
}

export function toCodeFenceLanguage(extWithDot: string): string {
  const key = extWithDot.replace(/^\./, '');
  if (key in EXT_LANG_MAP) {
    return EXT_LANG_MAP[key];
  }
  return key;
}

export function getCodeFenceLanguageForPath(path: string): string | null {
  const ext = getCodePreviewMatchedExtension(path);
  return ext ? toCodeFenceLanguage(ext) : null;
}

export function toFencedCode(markdown: string, language: string): string {
  const normalized = markdown.replace(/\n+$/, '');

  // Pick a fence longer than any backtick run in content so we never close early.
  const runs = normalized.match(/`+/g);
  const longestRun = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = '`'.repeat(Math.max(3, longestRun + 1));

  return `${fence}${language}\n${normalized}\n${fence}`;
}

export interface CodeReadingRenderResult {
  markdown: string;
  codeView: true;
  language: string;
}

/**
 * Unified code-reading entrypoint.
 *
 * Returns null when the target path should not be rendered as code-reading
 * mode. `markdown` is the fence a *markdown* host renders; the browser viewer
 * takes `language` (plus the raw content) and renders the source surface.
 *
 * An OpenAPI `.yaml` is *not* code-reading: it has its own document format
 * (`format: 'openapi'`), decided by the host from the content, so this helper
 * never has to know about it.
 */
export function buildCodeReadingRender(content: string, path: string): CodeReadingRenderResult | null {
  const language = getCodeFenceLanguageForPath(path);
  if (!language) {
    return null;
  }

  return {
    markdown: toFencedCode(content, language),
    codeView: true,
    language,
  };
}

