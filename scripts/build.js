#!/usr/bin/env fibjs

import { build } from 'esbuild';
import { createBuildConfig } from './build-config.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sync version from package.json to manifest.json
function syncVersion() {
  const packagePath = path.join(__dirname, '../package.json');
  const manifestPath = path.join(__dirname, '../src/manifest.json');
  
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  if (manifest.version !== packageJson.version) {
    manifest.version = packageJson.version;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`📌 Updated manifest.json version: ${packageJson.version}`);
  }
}

// Check for missing translation keys
async function checkMissingKeys() {
  console.log('🔍 Checking translation keys...\n');
  try {
    const { stdout, stderr } = await execAsync('node scripts/check-missing-keys.js');
    console.log(stdout);
    if (stderr) {
      console.error(stderr);
    }
    
    // Check if there are missing keys
    if (stdout.includes('Missing Keys') || stdout.includes('Extra Keys')) {
      console.warn('⚠️  Warning: Some translation keys are missing or extra.\n');
    }
  } catch (error) {
    console.error('❌ Failed to check translation keys:', error.message);
  }
}

// Production build only
console.log('🔨 Building extension...\n');

try {
  // Sync version first
  syncVersion();
  
  // Check translations first
  await checkMissingKeys();

  // Clean dist/chrome to avoid stale artifacts.
  const outdir = 'dist/chrome';
  if (fs.existsSync(outdir)) {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
  
  const config = createBuildConfig();
  const result = await build(config);
  console.log('✅ Build complete');
} catch (error) {
  console.error('❌ Build failed:', error);
  process.exit(1);
}
