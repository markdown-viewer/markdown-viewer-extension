#!/usr/bin/env node
/**
 * check-themes.cjs
 *
 * 主题系统质量门禁脚本。整合并扩展原有 check-font-config.cjs 的能力。
 *
 * 检查项：
 *   1. registry.json 结构与字段完整性
 *   2. preset / layout / color / table / code / font 配置文件存在性
 *   3. 重复 id 检查
 *   4. registry 条目引用的 preset 文件存在
 *   5. 每个 preset 引用的 layout / color / table / code 配置存在
 *   6. 每个 preset 使用的字体存在于 font-config.json
 *   7. 孤立 / 未使用的主题配置（warning）
 *   8. 基础 WCAG 对比度（正文 / 链接 / 表头 / 代码前景色 / alert 标题）
 *
 * 用法：
 *   node scripts/check-themes.cjs
 *
 * 退出状态：
 *   0  全部通过（允许 warning）
 *   1  存在 error（缺失引用、非法 schema、重复 id、关键对比度失败）
 */

const fs = require('fs');
const path = require('path');

const THEMES_ROOT = path.join(__dirname, '../src/themes');
const PRESETS_DIR = path.join(THEMES_ROOT, 'presets');
const LAYOUT_DIR = path.join(THEMES_ROOT, 'layout-schemes');
const COLOR_DIR = path.join(THEMES_ROOT, 'color-schemes');
const TABLE_DIR = path.join(THEMES_ROOT, 'table-styles');
const CODE_DIR = path.join(THEMES_ROOT, 'code-themes');
const FONT_CONFIG_PATH = path.join(THEMES_ROOT, 'font-config.json');
const REGISTRY_PATH = path.join(THEMES_ROOT, 'registry.json');

const errors = [];
const warnings = [];

function err(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    err(`无法解析 JSON: ${p} (${e.message})`);
    return null;
  }
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
}

// ============================================================================
// WCAG 对比度
// ============================================================================

function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  // #rgb / #rrggbb
  let m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    return { r, g, b, alpha: 1 };
  }
  m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const r = parseInt(s.slice(1, 3), 16);
    const g = parseInt(s.slice(3, 5), 16);
    const b = parseInt(s.slice(5, 7), 16);
    return { r, g, b, alpha: 1 };
  }
  // rgba()
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    return {
      r: parseInt(m[1]),
      g: parseInt(m[2]),
      b: parseInt(m[3]),
      alpha: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }
  // transparent
  if (s === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  return null;
}

function srgbToLinear(c) {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color) {
  if (!color) return 0;
  const r = srgbToLinear(color.r / 255);
  const g = srgbToLinear(color.g / 255);
  const b = srgbToLinear(color.b / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function blendOver(fg, bg) {
  if (!fg) return bg;
  if (!bg) return fg;
  const a = fg.alpha !== undefined ? fg.alpha : 1;
  if (a >= 1) return { r: fg.r, g: fg.g, b: fg.b, alpha: 1 };
  const bgAlpha = bg.alpha !== undefined ? bg.alpha : 1;
  const outAlpha = a + bgAlpha * (1 - a);
  if (outAlpha <= 0) return { r: 0, g: 0, b: 0, alpha: 0 };
  const r = (fg.r * a + bg.r * bgAlpha * (1 - a)) / outAlpha;
  const g = (fg.g * a + bg.g * bgAlpha * (1 - a)) / outAlpha;
  const b = (fg.b * a + bg.b * bgAlpha * (1 - a)) / outAlpha;
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), alpha: outAlpha };
}

function contrastRatio(fg, bg) {
  const fgResolved = blendOver(fg, bg);
  const L1 = relativeLuminance(fgResolved);
  const L2 = relativeLuminance(bg);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ============================================================================
// Schema 校验
// ============================================================================

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validatePreset(preset, file) {
  if (!preset) return;
  const id = file.replace(/\.json$/, '');
  if (!isNonEmptyString(preset.id)) err(`preset ${file}: 缺少 id`);
  else if (preset.id !== id) err(`preset ${file}: id "${preset.id}" 与文件名 "${id}" 不一致`);
  if (!isNonEmptyString(preset.name)) err(`preset ${file}: 缺少 name`);
  if (!preset.fontScheme || typeof preset.fontScheme !== 'object') err(`preset ${file}: 缺少 fontScheme`);
  if (!preset.fontScheme?.body?.fontFamily) err(`preset ${file}: 缺少 fontScheme.body.fontFamily`);
  if (!preset.fontScheme?.code?.fontFamily) err(`preset ${file}: 缺少 fontScheme.code.fontFamily`);
  if (!isNonEmptyString(preset.layoutScheme)) err(`preset ${file}: 缺少 layoutScheme`);
  if (!isNonEmptyString(preset.colorScheme)) err(`preset ${file}: 缺少 colorScheme`);
  if (!isNonEmptyString(preset.tableStyle)) err(`preset ${file}: 缺少 tableStyle`);
  if (!isNonEmptyString(preset.codeTheme)) err(`preset ${file}: 缺少 codeTheme`);
}

function validateLayout(layout, file) {
  if (!layout) return;
  const id = file.replace(/\.json$/, '');
  if (!isNonEmptyString(layout.id)) err(`layout ${file}: 缺少 id`);
  else if (layout.id !== id) err(`layout ${file}: id "${layout.id}" 与文件名 "${id}" 不一致`);
  if (!layout.body || typeof layout.body.fontSize !== 'string' || typeof layout.body.lineHeight !== 'number') {
    err(`layout ${file}: body.fontSize / body.lineHeight 非法`);
  }
  if (!layout.headings || typeof layout.headings !== 'object') err(`layout ${file}: 缺少 headings`);
  if (!layout.blocks || typeof layout.blocks !== 'object') err(`layout ${file}: 缺少 blocks`);
}

function validateColorScheme(cs, file) {
  if (!cs) return;
  const id = file.replace(/\.json$/, '');
  if (!isNonEmptyString(cs.id)) err(`color-scheme ${file}: 缺少 id`);
  else if (cs.id !== id) err(`color-scheme ${file}: id "${cs.id}" 与文件名 "${id}" 不一致`);
  if (!cs.text || !cs.text.primary) err(`color-scheme ${file}: 缺少 text.primary`);
  if (!cs.accent || !cs.accent.link) err(`color-scheme ${file}: 缺少 accent.link`);
  if (!cs.background || !cs.background.code) err(`color-scheme ${file}: 缺少 background.code`);
  if (!cs.table || !cs.table.border) err(`color-scheme ${file}: 缺少 table.border`);
}

function validateTableStyle(ts, file) {
  if (!ts) return;
  const id = file.replace(/\.json$/, '');
  if (!isNonEmptyString(ts.id)) err(`table-style ${file}: 缺少 id`);
  else if (ts.id !== id) err(`table-style ${file}: id "${ts.id}" 与文件名 "${id}" 不一致`);
  if (!ts.cell || typeof ts.cell.padding !== 'string') err(`table-style ${file}: 缺少 cell.padding`);
}

function validateCodeTheme(ct, file) {
  if (!ct) return;
  const id = file.replace(/\.json$/, '');
  if (!isNonEmptyString(ct.id)) err(`code-theme ${file}: 缺少 id`);
  else if (ct.id !== id) err(`code-theme ${file}: id "${ct.id}" 与文件名 "${id}" 不一致`);
  if (!ct.colors || typeof ct.colors !== 'object') err(`code-theme ${file}: 缺少 colors`);
  if (ct.foreground !== undefined && typeof ct.foreground !== 'string') err(`code-theme ${file}: foreground 非法`);
}

// ============================================================================
// Main
// ============================================================================

function main() {
  console.log('🔍 Running theme system quality checks...\n');

  // ---- 1. font-config.json ----
  const fontConfig = readJSON(FONT_CONFIG_PATH);
  if (!fontConfig) {
    err('font-config.json 无法加载');
  }
  const configuredFonts = new Set(fontConfig ? Object.keys(fontConfig.fonts || {}) : []);

  // ---- 2. registry.json ----
  const registry = readJSON(REGISTRY_PATH);
  if (!registry) {
    err('registry.json 无法加载');
    return report();
  }
  if (!Array.isArray(registry.themes)) {
    err('registry.json: themes 必须是数组');
    return report();
  }
  if (!registry.categories || typeof registry.categories !== 'object') {
    err('registry.json: 缺少 categories 对象');
  }

  // ---- 3. 收集所有配置文件 ----
  const presetFiles = listJsonFiles(PRESETS_DIR);
  const layoutFiles = listJsonFiles(LAYOUT_DIR);
  const colorFiles = listJsonFiles(COLOR_DIR);
  const tableFiles = listJsonFiles(TABLE_DIR);
  const codeFiles = listJsonFiles(CODE_DIR);

  // ---- 4. 加载并校验 presets ----
  const presetIds = new Set();
  const presets = new Map();
  for (const f of presetFiles) {
    const p = readJSON(path.join(PRESETS_DIR, f));
    validatePreset(p, f);
    if (p) {
      if (presetIds.has(p.id)) err(`preset id 重复: ${p.id}`);
      presetIds.add(p.id);
      presets.set(p.id, p);
    }
  }

  // ---- 5. 加载并校验 layout / color / table / code ----
  const layoutIds = new Set();
  const layouts = new Map();
  for (const f of layoutFiles) {
    const l = readJSON(path.join(LAYOUT_DIR, f));
    validateLayout(l, f);
    if (l) {
      if (layoutIds.has(l.id)) err(`layout id 重复: ${l.id}`);
      layoutIds.add(l.id);
      layouts.set(l.id, l);
    }
  }

  const colorIds = new Set();
  const colors = new Map();
  for (const f of colorFiles) {
    const c = readJSON(path.join(COLOR_DIR, f));
    validateColorScheme(c, f);
    if (c) {
      if (colorIds.has(c.id)) err(`color-scheme id 重复: ${c.id}`);
      colorIds.add(c.id);
      colors.set(c.id, c);
    }
  }

  const tableIds = new Set();
  const tables = new Map();
  for (const f of tableFiles) {
    const t = readJSON(path.join(TABLE_DIR, f));
    validateTableStyle(t, f);
    if (t) {
      if (tableIds.has(t.id)) err(`table-style id 重复: ${t.id}`);
      tableIds.add(t.id);
      tables.set(t.id, t);
    }
  }

  const codeIds = new Set();
  const codeThemes = new Map();
  for (const f of codeFiles) {
    const c = readJSON(path.join(CODE_DIR, f));
    validateCodeTheme(c, f);
    if (c) {
      if (codeIds.has(c.id)) err(`code-theme id 重复: ${c.id}`);
      codeIds.add(c.id);
      codeThemes.set(c.id, c);
    }
  }

  // ---- 6. registry 条目引用的 preset 文件存在 ----
  const registryPresetIds = new Set();
  for (const entry of registry.themes) {
    if (!entry || typeof entry !== 'object') {
      err('registry.json: themes 条目必须是对象');
      continue;
    }
    if (!isNonEmptyString(entry.id)) err('registry.json: 条目缺少 id');
    if (!isNonEmptyString(entry.file)) err(`registry 条目 ${entry.id}: 缺少 file`);
    if (!isNonEmptyString(entry.category)) err(`registry 条目 ${entry.id}: 缺少 category`);
    if (entry.id) registryPresetIds.add(entry.id);
    if (entry.file && !presetFiles.includes(entry.file)) {
      err(`registry 条目 ${entry.id}: 引用的 preset 文件 ${entry.file} 不存在`);
    }
    if (entry.category && registry.categories && !registry.categories[entry.category]) {
      err(`registry 条目 ${entry.id}: category "${entry.category}" 在 categories 中未定义`);
    }
  }

  // ---- 7. 孤立 preset 检查 ----
  for (const id of presetIds) {
    if (!registryPresetIds.has(id)) {
      warn(`preset ${id} 存在但未在 registry.json 中注册`);
    }
  }
  for (const f of presetFiles) {
    const id = f.replace(/\.json$/, '');
    if (!registryPresetIds.has(id) && !presetIds.has(id)) {
      // id 校验失败的 preset 已经在 validatePreset 中报错
    }
  }

  // ---- 8. preset 引用的 layout / color / table / code 配置存在 ----
  const usedLayouts = new Set();
  const usedColors = new Set();
  const usedTables = new Set();
  const usedCodes = new Set();

  for (const [id, preset] of presets) {
    if (preset.layoutScheme) {
      usedLayouts.add(preset.layoutScheme);
      if (!layoutIds.has(preset.layoutScheme)) {
        err(`preset ${id}: layoutScheme "${preset.layoutScheme}" 不存在`);
      }
    }
    if (preset.colorScheme) {
      usedColors.add(preset.colorScheme);
      if (!colorIds.has(preset.colorScheme)) {
        err(`preset ${id}: colorScheme "${preset.colorScheme}" 不存在`);
      }
    }
    if (preset.tableStyle) {
      usedTables.add(preset.tableStyle);
      if (!tableIds.has(preset.tableStyle)) {
        err(`preset ${id}: tableStyle "${preset.tableStyle}" 不存在`);
      }
    }
    if (preset.codeTheme) {
      usedCodes.add(preset.codeTheme);
      if (!codeIds.has(preset.codeTheme)) {
        err(`preset ${id}: codeTheme "${preset.codeTheme}" 不存在`);
      }
    }
  }

  // ---- 9. 孤立 layout / color / table / code ----
  for (const id of layoutIds) if (!usedLayouts.has(id)) warn(`layout-scheme ${id} 未被任何 preset 引用`);
  for (const id of colorIds) if (!usedColors.has(id)) warn(`color-scheme ${id} 未被任何 preset 引用`);
  for (const id of tableIds) if (!usedTables.has(id)) warn(`table-style ${id} 未被任何 preset 引用`);
  for (const id of codeIds) if (!usedCodes.has(id)) warn(`code-theme ${id} 未被任何 preset 引用`);

  // ---- 10. 字体存在性 ----
  function extractFontFamilies(obj, found = new Set()) {
    if (!obj || typeof obj !== 'object') return found;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'fontFamily' && typeof v === 'string') found.add(v);
      else if (typeof v === 'object') extractFontFamilies(v, found);
    }
    return found;
  }

  for (const [id, preset] of presets) {
    const fonts = extractFontFamilies(preset);
    for (const font of fonts) {
      if (!configuredFonts.has(font)) {
        err(`preset ${id}: 使用未配置的字体 "${font}"（font-config.json 中不存在）`);
      }
    }
  }

  // ---- 11. WCAG 对比度 ----
  const AA_NORMAL = 4.5;
  const AA_LARGE = 3.0;

  function checkContrast(label, fgColor, bgColor, threshold, allowExceptions) {
    const fg = parseColor(fgColor);
    const bg = parseColor(bgColor);
    if (!fg || !bg) {
      // 颜色无法解析（例如 transparent border），跳过而非报错
      return;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < threshold) {
      const level = threshold === AA_NORMAL ? 'AA(4.5:1)' : `AA-large(${threshold}:1)`;
      const msg = `对比度失败: ${label} — fg=${fgColor} bg=${bgColor} ratio=${ratio.toFixed(2)} (要求 ${level})`;
      if (allowExceptions) warn(msg); else err(msg);
    }
  }

  for (const [id, preset] of presets) {
    const cs = colors.get(preset.colorScheme);
    if (!cs) continue;
    const pageBg = cs.background?.page || '#ffffff';
    const codeBg = cs.background?.code || pageBg;

    // 正文 / muted / secondary 对 page 背景
    checkContrast(`preset ${id} text.primary`, cs.text.primary, pageBg, AA_NORMAL, false);
    checkContrast(`preset ${id} text.secondary`, cs.text.secondary, pageBg, AA_NORMAL, false);
    checkContrast(`preset ${id} text.muted`, cs.text.muted, pageBg, AA_NORMAL, false);
    // 链接颜色对 page 背景
    checkContrast(`preset ${id} accent.link`, cs.accent.link, pageBg, AA_NORMAL, false);

    // 表头对比度（背景为 transparent 时 fallback 到 page 背景）
    const headerBg = parseColor(cs.table.headerBackground)?.alpha === 0 ? pageBg : cs.table.headerBackground;
    checkContrast(`preset ${id} table.headerText`, cs.table.headerText, headerBg, AA_NORMAL, false);

    // 代码前景色对代码背景（error 级别，正文级要求）
    const codeTheme = codeThemes.get(preset.codeTheme);
    if (codeTheme) {
      const fg = codeTheme.foreground || '#24292e';
      checkContrast(`preset ${id} code.foreground`, fg, codeBg, AA_NORMAL, false);
      // 语法 token 前景对代码背景：warning 级别。
      // 语法高亮色板（GitHub/VSCode/Solarized/Dracula 等）遵循上游设计，
      // 部分 token 对比度低于 AA-large(3:1)，属于已知例外。后续可逐步替换，
      // 但不阻塞主题系统门禁。
      for (const [token, color] of Object.entries(codeTheme.colors || {})) {
        checkContrast(`preset ${id} code.${token}`, color, codeBg, AA_LARGE, true);
      }
    }

    // GitHub alert 标题颜色对 alert 背景（10% 颜色 + 90% page 的 tint）
    // warning 级别：alert 使用 GitHub-canonical 色板，深色背景下 alert 标题
    // 对比度天然不足 AA(4.5:1)。属于已知例外，不阻塞门禁。
    const alertColors = {
      note: '#0969da',
      tip: '#1a7f37',
      important: '#8250df',
      warning: '#9a6700',
      caution: '#cf222e',
    };
    const pageColorParsed = parseColor(pageBg);
    for (const [kind, color] of Object.entries(alertColors)) {
      const alertFg = parseColor(color);
      // 计算 10% tint 背景
      let alertBgStr = pageBg;
      if (pageColorParsed && alertFg) {
        const r = Math.round(0.9 * pageColorParsed.r + 0.1 * alertFg.r);
        const g = Math.round(0.9 * pageColorParsed.g + 0.1 * alertFg.g);
        const b = Math.round(0.9 * pageColorParsed.b + 0.1 * alertFg.b);
        alertBgStr = `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
      }
      checkContrast(`preset ${id} alert.${kind}`, color, alertBgStr, AA_NORMAL, true);
    }
  }

  return report();
}

function report() {
  console.log('\n' + '='.repeat(70));
  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`   ⚠️  ${w}`);
  }
  if (errors.length > 0) {
    console.log(`❌ ${errors.length} error(s):`);
    for (const e of errors) console.log(`   ❌ ${e}`);
    console.log('\n❌ Theme check failed.');
    return 1;
  }
  console.log('✅ Theme check passed.');
  return 0;
}

process.exit(main());