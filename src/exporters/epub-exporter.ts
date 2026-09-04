/**
 * EPUB Book Exporter — whole-book EPUB generation.
 *
 * Pipeline mirrors the existing book export paths:
 * - Markdown → HTML uses the same processor as the viewer/print path
 *   (KaTeX math, syntax highlighting, diagram plugins via AsyncTaskManager).
 * - Math follows the HTML export pattern: KaTeX HTML output plus the KaTeX
 *   stylesheet with font files embedded as data URLs (EPUBs are offline
 *   containers, so there is no CDN to reference).
 * - Images follow the DOCX pattern: every `<img>` is embedded to a data URL
 *   via ResourceEmbedder before packaging, so EPUB generation needs neither
 *   extra permissions nor CORS-capable servers.
 * - Packaging uses a local JSZip-based EPUB 3 writer (no runtime template
 *   compilation / eval), so it is fully compatible with extension CSP.
 *   The resulting Blob flows through the same platform download pipeline as
 *   DOCX exports.
 */

import type { DocumentService } from '../types/platform';
import type { BookTocEntry } from '../types/book-export';
import JSZip from 'jszip';
import { collectEpubCss } from './export-styles';
import { downloadBlob } from './docx-download';
import { EPUB_MIME_TYPE, toEpubFilename } from './epub-utils';
import { exportToHtml } from './html-exporter';

/**
 * A single book chapter: preprocessed markdown plus its navigation title.
 */
export interface EpubChapterInput {
  title: string;
  html: string;
}

export interface EpubRenderedChapterInput {
  title: string;
  container: HTMLElement;
}

export interface EpubProgressHandler {
  (phase: 'render' | 'convert' | 'pack', done: number, total: number): void;
}

export interface ExportToEpubOptions {
  container?: HTMLElement;
  chapters?: EpubRenderedChapterInput[];
  tocEntries?: BookTocEntry[];
  /** Book title (EPUB metadata + fallback filename) */
  title: string;
  /** Output filename (may include or omit the .epub extension) */
  filename?: string;
  /** Optional platform document service for local-file image reads */
  documentService?: DocumentService;
  onProgress?: EpubProgressHandler;
  signal?: AbortSignal;
}

export interface EpubExportResult {
  success: boolean;
  error?: string;
  filename?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface RenderedChapter {
  title: string;
  contentRootHtml: string;
}

function ensureWrappedContentRoot(contentRootHtml: string): string {
  if (/^\s*<[^>]+\bid=(['"])markdown-content\1/i.test(contentRootHtml)) {
    return contentRootHtml;
  }
  return `<div id="markdown-content" class="markdown-viewer-content">${contentRootHtml}</div>`;
}

interface PackagedImage {
  id: string;
  href: string;
  mediaType: string;
  data: Uint8Array;
}

interface EpubChapterFile {
  id: string;
  href: string;
  title: string;
  xhtml: string;
}

interface EpubTocNode {
  type: 'heading' | 'page';
  title: string;
  href: string | null;
  depth: number;
  children: EpubTocNode[];
}

async function renderSingleDocumentChapter(options: ExportToEpubOptions): Promise<RenderedChapter> {
  const { container, title, documentService, onProgress, signal } = options;
  if (!container) {
    throw new Error('Single-document EPUB export requires a rendered container');
  }
  signal?.throwIfAborted();
  onProgress?.('render', 0, 1);

  const htmlResult = await exportToHtml({
    container,
    filename: title,
    title,
    documentService,
    includeKatexCdn: false,
    onProgress: () => {
      // EPUB progress is reported at the flow layer.
    },
  });

  if (!htmlResult.success || !htmlResult.html) {
    throw new Error(htmlResult.error || 'Failed to serialize rendered HTML');
  }

  const parsed = new DOMParser().parseFromString(htmlResult.html, 'text/html');
  const contentRoot = parsed.querySelector('#markdown-content') as HTMLElement | null;
  if (!contentRoot) {
    throw new Error('Serialized HTML is missing #markdown-content');
  }

  onProgress?.('render', 1, 1);
  return { title, contentRootHtml: ensureWrappedContentRoot(contentRoot.outerHTML) };
}

async function renderChapterContainers(options: ExportToEpubOptions): Promise<RenderedChapter[]> {
  const { chapters, documentService, onProgress, signal } = options;
  if (!chapters || chapters.length === 0) {
    throw new Error('Whole-book EPUB export requires rendered chapter containers');
  }

  const rendered: RenderedChapter[] = [];
  const total = chapters.length;
  for (let i = 0; i < total; i++) {
    signal?.throwIfAborted();
    const chapter = chapters[i];
    const htmlResult = await exportToHtml({
      container: chapter.container,
      filename: chapter.title,
      title: chapter.title,
      documentService,
      includeKatexCdn: false,
      onProgress: () => {
        // EPUB progress is reported at the flow layer.
      },
    });

    if (!htmlResult.success || !htmlResult.html) {
      throw new Error(htmlResult.error || `Failed to serialize chapter: ${chapter.title}`);
    }

    const parsed = new DOMParser().parseFromString(htmlResult.html, 'text/html');
    const contentRoot = parsed.querySelector('#markdown-content') as HTMLElement | null;
    if (!contentRoot) {
      throw new Error(`Serialized HTML is missing #markdown-content for chapter: ${chapter.title}`);
    }

    rendered.push({ title: chapter.title, contentRootHtml: ensureWrappedContentRoot(contentRoot.outerHTML) });
    onProgress?.('render', i + 1, total);
  }

  return rendered;
}

function slugifyChapterTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[-\s]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return slug || 'chapter';
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getCurrentIsoDate(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function getCurrentYear(): string {
  return String(new Date().getFullYear());
}

function createBookId(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `book-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function dataUrlToBytes(dataUrl: string): { mediaType: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:([^;,]+)((?:;[^,]+)*?),(.*)$/s);
  if (!match) {
    throw new Error('Invalid data URL format');
  }

  const mediaType = match[1] || 'application/octet-stream';
  const metadata = match[2] || '';
  const payload = match[3] || '';
  const isBase64 = /;base64/i.test(metadata);

  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { mediaType, bytes };
  }

  return { mediaType, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

function extensionForMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/avif': 'avif',
  };
  return map[normalized] || 'bin';
}

function rewriteImagesForEpub(html: string, chapterIndex: number): { html: string; images: PackagedImage[] } {
  const seen = new Map<string, PackagedImage>();
  let imageCounter = 0;

  const rewritten = html.replace(/<img\b[^>]*\bsrc=(['"])(data:[^'"]+)\1[^>]*>/gi, (tag, quote: string, src: string) => {
    let image = seen.get(src);
    if (!image) {
      const decoded = dataUrlToBytes(src);
      const extension = extensionForMediaType(decoded.mediaType);
      const id = `img-${chapterIndex + 1}-${imageCounter + 1}`;
      image = {
        id,
        href: `images/${id}.${extension}`,
        mediaType: decoded.mediaType,
        data: decoded.bytes,
      };
      seen.set(src, image);
      imageCounter += 1;
    }

    return tag
      .replace(src, image.href)
      .replace(/\s+srcset=(['"])[^'"]*\1/gi, '');
  });

  return { html: rewritten, images: Array.from(seen.values()) };
}

function serializeChapterBodyAsXhtml(contentRootHtml: string): string {
  const xhtmlDocument = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'div', null);
  const placeholder = xhtmlDocument.documentElement;

  const htmlDocument = document.implementation.createHTMLDocument('');
  const container = htmlDocument.createElement('div');
  container.innerHTML = contentRootHtml;

  const sourceRoot = container.firstElementChild as HTMLElement | null;
  if (!sourceRoot) {
    throw new Error('EPUB chapter is missing a content root element');
  }

  const wrapper = xhtmlDocument.createElementNS('http://www.w3.org/1999/xhtml', sourceRoot.tagName.toLowerCase());
  for (const attr of Array.from(sourceRoot.attributes)) {
    wrapper.setAttribute(attr.name, attr.value);
  }

  if (placeholder.parentNode) {
    placeholder.parentNode.replaceChild(wrapper, placeholder);
  }

  while (sourceRoot.firstChild) {
    const imported = xhtmlDocument.importNode(sourceRoot.firstChild, true);
    wrapper.appendChild(imported);
    sourceRoot.removeChild(sourceRoot.firstChild);
  }

  const serialized = new XMLSerializer().serializeToString(wrapper);
  return serialized.replace(/^<([a-z0-9-]+) xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/i, '<$1');
}

function buildChapterXhtml(lang: string, title: string, contentRootHtml: string): string {
  const bodyContent = serializeChapterBodyAsXhtml(contentRootHtml);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  ${bodyContent}
</body>
</html>`;
}

function mapTocEntriesToChapterFiles(tocEntries: BookTocEntry[] | undefined, chapters: EpubChapterFile[]): BookTocEntry[] {
  const sourceEntries = tocEntries && tocEntries.length > 0
    ? tocEntries
    : chapters.map((chapter) => ({ type: 'page' as const, title: chapter.title, href: chapter.href, depth: 0 }));

  let pageIndex = 0;
  return sourceEntries.flatMap<BookTocEntry>((entry) => {
    if (entry.type === 'heading') {
      return [entry];
    }

    const chapter = chapters[pageIndex];
    pageIndex += 1;
    if (!chapter) {
      return [];
    }

    return [{ ...entry, href: chapter.href }];
  });
}

function buildTocTree(entries: BookTocEntry[]): EpubTocNode[] {
  const root: EpubTocNode = {
    type: 'heading',
    title: '',
    href: null,
    depth: -1,
    children: [],
  };
  const stack: EpubTocNode[] = [root];

  for (const entry of entries) {
    const node: EpubTocNode = {
      type: entry.type,
      title: entry.title,
      href: entry.type === 'page' ? entry.href : null,
      depth: entry.depth,
      children: [],
    };

    while (stack.length > 1 && stack[stack.length - 1].depth >= entry.depth) {
      stack.pop();
    }

    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  const assignFallbackHref = (nodes: EpubTocNode[]): string | null => {
    let firstHref: string | null = null;
    for (const node of nodes) {
      const childHref = assignFallbackHref(node.children);
      if (!node.href) {
        node.href = childHref;
      }
      if (!firstHref && node.href) {
        firstHref = node.href;
      }
    }
    return firstHref;
  };

  assignFallbackHref(root.children);
  return root.children;
}

function renderNavList(nodes: EpubTocNode[], indent = '      '): string {
  return nodes.map((node) => {
    const label = node.type === 'page' && node.href
      ? `<a href="${escapeXml(node.href)}">${escapeXml(node.title)}</a>`
      : `<span>${escapeXml(node.title)}</span>`;
    const children = node.children.length > 0
      ? `\n${indent}  <ol>\n${renderNavList(node.children, `${indent}    `)}\n${indent}  </ol>`
      : '';
    return `${indent}<li>${label}${children}</li>`;
  }).join('\n');
}

function buildNavDocument(lang: string, title: string, tocTree: EpubTocNode[]): string {
  const items = renderNavList(tocTree);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXml(title)}</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

function buildNcxDocument(lang: string, title: string, bookId: string, tocTree: EpubTocNode[]): { document: string; depth: number } {
  let playOrder = 1;
  let maxDepth = 1;

  const renderNodes = (nodes: EpubTocNode[], level: number, indent: string): string => {
    if (nodes.length === 0) {
      return '';
    }

    maxDepth = Math.max(maxDepth, level);
    return nodes.map((node) => {
      const pointId = `navPoint-${playOrder}`;
      const pointOrder = playOrder;
      playOrder += 1;
      const children = renderNodes(node.children, level + 1, `${indent}  `);
      const childBlock = children ? `\n${children}\n${indent}` : '';
      return `${indent}<navPoint id="${pointId}" playOrder="${pointOrder}">
${indent}  <navLabel><text>${escapeXml(node.title)}</text></navLabel>
${indent}  <content src="${escapeXml(node.href || '')}"/>${childBlock}</navPoint>`;
    }).join('\n');
  };

  const navPoints = renderNodes(tocTree.filter((node) => Boolean(node.href)), 1, '    ');

  return {
    depth: maxDepth,
    document: `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeXml(lang)}">
  <head>
    <meta name="dtb:uid" content="${escapeXml(bookId)}"/>
    <meta name="dtb:depth" content="${escapeXml(String(maxDepth))}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`,
  };
}

function buildContentOpf(options: {
  bookId: string;
  title: string;
  lang: string;
  chapters: EpubChapterFile[];
  images: PackagedImage[];
  tocDepth: number;
}): string {
  const { bookId, title, lang, chapters, images, tocDepth } = options;
  const now = getCurrentIsoDate();
  const year = getCurrentYear();

  const manifestItems = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '    <item id="style" href="style.css" media-type="text/css"/>',
    ...chapters.map((chapter) => `    <item id="${escapeXml(chapter.id)}" href="${escapeXml(chapter.href)}" media-type="application/xhtml+xml"/>`),
    ...images.map((image) => `    <item id="${escapeXml(image.id)}" href="${escapeXml(image.href)}" media-type="${escapeXml(image.mediaType)}"/>`),
  ].join('\n');

  const spineItems = [
    // The nav document must stay in the spine (EPUB spec). For single-file
    // books it is non-linear so readers open directly on the content instead
    // of a forced one-item TOC page; whole books keep the linear TOC first.
    chapters.length > 1
      ? '    <itemref idref="nav" linear="yes"/>'
      : '    <itemref idref="nav" linear="no"/>',
    ...chapters.map((chapter) => `    <itemref idref="${escapeXml(chapter.id)}"/>`),
  ].join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf"
         version="3.0"
         unique-identifier="BookId"
         xml:lang="${escapeXml(lang)}"
         prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${escapeXml(bookId)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(lang)}</dc:language>
    <dc:creator>docu.md Markdown Viewer</dc:creator>
    <dc:publisher>docu.md Markdown Viewer</dc:publisher>
    <dc:date>${escapeXml(now)}</dc:date>
    <dc:rights>Copyright &#x00A9; ${escapeXml(year)} by docu.md Markdown Viewer</dc:rights>
    <meta property="dcterms:modified">${escapeXml(now)}</meta>
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`;
}

async function packageEpub(options: {
  title: string;
  lang: string;
  styles: string;
  chapters: RenderedChapter[];
  tocEntries?: BookTocEntry[];
  onProgress?: EpubProgressHandler;
  signal?: AbortSignal;
}): Promise<Blob> {
  const { title, lang, styles, chapters, onProgress, signal } = options;
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  const metaInf = zip.folder('META-INF');
  const oebps = zip.folder('OEBPS');
  if (!metaInf || !oebps) {
    throw new Error('Failed to initialize EPUB archive');
  }

  metaInf.file('container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>');
  oebps.file('style.css', styles);

  const chapterFiles: EpubChapterFile[] = [];
  const imagesByHref = new Map<string, PackagedImage>();
  const total = chapters.length;

  for (let i = 0; i < total; i++) {
    signal?.throwIfAborted();
    const chapter = chapters[i];
    const slug = slugifyChapterTitle(chapter.title);
    const id = `chapter-${i + 1}`;
    const href = `${String(i).padStart(2, '0')}-${slug}.xhtml`;
    const rewritten = rewriteImagesForEpub(chapter.contentRootHtml, i);
    rewritten.images.forEach((image) => {
      if (!imagesByHref.has(image.href)) {
        imagesByHref.set(image.href, image);
      }
    });
    const xhtml = buildChapterXhtml(lang, chapter.title, rewritten.html);
    chapterFiles.push({ id, href, title: chapter.title, xhtml });
    oebps.file(href, xhtml);
    onProgress?.('convert', i + 2, total + 2);
  }

  const imagesFolder = oebps.folder('images');
  if (!imagesFolder) {
    throw new Error('Failed to initialize EPUB image folder');
  }
  Array.from(imagesByHref.values()).forEach((image) => {
    imagesFolder.file(image.href.replace(/^images\//, ''), image.data);
  });

  const tocTree = buildTocTree(mapTocEntriesToChapterFiles(options.tocEntries, chapterFiles));
  const bookId = createBookId();
  const ncx = buildNcxDocument(lang, title, bookId, tocTree);
  oebps.file('nav.xhtml', buildNavDocument(lang, title, tocTree));
  oebps.file('toc.ncx', ncx.document);
  oebps.file('content.opf', buildContentOpf({
    bookId,
    title,
    lang,
    chapters: chapterFiles,
    images: Array.from(imagesByHref.values()),
    tocDepth: ncx.depth,
  }));

  return zip.generateAsync({
    type: 'blob',
    mimeType: EPUB_MIME_TYPE,
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

/**
 * Export a list of preprocessed chapters to a single EPUB file and download
 * it through the platform file service.
 *
 * Math is rendered as KaTeX HTML (same as HTML export); the KaTeX stylesheet
 * with embedded fonts is collected from the live viewer document, so the
 * ebook matches the on-screen theme.
 */
export async function exportToEpub(options: ExportToEpubOptions): Promise<EpubExportResult> {
  const { title, filename: filenameOption, onProgress, signal } = options;

  try {
    const epubFilename = toEpubFilename(filenameOption || title);

    // 1. Reuse the current rendered DOM via the HTML export pipeline.
    const rendered = options.chapters
      ? await renderChapterContainers(options)
      : [await renderSingleDocumentChapter(options)];

    // 2. Collect viewer styles with embedded fonts (convert phase).
    onProgress?.('convert', 0, 2);
    const styles = await collectEpubCss();
    onProgress?.('convert', 1, 2);

    // 3. Package the EPUB (convert phase) without runtime template eval.
    signal?.throwIfAborted();
    const blob = await packageEpub({
      title,
      lang: (typeof document !== 'undefined' && document.documentElement?.lang) || 'en',
      styles,
      chapters: rendered,
      tocEntries: options.tocEntries,
      onProgress,
      signal,
    });

    // 4. Download through the platform pipeline (pack phase).
    await downloadBlob(blob, epubFilename, (uploaded, total) => {
      onProgress?.('pack', uploaded, total);
    }, EPUB_MIME_TYPE);

    return { success: true, filename: epubFilename };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg === 'Download cancelled by user') {
      throw error;
    }
    return { success: false, error: errMsg };
  }
}
