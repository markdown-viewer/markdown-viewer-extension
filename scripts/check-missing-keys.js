#!/usr/bin/env node

/**
 * Check missing translation keys across all locale files
 * and verify key usage in source code
 * Usage: node check-missing-keys.js
 */

import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.join(import.meta.dirname, '../src/_locales');
const SRC_DIR = path.join(import.meta.dirname, '../src');
const FLUTTER_DIR = path.join(import.meta.dirname, '../lib');

// Get all locale directories
function getLocaleDirs() {
  return fs.readdirSync(LOCALES_DIR)
    .filter(file => {
      const fullPath = path.join(LOCALES_DIR, file);
      return fs.statSync(fullPath).isDirectory() && file !== 'node_modules';
    })
    .sort();
}

// Load messages.json from a locale directory
function loadMessages(locale) {
  const messagesPath = path.join(LOCALES_DIR, locale, 'messages.json');
  try {
    const content = fs.readFileSync(messagesPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error loading ${locale}/messages.json:`, error.message);
    return null;
  }
}

// Get all keys from a messages object
function getKeys(messages) {
  return Object.keys(messages).sort();
}

// Find all translation key references in source code
function findKeysInCode() {
  const keysUsedInCode = new Set();
  const keysUsedInHTML = new Set();
  const keysUsedInDart = new Set();
  
  // Scan JavaScript files for translate() calls
  function scanJSFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Match translate('key') or translate("key")
      const translatePattern = /translate\s*\(\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = translatePattern.exec(content)) !== null) {
        keysUsedInCode.add(match[1]);
      }
      
      // Match chrome.i18n.getMessage('key') or chrome.i18n.getMessage("key")
      const i18nPattern = /chrome\.i18n\.getMessage\s*\(\s*['"]([^'"]+)['"]/g;
      while ((match = i18nPattern.exec(content)) !== null) {
        keysUsedInCode.add(match[1]);
      }
    } catch (error) {
      console.error(`Error scanning ${filePath}:`, error.message);
    }
  }
  
  // Scan HTML files for data-i18n attributes
  function scanHTMLFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Match data-i18n="key"
      const i18nPattern = /data-i18n\s*=\s*["']([^"']+)["']/g;
      let match;
      while ((match = i18nPattern.exec(content)) !== null) {
        keysUsedInHTML.add(match[1]);
      }
    } catch (error) {
      console.error(`Error scanning ${filePath}:`, error.message);
    }
  }
  
  // Scan manifest.json for __MSG_key__ patterns
  function scanManifestFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Match __MSG_key__
      const msgPattern = /__MSG_([^_]+)__/g;
      let match;
      while ((match = msgPattern.exec(content)) !== null) {
        keysUsedInCode.add(match[1]);
      }
    } catch (error) {
      console.error(`Error scanning ${filePath}:`, error.message);
    }
  }
  
  // Scan Dart files for localization.t() or localization.translate() calls
  function scanDartFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Match localization.t('key') or localization.t("key")
      const tPattern = /localization\.t\s*\(\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = tPattern.exec(content)) !== null) {
        keysUsedInDart.add(match[1]);
      }
      
      // Match localization.translate('key') or localization.translate("key")
      const translatePattern = /localization\.translate\s*\(\s*['"]([^'"]+)['"]/g;
      while ((match = translatePattern.exec(content)) !== null) {
        keysUsedInDart.add(match[1]);
      }
    } catch (error) {
      console.error(`Error scanning ${filePath}:`, error.message);
    }
  }
  
  // Recursively scan directory
  function scanDirectory(dir, extensions) {
    try {
      const files = fs.readdirSync(dir);
      
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          // Skip _locales directory and node_modules
          if (file !== '_locales' && file !== 'node_modules' && file !== 'dist') {
            scanDirectory(fullPath, extensions);
          }
        } else if (stat.isFile()) {
          const ext = path.extname(file);
          if (extensions.includes(ext)) {
            if (ext === '.js') {
              scanJSFile(fullPath);
            } else if (ext === '.html') {
              scanHTMLFile(fullPath);
            } else if (ext === '.dart') {
              scanDartFile(fullPath);
            }
          } else if (file === 'manifest.json') {
            scanManifestFile(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dir}:`, error.message);
    }
  }
  
  // Scan all source files
  scanDirectory(SRC_DIR, ['.js', '.html']);
  
  // Scan Flutter source files
  if (fs.existsSync(FLUTTER_DIR)) {
    scanDirectory(FLUTTER_DIR, ['.dart']);
  }
  
  // Combine all keys used in code
  const allUsedKeys = new Set([...keysUsedInCode, ...keysUsedInHTML, ...keysUsedInDart]);
  
  return {
    all: allUsedKeys,
    inJS: keysUsedInCode,
    inHTML: keysUsedInHTML,
    inDart: keysUsedInDart
  };
}

// Main function
function main() {
  console.log('🔍 Checking translation keys across all locales...\n');
  
  const locales = getLocaleDirs();
  console.log(`Found locales: ${locales.join(', ')}\n`);
  
  // Load all locales and collect all keys
  const localeData = new Map();
  const allKeys = new Set();
  
  locales.forEach(locale => {
    const messages = loadMessages(locale);
    if (messages) {
      const keys = getKeys(messages);
      localeData.set(locale, new Set(keys));
      keys.forEach(key => allKeys.add(key));
    }
  });
  
  const allKeysArray = Array.from(allKeys).sort();
  console.log(`📋 Total unique keys found across all locales: ${allKeysArray.length}\n`);
  
  // Find which keys are missing in which locales
  const missingKeysMap = new Map(); // key -> Set of locales missing this key
  
  allKeysArray.forEach(key => {
    const missingLocales = new Set();
    locales.forEach(locale => {
      const keys = localeData.get(locale);
      if (keys && !keys.has(key)) {
        missingLocales.add(locale);
      }
    });
    
    if (missingLocales.size > 0) {
      missingKeysMap.set(key, missingLocales);
    }
  });
  
  // Display missing keys table
  if (missingKeysMap.size > 0) {
    console.log('❌ Missing Keys (by message key):');
    console.log('─'.repeat(80));
    
    // Only show locales that have missing keys
    const localesWithMissingKeys = new Set();
    missingKeysMap.forEach((localesSet) => {
      localesSet.forEach(locale => localesWithMissingKeys.add(locale));
    });
    
    const relevantLocales = Array.from(localesWithMissingKeys).sort();
    
    if (relevantLocales.length > 0) {
      const missingTable = {};
      missingKeysMap.forEach((localesSet, key) => {
        const row = { Key: key };
        relevantLocales.forEach(locale => {
          row[locale] = localesSet.has(locale) ? '❌' : '✅';
        });
        missingTable[key] = row;
      });
      
      console.table(Object.values(missingTable));
      console.log(`\nShowing ${relevantLocales.length} locale(s) with missing keys: ${relevantLocales.join(', ')}`);
    }
  }
  
  if (missingKeysMap.size === 0) {
    console.log('\n🎉 All locales are complete and synchronized!\n');
  } else {
    console.log(`\n⚠️  Found ${missingKeysMap.size} key(s) with missing translations.\n`);
  }
  
  // Check for unused and undefined keys
  console.log('\n📝 Checking key usage in source code...\n');
  
  const usedKeys = findKeysInCode();
  console.log(`Found ${usedKeys.all.size} unique keys used in source code:`);
  console.log(`  - ${usedKeys.inJS.size} keys in JavaScript files`);
  console.log(`  - ${usedKeys.inHTML.size} keys in HTML files`);
  console.log(`  - ${usedKeys.inDart.size} keys in Flutter/Dart files\n`);
  
  // Keys defined but not used
  const definedKeys = allKeysArray;
  const unusedKeys = definedKeys.filter(key => !usedKeys.all.has(key));
  
  // Double-check unused keys with full-text search as fallback
  const trulyUnusedKeys = [];
  const falsePositives = [];
  
  if (unusedKeys.length > 0) {
    console.log('🔍 Double-checking unused keys with full-text search...\n');
    
    for (const key of unusedKeys) {
      let foundInSource = false;
      
      // Recursively search all source files
      function searchInDirectory(dir) {
        if (foundInSource) return;
        
        try {
          const files = fs.readdirSync(dir);
          
          for (const file of files) {
            if (foundInSource) break;
            
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
              // Skip these directories
              if (file !== '_locales' && file !== 'node_modules' && file !== 'dist' && file !== '.git' && file !== 'build') {
                searchInDirectory(fullPath);
              }
            } else if (stat.isFile()) {
              // Skip non-source files
              const ext = path.extname(file);
              if (['.js', '.html', '.json', '.css', '.md', '.dart'].includes(ext) || file === 'manifest.json') {
                try {
                  const content = fs.readFileSync(fullPath, 'utf8');
                  
                  // Search for the key as a whole word
                  const regex = new RegExp(`\\b${key}\\b`, 'g');
                  if (regex.test(content)) {
                    // Make sure it's not just in the messages.json files
                    if (!fullPath.includes('_locales')) {
                      foundInSource = true;
                      falsePositives.push({ key, file: fullPath.replace(SRC_DIR, 'src') });
                    }
                  }
                } catch (error) {
                  // Skip files that can't be read
                }
              }
            }
          }
        } catch (error) {
          // Skip directories that can't be read
        }
      }
      
      searchInDirectory(SRC_DIR);
      
      // Also search in Flutter directory
      if (!foundInSource && fs.existsSync(FLUTTER_DIR)) {
        searchInDirectory(FLUTTER_DIR);
      }
      
      if (!foundInSource) {
        trulyUnusedKeys.push(key);
      }
    }
  }
  
  if (falsePositives.length > 0) {
    console.log('⚠️  Keys marked as unused but found in full-text search (possible false positives):');
    console.log('─'.repeat(80));
    falsePositives.forEach(({ key, file }) => {
      console.log(`  🔍 ${key} - found in ${file}`);
    });
    console.log(`\nTotal false positives: ${falsePositives.length}\n`);
  }
  
  if (trulyUnusedKeys.length > 0) {
    console.log('⚠️  Keys defined in messages.json but NOT used in code:');
    console.log('─'.repeat(80));
    
    // Build table showing which locales have these unused keys
    // Only show locales that have at least one of these keys
    const localesWithUnusedKeys = new Set();
    trulyUnusedKeys.forEach(key => {
      locales.forEach(locale => {
        const keys = localeData.get(locale);
        if (keys && keys.has(key)) {
          localesWithUnusedKeys.add(locale);
        }
      });
    });
    
    const relevantLocales = Array.from(localesWithUnusedKeys).sort();
    
    if (relevantLocales.length > 0) {
      const unusedTable = {};
      trulyUnusedKeys.forEach(key => {
        const row = { Key: key };
        relevantLocales.forEach(locale => {
          const keys = localeData.get(locale);
          row[locale] = keys && keys.has(key) ? '✅' : '❌';
        });
        unusedTable[key] = row;
      });
      
      console.table(Object.values(unusedTable));
      console.log(`\nShowing ${relevantLocales.length} locale(s) with unused keys: ${relevantLocales.join(', ')}`);
    }
    console.log(`Total unused keys: ${trulyUnusedKeys.length}\n`);
  } else if (unusedKeys.length === 0) {
    console.log('✅ All defined keys are used in code.\n');
  } else {
    console.log('✅ All initially detected unused keys were found in full-text search.\n');
  }
  
  // Keys used but not defined
  const undefinedKeys = Array.from(usedKeys.all).filter(key => !allKeys.has(key));
  
  if (undefinedKeys.length > 0) {
    console.log('❌ Keys used in code but NOT defined in messages.json:');
    console.log('─'.repeat(80));
    undefinedKeys.forEach(key => {
      console.log(`  ⚠️  ${key}`);
    });
    console.log(`\nTotal undefined keys: ${undefinedKeys.length}\n`);
  } else {
    console.log('✅ All used keys are defined in messages.json.\n');
  }
  
  // Summary
  console.log('═'.repeat(80));
  console.log('📊 Summary:');
  console.log(`  • Total keys defined: ${definedKeys.length}`);
  console.log(`  • Total keys used in code: ${usedKeys.all.size}`);
  console.log(`  • Unused keys (pattern matching): ${unusedKeys.length}`);
  console.log(`  • Unused keys (verified): ${trulyUnusedKeys.length}`);
  console.log(`  • False positives: ${falsePositives.length}`);
  console.log(`  • Undefined keys: ${undefinedKeys.length}`);
  console.log(`  • Missing translations: ${missingKeysMap.size}`);
  console.log('═'.repeat(80) + '\n');
}

// Run the script
main();
