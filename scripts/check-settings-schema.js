#!/usr/bin/env node

/**
 * Check Settings Schema Consistency (门禁)
 *
 * Verifies the settings configuration is centralized:
 *   1. Generated files (src/config/settings.generated.ts and
 *      mobile/lib/config/settings_defaults.g.dart) are up to date with
 *      settings-schema.json (regenerates in-memory and diffs).
 *   2. No hardcoded setting defaults remain in consumer code — every
 *      platform storage layer / webview / exporter / CLI must read defaults
 *      from the schema (DEFAULT_SETTINGS / DEFAULT_RENDER_SETTINGS /
 *      normalizeSetting / generated Dart constants).
 *
 * Rules:
 *   - For every enum/boolean setting in settings-schema.json, any literal
 *     assignment that differs from the schema default is flagged as drift,
 *     UNLESS it is a known deliberate platform default (see ALLOWLIST).
 *   - Type annotations (`'left' | 'center'`) are ignored.
 *   - Tests, generated files and build artifacts are ignored.
 *
 * Usage:
 *   node scripts/check-settings-schema.js
 *
 * Exit status:
 *   0  all checks pass
 *   1  stale generated files or hardcoded defaults found
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import syncSettings from './sync-settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const errors = [];

// ---------------------------------------------------------------------------
// 1. Generated files up to date?
// ---------------------------------------------------------------------------
function checkGeneratedFiles() {
  const before = new Map();
  for (const p of [
    'src/config/settings.generated.ts',
    'mobile/lib/config/settings_defaults.g.dart',
  ]) {
    before.set(p, fs.readFileSync(path.join(projectRoot, p), 'utf8'));
  }

  const changed = syncSettings();

  if (changed) {
    errors.push(
      'Generated files are out of date with settings-schema.json. ' +
      'Run `node scripts/sync-settings.js` and commit the regenerated files.'
    );
  }

  // Restore the pre-check content if it changed (check must not modify files)
  for (const [p, content] of before) {
    fs.writeFileSync(path.join(projectRoot, p), content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// 2. Hardcoded defaults in consumer code?
// ---------------------------------------------------------------------------

/**
 * Known deliberate defaults that intentionally differ from the schema default.
 * Each entry: { file, lines: [1-based line numbers], reason }.
 * NOTE: keep this list minimal; new settings should reference the schema.
 */
const ALLOWLIST = [
  // CLI tool: headless render defaults to NOT merging empty cells (differs
  // from the viewer default true) — deliberate product decision.
  { file: 'src/cli/browser-renderer.ts', lines: [246, 308, 376, 469, 518, 694], reason: 'CLI default: no table cell merging' },
  { file: 'src/core/markdown-processor.ts', lines: [706], reason: 'processor param default: no merging (caller passes value)' },
  { file: 'src/core/viewer/viewer-controller.ts', lines: [178], reason: 'render option default: no merging (caller passes value)' },
  { file: 'scripts/md-to-html.js', lines: [95], reason: 'CLI default: no table cell merging' },
  // DOCX exporter: WPS/Word-oriented defaults differ from viewer defaults.
  { file: 'src/exporters/docx-exporter.ts', lines: [102], reason: 'DOCX exporter default emoji style: windows' },
];

const SCAN_DIRS = [
  'src',
  'vscode/src',
  'obsidian/src',
  'chrome/src',
  'firefox/src',
  'edge/src',
  'mobile/src',
  'mobile/lib',
  'scripts',
];

const SKIP_PATHS = [
  'src/config/settings.generated.ts',
  'mobile/lib/config/settings_defaults.g.dart',
  'scripts/check-settings-schema.js', // this file itself contains patterns in comments
  'node_modules',
  'mobile/build',
  'dist',
  'temp',
  /test\//,
  /plans\//,
  /\.github\//,
];

function shouldSkip(absPath) {
  const rel = path.relative(projectRoot, absPath);
  return SKIP_PATHS.some((p) => (typeof p === 'string' ? rel.includes(p) : p.test(rel)));
}

/** Build detection patterns from the schema (enum/boolean only). */
function buildPatterns() {
  const schema = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'settings-schema.json'), 'utf8')
  );
  const patterns = [];
  for (const s of schema.settings) {
    if (s.cliOnly || (s.type !== 'enum' && s.type !== 'boolean')) continue;
    const def = String(s.default);
    const candidates = s.type === 'enum' ? s.values : ['true', 'false'];
    for (const v of candidates) {
      if (v === def) continue; // default literals are harmless (same value)
      // Match `key: 'v'` / `key = 'v'` / `key ?? 'v'` / `key || 'v'`
      const lit = s.type === 'boolean' ? v : `'${v}'`;
      const esc = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      patterns.push({ key: s.key, value: v, regex: new RegExp(`${s.key}\\s*(?::\\s*|=\\s*|\\?\\?\\s*|\\|\\|\\s*)${esc}`) });
    }
  }
  return patterns;
}

function isTypeAnnotation(line) {
  // `imageLayout?: 'left' | 'center'` or `key: 'a' | 'b'` — type unions
  return /['"][^'"]*['"]\s*\|/.test(line) || /^\s*[a-zA-Z]+\??:\s*'/.test(line);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkip(abs)) walk(abs);
    } else if (/\.(ts|js|dart)$/.test(entry.name) && !shouldSkip(abs)) {
      checkFile(abs);
    }
  }
}

function checkFile(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const rel = path.relative(projectRoot, absPath);
  lines.forEach((line, i) => {
    if (isTypeAnnotation(line)) return;
    const lineNo = i + 1;
    for (const { key, value, regex } of PATTERNS) {
      if (!regex.test(line)) continue;
      const allow = ALLOWLIST.find(
        (a) => a.file === rel && a.lines.includes(lineNo)
      );
      if (allow) continue; // known deliberate default
      errors.push(
        `Hardcoded default for '${key}' (='${value}') at ${rel}:${lineNo}: ${line.trim()}` +
        ` — use DEFAULT_SETTINGS / normalizeSetting instead`
      );
      break;
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const PATTERNS = buildPatterns();

console.log('🔍 Checking settings schema consistency...');

checkGeneratedFiles();

for (const dir of SCAN_DIRS) {
  walk(path.join(projectRoot, dir));
}

if (errors.length > 0) {
  console.error(`\n✖ ${errors.length} problem(s) found:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    '\nFix: edit settings-schema.json (single source of truth) and use\n' +
    'DEFAULT_SETTINGS / normalizeSetting / generated Dart constants in consumers.\n' +
    'If the value is a deliberate platform default, add it to the ALLOWLIST.'
  );
  process.exit(1);
}

console.log('  ✓ Generated files up to date');
console.log('  ✓ No hardcoded setting defaults in consumer code');
console.log('All settings schema checks passed.');
