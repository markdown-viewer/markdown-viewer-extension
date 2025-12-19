#!/usr/bin/env node

/**
 * Update or add locale keys to all locale files
 * Usage: node scripts/update-locale-keys.js
 * 
 * - If key doesn't exist: add it
 * - If key exists but message differs: update it
 * - If key exists with same message: skip
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCALES_DIR = path.join(__dirname, '../src/_locales');

/**
 * Keys to add/update (English as default)
 * Format: { key: { message: "...", description: "..." } }
 */
const KEYS = {
  // Example:
  // export_docx: {
  //   message: "Share as Word",
  //   description: "Menu item for exporting to DOCX and sharing"
  // }
};

/**
 * Translations for each locale (override defaults)
 * Format: { locale: { key: { message: "..." } } }
 */
const TRANSLATIONS = {
  // Example:
  // zh_CN: {
  //   export_docx: { message: "分享为 Word" }
  // }
};

/**
 * Sort object keys alphabetically
 */
function sortObjectKeys(obj) {
  const sorted = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = obj[key];
  }
  return sorted;
}

/**
 * Process a single locale file
 */
function processLocaleFile(locale) {
  const messagesPath = path.join(LOCALES_DIR, locale, 'messages.json');
  
  if (!fs.existsSync(messagesPath)) {
    console.log(`⚠️  Skipping ${locale}: messages.json not found`);
    return { added: 0, updated: 0, skipped: 0 };
  }
  
  try {
    const content = fs.readFileSync(messagesPath, 'utf8');
    const messages = JSON.parse(content);
    
    let added = 0;
    let updated = 0;
    let skipped = 0;
    
    for (const [key, defaultValue] of Object.entries(KEYS)) {
      // Get translation for this locale, or use default
      const translation = TRANSLATIONS[locale]?.[key];
      const newMessage = translation?.message ?? defaultValue.message;
      
      if (!messages[key]) {
        // Key doesn't exist - add it
        messages[key] = {
          message: newMessage,
          description: defaultValue.description
        };
        added++;
      } else if (messages[key].message !== newMessage) {
        // Key exists but message differs - update it
        messages[key].message = newMessage;
        updated++;
      } else {
        // Key exists with same message - skip
        skipped++;
      }
    }
    
    if (added > 0 || updated > 0) {
      const sortedMessages = sortObjectKeys(messages);
      const sortedContent = JSON.stringify(sortedMessages, null, 2) + '\n';
      fs.writeFileSync(messagesPath, sortedContent, 'utf8');
      console.log(`✅ ${locale}: +${added} added, ~${updated} updated, =${skipped} unchanged`);
    } else if (skipped > 0) {
      console.log(`⏭️  ${locale}: all ${skipped} keys unchanged`);
    } else {
      console.log(`⏭️  ${locale}: no keys to process`);
    }
    
    return { added, updated, skipped };
  } catch (error) {
    console.error(`❌ Error processing ${locale}:`, error.message);
    return { added: 0, updated: 0, skipped: 0 };
  }
}

/**
 * Main function
 */
function main() {
  const keyCount = Object.keys(KEYS).length;
  
  if (keyCount === 0) {
    console.log('ℹ️  No keys defined in KEYS object. Add keys to process.');
    return;
  }
  
  console.log('🔄 Processing locale keys...\n');
  console.log('Keys:', Object.keys(KEYS).join(', '));
  console.log('');
  
  if (!fs.existsSync(LOCALES_DIR)) {
    console.error(`❌ Locales directory not found: ${LOCALES_DIR}`);
    process.exit(1);
  }
  
  const locales = fs.readdirSync(LOCALES_DIR)
    .filter(item => {
      const itemPath = path.join(LOCALES_DIR, item);
      return fs.statSync(itemPath).isDirectory();
    });
  
  let totalAdded = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  
  for (const locale of locales) {
    const { added, updated, skipped } = processLocaleFile(locale);
    totalAdded += added;
    totalUpdated += updated;
    totalSkipped += skipped;
  }
  
  console.log('');
  console.log(`📊 Summary: +${totalAdded} added, ~${totalUpdated} updated, =${totalSkipped} unchanged`);
  console.log('✨ Done!');
}

main();
