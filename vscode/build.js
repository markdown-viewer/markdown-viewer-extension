#!/usr/bin/env node

/**
 * VS Code Extension Build Script
 * 
 * Builds the VS Code extension including:
 * - Extension host code (vscode/src/extension.ts)
 * - Webview bundle (vscode/src/webview/main.ts + shared src/)
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * Get version from root package.json
 * @returns {string} Current version
 */
function getVersion() {
  const packagePath = path.join(projectRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return packageJson.version;
}

/**
 * Check for missing translation keys
 */
async function checkMissingKeys() {
  console.log('📦 Checking translations...');
  try {
    await import('../scripts/check-missing-keys.js');
  } catch (error) {
    console.error('⚠️  Warning: Failed to check translation keys:', error.message);
  }
}

// Sync supported formats
const { default: syncFormats } = await import('../scripts/sync-formats.js');
syncFormats();

/**
 * Copy directory recursively
 */
function copyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

/**
 * Build extension host (Node.js environment)
 */
async function buildExtensionHost() {
  console.log('📦 Building extension host...');

  await build({
    entryPoints: ['vscode/src/host/extension.ts'],
    bundle: true,
    outfile: 'dist/vscode/extension.js',
    format: 'cjs', // VS Code extensions use CommonJS
    platform: 'node',
    target: ['node18'],
    external: ['vscode'], // vscode module is provided by VS Code
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'MV_PLATFORM': '"vscode"',
      'MV_RUNTIME': '"background"'
    }
  });

  console.log('✅ Extension host built');
}

/**
 * Build webview bundle (browser environment)
 */
async function buildWebview() {
  console.log('📦 Building webview bundle...');

  // Build JS bundle
  await build({
    entryPoints: ['vscode/src/webview/main.ts'],
    bundle: true,
    outfile: 'dist/vscode/webview/bundle.js',
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'MV_PLATFORM': '"vscode"',
      'MV_RUNTIME': '"webview"',
      'global': 'globalThis'
    },
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'empty', // Don't bundle CSS in JS
      '.woff2': 'empty',
      '.woff': 'empty',
      '.ttf': 'empty',
      '.eot': 'empty'
    },
    assetNames: '[name]'
  });

  // Build iframe-render-worker bundle (heavy renderers: mermaid, vega, etc.)
  console.log('📦 Building iframe-render-worker...');
  await build({
    entryPoints: {
      'iframe-render-worker': 'mobile/src/webview/iframe-render-worker.ts'
    },
    bundle: true,
    outdir: 'dist/vscode/webview',
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'MV_PLATFORM': '"vscode"',
      'MV_RUNTIME': '"worker"',
      'global': 'globalThis'
    },
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'css',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl'
    },
    // Mermaid is loaded separately to keep bundle size manageable
    external: ['mermaid', 'web-worker']
  });

  // Build CSS bundle separately
  await build({
    entryPoints: ['src/ui/styles.css'],
    bundle: true,
    outfile: 'dist/vscode/webview/styles.css',
    loader: {
      '.css': 'css',
      '.woff2': 'file',
      '.woff': 'empty',
      '.ttf': 'empty',
      '.eot': 'empty'
    },
    assetNames: '[name]',
    minify: true
  });

  console.log('✅ Webview bundle built');
}

/**
 * Copy static assets
 */
function copyAssets() {
  console.log('� Copying assets...');

  const outdir = 'dist/vscode';

  // Create package.json for VS Code extension
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  
  // Extract VS Code specific fields
  const vscodePackage = {
    name: packageJson.name,
    displayName: packageJson.displayName,
    description: packageJson.description,
    version: packageJson.version,
    publisher: packageJson.publisher,
    license: packageJson.license,
    engines: {
      vscode: packageJson.engines?.vscode || '^1.85.0'
    },
    categories: packageJson.categories,
    activationEvents: packageJson.activationEvents,
    main: './extension.js',
    contributes: packageJson.contributes,
    icon: packageJson.icon,
    repository: packageJson.repository,
    keywords: packageJson.keywords?.filter(k => !k.includes('chrome'))
  };

  fs.writeFileSync(
    path.join(outdir, 'package.json'),
    JSON.stringify(vscodePackage, null, 2)
  );
  console.log('  • package.json');

  // Copy package.nls*.json files for VSCode menu localization
  const nlsSourceDir = path.join(projectRoot, 'vscode', '_locales');
  if (fs.existsSync(nlsSourceDir)) {
    const nlsFiles = fs.readdirSync(nlsSourceDir).filter(f => f.startsWith('package.nls') && f.endsWith('.json'));
    for (const nlsFile of nlsFiles) {
      fs.copyFileSync(path.join(nlsSourceDir, nlsFile), path.join(outdir, nlsFile));
    }
    console.log(`  • package.nls*.json (${nlsFiles.length} files)`);
  }

  // Copy locales
  copyDirectory('src/_locales', path.join(outdir, 'webview', '_locales'));
  console.log('  • _locales');

  // Copy themes
  copyDirectory('src/themes', path.join(outdir, 'webview', 'themes'));
  console.log('  • themes');

  // Copy DrawIO stencils
  copyDirectory('node_modules/@markdown-viewer/drawio2svg/resources/stencils', path.join(outdir, 'webview', 'stencils'));
  console.log('  • stencils');

  // Create iframe-render.html with inlined JS (for diagram rendering)
  // Mermaid is inlined first, then the worker script
  const mermaidJs = fs.readFileSync(path.join(projectRoot, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8');
  const iframeWorkerJs = fs.readFileSync(path.join(outdir, 'webview', 'iframe-render-worker.js'), 'utf8');
  const iframeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; connect-src https://fonts.googleapis.com https://fonts.gstatic.com;">
  <title>Render Frame</title>
  <style>
    * { margin: 0; padding: 0; }
    html, body { background: transparent; width: 1400px; min-height: 600px; }
  </style>
</head>
<body>
  <div id="render-container"></div>
  <canvas id="png-canvas"></canvas>
  <script>${mermaidJs}</script>
  <script>${iframeWorkerJs}</script>
</body>
</html>`;
  fs.writeFileSync(path.join(outdir, 'webview', 'iframe-render.html'), iframeHtml);
  // Remove standalone worker JS file since it's now inlined
  fs.unlinkSync(path.join(outdir, 'webview', 'iframe-render-worker.js'));
  console.log('  • iframe-render.html');

  // Copy icons
  copyDirectory('icons', path.join(outdir, 'icons'));
  console.log('  • icons');

  // Create self-contained Slidev Shell HTML
  // Single JS + single CSS from Vite build, inlined into one HTML file.
  // Loaded by main webview as a blob URL iframe.
  const slidevVscodeDir = path.join(projectRoot, 'dist', 'slidev-shell-vscode');
  if (fs.existsSync(slidevVscodeDir)) {
    const shellJs = fs.readFileSync(path.join(slidevVscodeDir, 'slidev-shell.js'), 'utf8');
    const shellCss = fs.readFileSync(path.join(slidevVscodeDir, 'assets', 'style.css'), 'utf8');

    // Read theme bundles and write as separate JSON file for webview to fetch
    const themesDir = path.join(projectRoot, 'dist', 'themes');
    if (fs.existsSync(themesDir)) {
      const manifest = JSON.parse(fs.readFileSync(path.join(themesDir, 'themes.json'), 'utf8'));
      const bundles = {};
      for (const [name, entry] of Object.entries(manifest)) {
        const themeFile = path.join(themesDir, /** @type {string} */ (entry.file));
        if (fs.existsSync(themeFile)) {
          bundles[name] = { code: fs.readFileSync(themeFile, 'utf8'), fonts: entry.fonts || {}, fontUrl: entry.fontUrl, colorSchema: entry.colorSchema };
        }
      }
      fs.writeFileSync(path.join(outdir, 'webview', 'slidev-theme-bundles.json'), JSON.stringify(bundles));
      console.log(`  • ${Object.keys(bundles).length} theme bundles (slidev-theme-bundles.json)`);
    } else {
      console.warn('  ⚠️  dist/themes not found — run "npx tsx slidev-shell/build-themes.ts" first');
    }

    const slidevInlineHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Slidev Shell</title>
  <style>${shellCss}</style>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="__SLIDEV_NONCE__">${shellJs}<\/script>
</body>
</html>`;

    fs.writeFileSync(path.join(outdir, 'webview', 'slidev-shell-inline.html'), slidevInlineHtml);
    console.log('  • slidev-shell-inline.html');
  } else {
    console.warn('  ⚠️  dist/slidev-shell-vscode not found — run "cd slidev-shell && npx vite build --config vite.vscode.config.ts" first');
  }

  // Copy settings panel styles
  if (fs.existsSync('vscode/src/webview/settings-panel.css')) {
    fs.copyFileSync('vscode/src/webview/settings-panel.css', path.join(outdir, 'webview', 'settings-panel.css'));
    console.log('  • settings-panel.css');
  }

  // Copy search panel styles
  if (fs.existsSync('vscode/src/webview/search-panel.css')) {
    fs.copyFileSync('vscode/src/webview/search-panel.css', path.join(outdir, 'webview', 'search-panel.css'));
    console.log('  • search-panel.css');
  }

  // Copy TOC panel styles
  if (fs.existsSync('vscode/src/webview/toc-panel.css')) {
    fs.copyFileSync('vscode/src/webview/toc-panel.css', path.join(outdir, 'webview', 'toc-panel.css'));
    console.log('  • toc-panel.css');
  }

  // Note: fonts (ZhuqueFangsong, ComicNeue) are only needed for mobile app
  // VS Code extension uses system fonts, no need to bundle custom fonts

  // Copy README from vscode directory
  if (fs.existsSync('vscode/README.md')) {
    fs.copyFileSync('vscode/README.md', path.join(outdir, 'README.md'));
    console.log('  • README.md');
  }

  // Copy LICENSE
  if (fs.existsSync('LICENSE')) {
    fs.copyFileSync('LICENSE', path.join(outdir, 'LICENSE'));
    console.log('  • LICENSE');
  }

  // Create .vscodeignore
  const vscodeignore = `
.vscode/**
node_modules/**
src/**
**/*.ts
**/*.map
.gitignore
tsconfig.json
`;
  fs.writeFileSync(path.join(outdir, '.vscodeignore'), vscodeignore.trim());
  console.log('  • .vscodeignore');

  console.log('✅ Assets copied');
}

/**
 * Main build function
 */
async function main() {
  const version = getVersion();
  console.log(`🔨 Building VS Code Extension... v${version}\n`);

  // Check translations
  await checkMissingKeys();

  // Change to project root for esbuild to work correctly
  process.chdir(projectRoot);

  try {
    // Clean output directory
    const outdir = 'dist/vscode';
    if (fs.existsSync(outdir)) {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
    fs.mkdirSync(outdir, { recursive: true });
    fs.mkdirSync(path.join(outdir, 'webview'), { recursive: true });

    // Build all parts
    await buildExtensionHost();
    await buildWebview();
    copyAssets();

    console.log(`\n✅ Build complete! Output: ${outdir}/`);

    // Package the extension
    console.log('\n📦 Packaging extension...');
    const vsceCmd = path.join(projectRoot, 'node_modules', '.bin', 'vsce');
    execSync(`"${vsceCmd}" package`, { cwd: outdir, stdio: 'inherit' });
    console.log('✅ Extension packaged!');

  } catch (error) {
    console.error('\n❌ Build failed:', error);
    process.exit(1);
  }
}

main();
