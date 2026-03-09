#!/usr/bin/env fibjs

import { build } from 'esbuild';
import { createBuildConfig } from './build-config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createZip } from '../scripts/create-zip.js';

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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  if (manifest.version !== packageJson.version) {
    manifest.version = packageJson.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
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

// Production build
const version = syncVersion();
console.log(`🔨 Building Firefox Extension... v${version}\n`);

try {
  // Sync supported formats
  const { default: syncFormats } = await import('../scripts/sync-formats.js');
  syncFormats();

  // Check translations
  await checkMissingKeys();

  // Clean dist/firefox to avoid stale artifacts
  const outdir = path.join(projectRoot, 'dist/firefox');
  if (fs.existsSync(outdir)) {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
  
  // Change to project root for esbuild to work correctly
  process.chdir(projectRoot);
  
  const config = createBuildConfig();
  const result = await build(config);
  
  // Analyze bundle sizes
  if (result.metafile) {
    const outputs = result.metafile.outputs;
    console.log('\n📊 Bundle sizes:');
    const bundles = Object.entries(outputs)
      .filter(([name]) => name.endsWith('.js'))
      .map(([name, info]) => ({
        name: name.replace('dist/firefox/', ''),
        size: info.bytes
      }))
      .sort((a, b) => b.size - a.size);
    
    for (const bundle of bundles) {
      const size = bundle.size >= 1024 * 1024 
        ? `${(bundle.size / 1024 / 1024).toFixed(2)} MB`
        : `${(bundle.size / 1024).toFixed(2)} KB`;
      console.log(`   ${bundle.name}: ${size}`);
    }
  }
  
  // Copy LICENSE
  const licenseSrc = path.join(projectRoot, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(outdir, 'LICENSE'));
    console.log('  • LICENSE');
  }
  
  // Create ZIP file for Firefox Add-ons submission
  const zipPath = path.join(projectRoot, 'dist', `firefox-v${version}.zip`);
  console.log('\n📦 Creating ZIP package...');
  
  // Remove existing zip if present
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  
  // Create zip from inside the firefox directory (so manifest.json is at root)
  createZip(outdir, zipPath);
  
  // Show zip file size
  const zipStats = fs.statSync(zipPath);
  const zipSize = zipStats.size >= 1024 * 1024
    ? `${(zipStats.size / 1024 / 1024).toFixed(2)} MB`
    : `${(zipStats.size / 1024).toFixed(2)} KB`;
  console.log(`   firefox-v${version}.zip: ${zipSize}`);
  
  console.log(`\n✅ Build complete!`);
  console.log(`   Output: dist/firefox/`);
  console.log(`   Package: dist/firefox-v${version}.zip`);
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}
