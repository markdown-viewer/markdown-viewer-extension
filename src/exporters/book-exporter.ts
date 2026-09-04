/**
 * Book Exporter — GitBook whole-book export core.
 *
 * Platform-agnostic: page fetching, per-page preprocessing (frontmatter strip,
 * relative URL absolutization, heading level shifting), merged markdown
 * assembly for DOCX export, and per-chapter assembly for EPUB export.
 * The DOCX conversion reuses the existing DocxExporter; the EPUB conversion
 * lives in epub-exporter.ts (both dynamically imported to avoid circular
 * dependencies).
 *
 * DOM/print rendering (PDF path) lives in book-renderer.ts.
 */

import type {
  BookExportDocxResult,
  BookExportEpubResult,
  BookExportProgressHandler,
  BookPage,
  BookTocEntry,
  BookTocHeading,
  BookTocPage,
} from '../types/book-export';
import type { PluginRenderer } from '../types/plugin';
import type { TranslateFunction } from '../types/core';
import type { DocumentService } from '../types/platform';

// ============================================================================
// Markers
// ============================================================================

/**
 * Chapter page-break marker inserted between merged book pages.
 * Recognized by the DOCX exporter (same pattern as [toc]) so that every
 * source file starts on a new page, independent of the user's
 * `docxHrDisplay` setting.
 */
export const BOOK_PAGE_BREAK_MARKER = '[pagebreak]';

// ============================================================================
// Preprocessing
// ============================================================================

const FRONTMATTER_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const ATX_HEADING_RE = /^(#{1,6})\s+(.+)$/;
const INLINE_LINK_RE = /(!?\[[^\]]*\])\s*\(\s*(<[^>]*>|[^)\s]+)((?:\s+["'][^"']*["'])?)\s*\)/g;
const REF_DEFINITION_RE = /^\[([^\]]+)\]:\s*(\S+)(?:\s+(?:".*"|'.*'|\(.*\)))?\s*$/gm;

function isAbsoluteUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

/**
 * Rewrite relative image/link URLs (inline and reference definitions) to
 * absolute URLs resolved against the page's own URL. The DOCX exporter and
 * the HTML print renderer both work with a single base URL, so absolutizing
 * at merge time is what allows per-page relative paths to keep working.
 */
export function absolutizeMarkdownUrls(markdown: string, baseUrl: string): string {
  const resolve = (raw: string): string => {
    if (isAbsoluteUrl(raw) || raw.startsWith('#') || raw.startsWith('data:')) {
      return raw;
    }
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return raw;
    }
  };

  let result = markdown.replace(INLINE_LINK_RE, (match, prefix: string, rawUrl: string, rest: string) => {
    const isAngle = rawUrl.startsWith('<') && rawUrl.endsWith('>');
    const url = isAngle ? rawUrl.slice(1, -1) : rawUrl;
    const resolved = resolve(url);
    return `${prefix}(${isAngle ? `<${resolved}>` : resolved}${rest})`;
  });

  result = result.replace(REF_DEFINITION_RE, (match, id: string, url: string) => `[${id}]: ${resolve(url)}`);

  return result;
}

/**
 * Find the level of the first ATX heading in a markdown document (0 if none).
 */
export function findFirstHeadingLevel(markdown: string): number {
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(ATX_HEADING_RE);
    if (match) {
      return match[1].length;
    }
  }
  return 0;
}

/**
 * Shift all ATX heading levels by `shift` (clamped to 1..6).
 */
export function shiftHeadingLevels(markdown: string, shift: number): string {
  if (shift === 0) {
    return markdown;
  }
  return markdown.replace(/^(#{1,6})(?=\s)/gm, (match, hashes: string) => {
    const level = Math.max(1, Math.min(6, hashes.length + shift));
    return '#'.repeat(level);
  });
}

export interface PreprocessPageOptions {
  /** Book-tree depth of the page (0 = top level) */
  depth?: number;
  /** Navigation title, used as a generated H1 when the page has no heading */
  chapterTitle?: string;
}

/**
 * Prepare a single book page for merging into a whole-book document:
 * 1. Strip YAML frontmatter (book export always uses 'hide' display mode).
 * 2. Absolutize relative URLs against the page's own URL.
 * 3. Shift heading levels so the page's first heading becomes H1
 *    (+1 additional level per nested depth). Pages without any heading get
 *    a generated H1 from the navigation title.
 */
export function preprocessPage(markdown: string, pageUrl: string, options: PreprocessPageOptions = {}): string {
  const { depth = 0, chapterTitle = '' } = options;

  let content = markdown.replace(/^\uFEFF/, '');
  content = content.replace(FRONTMATTER_RE, '');
  content = absolutizeMarkdownUrls(content, pageUrl);

  const firstLevel = findFirstHeadingLevel(content);
  if (firstLevel > 0) {
    // First heading aligns to the chapter level: H1 for top-level pages,
    // H(1+depth) for nested sections.
    const shift = 1 + depth - firstLevel;
    content = shiftHeadingLevels(content, shift);
  } else if (chapterTitle) {
    content = `# ${chapterTitle}\n\n${content}`;
  }

  return content;
}

// ============================================================================
// Merged markdown assembly
// ============================================================================

export interface BuildMergedMarkdownOptions {
  pages: BookPage[];
  navEntries?: BookTocEntry[];
  fetchPage: (href: string) => Promise<string>;
  onProgress?: BookExportProgressHandler;
  signal?: AbortSignal;
}

export interface BookMergedMarkdownResult {
  markdown: string;
  /** Pages that failed to fetch (export continues with the rest) */
  skipped: { href: string; error: string }[];
  totalPages: number;
}

function toBookTocEntries(pages: BookPage[]): BookTocPage[] {
  return pages.map((page) => ({ type: 'page', title: page.title, href: page.href, depth: page.depth }));
}

function isBookTocPage(entry: BookTocEntry): entry is BookTocPage {
  return entry.type === 'page';
}

function headingLineForDepth(depth: number, title: string): string {
  const level = Math.max(1, Math.min(6, depth + 1));
  return `${'#'.repeat(level)} ${title}`;
}

function diffHeadingPath(nextPath: BookTocHeading[], currentPath: BookTocHeading[]): string {
  let shared = 0;
  while (
    shared < nextPath.length
    && shared < currentPath.length
    && nextPath[shared].depth === currentPath[shared].depth
    && nextPath[shared].title === currentPath[shared].title
  ) {
    shared += 1;
  }

  return nextPath
    .slice(shared)
    .map((heading) => headingLineForDepth(heading.depth, heading.title))
    .join('\n\n');
}

/**
 * Fetch every book page in SUMMARY order, preprocess it, and join the pages
 * with [pagebreak] markers so each source file starts on a new page.
 * Individual page failures are collected and do not abort the export.
 */
export async function buildMergedMarkdown(options: BuildMergedMarkdownOptions): Promise<BookMergedMarkdownResult> {
  const { pages, navEntries = toBookTocEntries(pages), fetchPage, onProgress, signal } = options;
  const parts: string[] = [];
  const skipped: { href: string; error: string }[] = [];
  const total = pages.length;
  const activeHeadingPath: BookTocHeading[] = [];
  let emittedHeadingPath: BookTocHeading[] = [];
  let processedPages = 0;

  for (const entry of navEntries) {
    signal?.throwIfAborted();
    if (!isBookTocPage(entry)) {
      activeHeadingPath[entry.depth] = entry;
      activeHeadingPath.length = entry.depth + 1;
      continue;
    }

    const page = entry;
    try {
      const raw = await fetchPage(page.href);
      const processed = preprocessPage(raw, page.href, { depth: page.depth, chapterTitle: page.title });
      const pageHeadingPath: BookTocHeading[] = activeHeadingPath
        .filter((heading) => heading.depth < page.depth)
        .map((heading) => ({ type: 'heading' as const, title: heading.title, depth: heading.depth }));
      const headingBlock = diffHeadingPath(pageHeadingPath, emittedHeadingPath);

      if (processedPages > 0 && parts.length > 0) {
        parts.push(`\n\n${BOOK_PAGE_BREAK_MARKER}\n\n`);
      }
      if (headingBlock) {
        parts.push(`${headingBlock}\n\n`);
      }
      parts.push(processed.trim());
      emittedHeadingPath = pageHeadingPath;
      processedPages += 1;
    } catch (error) {
      skipped.push({ href: page.href, error: error instanceof Error ? error.message : String(error) });
    }
    onProgress?.('fetch', processedPages + skipped.length, total);
  }

  return { markdown: parts.join('\n'), skipped, totalPages: total };
}

// ============================================================================
// DOCX book export
// ============================================================================

export interface ExportBookToDocxOptions {
  pages: BookPage[];
  navEntries?: BookTocEntry[];
  /**
   * Book title rendered as the title-page heading. Only used when non-empty:
   * the title page is omitted entirely when there is no suitable title
   * (the directory name is NOT forced as the document title).
   */
  bookTitle?: string | null;
  /** Output filename (may include or omit the .docx extension) */
  filename?: string;
  fetchPage: (href: string) => Promise<string>;
  /** Diagram renderer (mermaid/plantuml etc.); optional */
  renderer?: PluginRenderer | null;
  onProgress?: BookExportProgressHandler;
  signal?: AbortSignal;
}

/**
 * Assemble the whole-book document markdown: optional title-page heading,
 * [toc] field, page break, then the merged chapters. Without a suitable
 * title the document simply starts with the table of contents.
 */
export function buildBookDocumentMarkdown(bookTitle: string | null | undefined, chaptersMarkdown: string): string {
  const titleBlock = bookTitle ? [`# ${bookTitle}`, ''] : [];
  return [
    ...titleBlock,
    '[toc]',
    '',
    BOOK_PAGE_BREAK_MARKER,
    '',
    chaptersMarkdown,
  ].join('\n');
}

/**
 * Export a whole book to a single DOCX (title page only when a suitable
 * title exists). Reuses the full DocxExporter pipeline (theme, math, code
 * highlighting, tables, footnotes, images).
 */
export async function exportBookToDocx(options: ExportBookToDocxOptions): Promise<BookExportDocxResult> {
  const { pages, navEntries, bookTitle = null, filename: filenameOption, fetchPage, renderer = null, onProgress, signal } = options;

  const merged = await buildMergedMarkdown({ pages, navEntries, fetchPage, onProgress, signal });

  const markdown = buildBookDocumentMarkdown(bookTitle, merged.markdown);

  // Dynamically import to avoid circular dependencies (same pattern as viewer-host)
  const DocxExporterModule = await import('./docx-exporter');
  const DocxExporter = DocxExporterModule.default;
  const exporter = new DocxExporter(renderer);

  const baseName = (filenameOption || bookTitle || 'book').trim();
  const filename = baseName.toLowerCase().endsWith('.docx') ? baseName : `${baseName}.docx`;

  const result = await exporter.exportToDocx(markdown, filename, (completed, total) => {
    onProgress?.('convert', completed, total);
  });

  return {
    success: result.success,
    error: result.error,
    skippedCount: merged.skipped.length,
    filename: result.success ? filename : undefined,
  };
}

export interface ExportBookToEpubOptions {
  pages: BookPage[];
  navEntries?: BookTocEntry[];
  /**
   * Book title (EPUB metadata + fallback filename). Used when non-empty;
   * otherwise the filename option (or a generic name) is used.
   */
  bookTitle?: string | null;
  /** Output filename (may include or omit the .epub extension) */
  filename?: string;
  fetchPage: (href: string) => Promise<string>;
  /** Diagram renderer (mermaid/plantuml etc.); optional */
  renderer?: PluginRenderer | null;
  /**
   * Optional platform document service used to embed chapter images.
   * Without it, `ResourceEmbedder` cannot read local image files and every
   * relative/absolute image reference stays in the EPUB unembedded (broken).
   */
  documentService?: DocumentService | null;
  translate: TranslateFunction;
  /** Auto-merge empty table cells (mirrors the viewer setting) */
  tableMergeEmpty?: boolean;
  /** Table layout setting (mirrors the viewer setting) */
  tableLayout?: 'left' | 'center' | 'center-full-width';
  /** Standalone image layout setting (mirrors the viewer setting) */
  imageLayout?: 'left' | 'center';
  /** Diagram/chart layout setting (mirrors the viewer setting) */
  diagramLayout?: 'left' | 'center';
  onProgress?: BookExportProgressHandler;
  signal?: AbortSignal;
}

/**
 * Export a whole book to a single EPUB: each SUMMARY page becomes one
 * chapter. Math follows the HTML export pattern (KaTeX HTML + embedded
 * KaTeX fonts), images follow the DOCX pattern (data-URL embedding).
 */
export async function exportBookToEpub(options: ExportBookToEpubOptions): Promise<BookExportEpubResult> {
  const {
    pages,
    navEntries = toBookTocEntries(pages),
    bookTitle = null,
    filename: filenameOption,
    fetchPage,
    renderer = null,
    documentService = null,
    translate,
    tableMergeEmpty,
    tableLayout,
    imageLayout,
    diagramLayout,
    onProgress,
    signal,
  } = options;

  const BookRendererModule = await import('./book-renderer');
  const rendered = await BookRendererModule.renderBookForPrint({
    pages,
    fetchPage,
    renderer: renderer ?? { render: async () => null },
    translate,
    tableMergeEmpty,
    tableLayout,
    imageLayout,
    diagramLayout,
    onProgress,
    signal,
  });

  const title = (bookTitle || filenameOption || 'Book').trim();
  const filename = filenameOption || title;

  try {
    // Dynamically import to avoid circular dependencies (same pattern as viewer-host)
    const EpubExporterModule = await import('./epub-exporter');
    const chapterElements = Array.from(rendered.container.querySelectorAll('.book-chapter'));
    const result = await EpubExporterModule.exportToEpub({
      chapters: chapterElements.map((element, index) => ({
        title: pages[index]?.title || `Chapter ${index + 1}`,
        container: element as HTMLElement,
      })),
      tocEntries: navEntries,
      title,
      filename,
      documentService: documentService ?? undefined,
      onProgress: (phase, done, total) => {
        onProgress?.(phase, done, total);
      },
      signal,
    });

    return {
      success: result.success,
      error: result.error,
      skippedCount: 0,
      filename: result.success ? result.filename : undefined,
    };
  } finally {
    rendered.cleanup();
  }
}
