#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { DEFAULT_RENDER_SETTINGS } from '../src/config/defaults.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// When installed/published from dist/cli, the renderer assets live next to
// this file; in development the script runs from scripts/ and the built
// assets live in ../dist/cli.
const cliAssetDir = existsSync(path.join(scriptDir, 'browser-renderer.js'))
  ? scriptDir
  : path.resolve(scriptDir, '..', 'dist', 'cli');

// Version comes from the package.json that ships next to this file (dist/cli)
// or the repository root in development.
const CLI_PKG_PATH = existsSync(path.join(scriptDir, 'package.json'))
  ? path.join(scriptDir, 'package.json')
  : path.resolve(scriptDir, '..', 'package.json');
const CLI_PKG = JSON.parse(readFileSync(CLI_PKG_PATH, 'utf8'));
const CLI_VERSION = CLI_PKG.version;
const CLI_HOMEPAGE = 'https://docu.md';

// Defaults in the help text are derived from the shared settings schema so
// the CLI help can never drift from settings-schema.json.
const HELP = `documd v${CLI_VERSION} — ${CLI_HOMEPAGE}
Render Markdown / diagrams / books with headless Chrome

Usage:
  documd <input> [<output>] [--format <f>] [options]

The second positional is treated as the output file (pandoc style) when its
extension is a known output format; the input extension must be a known input
format (.md/.markdown/.mdown/.mkd/.txt or a diagram source like .puml/.mmd/...).

Output formats (--format; inferred from the output extension when omitted):
  html, epub, docx, pdf        markdown / SUMMARY.md (--book) documents
  svg, png, drawio             diagram sources (PlantUML/Mermaid/DOT/Vega/...)

Options:
      --format <f>          html, epub, docx, pdf, svg, png or drawio
  -b, --book                Whole-book export: input is a GitBook SUMMARY.md
      --diagram-type <t>    Diagram renderer (default: inferred from the extension)
  -t, --theme <id>          Viewer theme (default: ${DEFAULT_RENDER_SETTINGS.theme})
      --title <text>        Override the document title
      --language <code>     Document language code (default: ${DEFAULT_RENDER_SETTINGS.language})
      --frontmatter <mode>  hide, table, or raw (default: ${DEFAULT_RENDER_SETTINGS.frontmatterDisplay})
      --table-layout <mode> left, center, or center-full-width (default: ${DEFAULT_RENDER_SETTINGS.tableLayout})
      --image-layout <mode> left or center (default: ${DEFAULT_RENDER_SETTINGS.imageLayout})
      --diagram-layout <mode> left or center (default: ${DEFAULT_RENDER_SETTINGS.diagramLayout})
      --merge-empty-cells   Merge empty Markdown table cells (default: on)
      --first-line-indent <n>  First-line indent in characters, 0-4 (default: ${DEFAULT_RENDER_SETTINGS.firstLineIndent})
      --chrome <path>       Explicit Chrome executable path
      --timeout <seconds>   Overall render timeout (default: 120)
  -v, --version             Print the version and exit
  -h, --help                Show this help

Website: ${CLI_HOMEPAGE}
`;

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
  return value;
}

const OUTPUT_FORMATS = ['html', 'epub', 'docx', 'pdf', 'svg', 'png', 'drawio'];
const DIAGRAM_FORMATS = ['svg', 'png', 'drawio'];
const OUTPUT_EXT_FORMATS = {
  '.html': 'html',
  '.epub': 'epub',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.svg': 'svg',
  '.png': 'png',
  '.drawio': 'drawio',
};
const DIAGRAM_EXT_TYPES = {
  '.puml': 'plantuml',
  '.plantuml': 'plantuml',
  '.wsd': 'plantuml',
  '.mmd': 'mermaid',
  '.mermaid': 'mermaid',
  '.dot': 'dot',
  '.gv': 'dot',
  '.vega': 'vega',
  '.vl': 'vega-lite',
  '.drawio': 'drawio',
  '.echarts': 'echarts',
  '.svg': 'svg',
  '.infographic': 'infographic',
  '.canvas': 'canvas',
};

// Recognised input extensions: Markdown documents plus every diagram source
// type. Used to decide whether a second positional argument can be treated as
// the output file (pandoc style) instead of guessing.
const INPUT_EXT_FORMATS = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.mkd': 'markdown',
  '.txt': 'markdown',
  ...DIAGRAM_EXT_TYPES,
};

function isDiagramInput(inputPath) {
  return Boolean(DIAGRAM_EXT_TYPES[path.extname(inputPath).toLowerCase()]);
}

function inferDiagramType(inputPath) {
  return DIAGRAM_EXT_TYPES[path.extname(inputPath).toLowerCase()] || null;
}

export function parseArgs(args) {
  const options = {
    theme: DEFAULT_RENDER_SETTINGS.theme,
    language: DEFAULT_RENDER_SETTINGS.language,
    frontmatterDisplay: DEFAULT_RENDER_SETTINGS.frontmatterDisplay,
    tableLayout: DEFAULT_RENDER_SETTINGS.tableLayout,
    imageLayout: DEFAULT_RENDER_SETTINGS.imageLayout,
    diagramLayout: DEFAULT_RENDER_SETTINGS.diagramLayout,
    tableMergeEmpty: DEFAULT_RENDER_SETTINGS.tableMergeEmpty,
    firstLineIndent: DEFAULT_RENDER_SETTINGS.firstLineIndent,
    timeoutMs: 120_000,
  };
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg === '-b' || arg === '--book') {
      options.bookMode = true;
    } else if (arg === '--diagram-type') {
      options.diagramType = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--format') {
      options.format = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '-t' || arg === '--theme') {
      options.theme = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--title') {
      options.title = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--language') {
      options.language = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--frontmatter') {
      options.frontmatterDisplay = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--table-layout') {
      options.tableLayout = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--image-layout') {
      options.imageLayout = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--diagram-layout') {
      options.diagramLayout = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--merge-empty-cells') {
      options.tableMergeEmpty = true;
    } else if (arg === '--first-line-indent') {
      const chars = Number(takeValue(args, i, arg));
      if (!Number.isInteger(chars) || chars < 0 || chars > 4) {
        throw new Error('--first-line-indent must be an integer between 0 and 4 (characters)');
      }
      options.firstLineIndent = chars;
      i += 1;
    } else if (arg === '--chrome') {
      options.chromePath = takeValue(args, i, arg);
      i += 1;
    } else if (arg === '--timeout') {
      const seconds = Number(takeValue(args, i, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--timeout must be a positive number of seconds');
      }
      options.timeoutMs = seconds * 1000;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!options.help && !options.version) {
    if (positional.length === 1) {
      options.input = positional[0];
    } else if (positional.length === 2) {
      // Pandoc-style second positional: treat it as the output file. Only
      // when both extensions are recognisable — otherwise fail loudly with
      // the unknown format named, instead of guessing.
      const [candidateInput, candidateOutput] = positional;
      const inputExt = path.extname(candidateInput).toLowerCase();
      const outputExt = path.extname(candidateOutput).toLowerCase();
      const inputKnown = INPUT_EXT_FORMATS[inputExt] !== undefined;
      // An explicit --format makes the output extension irrelevant (same as -o).
      const outputKnown = OUTPUT_EXT_FORMATS[outputExt] !== undefined || Boolean(options.format);
      if (inputKnown && outputKnown) {
        options.input = candidateInput;
        options.output = candidateOutput;
      } else {
        const problems = [];
        if (!inputKnown) {
          problems.push(`unknown input format "${inputExt || path.basename(candidateInput)}"`);
        }
        if (!OUTPUT_EXT_FORMATS[outputExt]) {
          problems.push(`unknown output format "${outputExt || path.basename(candidateOutput)}"`);
        }
        throw new Error(
          `Cannot treat "${candidateOutput}" as the output file: ${problems.join(' and ')}; use --format html|epub|docx|pdf|svg|png|drawio`,
        );
      }
    } else {
      throw new Error('Exactly one input file is required (usage: documd <input> [<output>] [options])');
    }
  }
  if (!['hide', 'table', 'raw'].includes(options.frontmatterDisplay)) {
    throw new Error('--frontmatter must be hide, table, or raw');
  }
  if (!['left', 'center', 'center-full-width'].includes(options.tableLayout)) {
    throw new Error('--table-layout must be left, center, or center-full-width');
  }
  if (!['left', 'center'].includes(options.imageLayout)) {
    throw new Error('--image-layout must be left or center');
  }
  if (!['left', 'center'].includes(options.diagramLayout)) {
    throw new Error('--diagram-layout must be left or center');
  }
  if (options.format && !OUTPUT_FORMATS.includes(options.format)) {
    throw new Error('--format must be html, epub, docx, pdf, svg, png or drawio');
  }

  // help/version need no input or format inference.
  if (options.help || options.version) {
    return options;
  }

  // Infer the output format when --format is omitted.
  if (!options.format) {
    if (options.output) {
      const ext = path.extname(options.output).toLowerCase();
      options.format = OUTPUT_EXT_FORMATS[ext];
      if (!options.format) {
        throw new Error(`Cannot infer --format from output "${options.output}"; use --format html|epub|docx|pdf|svg|png|drawio`);
      }
    } else if (options.bookMode) {
      options.format = 'epub';
    } else if (isDiagramInput(options.input)) {
      options.format = 'svg';
    } else {
      options.format = 'html';
    }
  }

  const diagramInput = isDiagramInput(options.input);
  if (DIAGRAM_FORMATS.includes(options.format)) {
    if (!diagramInput) {
      throw new Error(`Format "${options.format}" requires a diagram input (PlantUML/Mermaid/DOT/Vega/...); "${options.input}" is not one`);
    }
    options.diagramMode = true;
  } else if (diagramInput) {
    throw new Error(`Diagram input "${options.input}" cannot be exported as ${options.format}; use --format svg, png or drawio`);
  }

  if (options.bookMode) {
    if (!['epub', 'docx', 'pdf'].includes(options.format)) {
      throw new Error('--book requires --format epub, docx or pdf');
    }
  }

  return options;
}

/**
 * Parse a GitBook SUMMARY.md into book pages (same format as the viewer's
 * GitBook panel): `- [Title](relative-link)` with indentation depth.
 */
export function parseSummaryPages(summaryContent, summaryDir) {
  const pages = [];
  for (const line of summaryContent.split(/\r?\n/)) {
    const match = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+\[([^\]]+)\]\(([^)]+)\)\s*$/);
    if (!match) continue;
    const indent = match[1] || '';
    const title = match[2].trim();
    const target = match[3].trim();
    if (!target || /^(?:mailto:|javascript:|#)/i.test(target)) continue;
    let href = target;
    if (!href.startsWith('http')) {
      href = href.replace(/^\.?\//, '');
      if (summaryDir) {
        href = path.posix.join(summaryDir.replace(/\\/g, '/'), href);
      }
    }
    const depth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
    pages.push({ href, title, depth });
  }
  return pages;
}

function outputPathFor(inputPath, requestedOutput, format) {
  if (requestedOutput) return path.resolve(requestedOutput);
  const parsed = path.parse(inputPath);
  const extension = format === 'epub' ? '.epub' : format === 'docx' ? '.docx' : format === 'pdf' ? '.pdf' : DIAGRAM_FORMATS.includes(format) ? `.${format}` : '.html';
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

export async function ensureOutputDirectory(outputPath) {
  const outputDirectory = path.dirname(outputPath);
  try {
    const stats = await fs.stat(outputDirectory);
    if (!stats.isDirectory()) {
      throw new Error(`Output parent is not a directory: ${outputDirectory}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(outputDirectory, { recursive: true });
  }
}

function mimeType(filePath) {
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

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function sendFile(response, filePath) {
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeType(filePath),
      'cache-control': 'no-store',
    });
    response.end(data);
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
    response.end(error?.code === 'ENOENT' ? 'Not found' : 'Unable to read file');
  }
}

function rendererHtml(basePath) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="${basePath}/styles.css">
</head>
<body>
  <div id="markdown-page"><div id="markdown-content"></div></div>
  <script src="${basePath}/browser-renderer.js"></script>
</body>
</html>`;
}

function virtualDocumentDirectory(documentDir) {
  const normalized = documentDir.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return `__root__${normalized}`;
  return normalized;
}

function localPathFromVirtual(value) {
  if (value.startsWith('__root__/')) return `/${value.slice('__root__/'.length)}`;
  return value.replace(/\//g, path.sep);
}

async function startAssetServer(documentDir) {
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

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
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
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Render timed out after ${timeoutMs / 1000} seconds`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function renderMarkdownFile(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, options.format);
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.render === 'function');

    const html = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.render(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, html, 'utf8');
    return { outputPath, browserErrors };
  } finally {
    await browser?.close();
    await server.close();
  }
}

export async function snapshotMarkdownFile(options) {
  const inputPath = path.resolve(options.input);
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.snapshotDom === 'function');

    return await withTimeout(page.evaluate((request) => {
      return window.markdownCli.snapshotDom(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);
  } finally {
    await browser?.close();
    await server.close();
  }
}

function base64ToBuffer(base64) {
  // The page serializes bytes with String.fromCharCode, so the base64 payload
  // must be decoded as latin1 to recover the original binary bytes.
  return Buffer.from(Buffer.from(base64, 'base64').toString('latin1'), 'binary');
}

/**
 * Run the REAL single-document EPUB export pipeline (same code path as the
 * extension: HTML staticizing -> collectEpubCss -> JSZip packaging) and write
 * the generated .epub to disk.
 */
export async function exportMarkdownEpub(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, 'epub');
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderEpub === 'function');

    const result = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderEpub(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, base64ToBuffer(result.base64));
    return { outputPath, filename: result.filename, browserErrors };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Render a diagram source file (PlantUML / Mermaid / DOT / Vega / ...) to
 * SVG, PNG or DrawIO XML through the shared renderer registry.
 */
export async function exportMarkdownDiagram(options) {
  const inputPath = path.resolve(options.input);
  const diagramType = options.diagramType || inferDiagramType(inputPath);
  if (!diagramType) {
    throw new Error(`Cannot infer a diagram renderer from ${inputPath}; use --diagram-type`);
  }
  const format = options.format || 'svg';
  const content = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderDiagram === 'function');

    const result = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderDiagram(request);
    }, {
      diagramType,
      content,
      theme: options.theme || 'default',
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const ext = format === 'png' ? '.png' : format === 'drawio' ? '.drawio' : '.svg';
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + ext);

    await ensureOutputDirectory(outputPath);
    if (format === 'png') {
      if (!result.pngBase64) {
        throw new Error(`Diagram type "${diagramType}" produced no PNG`);
      }
      await fs.writeFile(outputPath, Buffer.from(result.pngBase64, 'base64'));
    } else if (format === 'drawio') {
      if (!result.drawioXml) {
        throw new Error(`Diagram type "${diagramType}" does not produce DrawIO XML (PlantUML only)`);
      }
      await fs.writeFile(outputPath, result.drawioXml, 'utf8');
    } else {
      if (!result.svg) {
        if (result.pngBase64) {
          throw new Error(`Diagram type "${diagramType}" produces PNG only; use --format png (or an output ending in .png)`);
        }
        throw new Error(`Diagram type "${diagramType}" produced no SVG`);
      }
      await fs.writeFile(outputPath, result.svg, 'utf8');
    }
    return { outputPath, browserErrors };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Run the REAL DOCX export pipeline (DocxExporter on the raw markdown) and
 * write the generated .docx to disk.
 */
export async function exportMarkdownDocx(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, 'docx');
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderDocx === 'function');

    const result = await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderDocx(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, base64ToBuffer(result.base64));
    return { outputPath, browserErrors };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Whole-book export: parse the SUMMARY.md pages and run the real book
 * pipeline (book-renderer + exportToEpub / exportBookToDocx).
 */
export async function exportMarkdownBook(options) {
  const inputPath = path.resolve(options.input);
  const summaryDir = path.dirname(inputPath);
  const summaryContent = await fs.readFile(inputPath, 'utf8');
  const pages = parseSummaryPages(summaryContent, '');
  if (pages.length === 0) {
    throw new Error(`No book pages found in ${inputPath}`);
  }
  const bookTitle = options.title || path.basename(summaryDir) || 'Book';

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(summaryDir);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    const apiName = options.format === 'epub' ? 'renderBookEpub' : 'renderBookDocx';
    await page.waitForFunction((name) => typeof window.markdownCli?.[name] === 'function', apiName);

    const result = await withTimeout(page.evaluate((request) => {
      const api = request.format === 'epub' ? window.markdownCli.renderBookEpub : window.markdownCli.renderBookDocx;
      return api(request);
    }, {
      markdown: '',
      filename: `${bookTitle}${options.format === 'epub' ? '.epub' : '.docx'}`,
      title: bookTitle,
      bookTitle,
      format: options.format,
      pages,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: summaryDir,
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const ext = options.format === 'epub' ? '.epub' : '.docx';
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(summaryDir, `${bookTitle}${ext}`);
    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, base64ToBuffer(result.base64));
    return { outputPath, browserErrors };
  } finally {
    await browser?.close();
    await server.close();
  }
}

function pdfOptions() {
  return {
    printBackground: true,
    preferCSSPageSize: true,
  };
}

function doneMessage(action, outputPath) {
  return `${action} ${outputPath}`;
}

/**
 * Export a single markdown file to PDF through the headless Chrome print
 * pipeline (shared print styles from print-utils).
 */
export async function exportMarkdownPdf(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = outputPathFor(inputPath, options.output, 'pdf');
  const markdown = await fs.readFile(inputPath, 'utf8');

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(path.dirname(inputPath));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderPdf === 'function');

    await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderPdf(request);
    }, {
      markdown,
      filename: path.basename(inputPath),
      title: options.title,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: path.dirname(inputPath),
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const pdf = await withTimeout(page.pdf(pdfOptions()), options.timeoutMs);
    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, pdf);
    return { outputPath, browserErrors };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Whole-book PDF export: parse the SUMMARY.md pages, render the book into
 * #book-print-root and print it through headless Chrome.
 */
export async function exportMarkdownBookPdf(options) {
  const inputPath = path.resolve(options.input);
  const summaryDir = path.dirname(inputPath);
  const summaryContent = await fs.readFile(inputPath, 'utf8');
  const pages = parseSummaryPages(summaryContent, '');
  if (pages.length === 0) {
    throw new Error(`No book pages found in ${inputPath}`);
  }
  const bookTitle = options.title || path.basename(summaryDir) || 'Book';

  await fs.access(path.join(cliAssetDir, 'browser-renderer.js')).catch(() => {
    throw new Error('CLI browser assets are missing. Run "npm run build:cli" first.');
  });

  const server = await startAssetServer(summaryDir);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(options.chromePath
        ? { executablePath: path.resolve(options.chromePath) }
        : { channel: 'chrome' }),
    });

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors = [];
    // Collect errors AND warnings: page-side render problems are logged as
    // concise console.warn messages (with the source line), never as full
    // stack-trace error dumps. Identical repeats (e.g. the same diagram
    // rendered twice) are collapsed.
    page.on('console', (message) => {
      if ((message.type() === 'error' || message.type() === 'warning') && !browserErrors.includes(message.text())) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(server.pageUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.markdownCli?.renderBookPdf === 'function');

    await withTimeout(page.evaluate((request) => {
      return window.markdownCli.renderBookPdf(request);
    }, {
      markdown: '',
      filename: `${bookTitle}.pdf`,
      title: bookTitle,
      pages,
      theme: options.theme,
      language: options.language,
      frontmatterDisplay: options.frontmatterDisplay,
      tableMergeEmpty: options.tableMergeEmpty,
      tableLayout: options.tableLayout,
      imageLayout: options.imageLayout,
      diagramLayout: options.diagramLayout,
      firstLineIndent: options.firstLineIndent,
      documentPath: inputPath,
      documentDir: summaryDir,
      documentBaseUrl: server.documentBaseUrl,
      fileReadUrl: server.fileReadUrl,
      resourceBaseUrl: server.resourceBaseUrl,
    }), options.timeoutMs);

    const pdf = await withTimeout(page.pdf(pdfOptions()), options.timeoutMs);
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(summaryDir, `${bookTitle}.pdf`);
    await ensureOutputDirectory(outputPath);
    await fs.writeFile(outputPath, pdf);
    return { outputPath, browserErrors };
  } finally {
    await browser?.close();
    await server.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.version) {
      process.stdout.write(`documd v${CLI_VERSION} — ${CLI_HOMEPAGE}\n`);
      return;
    }
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    // Startup banner: the version and homepage are shown when the CLI starts
    // (--version/--help print their own header); the completion message below
    // stays a clean "Rendered/Exported <path>".
    process.stdout.write(`documd v${CLI_VERSION} — ${CLI_HOMEPAGE}\n`);
    if (options.bookMode) {
      if (options.format === 'pdf') {
        const result = await exportMarkdownBookPdf(options);
        for (const warning of result.browserErrors) console.warn(`[browser] ${warning}`);
        console.log(doneMessage("Exported", result.outputPath));
        return;
      }
      const result = await exportMarkdownBook(options);
      for (const warning of result.browserErrors) console.warn(`[browser] ${warning}`);
      console.log(doneMessage("Exported", result.outputPath));
      return;
    }
    if (options.format === 'pdf') {
      const result = await exportMarkdownPdf(options);
      for (const warning of result.browserErrors) console.warn(`[browser] ${warning}`);
      console.log(doneMessage("Exported", result.outputPath));
      return;
    }
    if (options.diagramMode) {
      const result = await exportMarkdownDiagram(options);
      for (const warning of result.browserErrors) console.warn(`[browser] ${warning}`);
      console.log(doneMessage("Exported", result.outputPath));
      return;
    }
    if (options.format === 'docx') {
      const result = await exportMarkdownDocx(options);
      for (const warning of result.browserErrors) console.warn(`[browser] ${warning}`);
      console.log(doneMessage("Exported", result.outputPath));
      return;
    }
    if (options.format === 'epub') {
      const result = await exportMarkdownEpub(options);
      for (const warning of result.browserErrors) console.warn(`[browser] ${warning}`);
      console.log(doneMessage("Exported", result.outputPath));
      return;
    }
    const result = await renderMarkdownFile(options);
    for (const warning of result.browserErrors) console.warn(`[browser] ${warning}`);
    console.log(doneMessage("Rendered", result.outputPath));
  } catch (error) {
    console.error(`documd: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// Only run as a CLI entry point when this file is the invoked script.
// Compare REAL paths: process.argv[1] keeps symlinks (e.g. macOS /tmp ->
// /private/tmp, pnpm/yarn stores, npm link), while import.meta.url is the
// resolved module path. A plain path.resolve() comparison silently skipped
// main() in those layouts and the CLI exited 0 without doing anything.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
let isEntry = false;
try {
  isEntry = realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  // Fall back to the plain comparison if realpath fails (e.g. missing file).
  isEntry = invokedPath === fileURLToPath(import.meta.url);
}
if (isEntry) await main();
