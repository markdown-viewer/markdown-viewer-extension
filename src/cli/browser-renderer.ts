import mermaid from 'mermaid';

import { exportToHtml } from '../exporters/html-exporter';
import { collectEpubCss } from '../exporters/export-styles';
import { exportEpubFlow } from '../core/viewer/viewer-host';
import { renderMarkdownDocument, resetDocument } from '../core/viewer/viewer-controller';
import { mountOpenapiDocument } from '../core/viewer/openapi-view';
import { isOpenapiFile } from '../utils/openapi';
import { clearRenderDiagnostics, getRenderDiagnostics, type RenderDiagnostic } from '../core/render-diagnostics';
import { clearDiagramExports, getDiagramExport } from '../ui/diagram-export-registry';
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

/**
 * Asset export request: render the document and walk what it produced. The
 * kinds and the diagram payload format are the only knobs — everything else
 * (theme, layouts, frontmatter) matches a normal render, so the exported
 * figures are the figures the document shows.
 */
export interface CliAssetRequest extends CliBrowserRenderRequest {
  /** Asset kinds to collect (default: both, in document order). */
  kinds?: Array<'diagram' | 'image'>;
  /** Diagram payload: `png` (rendered pixels, default) or `svg` (engine vector). */
  diagramFormat?: 'png' | 'svg';
}

/** One exportable asset, already resolved to bytes (or to why it has none). */
export interface CliAssetEntry {
  /** 1-based document-order index across the collected kinds. */
  index: number;
  kind: 'diagram' | 'image';
  /** Diagram engine (plantuml, mermaid, html, svg, ...) or `image`. */
  type: string;
  /** 1-based markdown source line, when the pipeline knew it. */
  line: number | null;
  /** Placeholder id of the block this asset came from, when there is one. */
  blockId: string | null;
  /** Alt text carried by the rendered element. */
  alt: string;
  /** Source URL of an image asset (how it was read). */
  src?: string;
  /** Diagram PNG payload (base64, no data: prefix). */
  pngBase64?: string;
  /** Diagram SVG payload, when the engine produces one. */
  svg?: string;
  /** Image bytes, copied from the source resource (base64). */
  imageBase64?: string;
  /** MIME type of the image bytes. */
  contentType?: string;
  width: number | null;
  height: number | null;
  /** Why this asset cannot be exported (render failure, unreadable image, ...). */
  error?: string;
}

export interface CliAssetsResult {
  assets: CliAssetEntry[];
  /** Structured render problems collected while the document rendered. */
  diagnostics: RenderDiagnostic[];
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
  /** Walk the rendered document and return every exportable figure and image. */
  collectAssets(request: CliAssetRequest): Promise<CliAssetsResult>;
  /** Structured problems the render pipeline recorded during the last render. */
  diagnostics(): RenderDiagnostic[];
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

  // Every page API starts with the same clean slate: diagnostics and the
  // diagram export registry describe one render, not the whole page session.
  clearRenderDiagnostics();
  clearDiagramExports();

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

  await renderRequestInto(markdownContent, request);
  await document.fonts?.ready;
}

/**
 * Render the request's document into `container`, then run its async passes.
 *
 * A `.yaml`/`.yml` spec is a document, not markdown: it mounts its rendered
 * reference directly (the embedded-fence route is gone, so ```openapi fences
 * stay code). Everything else goes through the markdown pipeline.
 */
async function renderRequestInto(container: HTMLElement, request: CliBrowserRenderRequest): Promise<void> {
  if (isOpenapiFile(request.markdown, request.filename)) {
    await mountOpenapiDocument(container, request.markdown, { key: request.filename });
    return;
  }

  const result = await renderMarkdownDocument({
    markdown: request.markdown,
    container,
    renderer: globalThis.platform!.renderer,
    translate: (key) => key,
    frontmatterDisplay: request.frontmatterDisplay || DEFAULT_RENDER_SETTINGS.frontmatterDisplay,
    tableMergeEmpty: request.tableMergeEmpty ?? false,
    tableLayout: request.tableLayout || DEFAULT_RENDER_SETTINGS.tableLayout,
  });

  await result.taskManager.processAll();
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

  await renderRequestInto(markdownContent, request);
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

// ── Asset export ─────────────────────────────────────────────────────────────
// collectAssets walks the RENDERED document instead of re-parsing the markdown:
// every figure the reader sees is already in the DOM, carrying the engine that
// produced it, the source hash its intermediate formats are registered under
// and — through the placeholder that preceded it — the markdown line it came
// from. Plain images are returned as their original bytes; the export copies
// resources, it never re-encodes them.

const DATA_URL_PATTERN = /^data:([^;,]+)?((?:;[^,]+)*?),(.*)$/s;

function decodeDataUrl(url: string): { base64: string; contentType: string } {
  const match = url.match(DATA_URL_PATTERN);
  if (!match) {
    throw new Error('invalid data URL');
  }
  const contentType = match[1] || 'application/octet-stream';
  const payload = match[3] || '';
  if (/;base64/i.test(match[2] || '')) {
    return { base64: payload, contentType };
  }
  return {
    base64: bytesToBase64(new TextEncoder().encode(decodeURIComponent(payload))),
    contentType,
  };
}

/** Read an image through the page: inline payload, document server or network. */
async function readImageBytes(src: string): Promise<{ base64: string; contentType: string }> {
  if (src.startsWith('data:')) {
    return decodeDataUrl(src);
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  return { base64: bytesToBase64(bytes), contentType };
}

/** Markdown line of a rendered element (placeholders and images carry it). */
function sourceLineOf(element: HTMLElement | null): number | null {
  const line = Number(element?.dataset?.sourceLine);
  return Number.isFinite(line) && line > 0 ? line : null;
}

/**
 * Document line of a plain image.
 *
 * Unlike plugin placeholders (whose reports already add the block offset),
 * image attributes come straight from the remark AST of a block that was
 * parsed on its own — so the block's own `data-line` has to be added back to
 * name the real line of the document.
 */
function imageDocumentLine(image: HTMLImageElement): number | null {
  const relative = sourceLineOf(image);
  if (relative === null) {
    return null;
  }
  const blockStart = Number(image.closest('[data-line]')?.getAttribute('data-line'));
  return Number.isFinite(blockStart) && blockStart >= 0 ? blockStart + relative : relative;
}

function renderedSize(image: HTMLImageElement | null): { width: number | null; height: number | null } {
  if (!image || !image.naturalWidth) {
    return { width: null, height: null };
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function requestedKinds(request: CliAssetRequest): Set<'diagram' | 'image'> {
  const kinds = request.kinds && request.kinds.length > 0 ? request.kinds : (['diagram', 'image'] as const);
  return new Set<'diagram' | 'image'>(kinds);
}

/**
 * Collect every diagram and image in the rendered document, in document order.
 *
 * Classification follows the DOM, not the markdown: an element the diagram
 * pipeline rendered (`data-plugin-rendered`) is a figure — its payload is the
 * engine's SVG or the pixels the page shows — and anything else that is an
 * `<img>` is an image, copied verbatim. Blocks that failed are returned too, as
 * entries with an `error` and no payload, so a caller can report them by index,
 * engine and line instead of only seeing a missing file.
 */
async function collectAssets(request: CliAssetRequest): Promise<CliAssetsResult> {
  await renderContent(request);

  const content = document.getElementById('markdown-content');
  if (!(content instanceof HTMLElement)) {
    throw new Error('CLI renderer page is missing its Markdown containers');
  }

  const kinds = requestedKinds(request);
  const diagramFormat = request.diagramFormat === 'svg' ? 'svg' : 'png';
  // Reasons of the failures this render reported, by block: the error block in
  // the document carries a localized message, while the diagnostic carries the
  // engine's own reason. The report prefers the diagnostic, so a failure reads
  // as a cause instead of a placeholder phrase.
  const diagnosticReasons = new Map<string, string>();
  for (const diagnostic of getRenderDiagnostics()) {
    if (diagnostic.level === 'error' && diagnostic.blockId && diagnostic.message) {
      diagnosticReasons.set(diagnostic.blockId, diagnostic.message);
    }
  }
  const nodes = Array.from(
    content.querySelectorAll<HTMLElement>('.diagram-block, img, .mv-plugin-error, .async-placeholder'),
  );
  const assets: CliAssetEntry[] = [];

  for (const node of nodes) {
    // The <img> inside a rendered block is that block's payload, not an asset
    // of its own; only the block element counts.
    if (node instanceof HTMLImageElement && node.closest('.diagram-block')) {
      continue;
    }

    const isPlaceholder = node.classList.contains('async-placeholder');
    const isErrorBlock = node.classList.contains('mv-plugin-error');
    const isRenderedDiagram =
      node.classList.contains('diagram-block') ||
      (node instanceof HTMLImageElement && node.dataset.pluginRendered === 'true');

    if (isPlaceholder || isErrorBlock || isRenderedDiagram) {
      if (!kinds.has('diagram')) continue;
      const image = node instanceof HTMLImageElement ? node : node.querySelector('img');
      const type = node.dataset.pluginType || image?.dataset.pluginType || 'diagram';
      const sourceHash = node.dataset.sourceHash || image?.dataset.sourceHash || '';
      const blockId = node.id || node.dataset.blockId || null;
      const entry: CliAssetEntry = {
        index: 0,
        kind: 'diagram',
        type,
        line: sourceLineOf(node),
        blockId,
        alt: image?.alt || '',
        ...renderedSize(image),
      };

      if (isPlaceholder) {
        entry.error = 'the block was never rendered';
      } else if (isErrorBlock) {
        entry.error =
          (blockId && diagnosticReasons.get(blockId)) ||
          (node.textContent || '').trim().replace(/\s+/g, ' ') ||
          'the block failed to render';
      } else if (diagramFormat === 'svg') {
        const exported = sourceHash ? getDiagramExport(sourceHash) : undefined;
        if (exported?.svg) {
          entry.svg = exported.svg;
          entry.type = exported.pluginType || type;
        } else {
          entry.error = `${type} produced no SVG; export with --format png instead`;
        }
      } else {
        const src = image?.getAttribute('src') || '';
        try {
          if (!src.startsWith('data:')) {
            throw new Error('the rendered figure carries no inline payload');
          }
          entry.pngBase64 = decodeDataUrl(src).base64;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
        }
      }

      assets.push(entry);
      continue;
    }

    // A plain image: copied in its original format, never re-encoded.
    if (!kinds.has('image')) continue;
    const image = node as HTMLImageElement;
    const src = image.getAttribute('src') || '';
    const entry: CliAssetEntry = {
      index: 0,
      kind: 'image',
      type: 'image',
      line: imageDocumentLine(image),
      blockId: null,
      alt: image.alt || '',
      src,
      ...renderedSize(image),
    };
    try {
      const bytes = await readImageBytes(src);
      entry.imageBase64 = bytes.base64;
      entry.contentType = bytes.contentType;
      if (image.complete && image.naturalWidth === 0) {
        entry.error = 'the image did not load in the rendered document';
      }
    } catch (error) {
      entry.error = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    assets.push(entry);
  }

  // Index in document order, so `documd --assets --only 2` names the same
  // asset before and after a filter is applied.
  assets.forEach((asset, position) => {
    asset.index = position + 1;
  });

  return { assets, diagnostics: getRenderDiagnostics() };
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
  collectAssets,
  diagnostics: getRenderDiagnostics,
  renderDocx,
  renderBookDocx,
  renderPdf,
  renderBookPdf,
};
