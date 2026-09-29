import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, Page } from 'playwright-core';

import { launchBrowser, printPageToPdf } from '../../scripts/documd.js';

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(helperDir, '..', '..');
const cliAssetDir = path.join(projectRoot, 'dist', 'cli');

export interface BookPageInput {
  href: string;
  title: string;
  depth?: number;
}

export type BookTocEntryInput =
  | { type: 'heading'; title: string; depth?: number }
  | { type: 'page'; href: string; title: string; depth?: number };

export interface BookDomSnapshot {
  chapters: Array<{ href: string; html: string }>;
}

export interface DiagramResult {
  svg?: string;
  pngBase64?: string;
  drawioXml?: string;
  width: number;
  height: number;
}

/** Mirrors CliAssetEntry in src/cli/browser-renderer.ts (one exportable asset). */
export interface AssetEntry {
  index: number;
  kind: 'diagram' | 'image';
  type: string;
  line: number | null;
  blockId: string | null;
  alt: string;
  src?: string;
  pngBase64?: string;
  svg?: string;
  imageBase64?: string;
  contentType?: string;
  width: number | null;
  height: number | null;
  error?: string;
}

/** Mirrors RenderDiagnostic in src/core/render-diagnostics.ts. */
export interface RenderDiagnosticEntry {
  level: 'error' | 'warning';
  kind: string;
  type?: string | null;
  line?: number | null;
  blockId?: string | null;
  message: string;
}

export interface AssetsResult {
  assets: AssetEntry[];
  diagnostics: RenderDiagnosticEntry[];
}

declare global {
  interface Window {
    markdownCli: {
      render(request: unknown): Promise<string>;
      snapshotDom(request: unknown): Promise<BrowserDomSnapshot>;
      collectEpubCss(request: unknown): Promise<string>;
      renderEpub(request: unknown): Promise<{ filename: string; base64: string }>;
      renderBookDom(request: unknown): Promise<BookDomSnapshot>;
      renderBookEpub(request: unknown): Promise<{ filename: string; base64: string }>;
      renderDiagram(request: unknown): Promise<DiagramResult>;
      collectAssets(request: unknown): Promise<AssetsResult>;
      diagnostics(): RenderDiagnosticEntry[];
      renderDocx(request: unknown): Promise<{ filename: string; base64: string }>;
      renderBookDocx(request: unknown): Promise<{ filename: string; base64: string }>;
      renderPdf(request: unknown): Promise<void>;
      renderBookPdf(request: unknown): Promise<void>;
    };
  }
}

export interface BrowserRenderRequest {
  markdown: string;
  filename: string;
  title?: string;
  theme?: string;
  language?: string;
  frontmatterDisplay?: 'hide' | 'table' | 'raw';
  tableMergeEmpty?: boolean;
  tableLayout?: 'left' | 'center' | 'center-full-width';
  imageLayout?: 'left' | 'center';
  diagramLayout?: 'left' | 'center';
  firstLineIndent?: number;
  documentPath: string;
  documentDir: string;
  documentBaseUrl: string;
  fileReadUrl: string;
  resourceBaseUrl: string;
}

export interface BrowserDomSnapshot {
  pageHtml: string;
  contentClassName: string;
  contentStyle: string;
  blockquoteCount: number;
  imageCount: number;
  diagramBlockCount: number;
  tableCount: number;
}

export interface BrowserLayoutMeasurement {
  selector: string;
  count: number;
  elements: Array<{
    left: number;
    top: number;
    width: number;
    height: number;
    // Margins (all four directions; drift in block spacing shows up here).
    marginTop: string;
    marginRight: string;
    marginBottom: string;
    marginLeft: string;
    // Padding (all four directions).
    paddingTop: string;
    paddingRight: string;
    paddingBottom: string;
    paddingLeft: string;
    // Border widths (blockquote/table/hr borders).
    borderTopWidth: string;
    borderRightWidth: string;
    borderBottomWidth: string;
    borderLeftWidth: string;
    // Typography and colors.
    fontFamily: string;
    fontSize: string;
    lineHeight: string;
    fontWeight: string;
    fontStyle: string;
    color: string;
    textDecorationLine: string;
    textAlign: string;
    textIndent: string;
    display: string;
    backgroundColor: string;
    /** Resolved `break-inside` (also carries the legacy page-break-inside value). */
    breakInside: string;
    overflowX: string;
    overflowY: string;
  }>;
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[extension] || 'application/octet-stream';
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function sendFile(response: http.ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeType(filePath),
      'cache-control': 'no-store',
    });
    response.end(data);
  } catch (error: any) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
    response.end(error?.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
  }
}

/**
 * The page the contract suites render in — the CLI's page (see
 * `rendererHtml` in scripts/documd.js) including its CSP, so the suites exercise
 * the same policy the CLI ships: no inline scripts or handlers, inline styles
 * and runtime-injected stylesheets allowed.
 */
const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob: http: https:",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function rendererHtml(basePath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}">
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="${basePath}/styles.css">
</head>
<body>
  <div id="markdown-page"><div id="markdown-content"></div></div>
  <script src="${basePath}/browser-renderer.js"></script>
</body>
</html>`;
}

function virtualDocumentDirectory(documentDir: string): string {
  const normalized = documentDir.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return `__root__${normalized}`;
  return normalized;
}

function localPathFromVirtual(value: string): string {
  if (value.startsWith('__root__/')) return `/${value.slice('__root__/'.length)}`;
  return value.replace(/\//g, path.sep);
}

async function startAssetServer(documentDir: string): Promise<{
  pageUrl: string;
  documentBaseUrl: string;
  fileReadUrl: string;
  resourceBaseUrl: string;
  close: () => Promise<void>;
}> {
  const token = crypto.randomBytes(18).toString('hex');
  const basePath = `/__documd/${token}`;
  const virtualDirectory = virtualDocumentDirectory(documentDir);
  const rendererPath = `${basePath}/fs/${virtualDirectory}/__documd_renderer__.html`;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const decodedPathname = decodeURIComponent(url.pathname);
      if (decodedPathname === rendererPath) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(rendererHtml(basePath));
        return;
      }

      if (url.pathname === `${basePath}/file`) {
        const requestedPath = url.searchParams.get('path');
        if (!requestedPath) {
          response.writeHead(400).end('Missing path');
          return;
        }
        let localPath = requestedPath;
        if (localPath.toLowerCase().startsWith('file:')) {
          localPath = fileURLToPath(localPath);
        } else if (!path.isAbsolute(localPath)) {
          localPath = path.resolve(documentDir, localPath);
        }
        await sendFile(response, localPath);
        return;
      }

      if (url.pathname.startsWith(`${basePath}/document/`)) {
        const relativePath = decodeURIComponent(url.pathname.slice(`${basePath}/document/`.length));
        const localPath = path.resolve(documentDir, relativePath);
        if (!isWithin(documentDir, localPath)) {
          response.writeHead(403).end('Outside document directory');
          return;
        }
        await sendFile(response, localPath);
        return;
      }

      if (decodedPathname.startsWith(`${basePath}/fs/`)) {
        const virtualPath = decodedPathname.slice(`${basePath}/fs/`.length);
        await sendFile(response, localPathFromVirtual(virtualPath));
        return;
      }

      const assetPrefix = `${basePath}/`;
      if (url.pathname.startsWith(assetPrefix)) {
        const relativePath = decodeURIComponent(url.pathname.slice(assetPrefix.length));
        const localPath = path.resolve(cliAssetDir, relativePath);
        if (!isWithin(cliAssetDir, localPath)) {
          response.writeHead(403).end('Outside asset directory');
          return;
        }
        await sendFile(response, localPath);
        return;
      }

      response.writeHead(404).end('Not found');
    } catch {
      response.writeHead(500).end('Internal server error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to determine renderer server address');
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    pageUrl: `${origin}${rendererPath}`,
    documentBaseUrl: `${origin}${basePath}/fs/${virtualDirectory}`,
    fileReadUrl: `${origin}${basePath}/file`,
    resourceBaseUrl: `${origin}${basePath}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Render timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface BrowserConsoleMessage {
  type: string;
  text: string;
}

export interface BrowserRenderHarness {
  snapshotDom(inputPath: string, overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number }): Promise<BrowserDomSnapshot>;
  /**
   * Render the document and measure layout/style for the given selectors.
   * `media: 'print'` emulates the print media type first, so @media print
   * declarations (page-break rules) are the ones that resolve.
   */
  measureLayout(inputPath: string, selectors: string[], overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number; media?: 'screen' | 'print' }): Promise<BrowserLayoutMeasurement[]>;
  /** Console messages emitted by the page since harness creation (type + text). */
  consoleMessages(): BrowserConsoleMessage[];
  /** Collect the EPUB stylesheet exactly as the exporter produces it. */
  collectEpubCss(inputPath: string, overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number }): Promise<string>;
  /** Run the REAL standalone HTML export pipeline and return the exported HTML string. */
  renderHtml(inputPath: string, overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number }): Promise<string>;
  /** Run the real single-document EPUB export pipeline and return the .epub bytes. */
  renderEpub(inputPath: string, overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number }): Promise<{ filename: string; base64: string }>;
  /**
   * Render a whole book through the REAL print renderer (same pipeline as the
   * whole-book PDF/EPUB export). Pages are resolved against the input file's
   * directory (the harness documentDir).
   */
  renderBookDom(
    pages: BookPageInput[],
    overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number },
  ): Promise<BookDomSnapshot>;
  renderBookEpub(
    pages: BookPageInput[],
    overrides?: Partial<BrowserRenderRequest> & { bookTitle?: string; tocEntries?: BookTocEntryInput[]; timeoutMs?: number },
  ): Promise<{ filename: string; base64: string }>;
  /**
   * Render a diagram source through the shared renderer registry
   * (mermaid / plantuml / dot / vega / ...) and return its representations.
   */
  renderDiagram(
    diagramType: string,
    content: string,
    overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number },
  ): Promise<DiagramResult>;
  /** Render a diagram from a URL served by the harness asset server (remote-URL path). */
  renderDiagramUrl(
    diagramType: string,
    relativePath: string,
    overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number },
  ): Promise<DiagramResult>;
  /**
   * Walk the rendered document for its exportable figures and images (the
   * documd `--assets` page API), optionally restricted to some kinds and to
   * the png/svg diagram payload.
   */
  collectAssets(
    inputPath: string,
    overrides?: Partial<BrowserRenderRequest> & {
      timeoutMs?: number;
      kinds?: Array<'diagram' | 'image'>;
      diagramFormat?: 'png' | 'svg';
    },
  ): Promise<AssetsResult>;
  /** Structured render diagnostics of the last render in this page. */
  diagnostics(): Promise<RenderDiagnosticEntry[]>;
  /** Run the REAL DOCX export pipeline and return the .docx bytes. */
  renderDocx(
    inputPath: string,
    overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number },
  ): Promise<{ filename: string; base64: string }>;
  /** Run the REAL whole-book DOCX export pipeline and return the .docx bytes. */
  renderBookDocx(
    pages: BookPageInput[],
    overrides?: Partial<BrowserRenderRequest> & { bookTitle?: string; tocEntries?: BookTocEntryInput[]; timeoutMs?: number },
  ): Promise<{ filename: string; base64: string }>;
  /** Prepare + print a single document to PDF (headless Chrome). */
  renderPdf(
    inputPath: string,
    overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number },
  ): Promise<Buffer>;
  /** Prepare + print a whole book to PDF (headless Chrome). */
  renderBookPdf(
    pages: BookPageInput[],
    overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number },
  ): Promise<Buffer>;
  /**
   * Simulate an EPUB reader rendering the exported chapter:
   * - content root comes from the real HTML export pipeline (same DOM the
   *   EPUB exporter serializes),
   * - stylesheet comes from collectEpubCss (same CSS as the EPUB style.css),
   * - injected into a 500px reader-like container,
   * - media emulated (screen / print),
   * - optionally with var() declarations stripped (readers without custom
   *   property support, e.g. Apple Books).
   */
  measureEpubReader(
    inputPath: string,
    selectors: string[],
    env: EpubReaderEnvironment,
    overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number },
  ): Promise<BrowserLayoutMeasurement[]>;
  /**
   * Export the document to standalone HTML, inject it into the page and
   * measure the given selectors — verifies the exported HTML renders with
   * the same layout semantics as the live viewer.
   */
  measureHtmlLayout(inputPath: string, selectors: string[], overrides?: Partial<BrowserRenderRequest> & { timeoutMs?: number }): Promise<BrowserLayoutMeasurement[]>;
  /**
   * Run a function in the renderer page, bypassing the pipeline — for tests that
   * have to put markup there *without* the sanitizer, e.g. to prove the page's
   * CSP refuses to run it. Returns whatever the function returns.
   */
  evaluateInPage<T>(fn: () => T): Promise<T>;
  dispose(): Promise<void>;
}

export interface EpubReaderEnvironment {
  media: 'screen' | 'print';
  /** Strip var() declarations to emulate readers without custom properties. */
  stripVar: boolean;
}

export async function createBrowserRenderHarness(options: { inputPath: string; chromePath?: string } ): Promise<BrowserRenderHarness> {
  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const inputPath = path.resolve(options.inputPath);
  const documentDir = path.dirname(inputPath);
  const server = await startAssetServer(documentDir);

  const browser: Browser = await launchBrowser({ chromePath: options.chromePath });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page: Page = await context.newPage();
  await page.goto(server.pageUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.markdownCli?.snapshotDom === 'function');

  // Collect console output so tests can assert on page-side diagnostics
  // (e.g. plugin render failures must be concise warnings, not error dumps).
  const consoleMessages: BrowserConsoleMessage[] = [];
  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });

  return {
    consoleMessages() {
      return consoleMessages.slice();
    },
    evaluateInPage(fn) {
      return withTimeout(page.evaluate(fn), 30_000);
    },
    async snapshotDom(targetPath: string, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 120_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.snapshotDom(request);
      }, {
        markdown,
        filename: path.basename(resolved),
        title: overrides.title,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
    },
    async measureLayout(targetPath: string, selectors: string[], overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 120_000;
      // The stylesheet carries a @media print block (page-break rules); emulate the
      // media type before rendering so print-only declarations resolve.
      if (overrides.media) {
        await page.emulateMedia({ media: overrides.media });
      }
      const measurement = await withTimeout(page.evaluate(({ request, selectors }) => {
        return window.markdownCli.snapshotDom(request).then(async () => {
          // Wait for every image to decode so geometry measurements are based
          // on final rendered dimensions, not placeholder boxes.
          const images = Array.from(document.querySelectorAll<HTMLImageElement>('#markdown-content img'));
          await Promise.all(images.map((img) => {
            if (typeof img.decode === 'function') {
              return img.decode().catch(() => undefined);
            }
            return new Promise<void>((resolve) => {
              if (img.complete) {
                resolve();
                return;
              }
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            });
          }));
          return selectors.map((selector) => {
            const nodes = Array.from(document.querySelectorAll(selector));
            return {
              selector,
              count: nodes.length,
              elements: nodes.map((node) => {
                const element = node as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  marginTop: style.marginTop,
                  marginRight: style.marginRight,
                  marginBottom: style.marginBottom,
                  marginLeft: style.marginLeft,
                  paddingTop: style.paddingTop,
                  paddingRight: style.paddingRight,
                  paddingBottom: style.paddingBottom,
                  paddingLeft: style.paddingLeft,
                  borderTopWidth: style.borderTopWidth,
                  borderRightWidth: style.borderRightWidth,
                  borderBottomWidth: style.borderBottomWidth,
                  borderLeftWidth: style.borderLeftWidth,
                  fontFamily: style.fontFamily,
                  fontSize: style.fontSize,
                  lineHeight: style.lineHeight,
                  fontWeight: style.fontWeight,
                  fontStyle: style.fontStyle,
                  color: style.color,
                  textDecorationLine: style.textDecorationLine,
                  textAlign: style.textAlign,
                  textIndent: style.textIndent,
                  display: style.display,
                  backgroundColor: style.backgroundColor,
                  overflowX: style.overflowX,
                  overflowY: style.overflowY,
                  breakInside: style.breakInside,
                };
              }),
            };
          });
        });
      }, {
        request: {
          markdown,
          filename: path.basename(resolved),
          title: overrides.title,
          theme: overrides.theme || 'default',
          language: overrides.language || 'en',
          frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
          tableMergeEmpty: overrides.tableMergeEmpty ?? false,
          tableLayout: overrides.tableLayout || 'center',
          imageLayout: overrides.imageLayout || 'center',
          diagramLayout: overrides.diagramLayout || 'center',
          firstLineIndent: overrides.firstLineIndent ?? 0,
          documentPath: resolved,
          documentDir: path.dirname(resolved),
          documentBaseUrl: server.documentBaseUrl,
          fileReadUrl: server.fileReadUrl,
          resourceBaseUrl: server.resourceBaseUrl,
        },
        selectors,
      }), timeoutMs);
      if (overrides.media) {
        // Leave the page in its default media state for later measurements.
        await page.emulateMedia({ media: 'screen' });
      }
      return measurement;
    },
    async collectEpubCss(targetPath: string, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 120_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.collectEpubCss(request);
      }, {
        markdown,
        filename: path.basename(resolved),
        title: overrides.title,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
    },
    async renderHtml(targetPath: string, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 120_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.render(request);
      }, {
        markdown,
        filename: path.basename(resolved),
        title: overrides.title,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
    },
    async renderBookDom(pages: BookPageInput[], overrides = {}) {
      const resolved = path.resolve(overrides.inputPath || 'test/fixtures/layout/body-text.md');
      const timeoutMs = overrides.timeoutMs ?? 180_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderBookDom(request);
      }, {
        markdown: '',
        filename: 'book.md',
        title: 'Book',
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
        pages,
      }), timeoutMs);
    },
    async renderBookEpub(pages: BookPageInput[], overrides = {}) {
      const resolved = path.resolve(overrides.inputPath || 'test/fixtures/layout/body-text.md');
      const timeoutMs = overrides.timeoutMs ?? 240_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderBookEpub(request);
      }, {
        markdown: '',
        filename: overrides.filename || 'book.epub',
        title: overrides.bookTitle || 'Test Book',
        bookTitle: overrides.bookTitle,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
        pages,
        tocEntries: overrides.tocEntries,
      }), timeoutMs);
    },
    async renderPdf(targetPath: string, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 240_000;
      await withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderPdf(request);
      }, {
        markdown,
        filename: path.basename(resolved),
        title: overrides.title,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
      return printPageToPdf(page, timeoutMs);
    },
    async renderBookPdf(pages: BookPageInput[], overrides = {}) {
      const resolved = path.resolve(overrides.inputPath || 'test/fixtures/layout/body-text.md');
      const timeoutMs = overrides.timeoutMs ?? 240_000;
      await withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderBookPdf(request);
      }, {
        markdown: '',
        filename: 'book.pdf',
        title: 'Book',
        pages,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
      return printPageToPdf(page, timeoutMs);
    },
    async renderBookDocx(pages: BookPageInput[], overrides = {}) {
      const resolved = path.resolve(overrides.inputPath || 'test/fixtures/layout/body-text.md');
      const timeoutMs = overrides.timeoutMs ?? 240_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderBookDocx(request);
      }, {
        markdown: '',
        filename: overrides.filename || 'book.docx',
        title: overrides.bookTitle || 'Test Book',
        bookTitle: overrides.bookTitle,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
        pages,
        tocEntries: overrides.tocEntries,
      }), timeoutMs);
    },
    async renderDocx(targetPath: string, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 240_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderDocx(request);
      }, {
        markdown,
        filename: overrides.filename || path.basename(resolved),
        title: overrides.title,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
    },
    async renderDiagramUrl(diagramType: string, relativePath: string, overrides = {}) {
      const base = server.documentBaseUrl.endsWith('/') ? server.documentBaseUrl : `${server.documentBaseUrl}/`;
      const url = new URL(relativePath, base).href;
      return this.renderDiagram(diagramType, url, overrides);
    },
    async renderDiagram(diagramType: string, content: string, overrides = {}) {
      const timeoutMs = overrides.timeoutMs ?? 180_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderDiagram(request);
      }, {
        diagramType,
        content,
        theme: overrides.theme || 'default',
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
    },
    async renderEpub(targetPath: string, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 180_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.renderEpub(request);
      }, {
        markdown,
        filename: overrides.filename || path.basename(resolved),
        title: overrides.title,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
      }), timeoutMs);
    },
    async collectAssets(targetPath: string, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 180_000;
      return withTimeout(page.evaluate((request) => {
        return window.markdownCli.collectAssets(request);
      }, {
        markdown,
        filename: overrides.filename || path.basename(resolved),
        title: overrides.title,
        theme: overrides.theme || 'default',
        language: overrides.language || 'en',
        frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
        tableMergeEmpty: overrides.tableMergeEmpty ?? false,
        tableLayout: overrides.tableLayout || 'center',
        imageLayout: overrides.imageLayout || 'center',
        diagramLayout: overrides.diagramLayout || 'center',
        firstLineIndent: overrides.firstLineIndent ?? 0,
        documentPath: resolved,
        documentDir: path.dirname(resolved),
        documentBaseUrl: server.documentBaseUrl,
        fileReadUrl: server.fileReadUrl,
        resourceBaseUrl: server.resourceBaseUrl,
        kinds: overrides.kinds,
        diagramFormat: overrides.diagramFormat,
      }), timeoutMs);
    },
    async diagnostics() {
      return page.evaluate(() => window.markdownCli.diagnostics());
    },
    async measureEpubReader(targetPath: string, selectors: string[], env: EpubReaderEnvironment, overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 180_000;
      await page.emulateMedia({ media: env.media });
      return withTimeout(page.evaluate(async ({ request, selectors, stripVar }) => {
        // The EPUB stylesheet is theme-only; cache it per session instead of
        // re-fetching all embedded fonts for every fixture.
        const cacheKey = `${request.theme}:${stripVar ? 'no-var' : 'var'}`;
        const cache = (window as any).__epubReaderCssCache ??= {};
        if (!cache[cacheKey]) {
          cache[cacheKey] = await window.markdownCli.collectEpubCss(request);
        }
        const css = cache[cacheKey];

        const html = await window.markdownCli.render(request);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const contentRoot = doc.querySelector('#markdown-content');
        if (!contentRoot) throw new Error('Exported HTML missing #markdown-content');

        // Readers without custom-property support drop every var() declaration
        // wholesale (fallbacks are NOT applied by engines that lack var()).
        // The semicolon must survive so the following declaration keeps its
        // own boundary (e.g. `color: var(--x); text-decoration: none` ->
        // `color: ; text-decoration: none`, not `color: text-decoration: none`).
        const cssText = stripVar ? css.replace(/\bvar\([^)]*\)/g, '') : css;

        let tempStyle = document.getElementById('epub-reader-style') as HTMLStyleElement | null;
        if (!tempStyle) {
          tempStyle = document.createElement('style');
          tempStyle.id = 'epub-reader-style';
          document.head.appendChild(tempStyle);
        }
        tempStyle.textContent = cssText;

        let host = document.getElementById('epub-reader-root') as HTMLElement | null;
        if (!host) {
          host = document.createElement('div');
          host.id = 'epub-reader-root';
          // A 500px reader-like page. Positioned off-screen; geometry comes
          // from computed styles + rects, so off-screen placement is fine.
          host.style.cssText = 'position:absolute;left:-9999px;top:0;width:500px;';
          document.body.appendChild(host);
        }

        // Isolate the host from the page's own stylesheet (dist/cli/styles.css
        // carries @media print rules that would otherwise activate under
        // print-media emulation and contaminate the reader simulation).
        const pageSheets = Array.from(document.styleSheets)
          .filter((ss) => ss.ownerNode !== tempStyle);
        const disabledBefore = pageSheets.map((ss) => ss.disabled);
        pageSheets.forEach((ss) => { ss.disabled = true; });

        try {
          host.innerHTML = contentRoot.outerHTML;

          const images = Array.from(host.querySelectorAll<HTMLImageElement>('img'));
          await Promise.all(images.map((img) => {
            if (typeof img.decode === 'function') {
              return img.decode().catch(() => undefined);
            }
            return new Promise<void>((resolve) => {
              if (img.complete) {
                resolve();
                return;
              }
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            });
          }));

          return selectors.map((selector) => {
            const nodes = Array.from(host.querySelectorAll(selector));
            return {
              selector,
              count: nodes.length,
              elements: nodes.map((node) => {
                const element = node as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  marginTop: style.marginTop,
                  marginRight: style.marginRight,
                  marginBottom: style.marginBottom,
                  marginLeft: style.marginLeft,
                  paddingTop: style.paddingTop,
                  paddingRight: style.paddingRight,
                  paddingBottom: style.paddingBottom,
                  paddingLeft: style.paddingLeft,
                  borderTopWidth: style.borderTopWidth,
                  borderRightWidth: style.borderRightWidth,
                  borderBottomWidth: style.borderBottomWidth,
                  borderLeftWidth: style.borderLeftWidth,
                  fontFamily: style.fontFamily,
                  fontSize: style.fontSize,
                  lineHeight: style.lineHeight,
                  fontWeight: style.fontWeight,
                  fontStyle: style.fontStyle,
                  color: style.color,
                  textDecorationLine: style.textDecorationLine,
                  textAlign: style.textAlign,
                  textIndent: style.textIndent,
                  display: style.display,
                  backgroundColor: style.backgroundColor,                  overflowX: style.overflowX,
                  overflowY: style.overflowY,                };
              }),
            };
          });
        } finally {
          pageSheets.forEach((ss, i) => { ss.disabled = disabledBefore[i]; });
        }
      }, {
        request: {
          markdown,
          filename: path.basename(resolved),
          title: overrides.title,
          theme: overrides.theme || 'default',
          language: overrides.language || 'en',
          frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
          tableMergeEmpty: overrides.tableMergeEmpty ?? false,
          tableLayout: overrides.tableLayout || 'center',
          imageLayout: overrides.imageLayout || 'center',
          diagramLayout: overrides.diagramLayout || 'center',
          firstLineIndent: overrides.firstLineIndent ?? 0,
          documentPath: resolved,
          documentDir: path.dirname(resolved),
          documentBaseUrl: server.documentBaseUrl,
          fileReadUrl: server.fileReadUrl,
          resourceBaseUrl: server.resourceBaseUrl,
        },
        selectors,
        stripVar: env.stripVar,
      }), timeoutMs);
    },
    async measureHtmlLayout(targetPath: string, selectors: string[], overrides = {}) {
      const resolved = path.resolve(targetPath);
      const markdown = await fs.readFile(resolved, 'utf8');
      const timeoutMs = overrides.timeoutMs ?? 120_000;
      return withTimeout(page.evaluate(async ({ request, selectors }) => {
        const html = await window.markdownCli.render(request);
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // Inject the exported stylesheet and body content into an off-screen
        // container so the exported document can be measured like the live one.
        const exportedStyle = doc.querySelector('style');
        const tempStyle = document.createElement('style');
        tempStyle.textContent = exportedStyle?.textContent || '';
        document.head.appendChild(tempStyle);

        const host = document.createElement('div');
        host.id = 'exported-html-root';
        host.style.cssText = 'position:absolute;left:-9999px;top:0;width:100%;';
        host.innerHTML = doc.body.innerHTML;
        document.body.appendChild(host);

        try {
          const images = Array.from(host.querySelectorAll<HTMLImageElement>('img'));
          await Promise.all(images.map((img) => {
            if (typeof img.decode === 'function') {
              return img.decode().catch(() => undefined);
            }
            return new Promise<void>((resolve) => {
              if (img.complete) {
                resolve();
                return;
              }
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            });
          }));

          return selectors.map((selector) => {
            const nodes = Array.from(host.querySelectorAll(selector));
            return {
              selector,
              count: nodes.length,
              elements: nodes.map((node) => {
                const element = node as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  marginTop: style.marginTop,
                  marginRight: style.marginRight,
                  marginBottom: style.marginBottom,
                  marginLeft: style.marginLeft,
                  paddingTop: style.paddingTop,
                  paddingRight: style.paddingRight,
                  paddingBottom: style.paddingBottom,
                  paddingLeft: style.paddingLeft,
                  borderTopWidth: style.borderTopWidth,
                  borderRightWidth: style.borderRightWidth,
                  borderBottomWidth: style.borderBottomWidth,
                  borderLeftWidth: style.borderLeftWidth,
                  fontFamily: style.fontFamily,
                  fontSize: style.fontSize,
                  lineHeight: style.lineHeight,
                  fontWeight: style.fontWeight,
                  fontStyle: style.fontStyle,
                  color: style.color,
                  textDecorationLine: style.textDecorationLine,
                  textAlign: style.textAlign,
                  textIndent: style.textIndent,
                  display: style.display,
                  backgroundColor: style.backgroundColor,                  overflowX: style.overflowX,
                  overflowY: style.overflowY,                };
              }),
            };
          });
        } finally {
          host.remove();
          tempStyle.remove();
        }
      }, {
        request: {
          markdown,
          filename: path.basename(resolved),
          title: overrides.title,
          theme: overrides.theme || 'default',
          language: overrides.language || 'en',
          frontmatterDisplay: overrides.frontmatterDisplay || 'hide',
          tableMergeEmpty: overrides.tableMergeEmpty ?? false,
          tableLayout: overrides.tableLayout || 'center',
          imageLayout: overrides.imageLayout || 'center',
          diagramLayout: overrides.diagramLayout || 'center',
          firstLineIndent: overrides.firstLineIndent ?? 0,
          documentPath: resolved,
          documentDir: path.dirname(resolved),
          documentBaseUrl: server.documentBaseUrl,
          fileReadUrl: server.fileReadUrl,
          resourceBaseUrl: server.resourceBaseUrl,
        },
        selectors,
      }), timeoutMs);
    },
    async dispose() {
      await context.close();
      await browser.close();
      await server.close();
    },
  };
}