#!/usr/bin/env fibjs

import { build } from 'esbuild';
import { createBuildConfig } from './build-config.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * Sync version from package.json to manifest.json
 * @returns {string} Current version
 */
function syncVersion() {
  const packagePath = path.join(projectRoot, 'package.json');
  const manifestPath = path.join(__dirname, 'manifest.json');
  
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  
  if (manifest.version !== packageJson.version) {
    // Only replace the version line to preserve structure
    const newManifestText = manifestText.replace(
      /"version":\s*"[^"]*"/,
      `"version": "${packageJson.version}"`
    );
    fs.writeFileSync(manifestPath, newManifestText, 'utf8');
    console.log(`  • Updated manifest.json version`);
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

function ensureSlidevAssets() {
  console.log('📦 Building Slidev shell assets...');
  execSync('npm run build:slidev-shell', { stdio: 'inherit' });
  execSync('npx tsx slidev-shell/build-themes.ts', { stdio: 'inherit' });
}

// Production build
const version = syncVersion();
console.log(`🔨 Building Chrome Extension... v${version}\n`);

try {
  // Sync supported formats
  const { default: syncFormats } = await import('../scripts/sync-formats.js');
  syncFormats();

  // Sync settings schema
  const { default: syncSettings } = await import('../scripts/sync-settings.js');
  syncSettings();

  // Check translations
  await checkMissingKeys();

  // Build Slidev shell + theme bundles required by Chrome runtime
  ensureSlidevAssets();

  // Clean dist/chrome to avoid stale artifacts.
  const outdir = path.join(projectRoot, 'dist/chrome');
  if (fs.existsSync(outdir)) {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
  
  // Change to project root for esbuild to work correctly
  process.chdir(projectRoot);
  
  const config = createBuildConfig();
  await build(config);
  
  // Copy LICENSE
  const licenseSrc = path.join(projectRoot, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(outdir, 'LICENSE'));
    console.log('  • LICENSE');
  }
  
  // Create ZIP file for Chrome Web Store submission
  const zipPath = path.join(projectRoot, 'dist', `chrome-v${version}.zip`);
  console.log('\n📦 Creating ZIP package...');
  
  // Remove existing zip if present
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  
  // Create zip from inside the chrome directory (so manifest.json is at root)
  execSync(`cd "${outdir}" && zip -r "${zipPath}" .`, { stdio: 'ignore' });
  
  // Show zip file size
  const zipStats = fs.statSync(zipPath);
  const zipSize = zipStats.size >= 1024 * 1024
    ? `${(zipStats.size / 1024 / 1024).toFixed(2)} MB`
    : `${(zipStats.size / 1024).toFixed(2)} KB`;
  console.log(`   chrome-v${version}.zip: ${zipSize}`);
  
  console.log(`\n✅ Build complete!`);
  console.log(`   Output: dist/chrome/`);
  console.log(`   Package: dist/chrome-v${version}.zip`);
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}
