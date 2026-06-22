const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'docs', 'index.html');
const dataPath = path.join(repoRoot, 'docs', 'assets', 'js', 'homepage-i18n-data.js');

const html = fs.readFileSync(indexPath, 'utf8');
const dataJs = fs.readFileSync(dataPath, 'utf8');

function skipTrivia(source, start, end) {
  let index = start;
  while (index < end) {
    const char = source[index];
    const next = source[index + 1];

    if (/\s/.test(char) || char === ',') {
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      index += 2;
      while (index < end && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < end && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    break;
  }
  return index;
}

function readStringEnd(source, start, end) {
  const quote = source[start];
  let index = start + 1;
  while (index < end) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    index += 1;
  }
  throw new Error(`Unterminated string starting at ${start}`);
}

function readBalancedEnd(source, start, end) {
  const openChar = source[start];
  const closeChar = openChar === '{' ? '}' : openChar === '[' ? ']' : null;
  if (!closeChar) {
    throw new Error(`Unsupported balanced token: ${openChar}`);
  }

  let depth = 0;
  let index = start;
  while (index < end) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '\'' || char === '"') {
      index = readStringEnd(source, index, end);
      continue;
    }

    if (char === '/' && next === '/') {
      index += 2;
      while (index < end && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < end && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  throw new Error(`Unterminated balanced block starting at ${start}`);
}

function readPropertyName(source, start, end) {
  const char = source[start];
  if (char === '\'' || char === '"') {
    const valueEnd = readStringEnd(source, start, end);
    return {
      name: source.slice(start + 1, valueEnd - 1),
      end: valueEnd,
    };
  }

  let index = start;
  while (index < end && /[A-Za-z0-9_$-]/.test(source[index])) {
    index += 1;
  }

  if (index === start) {
    throw new Error(`Unsupported property name at ${start}`);
  }

  return {
    name: source.slice(start, index),
    end: index,
  };
}

function readValueEnd(source, start, end) {
  const char = source[start];
  if (char === '{' || char === '[') {
    return readBalancedEnd(source, start, end);
  }
  if (char === '\'' || char === '"') {
    return readStringEnd(source, start, end);
  }

  let index = start;
  while (index < end) {
    const current = source[index];
    if (current === ',') {
      return index;
    }
    if (current === '\n' || current === '\r') {
      return index;
    }
    if (current === '}') {
      return index;
    }
    index += 1;
  }
  return index;
}

function parseObjectEntries(source, objectStart, objectEnd) {
  const entries = [];
  let index = objectStart + 1;

  while (index < objectEnd - 1) {
    index = skipTrivia(source, index, objectEnd);
    if (index >= objectEnd - 1 || source[index] === '}') {
      break;
    }

    const property = readPropertyName(source, index, objectEnd);
    index = skipTrivia(source, property.end, objectEnd);
    if (source[index] !== ':') {
      throw new Error(`Expected ':' after property ${property.name}`);
    }

    index = skipTrivia(source, index + 1, objectEnd);
    const valueStart = index;
    const valueEnd = readValueEnd(source, valueStart, objectEnd);

    entries.push({
      name: property.name,
      valueStart,
      valueEnd,
      isObject: source[valueStart] === '{',
    });

    index = valueEnd;
  }

  return entries;
}

function findRootObjectBounds(source) {
  const assignIndex = source.indexOf('=');
  if (assignIndex === -1) {
    throw new Error('Missing DOCUMD_HOMEPAGE_I18N assignment');
  }

  const objectStart = source.indexOf('{', assignIndex);
  if (objectStart === -1) {
    throw new Error('Missing root object literal');
  }

  return {
    start: objectStart,
    end: readBalancedEnd(source, objectStart, source.length),
  };
}

function collectDuplicateLocaleKeys(source, sectionName) {
  const rootBounds = findRootObjectBounds(source);
  const rootEntries = parseObjectEntries(source, rootBounds.start, rootBounds.end);
  const section = rootEntries.find((entry) => entry.name === sectionName);
  if (!section || !section.isObject) {
    return [];
  }

  const localeEntries = parseObjectEntries(source, section.valueStart, section.valueEnd);
  const duplicates = [];

  for (const localeEntry of localeEntries) {
    if (!localeEntry.isObject) {
      continue;
    }

    const keyEntries = parseObjectEntries(source, localeEntry.valueStart, localeEntry.valueEnd);
    const seen = new Set();
    const repeated = [];

    for (const keyEntry of keyEntries) {
      if (seen.has(keyEntry.name) && !repeated.includes(keyEntry.name)) {
        repeated.push(keyEntry.name);
        continue;
      }
      seen.add(keyEntry.name);
    }

    if (repeated.length > 0) {
      duplicates.push({
        section: sectionName,
        locale: localeEntry.name,
        keys: repeated,
      });
    }
  }

  return duplicates;
}

function normalizeValue(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function countScriptCharacters(text) {
  const counts = {
    latin: 0,
    han: 0,
    hiragana: 0,
    katakana: 0,
    hangul: 0,
    cyrillic: 0,
    devanagari: 0,
    thai: 0,
  };

  for (const char of text) {
    if (/\p{Script=Latin}/u.test(char)) counts.latin += 1;
    if (/\p{Script=Han}/u.test(char)) counts.han += 1;
    if (/\p{Script=Hiragana}/u.test(char)) counts.hiragana += 1;
    if (/\p{Script=Katakana}/u.test(char)) counts.katakana += 1;
    if (/\p{Script=Hangul}/u.test(char)) counts.hangul += 1;
    if (/\p{Script=Cyrillic}/u.test(char)) counts.cyrillic += 1;
    if (/\p{Script=Devanagari}/u.test(char)) counts.devanagari += 1;
    if (/\p{Script=Thai}/u.test(char)) counts.thai += 1;
  }

  return counts;
}

function getLocaleScriptProfile(lang) {
  const profiles = {
    'zh-CN': { expected: ['han'], unexpected: ['latin'], minimumExpectedChars: 2 },
    'zh-TW': { expected: ['han'], unexpected: ['latin'], minimumExpectedChars: 2 },
    ja: { expected: ['han', 'hiragana', 'katakana'], unexpected: ['latin'], minimumExpectedChars: 2 },
    ko: { expected: ['hangul'], unexpected: ['latin'], minimumExpectedChars: 2 },
    ru: { expected: ['cyrillic'], unexpected: ['latin'], minimumExpectedChars: 2 },
    uk: { expected: ['cyrillic'], unexpected: ['latin'], minimumExpectedChars: 2 },
    be: { expected: ['cyrillic'], unexpected: ['latin'], minimumExpectedChars: 2 },
    hi: { expected: ['devanagari'], unexpected: ['latin'], minimumExpectedChars: 2 },
    th: { expected: ['thai'], unexpected: ['latin'], minimumExpectedChars: 2 },
    de: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    'pt-BR': { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    'pt-PT': { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    nl: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    vi: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    fr: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    it: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    es: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    id: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    ms: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    pl: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    fi: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    lt: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    no: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    da: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    sv: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    tr: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
    et: { expected: ['latin'], unexpected: ['han', 'cyrillic', 'thai', 'devanagari', 'hangul'], minimumExpectedChars: 4 },
  };

  return profiles[lang] || null;
}

function collectScriptMismatchIssues(translationsByLocale) {
  const results = [];

  for (const [lang, dictionary] of Object.entries(translationsByLocale)) {
    const profile = getLocaleScriptProfile(lang);
    if (!profile) {
      continue;
    }

    const suspiciousKeys = [];

    for (const [key, rawValue] of Object.entries(dictionary)) {
      const value = normalizeValue(rawValue);
      if (value.length < 16) {
        continue;
      }

      const counts = countScriptCharacters(value);
      const expectedCount = profile.expected.reduce((sum, script) => sum + (counts[script] || 0), 0);
      const unexpectedCount = profile.unexpected.reduce((sum, script) => sum + (counts[script] || 0), 0);
      const totalTracked = Object.values(counts).reduce((sum, count) => sum + count, 0);

      if (totalTracked < profile.minimumExpectedChars) {
        continue;
      }

      if (
        expectedCount < profile.minimumExpectedChars
        && unexpectedCount >= Math.max(profile.minimumExpectedChars, 8)
        && value.length >= 18
      ) {
        suspiciousKeys.push(key);
      }
    }

    if (suspiciousKeys.length > 0) {
      results.push({ locale: lang, keys: suspiciousKeys });
    }
  }

  return results;
}

function areFallbackLinked(left, right, fallbackMap) {
  let current = left;
  const seenLeft = new Set();
  while (current && !seenLeft.has(current)) {
    if (current === right) {
      return true;
    }
    seenLeft.add(current);
    current = fallbackMap[current];
  }

  current = right;
  const seenRight = new Set();
  while (current && !seenRight.has(current)) {
    if (current === left) {
      return true;
    }
    seenRight.add(current);
    current = fallbackMap[current];
  }

  return false;
}

function collectCrossLocaleCopyIssues(translationsByLocale, fallbackMap) {
  const byKeyAndValue = new Map();

  for (const [lang, dictionary] of Object.entries(translationsByLocale)) {
    for (const [key, rawValue] of Object.entries(dictionary)) {
      const value = normalizeValue(rawValue);
      if (value.length < 20 || !/\s/.test(value)) {
        continue;
      }

      const marker = `${key}\u0000${value}`;
      if (!byKeyAndValue.has(marker)) {
        byKeyAndValue.set(marker, { key, locales: [] });
      }
      byKeyAndValue.get(marker).locales.push(lang);
    }
  }

  const pairMatches = new Map();

  for (const entry of byKeyAndValue.values()) {
    if (entry.locales.length < 2) {
      continue;
    }

    for (let index = 0; index < entry.locales.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < entry.locales.length; otherIndex += 1) {
        const left = entry.locales[index];
        const right = entry.locales[otherIndex];

        if (areFallbackLinked(left, right, fallbackMap)) {
          continue;
        }

        const pair = [left, right].sort().join('::');
        if (!pairMatches.has(pair)) {
          pairMatches.set(pair, []);
        }
        pairMatches.get(pair).push(entry.key);
      }
    }
  }

  const results = [];
  for (const [pair, keys] of pairMatches.entries()) {
    if (keys.length < 3) {
      continue;
    }

    const [left, right] = pair.split('::');
    results.push({ left, right, keys });
  }

  return results.sort((left, right) => right.keys.length - left.keys.length);
}

function collectUntranslatedKeys(translations) {
  const results = [];

  for (const [lang, dictionary] of Object.entries(translations)) {
    if (lang === 'en') {
      continue;
    }

    const untranslated = [];
    for (const [key, value] of Object.entries(dictionary)) {
      if (typeof value === 'string' && value === key) {
        untranslated.push(key);
      }
    }

    if (untranslated.length > 0) {
      results.push({ locale: lang, keys: untranslated });
    }
  }

  return results;
}

function evaluateDataBundle(source) {
  const context = { window: {} };
  vm.runInNewContext(source, context);
  if (!context.window.DOCUMD_HOMEPAGE_I18N) {
    throw new Error('Missing DOCUMD_HOMEPAGE_I18N bundle');
  }
  return context.window.DOCUMD_HOMEPAGE_I18N;
}

function extractKeys(source) {
  const keys = new Set();
  const regex = /data-i18n(?:-html)?="([^"]+)"/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

function extractMenuLanguages(source) {
  const languages = [];
  const regex = /<option value="([^"]+)">/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    languages.push(match[1]);
  }
  return languages;
}

const bundle = evaluateDataBundle(dataJs);
const pageMeta = bundle.pageMeta || {};
const translations = bundle.translations || {};
const fallbackLocales = bundle.fallbackLocales || {};
const supported = bundle.supported || [];
const requiredKeys = extractKeys(html);
// Universal English terms that don't need translation (brand names, technical terms, numbers)
const EXCLUDED_KEYS = new Set([
  'FAQ',
  'Web Store',
  'Marketplace',
  'Plugin',
  'Add-ons',
  'Enterprise 45%',
  'SMB 35%',
  'Individual 20%',
  'iOS and Android',
]);
const translatableKeys = requiredKeys.filter((key) => !EXCLUDED_KEYS.has(key));
const menuLanguages = extractMenuLanguages(html);

const issues = [];
const duplicateIssues = [
  ...collectDuplicateLocaleKeys(dataJs, 'pageMeta'),
  ...collectDuplicateLocaleKeys(dataJs, 'translations'),
];
const scriptMismatchIssues = collectScriptMismatchIssues(translations);
const crossLocaleCopyIssues = collectCrossLocaleCopyIssues(translations, fallbackLocales);
const untranslatedIssues = collectUntranslatedKeys(translations);

function buildDictionary(lang) {
  return translations[lang] || {};
}

for (const lang of menuLanguages) {
  if (lang === 'en') {
    continue;
  }

  if (!supported.includes(lang)) {
    issues.push(`[supported] Missing language: ${lang}`);
  }

  if (!pageMeta[lang]) {
    issues.push(`[pageMeta] Missing language: ${lang}`);
  }

  if (!translations[lang]) {
    issues.push(`[translations] Missing language: ${lang}`);
    continue;
  }

  const dictionary = buildDictionary(lang);
  const missingKeys = translatableKeys.filter((key) => !(key in dictionary));
  if (missingKeys.length > 0) {
    issues.push(`[keys] ${lang} missing ${missingKeys.length} key(s): ${missingKeys.join(' | ')}`);
  }
}

const extraPageMeta = Object.keys(pageMeta).filter((lang) => lang !== 'en' && !menuLanguages.includes(lang));
const extraTranslations = Object.keys(translations).filter((lang) => !menuLanguages.includes(lang));
const extraSupported = supported.filter((lang) => !menuLanguages.includes(lang));

if (extraPageMeta.length > 0) {
  issues.push(`[pageMeta] Extra language(s) not in menu: ${extraPageMeta.join(', ')}`);
}
if (extraTranslations.length > 0) {
  issues.push(`[translations] Extra language(s) not in menu: ${extraTranslations.join(', ')}`);
}
if (extraSupported.length > 0) {
  issues.push(`[supported] Extra language(s) not in menu: ${extraSupported.join(', ')}`);
}

for (const duplicate of duplicateIssues) {
  issues.push(
    `[duplicates] ${duplicate.section}.${duplicate.locale} repeated ${duplicate.keys.length} key(s): ${duplicate.keys.join(' | ')}`
  );
}

for (const mismatch of scriptMismatchIssues) {
  issues.push(
    `[script] translations.${mismatch.locale} has ${mismatch.keys.length} suspicious key(s) with unexpected writing system: ${mismatch.keys.join(' | ')}`
  );
}

for (const copyIssue of crossLocaleCopyIssues) {
  issues.push(
    `[copy] translations.${copyIssue.left} and translations.${copyIssue.right} share ${copyIssue.keys.length} long identical value(s): ${copyIssue.keys.join(' | ')}`
  );
}

for (const untranslated of untranslatedIssues) {
  issues.push(
    `[untranslated] translations.${untranslated.locale} has ${untranslated.keys.length} value(s) identical to English: ${untranslated.keys.join(' | ')}`
  );
}

console.log(`Homepage i18n keys: ${requiredKeys.length}`);
console.log(`Homepage language menu: ${menuLanguages.length}`);

if (issues.length === 0) {
  console.log('All homepage i18n keys are covered.');
  process.exit(0);
}

console.log('Homepage i18n coverage issues:');
for (const issue of issues) {
  console.log(`- ${issue}`);
}

process.exitCode = 1;