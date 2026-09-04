import mermaid from 'mermaid';

import { exportToHtml } from '../exporters/html-exporter';
import { collectEpubCss } from '../exporters/export-styles';
import { exportEpubFlow } from '../core/viewer/viewer-host';
import { renderMarkdownDocument, resetDocument } from '../core/viewer/viewer-controller';
import { handleRender, initRenderEnvironment } from '../renderers/render-worker-core';
import { loadAndApplyTheme } from '../utils/theme-to-css';
import type { DocumentService, PlatformAPI } from '../types/platform';
import type { RendererThemeConfig } from '../types/render';
import type { BookPage } from '../types/book-export';
import { DEFAULT_RENDER_SETTINGS } from '../config/settings.generated';

type FrontmatterDisplay = 'hide' | 'table' | 'raw';

export interface CliBrowserRenderRequest {
  markdown: string;
  filename: string;
  title?: string;
  theme?: string;
  language?: string;
  frontmatterDisplay?: FrontmatterDisplay;
  tableMergeEmpty?: boolean;
  tableLayout?: 'left' | 'center' | 'center-full-width';
  imageLayout?: 'left' | 'center';
  diagramLayout?: 'left' | 'center';
  /** First-line indent in em (0 = disabled); exercised via platform settings */
  firstLineIndent?: number;
  documentPath: string;
  documentDir: string;
  documentBaseUrl: string;
  fileReadUrl: string;
  resourceBaseUrl: string;
}

export interface CliBrowserDomSnapshot {
  pageHtml: string;
  contentClassName: string;
  contentStyle: string;
  blockquoteCount: number;
  imageCount: number;
  diagramBlockCount: number;
  tableCount: number;
}

export interface CliBookPageInput {
  /** Relative page path (resolved against the document directory). */
  href: string;
  title: string;
  depth?: number;
}

interface CliBookExportProgressSample {
  phase: 'fetch' | 'render' | 'convert' | 'pack';
  done: number;
  total: number;
  elapsedMs: number;
}

export type CliBookTocEntryInput =
  | { type: 'heading'; title: string; depth?: number }
  | { type: 'page'; href: string; title: string; depth?: number };

export interface CliBookDomSnapshot {
  /** Every chapter's content-root outerHTML (the book wrapper contract). */
  chapters: Array<{ href: string; html: string }>;
}

export interface CliDiagramRequest {
  /** Renderer type: mermaid / plantuml / dot / vega / vega-lite / drawio / echarts / svg / infographic / canvas. */
  diagramType: string;
  content: string;
  theme?: string;
  /** Resource base (server) — theme assets are fetched through it. */
  documentBaseUrl?: string;
  fileReadUrl?: string;
  resourceBaseUrl?: string;
}

export interface CliDiagramResult {
  svg?: string;
  pngBase64?: string;
  /** PlantUML renderers may also produce a DrawIO XML representation. */
  drawioXml?: string;
  width: number;
  height: number;
}

type CliBrowserApi = {
  render(request: CliBrowserRenderRequest): Promise<string>;
  snapshotDom(request: CliBrowserRenderRequest): Promise<CliBrowserDomSnapshot>;
  collectEpubCss(request: CliBrowserRenderRequest): Promise<string>;
  renderEpub(request: CliBrowserRenderRequest): Promise<{ filename: string; base64: string }>;
  renderBookDom(request: CliBrowserRenderRequest & { pages: CliBookPageInput[] }): Promise<CliBookDomSnapshot>;
  renderBookEpub(
    request: CliBrowserRenderRequest & { pages: CliBookPageInput[]; tocEntries?: CliBookTocEntryInput[]; bookTitle?: string; captureProgressTrace?: boolean },
  ): Promise<{ filename: string; base64: string; progressTrace?: CliBookExportProgressSample[]; totalElapsedMs?: number }>;
  renderDiagram(request: CliDiagramRequest & { theme?: string }): Promise<CliDiagramResult>;
  renderDocx(request: CliBrowserRenderRequest): Promise<{ filename: string; base64: string }>;
  renderBookDocx(
    request: CliBrowserRenderRequest & { pages: CliBookPageInput[]; tocEntries?: CliBookTocEntryInput[]; bookTitle?: string; captureProgressTrace?: boolean },
  ): Promise<{ filename: string; base64: string; progressTrace?: CliBookExportProgressSample[]; totalElapsedMs?: number }>;
  /** Prepare the page for a headless PDF: render + inject print styles. */
  renderPdf(request: CliBrowserRenderRequest): Promise<void>;
  renderBookPdf(request: CliBrowserRenderRequest & { pages: CliBookPageInput[] }): Promise<void>;
};

declare global {
  interface Window {
    markdownCli: CliBrowserApi;
    mermaid: typeof mermaid;
  }
}

window.mermaid = mermaid;
initRenderEnvironment();

let rendererThemeConfig: RendererThemeConfig | null = null;

/** Captures the blob passed to platform.file.download during an export. */
let capturedDownload: Blob | null = null;

/**
 * Return the blob captured by the platform file.download mock. Read via a
 * helper (never inline after a local `capturedDownload = null` reset):
 * TypeScript's control flow cannot see that configurePlatform's download
 * callback re-assigns the module-level variable, so a direct read after the
 * guard narrows to `never`.
 */
function requireCapturedDownload(message: string): Blob {
  const blob = capturedDownload;
  if (!blob) {
    throw new Error(message);
  }
  return blob;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function mapCliBookTocEntries(entries: CliBookTocEntryInput[] | undefined) {
  return entries?.map((entry) => {
    if (entry.type === 'heading') {
      return { type: 'heading' as const, title: entry.title, depth: entry.depth ?? 0 };
    }
    return { type: 'page' as const, href: entry.href, title: entry.title, depth: entry.depth ?? 0 };
  });
}

/**
 * Resolve every book page href to an absolute URL against the harness
 * document base URL. Relative SUMMARY.md targets (e.g. `chapters/a.md`) must
 * become absolute before `preprocessPage` absolutizes the page's own relative
 * image/link URLs — with a relative page href `new URL(img, pageHref)` throws
 * and every image stays relative, so whole-book EPUB exports end up with
 * external (broken) image references.
 */
function resolveBookPageHrefs(
  request: CliBrowserRenderRequest & { pages: CliBookPageInput[] },
): BookPage[] {
  const baseUrl = `${request.documentBaseUrl || 'http://127.0.0.1/'}/`;
  return (request.pages || []).map((page) => {
    let href = page.href;
    try {
      href = new URL(page.href, baseUrl).href;
    } catch {
      // Keep the raw href when it cannot be parsed (fetchPage will surface the error).
    }
    return { href, title: page.title, depth: page.depth ?? 0 };
  });
}

function createDocumentService(request: CliBrowserRenderRequest): DocumentService {
  const readResponse = async (url: string, binary = false): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to read resource (${response.status}): ${url}`);
    }
    if (!binary) return response.text();
    return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  };

  const relativeUrl = (relativePath: string): string => {
    const normalized = normalizeRelativePath(relativePath);
    return new URL(normalized, `${request.documentBaseUrl}/`).href;
  };

  return {
    documentPath: request.documentPath,
    documentDir: request.documentDir,
    baseUrl: request.documentBaseUrl,
    needsUriRewrite: false,
    readFile: async (filePath, options) => {
      if (!/^(?:file:|[a-zA-Z]:[\\/]|\/)/.test(filePath)) {
        return readResponse(relativeUrl(filePath), options?.binary);
      }
      const url = new URL(request.fileReadUrl);
      url.searchParams.set('path', filePath);
      return readResponse(url.href, options?.binary);
    },
    readRelativeFile: (relativePath, options) => readResponse(relativeUrl(relativePath), options?.binary),
    resolvePath: (relativePath) => normalizeRelativePath(relativePath),
    toResourceUrl: (filePath) => {
      if (/^(?:file:|[a-zA-Z]:[\\/]|\/)/.test(filePath)) {
        const url = new URL(request.fileReadUrl);
        url.searchParams.set('path', filePath);
        return url.href;
      }
      return relativeUrl(filePath);
    },
    setDocumentPath: () => {},
  };
}

function configurePlatform(request: CliBrowserRenderRequest): DocumentService {
  const documentService = createDocumentService(request);
  const resourceBaseUrl = new URL(request.resourceBaseUrl);

  const renderer = {
    async init(): Promise<void> {},
    setThemeConfig(config: RendererThemeConfig): void {
      rendererThemeConfig = config;
    },
    getThemeConfig(): RendererThemeConfig | null {
      return rendererThemeConfig;
    },
    render(type: string, content: string | object) {
      return handleRender({ renderType: type, input: content, themeConfig: rendererThemeConfig });
    },
  };

  globalThis.platform = {
    platform: 'chrome',
    renderer,
    resource: {
      getURL: (resourcePath: string) => new URL(resourcePath, resourceBaseUrl).href,
      fetch: async (resourcePath: string) => {
        const response = await fetch(new URL(resourcePath, resourceBaseUrl));
        if (!response.ok) throw new Error(`Unable to fetch ${resourcePath}: ${response.status}`);
        return response.text();
      },
    },
    settings: {
      get: async (key: string) => {
        switch (key) {
          case 'themeId': return request.theme || 'default';
          case 'firstLineIndent': return request.firstLineIndent ?? DEFAULT_RENDER_SETTINGS.firstLineIndent;
          case 'tableLayout': return request.tableLayout ?? DEFAULT_RENDER_SETTINGS.tableLayout;
          case 'imageLayout': return request.imageLayout ?? DEFAULT_RENDER_SETTINGS.imageLayout;
          case 'diagramLayout': return request.diagramLayout ?? DEFAULT_RENDER_SETTINGS.diagramLayout;
          case 'frontmatterDisplay': return request.frontmatterDisplay ?? DEFAULT_RENDER_SETTINGS.frontmatterDisplay;
          case 'tableMergeEmpty': return request.tableMergeEmpty ?? false;
          case 'docxHrDisplay': return 'hide';
          case 'docxEmojiStyle': return 'system';
          default: return undefined;
        }
      },
      set: async () => {},
    },
    document: documentService,
    file: {
      download: async (blob: Blob) => {
        capturedDownload = blob;
      },
    },
  } as unknown as PlatformAPI;

  return documentService;
}

/**
 * Reset the page, apply the theme and render the requested markdown into the
 * content root with the requested layout classes (shared by render and
 * renderEpub).
 */
async function renderContent(request: CliBrowserRenderRequest): Promise<void> {
  const markdownContent = document.getElementById('markdown-content');
  if (!(markdownContent instanceof HTMLElement)) {
    throw new Error('CLI renderer page is missing its Markdown containers');
  }

  resetDocument();
  markdownContent.replaceChildren();
  rendererThemeConfig = null;
  capturedDownload = null;

  configurePlatform(request);
  document.documentElement.lang = request.language || 'en';
  document.title = request.title || request.filename;

  await loadAndApplyTheme(request.theme || 'default');

  markdownContent.classList.remove(
    'table-layout-left',
    'table-layout-center',
    'table-layout-center-full-width',
    'image-layout-left',
    'image-layout-center',
    'diagram-layout-left',
    'diagram-layout-center',
  );
  markdownContent.classList.add(
    `table-layout-${request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout}`,
    `image-layout-${request.imageLayout || DEFAULT_RENDER_SETTINGS.imageLayout}`,
    `diagram-layout-${request.diagramLayout || DEFAULT_RENDER_SETTINGS.diagramLayout}`,
  );

  const result = await renderMarkdownDocument({
    markdown: request.markdown,
    container: markdownContent,
    renderer: globalThis.platform!.renderer,
    translate: (key) => key,
    frontmatterDisplay: request.frontmatterDisplay || DEFAULT_RENDER_SETTINGS.frontmatterDisplay,
    tableMergeEmpty: request.tableMergeEmpty ?? false,
    tableLayout: request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout,
  });

  await result.taskManager.processAll();
  await document.fonts?.ready;
}

async function render(request: CliBrowserRenderRequest): Promise<string> {
  const markdownPage = document.getElementById('markdown-page');
  if (!(markdownPage instanceof HTMLElement)) {
    throw new Error('CLI renderer page is missing its Markdown containers');
  }

  await renderContent(request);

  const exported = await exportToHtml({
    container: markdownPage,
    filename: request.filename,
    title: request.title || request.filename,
    documentService: (globalThis.platform as PlatformAPI)?.document,
    includeKatexCdn: true,
  });

  if (!exported.success || !exported.html) {
    throw new Error(exported.error || 'HTML export failed');
  }
  return exported.html;
}

async function snapshotDom(request: CliBrowserRenderRequest): Promise<CliBrowserDomSnapshot> {
  const markdownContent = document.getElementById('markdown-content');
  const markdownPage = document.getElementById('markdown-page');
  if (!(markdownContent instanceof HTMLElement) || !(markdownPage instanceof HTMLElement)) {
    throw new Error('CLI renderer page is missing its Markdown containers');
  }

  resetDocument();
  markdownContent.replaceChildren();
  rendererThemeConfig = null;

  configurePlatform(request);
  document.documentElement.lang = request.language || 'en';
  document.title = request.title || request.filename;

  await loadAndApplyTheme(request.theme || 'default');

  markdownContent.classList.remove(
    'table-layout-left',
    'table-layout-center',
    'table-layout-center-full-width',
    'image-layout-left',
    'image-layout-center',
    'diagram-layout-left',
    'diagram-layout-center',
  );
  markdownContent.classList.add(
    `table-layout-${request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout}`,
    `image-layout-${request.imageLayout || DEFAULT_RENDER_SETTINGS.imageLayout}`,
    `diagram-layout-${request.diagramLayout || DEFAULT_RENDER_SETTINGS.diagramLayout}`,
  );

  const result = await renderMarkdownDocument({
    markdown: request.markdown,
    container: markdownContent,
    renderer: globalThis.platform!.renderer,
    translate: (key) => key,
    frontmatterDisplay: request.frontmatterDisplay || DEFAULT_RENDER_SETTINGS.frontmatterDisplay,
    tableMergeEmpty: request.tableMergeEmpty ?? false,
    tableLayout: request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout,
  });

  await result.taskManager.processAll();
  await document.fonts?.ready;

  return {
    pageHtml: markdownPage.outerHTML,
    contentClassName: markdownContent.className,
    contentStyle: markdownContent.getAttribute('style') || '',
    blockquoteCount: markdownContent.querySelectorAll('blockquote').length,
    imageCount: markdownContent.querySelectorAll('img').length,
    diagramBlockCount: markdownContent.querySelectorAll('.diagram-block').length,
    tableCount: markdownContent.querySelectorAll('table').length,
  };
}

/**
 * Collect the EPUB stylesheet exactly as the exporter would (shared
 * `collectEpubCss`), after applying the requested theme. Exposed for the
 * EPUB CSS contract tests: the output must be the raw collected content CSS
 * with embedded fonts — no exporter-side rewriting.
 */
async function collectEpubCssForCli(request: CliBrowserRenderRequest): Promise<string> {
  configurePlatform(request);
  await loadAndApplyTheme(request.theme || 'default');
  return collectEpubCss();
}

/**
 * Run the REAL single-document EPUB export pipeline (same as the extension:
 * HTML staticizing -> collectEpubCss -> JSZip packaging -> platform download)
 * and return the generated .epub bytes instead of downloading them.
 */
async function renderEpub(request: CliBrowserRenderRequest): Promise<{ filename: string; base64: string }> {
  const markdownPage = document.getElementById('markdown-page');
  if (!(markdownPage instanceof HTMLElement)) {
    throw new Error('CLI renderer page is missing its Markdown containers');
  }

  await renderContent(request);

  let resultFilename = '';
  let exportError: string | null = null;
  await exportEpubFlow({
    container: markdownPage,
    filename: request.filename,
    title: request.title || request.filename,
    onSuccess: (filename) => {
      resultFilename = filename;
    },
    onError: (error) => {
      exportError = error;
    },
  });

  if (exportError) {
    throw new Error(exportError);
  }
  if (!capturedDownload) {
    throw new Error('EPUB export completed but no download blob was captured');
  }

  const bytes = new Uint8Array(await capturedDownload.arrayBuffer());
  return { filename: resultFilename || toEpubFallbackName(request.filename), base64: bytesToBase64(bytes) };
}

function toEpubFallbackName(filename: string): string {
  const name = filename || 'document.epub';
  return name.toLowerCase().endsWith('.epub') ? name : `${name}.epub`;
}

/**
 * Render a whole book through the REAL print renderer (same pipeline as the
 * whole-book PDF/EPUB export) and return every chapter's content root.
 */
async function renderBookDom(
  request: CliBrowserRenderRequest & { pages: CliBookPageInput[] },
): Promise<CliBookDomSnapshot> {
  configurePlatform(request);
  await loadAndApplyTheme(request.theme || 'default');

  const { renderBookForPrint } = await import('../exporters/book-renderer');
  const platform = globalThis.platform as PlatformAPI;
  const documentService = platform.document as DocumentService;
  const rendered = await renderBookForPrint({
    pages: resolveBookPageHrefs(request),
    fetchPage: async (href) => {
      const content = await documentService.readRelativeFile(href);
      return content;
    },
    renderer: platform.renderer,
    translate: (key) => key,
    tableMergeEmpty: request.tableMergeEmpty ?? false,
    tableLayout: request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout,
    imageLayout: request.imageLayout || DEFAULT_RENDER_SETTINGS.imageLayout,
    diagramLayout: request.diagramLayout || DEFAULT_RENDER_SETTINGS.diagramLayout,
  });

  try {
    const chapters = Array.from(rendered.container.querySelectorAll('.book-chapter')).map(
      (chapter) => {
        const content = chapter.querySelector('#markdown-content') as HTMLElement | null;
        return {
          href: chapter.getAttribute('data-href') || '',
          html: content ? content.outerHTML : '',
        };
      },
    );
    return { chapters };
  } finally {
    rendered.cleanup();
  }
}

/**
 * Run the REAL whole-book EPUB export pipeline (renderBookForPrint ->
 * exportToEpub with chapter containers) and return the generated .epub.
 */
async function renderBookEpub(
  request: CliBrowserRenderRequest & { pages: CliBookPageInput[]; tocEntries?: CliBookTocEntryInput[]; bookTitle?: string; captureProgressTrace?: boolean },
): Promise<{ filename: string; base64: string; progressTrace?: CliBookExportProgressSample[]; totalElapsedMs?: number }> {
  configurePlatform(request);
  await loadAndApplyTheme(request.theme || 'default');
  capturedDownload = null;
  const startedAt = performance.now();
  const progressTrace: CliBookExportProgressSample[] = [];

  const { exportBookToEpub } = await import('../exporters/book-exporter');
  const platform = globalThis.platform as PlatformAPI;
  const documentService = platform.document as DocumentService;
  let resultFilename = '';
  let exportError: string | null = null;

  const result = await exportBookToEpub({
    pages: resolveBookPageHrefs(request),
    documentService,
    navEntries: mapCliBookTocEntries(request.tocEntries),
    bookTitle: request.bookTitle || request.title,
    filename: request.filename,
    fetchPage: async (href) => documentService.readRelativeFile(href),
    renderer: platform.renderer,
    translate: (key) => key,
    tableMergeEmpty: request.tableMergeEmpty ?? false,
    tableLayout: request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout,
    imageLayout: request.imageLayout || DEFAULT_RENDER_SETTINGS.imageLayout,
    diagramLayout: request.diagramLayout || DEFAULT_RENDER_SETTINGS.diagramLayout,
    onProgress: (phase, done, total) => {
      progressTrace.push({ phase, done, total, elapsedMs: performance.now() - startedAt });
    },
  });

  if (!result.success || !result.filename) {
    throw new Error(result.error || 'Book EPUB export failed');
  }
  resultFilename = result.filename;

  const bytes = new Uint8Array(
    await requireCapturedDownload('Book EPUB export completed but no download blob was captured').arrayBuffer(),
  );
  return {
    filename: resultFilename,
    base64: bytesToBase64(bytes),
    progressTrace: request.captureProgressTrace ? progressTrace : undefined,
    totalElapsedMs: request.captureProgressTrace ? performance.now() - startedAt : undefined,
  };
}

/**
 * Render a single diagram source file through the shared renderer registry
 * and return its SVG / PNG / DrawIO representations.
 */
async function renderDiagram(request: CliDiagramRequest): Promise<CliDiagramResult> {
  configurePlatform({
    markdown: '',
    filename: 'diagram',
    documentPath: '/diagram',
    documentDir: '/',
    documentBaseUrl: request.documentBaseUrl || 'http://127.0.0.1/',
    fileReadUrl: request.fileReadUrl || 'http://127.0.0.1/',
    resourceBaseUrl: request.resourceBaseUrl || 'http://127.0.0.1/',
    theme: request.theme,
  });
  await loadAndApplyTheme(request.theme || 'default');

  const result = await handleRender({
    renderType: request.diagramType,
    input: request.content,
    themeConfig: rendererThemeConfig,
  });

  return {
    svg: result.svg,
    pngBase64: result.base64,
    drawioXml: result.drawioXml,
    width: result.width,
    height: result.height,
  };
}

function toDocxFilename(filename: string): string {
  let docxFilename = filename || 'document.docx';
  if (docxFilename.toLowerCase().endsWith('.md')) {
    docxFilename = docxFilename.slice(0, -3) + '.docx';
  } else if (docxFilename.toLowerCase().endsWith('.markdown')) {
    docxFilename = docxFilename.slice(0, -9) + '.docx';
  } else if (!docxFilename.toLowerCase().endsWith('.docx')) {
    docxFilename += '.docx';
  }
  return docxFilename;
}

/**
 * Run the REAL DOCX export pipeline (DocxExporter on the raw markdown) and
 * return the generated .docx bytes.
 */
async function renderDocx(request: CliBrowserRenderRequest): Promise<{ filename: string; base64: string }> {
  configurePlatform(request);
  await loadAndApplyTheme(request.theme || 'default');
  capturedDownload = null;

  const DocxExporterModule = await import('../exporters/docx-exporter');
  const DocxExporter = DocxExporterModule.default;
  const exporter = new DocxExporter(globalThis.platform?.renderer);
  const result = await exporter.exportToDocx(request.markdown, request.filename);

  if (!result.success) {
    throw new Error(result.error || 'DOCX export failed');
  }

  const bytes = new Uint8Array(
    await requireCapturedDownload('DOCX export completed but no download blob was captured').arrayBuffer(),
  );
  return { filename: toDocxFilename(request.filename), base64: bytesToBase64(bytes) };
}

/**
 * Run the REAL whole-book DOCX export pipeline (merged markdown -> DocxExporter)
 * and return the generated .docx bytes.
 */
async function renderBookDocx(
  request: CliBrowserRenderRequest & { pages: CliBookPageInput[]; tocEntries?: CliBookTocEntryInput[]; bookTitle?: string; captureProgressTrace?: boolean },
): Promise<{ filename: string; base64: string; progressTrace?: CliBookExportProgressSample[]; totalElapsedMs?: number }> {
  configurePlatform(request);
  await loadAndApplyTheme(request.theme || 'default');
  capturedDownload = null;
  const startedAt = performance.now();
  const progressTrace: CliBookExportProgressSample[] = [];

  const { exportBookToDocx } = await import('../exporters/book-exporter');
  const platform = globalThis.platform as PlatformAPI;
  const documentService = platform.document as DocumentService;
  const result = await exportBookToDocx({
    pages: resolveBookPageHrefs(request),
    navEntries: mapCliBookTocEntries(request.tocEntries),
    bookTitle: request.bookTitle || request.title,
    filename: request.filename,
    fetchPage: async (href) => documentService.readRelativeFile(href),
    renderer: platform.renderer,
    onProgress: (phase, done, total) => {
      progressTrace.push({ phase, done, total, elapsedMs: performance.now() - startedAt });
    },
  });

  if (!result.success) {
    throw new Error(result.error || 'Book DOCX export failed');
  }

  const bytes = new Uint8Array(
    await requireCapturedDownload('Book DOCX export completed but no download blob was captured').arrayBuffer(),
  );
  return {
    filename: result.filename || toDocxFilename(request.filename),
    base64: bytesToBase64(bytes),
    progressTrace: request.captureProgressTrace ? progressTrace : undefined,
    totalElapsedMs: request.captureProgressTrace ? performance.now() - startedAt : undefined,
  };
}

/**
 * Prepare the page for a headless PDF: render the document and inject the
 * shared print stylesheet. The caller (Node) then calls page.pdf().
 */
async function renderPdf(request: CliBrowserRenderRequest): Promise<void> {
  await renderContent(request);

  const { buildPrintCss } = await import('../ui/print-utils');
  const markdownPage = document.getElementById('markdown-page');
  if (!(markdownPage instanceof HTMLElement)) {
    throw new Error('CLI renderer page is missing its Markdown containers');
  }
  const printStyle = document.createElement('style');
  printStyle.id = 'mv-print-inject';
  printStyle.textContent = buildPrintCss(markdownPage);
  document.head.appendChild(printStyle);
  await document.fonts?.ready;
}

/**
 * Prepare the page for a whole-book headless PDF: render the book into
 * #book-print-root (kept in the DOM for printing) and inject the shared
 * print stylesheet plus the chapter-page-break CSS.
 */
async function renderBookPdf(
  request: CliBrowserRenderRequest & { pages: CliBookPageInput[] },
): Promise<void> {
  configurePlatform(request);
  await loadAndApplyTheme(request.theme || 'default');

  const { renderBookForPrint } = await import('../exporters/book-renderer');
  const { buildPrintCss, BOOK_PRINT_CSS } = await import('../ui/print-utils');
  const platform = globalThis.platform as PlatformAPI;
  const documentService = platform.document as DocumentService;
  await renderBookForPrint({
    pages: resolveBookPageHrefs(request),
    fetchPage: async (href) => documentService.readRelativeFile(href),
    renderer: platform.renderer,
    translate: (key) => key,
    tableMergeEmpty: request.tableMergeEmpty ?? false,
    tableLayout: request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout,
    imageLayout: request.imageLayout || DEFAULT_RENDER_SETTINGS.imageLayout,
    diagramLayout: request.diagramLayout || DEFAULT_RENDER_SETTINGS.diagramLayout,
  });

  const printStyle = document.createElement('style');
  printStyle.id = 'mv-print-inject';
  printStyle.textContent = buildPrintCss(document.body, BOOK_PRINT_CSS);
  document.head.appendChild(printStyle);
  await document.fonts?.ready;
}

window.markdownCli = {
  render,
  snapshotDom,
  collectEpubCss: collectEpubCssForCli,
  renderEpub,
  renderBookDom,
  renderBookEpub,
  renderDiagram,
  renderDocx,
  renderBookDocx,
  renderPdf,
  renderBookPdf,
};
