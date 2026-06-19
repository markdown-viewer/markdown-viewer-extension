/**
 * Canonical extension → language mapping — single source of truth.
 * Used by both code-preview (syntax highlighting) and file-icons (sidebar icons).
 *
 * Key:   extension without leading dot (e.g. 'cpp', 'd.ts')
 * Value: highlight.js language identifier (e.g. 'cpp', 'typescript')
 *
 * To add a new extension, just add an entry here. Both code-preview and
 * file-icons will pick it up automatically.
 */
export const EXT_LANG_MAP: Record<string, string> = {
  // ── JavaScript / TypeScript ──
  'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
  'jsx': 'javascript',
  'ts': 'typescript', 'mts': 'typescript', 'cts': 'typescript',
  'tsx': 'typescript', 'd.ts': 'typescript',

  // ── Web Frameworks ──
  'vue': 'vue', 'svelte': 'svelte',

  // ── Systems Languages ──
  'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust',
  'java': 'java', 'kt': 'kotlin', 'swift': 'swift', 'dart': 'dart',
  'c': 'c', 'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp',
  'h': 'c', 'hpp': 'cpp', 'hh': 'cpp', 'hxx': 'cpp',
  'cs': 'csharp', 'php': 'php', 'lua': 'lua', 'r': 'r',
  'scala': 'scala', 'zig': 'zig', 'pl': 'perl', 'perl': 'perl',

  // ── Web ──
  'html': 'html', 'htm': 'html',
  'css': 'css', 'scss': 'scss', 'sass': 'scss', 'less': 'less',

  // ── Data / Config ──
  'json': 'json', 'jsonc': 'json', 'json5': 'json',
  'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml',
  'ini': 'ini', 'env': 'ini', 'properties': 'ini',
  'xml': 'xml', 'xsl': 'xml', 'xslt': 'xml',

  // ── Shell ──
  'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
  'fish': 'fish', 'ps1': 'powershell', 'bat': 'bat', 'cmd': 'bat',

  // ── Markdown / Text / Docs ──
  // Note: .md / .markdown are deliberately excluded from EXT_LANG_MAP.
  // They are rendered as formatted markdown, not as fenced code blocks.
  // Their file-panel icons are handled directly in file-icons.ts.
  'mdx': 'markdown',
  'txt': 'plaintext', 'log': 'plaintext',
  'tex': 'latex', 'bib': 'latex',
  'csv': 'csv', 'tsv': 'csv',
  'sql': 'sql',
};

/**
 * All extensions suitable for code-preview rendering.
 * Derived from EXT_LANG_MAP; sorted longest-first so compound extensions
 * (.d.ts, .slides.md) match before their simpler suffixes.
 */
export const CODE_PREVIEW_EXTENSIONS: readonly string[] = Object.keys(EXT_LANG_MAP)
  .map((ext) => '.' + ext)
  .sort((a, b) => b.length - a.length);
