#!/usr/bin/env fibjs

// Mobile build script - packages WebView resources for Flutter app
// All JS/CSS bundled into single files for simpler loading
import fs from 'fs';
import path from 'path';
import { build } from 'esbuild';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const DIST_DIR = 'mobile/build/mobile';
const SRC_DIR = 'src';

/**
 * Sync version from package.json to pubspec.yaml
 * @returns {string} Current version
 */
function syncVersion() {
  const packagePath = path.join(projectRoot, 'package.json');
  const pubspecPath = path.join(__dirname, 'pubspec.yaml');
  
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
    console.log(`  • Updated pubspec.yaml version`);
  }
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

/**
 * Download custom fonts if not present
 */
async function downloadFonts() {
  try {
    await import('../scripts/download-fonts.js');
  } catch (error) {
    console.error('⚠️  Warning: Failed to download fonts:', error.message);
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
  console.log('📦 Building main bundle...');

  await build({
    entryPoints: {
      'bundle': 'mobile/src/webview/main.ts'
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

  console.log('✅ Main bundle built');
}

/**
 * Build render frame bundle (heavy renderers: mermaid, vega, etc.)
 * Runs in isolated iframe to avoid blocking main thread
 */
async function buildIframeRenderWorkerBundle() {
  console.log('📦 Building iframe-render-worker...');

  await build({
    entryPoints: {
      'iframe-render-worker': 'mobile/src/webview/iframe-render-worker.ts'
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

  console.log('✅ Iframe-render-worker built');
}

/**
 * Build styles - all CSS bundled into one file
 * Includes: app styles, katex, highlight.js, custom Chinese fonts
 */
async function buildStyles() {
  console.log('📦 Building styles...');

  // Create a combined CSS entry point in project root (where paths resolve correctly)
  const combinedCssPath = path.join(projectRoot, '_combined_mobile.css');
  const cssImports = [
    '@import "./src/ui/styles.css";',
    '@import "./node_modules/katex/dist/katex.min.css";',
    '@import "./node_modules/highlight.js/styles/github.css";',
    '@import "./mobile/mobile-fonts.css";'
  ].join('\n');
  
  fs.writeFileSync(combinedCssPath, cssImports);

  await build({
    entryPoints: [combinedCssPath],
    bundle: true,
    outfile: `${DIST_DIR}/styles.css`,
    loader: {
      '.css': 'css',
      '.eot': 'dataurl'  // KaTeX fonts (small)
    },
    // Keep font URLs as-is, files are copied separately
    external: ['*.woff', '*.woff2', '*.ttf'],
    minify: true
  });

  // Clean up temp file
  fs.unlinkSync(combinedCssPath);

  console.log('✅ Styles built');
}

/**
 * Copy static resources (only non-JS/CSS resources)
 */
function copyResources() {
  console.log('� Copying resources...');

  // Copy HTML templates
  copyFile('mobile/src/webview/index.html', `${DIST_DIR}/index.html`);
  console.log('  • index.html');
  
  copyFile('mobile/src/webview/iframe-render.html', `${DIST_DIR}/iframe-render.html`);
  console.log('  • iframe-render.html');

  // Copy mermaid library (loaded separately via script tag)
  const libsDir = `${DIST_DIR}/libs`;
  if (!fs.existsSync(libsDir)) {
    fs.mkdirSync(libsDir, { recursive: true });
  }
  copyFile('node_modules/mermaid/dist/mermaid.min.js', `${libsDir}/mermaid.min.js`);
  console.log('  • libs/mermaid.min.js');

  // Copy themes
  copyDirectory('src/themes', `${DIST_DIR}/themes`);
  console.log('  • themes');

  // Copy locales
  copyDirectory('src/_locales', `${DIST_DIR}/_locales`);
  console.log('  • _locales');

  // Copy DrawIO stencils
  copyDirectory('node_modules/@markdown-viewer/drawio2svg/resources/stencils', `${DIST_DIR}/stencils`);
  console.log('  • stencils');

  // Copy app icons for Flutter
  const iconsDir = `${DIST_DIR}/icons`;
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }
  copyFile('icons/icon128.png', `${iconsDir}/icon128.png`);
  console.log('  • icons');

  // Copy KaTeX fonts (only woff2 for modern browsers)
  const katexFontsDir = 'node_modules/katex/dist/fonts';
  if (fs.existsSync(katexFontsDir)) {
    const fontsDestDir = `${DIST_DIR}/fonts`;
    if (!fs.existsSync(fontsDestDir)) {
      fs.mkdirSync(fontsDestDir, { recursive: true });
    }
    // Only copy .woff2 files (modern, smallest format)
    const fontFiles = fs.readdirSync(katexFontsDir);
    for (const file of fontFiles) {
      if (file.endsWith('.woff2')) {
        fs.copyFileSync(
          path.join(katexFontsDir, file),
          path.join(fontsDestDir, file)
        );
      }
    }
    console.log('  • fonts (KaTeX)');
  }

  // Copy custom Chinese fonts (Zhuque Fangsong for FangSong fallback)
  const customFontsDir = 'mobile/build/fonts';
  if (fs.existsSync(customFontsDir)) {
    const fontsDestDir = `${DIST_DIR}/fonts`;
    if (!fs.existsSync(fontsDestDir)) {
      fs.mkdirSync(fontsDestDir, { recursive: true });
    }
    const fontFiles = fs.readdirSync(customFontsDir);
    for (const file of fontFiles) {
      if (file.endsWith('.woff2') || file.endsWith('.ttf')) {
        fs.copyFileSync(
          path.join(customFontsDir, file),
          path.join(fontsDestDir, file)
        );
      }
    }
    console.log('  • fonts (custom Chinese)');
  }

  console.log('✅ Resources copied');
}

/**
 * Main build function
 */
async function main() {
  // Change to project root for esbuild to work correctly
  process.chdir(projectRoot);

  // Sync version first
  const version = syncVersion();
  console.log(`🔨 Building Mobile App... v${version}\n`);

  // Check translations
  await checkMissingKeys();

  // Download fonts if needed
  await downloadFonts();

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
    
    const formatSize = (bytes) => bytes >= 1024 * 1024 
      ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
      : `${(bytes / 1024).toFixed(2)} KB`;
    
    console.log(`\n📊 Bundle sizes:`);
    console.log(`   bundle.js: ${formatSize(mainBundleSize)}`);
    console.log(`   iframe-render-worker.js: ${formatSize(renderBundleSize)}`);
    console.log(`   styles.css: ${formatSize(stylesSize)}`);

    console.log(`\n✅ Build complete! Output: ${DIST_DIR}/`);
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

main();
