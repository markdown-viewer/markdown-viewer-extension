#!/usr/bin/env node
// Generate file-icons-data.ts from material-icon-theme SVGs
// Icons source: material-icon-theme (MIT License) by PKief
// https://github.com/material-extensions/vscode-material-icon-theme

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ICONS_DIR = join(ROOT, 'node_modules/material-icon-theme/icons');
const OUTPUT = join(ROOT, 'chrome/src/workspace/file-icons-data.ts');

// Icons to extract: [localName, svgFileName]
const icons = [
  // UI
  ['folder', 'folder'],
  ['folderOpen', 'folder-open'],
  // File types
  ['file', 'file'],
  ['markdown', 'markdown'],
  ['html', 'html'],
  ['css', 'css'],
  ['javascript', 'javascript'],
  ['typescript', 'typescript'],
  ['typescriptDef', 'typescript-def'],
  ['react', 'react'],
  ['reactTs', 'react_ts'],
  ['vue', 'vue'],
  ['json', 'json'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['xml', 'xml'],
  ['svg', 'svg'],
  ['python', 'python'],
  ['go', 'go'],
  ['rust', 'rust'],
  ['java', 'java'],
  ['c', 'c'],
  ['cpp', 'cpp'],
  ['ruby', 'ruby'],
  ['php', 'php'],
  ['swift', 'swift'],
  ['dart', 'dart'],
  ['kotlin', 'kotlin'],
  ['scala', 'scala'],
  ['lua', 'lua'],
  ['perl', 'perl'],
  ['r', 'r'],
  ['zig', 'zig'],
  ['erlang', 'erlang'],
  ['image', 'image'],
  ['video', 'video'],
  ['audio', 'audio'],
  ['font', 'font'],
  ['pdf', 'pdf'],
  ['zip', 'zip'],
  ['lock', 'lock'],
  ['git', 'git'],
  ['docker', 'docker'],
  ['console', 'console'],
  ['settings', 'settings'],
  ['database', 'database'],
  ['log', 'log'],
  ['tex', 'tex'],
  ['mermaid', 'mermaid'],
  ['word', 'word'],
  ['powerpoint', 'powerpoint'],
  ['table', 'table'],
  ['readme', 'readme'],
  ['license', 'license'],
  ['changelog', 'changelog'],
  ['todo', 'todo'],
];

function readSvg(name) {
  const path = join(ICONS_DIR, `${name}.svg`);
  let content = readFileSync(path, 'utf-8').trim();
  // Remove XML declaration if present
  content = content.replace(/<\?xml[^?]*\?>\s*/g, '');
  return content;
}

const lines = [
  '// Auto-generated from material-icon-theme (MIT License)',
  '// https://github.com/material-extensions/vscode-material-icon-theme',
  '// Run: node scripts/generate-file-icons.js',
  '',
];

for (const [name, svgFile] of icons) {
  const svg = readSvg(svgFile);
  lines.push(`export const ${name} = '${svg.replace(/'/g, "\\'")}';`);
}

lines.push('');
writeFileSync(OUTPUT, lines.join('\n'), 'utf-8');

console.log(`✅ Generated ${OUTPUT}`);
console.log(`   ${icons.length} icons inlined`);
