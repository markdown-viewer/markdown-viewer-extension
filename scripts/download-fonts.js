#!/usr/bin/env node

/**
 * Download custom fonts for mobile app
 * These fonts are too large to commit to git, so we download them on demand
 * Fonts are stored in mobile/build/fonts (build artifacts, gitignored)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(__dirname, '../mobile/build/fonts');

const FONTS = [
  {
    name: 'Zhuque Fangsong',
    filename: 'ZhuqueFangsong-Regular.woff2',
    // GitHub releases provide a zip file, extract TTF from it
    downloadUrl: 'https://github.com/TrionesType/zhuque/releases/download/v0.212/ZhuqueFangsong-v0.212.zip',
    downloadFilename: 'ZhuqueFangsong-v0.212.zip',
    ttfFilename: 'ZhuqueFangsong-Regular.ttf',
    extractFrom: 'zip', // 'zip' or null for direct TTF
    ttfPathInZip: 'ZhuqueFangsong-Regular.ttf', // path inside zip
    needsConversion: true,
    license: 'SIL OFL 1.1',
    source: 'https://github.com/TrionesType/zhuque'
  },
  {
    name: 'Comic Neue',
    filename: 'ComicNeue-Regular.woff2',
    downloadUrl: 'https://fonts.gstatic.com/s/comicneue/v9/4UaHrEJDsxBrF37olUeDx60.ttf',
    downloadFilename: 'ComicNeue-Regular.ttf',
    ttfFilename: 'ComicNeue-Regular.ttf',
    extractFrom: null, // direct TTF download
    needsConversion: true,
    license: 'SIL OFL 1.1',
    source: 'https://github.com/crozynski/comicneue'
  }
];

function downloadFile(url, destPath) {
  try {
    execSync(`curl -L -o "${destPath}" "${url}"`, { stdio: 'inherit' });
    return true;
  } catch (err) {
    return false;
  }
}

function checkWoff2Compress() {
  try {
    execSync('which woff2_compress', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function processFont(font) {
  const woff2Path = path.join(FONTS_DIR, font.filename);
  const ttfPath = path.join(FONTS_DIR, font.ttfFilename);
  const downloadPath = path.join(FONTS_DIR, font.downloadFilename);
  
  // Check if woff2 already exists
  // If woff2 already exists, accept it
  if (fs.existsSync(woff2Path)) {
    const stats = fs.statSync(woff2Path);
    if (stats.size > 1000) {
      console.log(`  ✓ ${font.name} already exists (${(stats.size / 1024).toFixed(1)} KB)`);
      return true;
    }
  }

  // If only TTF exists (from previous run or manual copy), accept it and convert if possible
  if (fs.existsSync(ttfPath)) {
    const ttfStats = fs.statSync(ttfPath);
    if (ttfStats.size > 1000) {
      // Attempt conversion if woff2_compress is available and woff2 missing
      if (!fs.existsSync(woff2Path) && checkWoff2Compress()) {
        try {
          console.log(`  ⇄ Converting existing TTF to woff2 for ${font.name}...`);
          execSync(`woff2_compress "${ttfPath}"`, { cwd: FONTS_DIR, stdio: 'inherit' });
          if (fs.existsSync(woff2Path)) {
            const woff2Stats = fs.statSync(woff2Path);
            console.log(`    ✓ Converted to woff2 (${(woff2Stats.size / 1024).toFixed(1)} KB)`);
            // remove ttf after conversion
            fs.unlinkSync(ttfPath);
            return true;
          }
        } catch (err) {
          // Conversion failed, but TTF is present — accept TTF
          console.log(`    ⚠ woff2 conversion failed, keeping TTF for ${font.name}`);
          return true;
        }
      }

      console.log(`  ✓ ${font.name} TTF already exists (${(ttfStats.size / 1024).toFixed(1)} KB)`);
      return true;
    }
  }
  
  console.log(`  ⬇ Downloading ${font.name}...`);
  
  try {
    // Download file using curl
    if (!downloadFile(font.downloadUrl, downloadPath)) {
      throw new Error('curl download failed');
    }
    
    const downloadStats = fs.statSync(downloadPath);
    console.log(`    Downloaded (${(downloadStats.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // Extract from zip if needed
    if (font.extractFrom === 'zip') {
      console.log(`    Extracting from zip...`);
      execSync(`unzip -o "${downloadPath}" "${font.ttfPathInZip}" -d "${FONTS_DIR}"`, { stdio: 'inherit' });
      // Clean up zip
      fs.unlinkSync(downloadPath);
      
      if (!fs.existsSync(ttfPath)) {
        throw new Error(`TTF file not found in zip: ${font.ttfPathInZip}`);
      }
    }
    
    if (font.needsConversion) {
      if (!checkWoff2Compress()) {
        console.log(`    ⚠ woff2_compress not found, keeping TTF file`);
        return true;
      }
      
      console.log(`    Converting to woff2...`);
      execSync(`woff2_compress "${ttfPath}"`, { cwd: FONTS_DIR, stdio: 'inherit' });
      
      // Clean up TTF
      if (fs.existsSync(ttfPath)) {
        fs.unlinkSync(ttfPath);
      }
      
      const woff2Stats = fs.statSync(woff2Path);
      console.log(`    ✓ Converted to woff2 (${(woff2Stats.size / 1024).toFixed(1)} KB)`);
    }
    
    return true;
  } catch (err) {
    console.error(`    ✗ Failed: ${err.message}`);
    // Clean up partial downloads
    [downloadPath, ttfPath].forEach(p => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    return false;
  }
}

function main() {
  console.log('📦 Checking custom fonts...\n');
  
  // Ensure fonts directory exists
  if (!fs.existsSync(FONTS_DIR)) {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
  }
  
  let allSuccess = true;
  
  for (const font of FONTS) {
    const success = processFont(font);
    if (!success) {
      allSuccess = false;
    }
  }
  
  console.log('');
  
  if (allSuccess) {
    console.log('✅ All fonts ready!\n');
  } else {
    console.log('⚠ Some fonts failed to download. Build may have missing fonts.\n');
    process.exit(1);
  }
}

main();
