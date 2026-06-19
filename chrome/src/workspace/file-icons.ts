// File tree SVG icons
// UI chevrons: Lucide Icons (ISC License) — https://lucide.dev
// File/folder icons: material-icon-theme (MIT License) — https://github.com/material-extensions/vscode-material-icon-theme

import * as mi from './file-icons-data';
import { EXT_LANG_MAP } from '../../../src/utils/extension-categories';

// ─── UI icons (Lucide, stroke-based, follows currentColor) ───
const A = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
export const chevronRight = `<svg ${A}><path d="m9 18 6-6-6-6"/></svg>`;
export const chevronDown = `<svg ${A}><path d="m6 9 6 6 6-6"/></svg>`;
export const searchIcon = `<svg ${A}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
export const closeIcon = `<svg ${A}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
export const fileSearchIcon = `<svg ${A}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
export const textSearchIcon = `<svg ${A}><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>`;

// ─── Navigation icons (Lucide, stroke-based, follows currentColor) ───
export const arrowLeft = `<svg ${A}><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`;
export const arrowRight = `<svg ${A}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;

// ─── Folder icons (Lucide, stroke-based, follows currentColor) ───
export const folderClosed = `<svg ${A}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
export const folderOpen = `<svg ${A}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`;
export const folderPlus = `<svg ${A}><path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;

// ─── Language → icon mapping (derived from shared extension-categories) ───
const LANG_ICON: Record<string, string> = {
  'javascript': mi.javascript,
  'typescript': mi.typescript,
  'python': mi.python,
  'ruby': mi.ruby,
  'go': mi.go,
  'rust': mi.rust,
  'java': mi.java,
  'kotlin': mi.kotlin,
  'swift': mi.swift,
  'dart': mi.dart,
  'c': mi.c,
  'cpp': mi.cpp,
  'csharp': mi.java,
  'php': mi.php,
  'lua': mi.lua,
  'r': mi.r,
  'scala': mi.scala,
  'zig': mi.zig,
  'perl': mi.perl,
  'vue': mi.vue,
  'svelte': mi.javascript,
  'html': mi.html,
  'css': mi.css,
  'scss': mi.css,
  'less': mi.css,
  'xml': mi.xml,
  'json': mi.json,
  'yaml': mi.yaml,
  'toml': mi.toml,
  'ini': mi.settings,
  'bash': mi.console,
  'fish': mi.console,
  'powershell': mi.console,
  'bat': mi.console,
  'markdown': mi.markdown,
  'plaintext': mi.file,
  'latex': mi.tex,
  'csv': mi.table,
  'sql': mi.database,
};

// Per-extension icon overrides (where icon differs from the language default).
const EXT_ICON_OVERRIDE: Record<string, string> = {
  'jsx': mi.react,
  'tsx': mi.reactTs,
  'log': mi.log,       // .log uses mi.log, not plaintext's mi.file
};

function buildLangExtMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const ext of Object.keys(EXT_LANG_MAP)) {
    if (ext in EXT_ICON_OVERRIDE) {
      map[ext] = EXT_ICON_OVERRIDE[ext];
    } else {
      const lang = EXT_LANG_MAP[ext];
      map[ext] = LANG_ICON[lang] || mi.file;
    }
  }
  return map;
}

// ─── Extension → icon mapping ───
const extMap: Record<string, string> = {
  // ── Language-derived (from shared extension-categories.ts) ──
  ...buildLangExtMap(),

  // ── Markdown (excluded from EXT_LANG_MAP — rendered, not code-previewed) ──
  'md': mi.markdown, 'markdown': mi.markdown,

  // ── Diagrams (not in EXT_LANG_MAP — rendered, not syntax-highlighted) ──
  'mermaid': mi.mermaid, 'mmd': mi.mermaid,
  'plantuml': mi.mermaid, 'puml': mi.mermaid,
  'gv': mi.settings, 'dot': mi.settings,
  'drawio': mi.settings,

  // ── Charts ──
  'vega': mi.table, 'vl': mi.table, 'vega-lite': mi.table,

  // ── Design / Canvas ──
  'infographic': mi.image, 'canvas': mi.image,
  // Images
  'png': mi.image, 'jpg': mi.image, 'jpeg': mi.image,
  'gif': mi.image, 'webp': mi.image, 'bmp': mi.image, 'ico': mi.image,
  'tiff': mi.image, 'tif': mi.image, 'avif': mi.image,
  // Audio / Video
  'mp3': mi.audio, 'wav': mi.audio, 'ogg': mi.audio,
  'flac': mi.audio, 'aac': mi.audio, 'm4a': mi.audio,
  'mp4': mi.video, 'webm': mi.video, 'mkv': mi.video,
  'avi': mi.video, 'mov': mi.video, 'wmv': mi.video,
  // Archives
  'zip': mi.zip, 'tar': mi.zip, 'gz': mi.zip,
  'bz2': mi.zip, 'xz': mi.zip, '7z': mi.zip,
  'rar': mi.zip, 'tgz': mi.zip,
  // Spreadsheet
  'xls': mi.table, 'xlsx': mi.table, 'ods': mi.table,
  // Lock / Security
  'lock': mi.lock,
  // PDF / Font
  'pdf': mi.pdf, 'woff': mi.font, 'woff2': mi.font, 'ttf': mi.font, 'otf': mi.font, 'eot': mi.font,
  // DB
  'sqlite': mi.database, 'db': mi.database,
  // Text / Docs (non-language)
  'rtf': mi.word,
  // Vector
  'svg': mi.svg,
  // Doc files
  'doc': mi.word, 'docx': mi.word, 'odt': mi.word,
  'ppt': mi.powerpoint, 'pptx': mi.powerpoint, 'odp': mi.powerpoint,
};

// Compound extensions checked before simple dot-extension
const compoundExts: [string, string][] = [
  ['.slides.md', mi.powerpoint],
  ['.d.ts', mi.typescriptDef],
  ['.test.ts', mi.typescript],
  ['.test.js', mi.javascript],
  ['.spec.ts', mi.typescript],
  ['.spec.js', mi.javascript],
  ['.config.js', mi.settings],
  ['.config.ts', mi.settings],
  ['.config.mjs', mi.settings],
];

export function getFileIcon(name: string): string {
  const lower = name.toLowerCase();

  // Check compound extensions first
  for (const [suffix, icon] of compoundExts) {
    if (lower.endsWith(suffix)) return icon;
  }

  // Simple extension lookup
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const ext = lower.slice(dot + 1);
    if (ext in extMap) return extMap[ext];
  }

  // Known config filenames
  const baseName = lower.split('/').pop() || lower;
  if (['dockerfile', 'makefile', 'cmakelists.txt', 'gemfile', 'rakefile'].includes(baseName)) return mi.docker;
  if (['.gitignore', '.gitattributes'].includes(baseName)) return mi.git;
  if (['.editorconfig', '.eslintrc', '.prettierrc'].includes(baseName)) return mi.settings;
  if (baseName === 'readme.md' || baseName === 'readme.txt' || baseName === 'readme') return mi.readme;
  if (baseName === 'license' || baseName === 'license.md' || baseName === 'license.txt') return mi.license;
  if (baseName === 'changelog.md' || baseName === 'changelog') return mi.changelog;
  if (baseName === 'todo.md' || baseName === 'todo' || baseName === 'todo.txt') return mi.todo;
  if (baseName === 'dockerfile') return mi.docker;
  if (baseName === 'package.json' || baseName === 'package-lock.json') return mi.json;
  if (baseName === 'tsconfig.json') return mi.typescript;

  return mi.file;
}
