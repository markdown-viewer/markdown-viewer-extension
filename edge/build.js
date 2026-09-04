#!/usr/bin/env fibjs

import { build } from 'esbuild';
import { createBuildConfig } from './build-config.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function syncVersion() {
  const packagePath = path.join(projectRoot, 'package.json');
  const manifestPath = path.join(__dirname, 'manifest.json');

  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);

  if (manifest.version !== packageJson.version) {
    const newManifestText = manifestText.replace(
      /"version":\s*"[^"]*"/,
      `"version": "${packageJson.version}"`
    );
    fs.writeFileSync(manifestPath, newManifestText, 'utf8');
    console.log('  • Updated manifest.json version');
  }

  return packageJson.version;
}

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

function validateZipPackage(zipPath) {
  const entries = execSync(`zipinfo -1 "${zipPath}"`, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!entries.includes('manifest.json')) {
    throw new Error(`Edge package is missing manifest.json at archive root: ${zipPath}`);
  }
}

const version = syncVersion();
console.log(`🔨 Building Edge Extension... v${version}\n`);

try {
  const { default: syncFormats } = await import('../scripts/sync-formats.js');
  syncFormats();

  // Sync settings schema
  const { default: syncSettings } = await import('../scripts/sync-settings.js');
  syncSettings();

  await checkMissingKeys();
  ensureSlidevAssets();

  const outdir = path.join(projectRoot, 'dist/edge');
  if (fs.existsSync(outdir)) {
    fs.rmSync(outdir, { recursive: true, force: true });
  }

  process.chdir(projectRoot);

  const config = createBuildConfig();
  await build(config);

  const licenseSrc = path.join(projectRoot, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(outdir, 'LICENSE'));
    console.log('  • LICENSE');
  }

  const zipPath = path.join(projectRoot, 'dist', `edge-v${version}.zip`);
  console.log('\n📦 Creating ZIP package...');

  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  execSync(`cd "${outdir}" && zip -r "${zipPath}" .`, { stdio: 'ignore' });
  validateZipPackage(zipPath);

  const zipStats = fs.statSync(zipPath);
  const zipSize = zipStats.size >= 1024 * 1024
    ? `${(zipStats.size / 1024 / 1024).toFixed(2)} MB`
    : `${(zipStats.size / 1024).toFixed(2)} KB`;
  console.log(`   edge-v${version}.zip: ${zipSize}`);

  console.log('\n✅ Build complete!');
  console.log('   Output: dist/edge/');
  console.log(`   Package: dist/edge-v${version}.zip`);
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}