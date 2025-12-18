#!/usr/bin/env fibjs

// Mobile build script - packages WebView resources for Flutter app
// All JS/CSS bundled into single files for simpler loading
import fs from 'fs';
import path from 'path';
import { build } from 'esbuild';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIST_DIR = 'build/mobile';
const SRC_DIR = 'src';

/**
 * Sync version from package.json to pubspec.yaml
 */
function syncVersion() {
  const packagePath = path.join(__dirname, '../package.json');
  const pubspecPath = path.join(__dirname, '../pubspec.yaml');
  
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  let pubspec = fs.readFileSync(pubspecPath, 'utf8');
  
  // Flutter version format: major.minor.patch+buildNumber
  const versionMatch = pubspec.match(/version:\s*([\d.]+)(\+\d+)?/);
  const currentVersion = versionMatch ? versionMatch[1] : null;
  const buildNumber = versionMatch && versionMatch[2] ? versionMatch[2] : '+1';
  
  if (currentVersion !== packageJson.version) {
    const newVersion = `${packageJson.version}${buildNumber}`;
    pubspec = pubspec.replace(/version:\s*[\d.]+(\+\d+)?/, `version: ${newVersion}`);
    fs.writeFileSync(pubspecPath, pubspec, 'utf8');
    console.log(`📌 Updated pubspec.yaml version: ${newVersion}`);
  }
}

/**
 * Copy directory recursively
 */
function copyDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(sourceDir, entry.name);
    const destPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy file if exists
 */
function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;

  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.copyFileSync(src, dest);
  return true;
}

/**
 * Build main bundle (lightweight - no heavy renderers)
 * Heavy renderers (mermaid, vega) are in iframe-render-worker bundle
 */
async function buildMainBundle() {
  console.log('📦 Building main bundle (lightweight)...');

  await build({
    entryPoints: {
      'bundle': 'src/platform/mobile/main.ts'
    },
    bundle: true,
    outdir: DIST_DIR,
    format: 'iife',
    target: ['es2020'],
    treeShaking: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'global': 'globalThis',
      'PLATFORM': '"mobile"'
    },
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'css',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl'
    },
    minify: true,
    sourcemap: false,
    external: []
  });

  console.log(`✅ Main bundle created: ${DIST_DIR}/bundle.js`);
}

/**
 * Build render frame bundle (heavy renderers: mermaid, vega, etc.)
 * Runs in isolated iframe to avoid blocking main thread
 */
async function buildIframeRenderWorkerBundle() {
  console.log('📦 Building iframe-render-worker bundle (renderers)...');

  await build({
    entryPoints: {
      'iframe-render-worker': 'src/renderers/worker/dom/iframe-render-worker.ts'
    },
    bundle: true,
    outdir: DIST_DIR,
    format: 'iife',
    target: ['es2020'],
    treeShaking: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'global': 'globalThis',
      'PLATFORM': '"mobile"'
    },
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'css',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl'
    },
    minify: true,
    sourcemap: false,
    external: []
  });

  console.log(`✅ Iframe render worker bundle created: ${DIST_DIR}/iframe-render-worker.js`);
}

/**
 * Build styles - all CSS bundled into one file
 * Includes: app styles, katex, highlight.js
 */
async function buildStyles() {
  console.log('🎨 Building styles (all-in-one)...');

  // Create a combined CSS entry point in project root (where paths resolve correctly)
  const combinedCssPath = '_combined_mobile.css';
  const cssImports = [
    '@import "./src/ui/styles.css";',
    '@import "./node_modules/katex/dist/katex.min.css";',
    '@import "./node_modules/highlight.js/styles/github.css";'
  ].join('\n');
  
  fs.writeFileSync(combinedCssPath, cssImports);

  await build({
    entryPoints: [combinedCssPath],
    bundle: true,
    outfile: `${DIST_DIR}/styles.css`,
    loader: {
      '.css': 'css',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.eot': 'dataurl'
    },
    minify: true
  });

  // Clean up temp file
  fs.unlinkSync(combinedCssPath);

  console.log(`✅ Styles created: ${DIST_DIR}/styles.css`);
}

/**
 * Copy static resources (only non-JS/CSS resources)
 */
function copyResources() {
  console.log('📂 Copying resources...');

  // Copy HTML templates
  copyFile('src/platform/mobile/index.html', `${DIST_DIR}/index.html`);
  console.log('  ✓ index.html');
  
  copyFile('src/renderers/worker/dom/iframe-render.html', `${DIST_DIR}/iframe-render.html`);
  console.log('  ✓ iframe-render.html');

  // Copy themes
  copyDirectory('src/themes', `${DIST_DIR}/themes`);
  console.log('  ✓ themes/');

  // Copy locales
  copyDirectory('src/_locales', `${DIST_DIR}/_locales`);
  console.log('  ✓ _locales/');

  // Copy KaTeX fonts (needed for math rendering, CSS is bundled)
  const katexFontsDir = 'node_modules/katex/dist/fonts';
  if (fs.existsSync(katexFontsDir)) {
    copyDirectory(katexFontsDir, `${DIST_DIR}/fonts`);
    console.log('  ✓ fonts/ (KaTeX)');
  }

  console.log('✅ Resources copied');
}

/**
 * Main build function
 */
async function main() {
  console.log('🚀 Building mobile WebView resources...\n');

  // Sync version first
  syncVersion();

  // Clean build/mobile
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  try {
    await buildMainBundle();
    await buildIframeRenderWorkerBundle();
    await buildStyles();
    copyResources();

    // Show bundle sizes
    const mainBundleSize = fs.statSync(`${DIST_DIR}/bundle.js`).size;
    const renderBundleSize = fs.statSync(`${DIST_DIR}/iframe-render-worker.js`).size;
    const stylesSize = fs.statSync(`${DIST_DIR}/styles.css`).size;
    console.log(`\n📊 Bundle sizes:`);
    console.log(`   bundle.js:       ${(mainBundleSize / 1024 / 1024).toFixed(2)} MB (main view)`);
    console.log(`   iframe-render-worker.js: ${(renderBundleSize / 1024 / 1024).toFixed(2)} MB (renderers)`);
    console.log(`   styles.css:      ${(stylesSize / 1024).toFixed(2)} KB`);

    console.log('\n✨ Mobile build complete!');
    console.log(`📁 Output: ${DIST_DIR}/`);
    console.log('\nArchitecture:');
    console.log('  - index.html (main view, loads bundle.js)');
    console.log('  - iframe-render.html (iframe, loads iframe-render-worker.js for diagrams)');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

main();