#!/usr/bin/env node

/**
 * Obsidian Plugin Build Script
 *
 * Builds the Obsidian plugin including:
 * - Plugin host code (obsidian/src/host/main.ts) → main.js
 * - Webview bundle (obsidian/src/webview/main.ts) → webview/bundle.js
 * - Static assets (themes, locales, stencils, styles)
 * - iframe-render.html with inlined mermaid + worker
 *
 * The host's buildWebviewHTML() method loads the webview via Blob URL,
 * so all JS/CSS must be available for inlining or fetched via FETCH_ASSET.
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outdir = path.join(projectRoot, 'dist', 'obsidian');

/**
 * Sync version from package.json to manifest.json
 * @returns {string} Current version
 */
function syncVersion() {
  const packagePath = path.join(projectRoot, 'package.json');
  const manifestPath = path.join(__dirname, 'manifest.json');

  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.version !== packageJson.version) {
    manifest.version = packageJson.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`  • Updated manifest.json version`);
  }
  return packageJson.version;
}

/**
 * Copy directory recursively
 */
function copyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyDirectory(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/**
 * Build the Obsidian plugin (single bundle).
 *
 * Host and webview code run in the same Electron renderer process.
 * The webview module is imported directly by preview-view.ts via
 * DirectTransport, so everything compiles into one main.js.
 *
 * Output: dist/obsidian/main.js (CJS, required by Obsidian)
 */
async function buildHost() {
  console.log('📦 Building plugin...');
  await build({
    entryPoints: ['obsidian/src/host/main.ts'],
    bundle: true,
    outfile: path.join(outdir, 'main.js'),
    format: 'cjs',
    platform: 'browser',
    target: ['chrome120'],
    external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view'],
    sourcemap: process.argv.includes('--dev') ? 'inline' : false,
    minify: !process.argv.includes('--dev'),
    define: {
      'process.env.NODE_ENV': process.argv.includes('--dev') ? '"development"' : '"production"',
      'global': 'globalThis',
    },
    inject: [path.join(projectRoot, 'scripts', 'buffer-shim.js')],
    loader: {
      '.css': 'empty',
      '.woff2': 'empty',
      '.woff': 'empty',
      '.ttf': 'empty',
      '.eot': 'empty',
    },
  });
  console.log('✅ Plugin built');
}

/**
 * Build the iframe render worker (Mermaid, Vega, DrawIO renderers).
 * Output: dist/obsidian/webview/iframe-render-worker.js (IIFE)
 */
async function buildIframeRenderWorker() {
  console.log('📦 Building iframe-render-worker...');
  await build({
    entryPoints: {
      'iframe-render-worker': path.join(projectRoot, 'mobile', 'src', 'webview', 'iframe-render-worker.ts'),
    },
    bundle: true,
    outdir: path.join(outdir, 'webview'),
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: !process.argv.includes('--dev'),
    define: {
      'process.env.NODE_ENV': process.argv.includes('--dev') ? '"development"' : '"production"',
      'global': 'globalThis',
      'PLATFORM': '"obsidian"',
    },
    inject: [path.join(projectRoot, 'scripts', 'buffer-shim.js')],
    loader: {
      '.css': 'css',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
    },
    external: ['mermaid'],
  });
  console.log('✅ iframe-render-worker built');
}

/**
 * Build CSS bundle.
 */
async function buildCSS() {
  console.log('📦 Building CSS...');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'ui', 'styles.css')],
    bundle: true,
    outfile: path.join(outdir, 'webview', 'styles.css'),
    loader: {
      '.css': 'css',
      '.woff2': 'file',
      '.woff': 'empty',
      '.ttf': 'empty',
      '.eot': 'empty',
    },
    assetNames: '[name]',
    minify: !process.argv.includes('--dev'),
  });
  console.log('✅ CSS built');
}

/**
 * Copy static assets into dist/obsidian/
 */
function copyAssets() {
  console.log('📦 Copying assets...');

  // manifest.json
  fs.copyFileSync(
    path.join(projectRoot, 'obsidian', 'manifest.json'),
    path.join(outdir, 'manifest.json'),
  );
  console.log('  • manifest.json');

  // Locales
  copyDirectory(
    path.join(projectRoot, 'src', '_locales'),
    path.join(outdir, 'webview', '_locales'),
  );
  console.log('  • _locales');

  // Themes
  copyDirectory(
    path.join(projectRoot, 'src', 'themes'),
    path.join(outdir, 'webview', 'themes'),
  );
  console.log('  • themes');

  // DrawIO stencils
  const stencilsSrc = path.join(projectRoot, 'node_modules', '@markdown-viewer', 'drawio2svg', 'resources', 'stencils');
  if (fs.existsSync(stencilsSrc)) {
    copyDirectory(stencilsSrc, path.join(outdir, 'webview', 'stencils'));
    console.log('  • stencils');
  }

  // Settings panel CSS
  const settingsCss = path.join(projectRoot, 'vscode', 'src', 'webview', 'settings-panel.css');
  if (fs.existsSync(settingsCss)) {
    fs.copyFileSync(settingsCss, path.join(outdir, 'webview', 'settings-panel.css'));
    console.log('  • settings-panel.css');
  }

  // Create iframe-render.html with inlined JS
  const mermaidPath = path.join(projectRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
  const workerPath = path.join(outdir, 'webview', 'iframe-render-worker.js');
  if (fs.existsSync(mermaidPath) && fs.existsSync(workerPath)) {
    const mermaidJs = fs.readFileSync(mermaidPath, 'utf8');
    const workerJs = fs.readFileSync(workerPath, 'utf8');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';">
  <title>Render Frame</title>
  <style>* { margin: 0; padding: 0; } html, body { background: transparent; width: 1400px; min-height: 600px; }</style>
</head>
<body>
  <div id="render-container"></div>
  <canvas id="png-canvas"></canvas>
  <script>${mermaidJs}</script>
  <script>${workerJs}</script>
</body>
</html>`;
    fs.writeFileSync(path.join(outdir, 'webview', 'iframe-render.html'), html);
    // Remove standalone worker file
    fs.unlinkSync(workerPath);
    console.log('  • iframe-render.html');
  }

  // styles.css for plugin (container styles + webview CSS + settings CSS)
  // Obsidian auto-loads styles.css — merge everything into one file.
  const pluginStyles = `
/* Obsidian Markdown Viewer Preview — plugin styles */
.markdown-viewer-preview {
  padding: 0;
  overflow-y: auto !important;
  user-select: text !important;
  -webkit-user-select: text !important;
}
.markdown-viewer-preview #markdown-wrapper {
  margin-left: 0 !important;
  margin-top: 0 !important;
}
.markdown-viewer-preview #markdown-page {
  max-width: none !important;
}
.markdown-viewer-preview #toolbar,
.markdown-viewer-preview #table-of-contents,
.markdown-viewer-preview #toc-overlay {
  display: none !important;
}
.markdown-viewer-preview #markdown-content {
  box-shadow: none;
  min-height: auto;
}

/* Map Obsidian CSS variables → --vscode-* for settings panel compatibility */
.markdown-viewer-preview {
  --vscode-foreground: var(--text-normal);
  --vscode-font-family: var(--font-interface);
  --vscode-dropdown-background: var(--background-secondary);
  --vscode-dropdown-foreground: var(--text-normal);
  --vscode-dropdown-border: var(--background-modifier-border);
  --vscode-panel-border: var(--background-modifier-border);
  --vscode-editor-background: var(--background-primary);
  --vscode-contrastBorder: var(--background-modifier-border);
  --vscode-button-secondaryBorder: var(--background-modifier-border);
  --vscode-button-border: transparent;
  --vscode-button-hoverBackground: var(--interactive-accent-hover);
  --vscode-toolbar-hoverBackground: var(--background-modifier-hover);
  --vscode-list-hoverBackground: var(--background-modifier-hover);
  --vscode-list-activeSelectionBackground: var(--interactive-accent);
  --vscode-list-activeSelectionForeground: var(--text-on-accent);
  --vscode-focusBorder: var(--interactive-accent);
  --vscode-input-background: var(--background-primary);
  --vscode-input-border: var(--background-modifier-border);
  --vscode-input-foreground: var(--text-normal);
  --vscode-badge-background: var(--interactive-accent);
  --vscode-badge-foreground: var(--text-on-accent);
  --vscode-button-background: var(--interactive-accent);
  --vscode-button-foreground: var(--text-on-accent);
  --vscode-checkbox-background: var(--background-secondary);
  --vscode-checkbox-border: var(--background-modifier-border);
}

/* Override Obsidian global form styles within the settings panel */
.vscode-settings-panel select,
.vscode-settings-panel button,
.vscode-settings-panel input {
  box-shadow: none !important;
  -webkit-appearance: none;
  appearance: none;
}
.vscode-settings-panel select.vscode-settings-select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 5l3 3 3-3z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  padding-right: 24px;
}
.vscode-settings-panel .vscode-cache-clear-btn {
  border-radius: 2px !important;
}
`;

  // Combine: plugin container styles + webview CSS + settings panel CSS
  let combinedCss = pluginStyles.trim() + '\n\n';

  // Append webview styles (blockquote, code, headings, etc.)
  const webviewCssPath = path.join(outdir, 'webview', 'styles.css');
  if (fs.existsSync(webviewCssPath)) {
    combinedCss += '/* === Webview Styles === */\n';
    let webviewCss = fs.readFileSync(webviewCssPath, 'utf8');
    // Replace @font-face url() references with base64-embedded data URLs
    webviewCss = webviewCss.replace(/@font-face\s*\{[^}]*\}/g, (block) => {
      const urlMatch = block.match(/url\(['"]?\.\/(.*?\.woff2)['"]?\)/);
      if (!urlMatch) return block;
      const fontFile = urlMatch[1];
      const fontPath = path.join(outdir, 'webview', fontFile);
      if (!fs.existsSync(fontPath)) return '';
      const b64 = fs.readFileSync(fontPath).toString('base64');
      return block.replace(/url\(['"]?\.\/(.*?\.woff2)['"]?\)\s*(format\([^)]*\))?/, `url("data:font/woff2;base64,${b64}") format("woff2")`);
    });
    combinedCss += webviewCss + '\n\n';
  }

  // Append settings panel CSS
  const settingsCssPath = path.join(outdir, 'webview', 'settings-panel.css');
  if (fs.existsSync(settingsCssPath)) {
    combinedCss += '/* === Settings Panel Styles === */\n';
    combinedCss += fs.readFileSync(settingsCssPath, 'utf8') + '\n';
  }

  fs.writeFileSync(path.join(outdir, 'styles.css'), combinedCss);
  console.log('  • styles.css (combined)');

  console.log('✅ Assets copied');
}

/**
 * Main build entry
 */
async function main() {
  const isDev = process.argv.includes('--dev');
  const version = syncVersion();
  console.log(`🔨 Building Obsidian Plugin... v${version} ${isDev ? '(dev)' : '(production)'}\n`);

  process.chdir(projectRoot);

  try {
    // Clean output
    if (fs.existsSync(outdir)) fs.rmSync(outdir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outdir, 'webview'), { recursive: true });

    // Build all parts
    await buildHost();
    await buildIframeRenderWorker();
    await buildCSS();
    copyAssets();

    console.log(`\n✅ Build complete! Output: dist/obsidian/`);
  } catch (error) {
    console.error('\n❌ Build failed:', error);
    process.exit(1);
  }
}

main();
