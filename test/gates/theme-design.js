/**
 * Theme visual design audit — quantified design principles, per theme.
 *
 * Sits above theme-system.js (schema + contrast) and checks the things a
 * schema cannot express:
 *   D1 background layering   every surface must differ visibly from `page`
 *   D2 quote semantics       a plain blockquote must not impersonate an alert
 *   D3 heading contrast      colorScheme.headings per level ≥ 3:1 on `page`
 *   D4 hue coherence         tinted surfaces share one hue family
 *   D5 heading ladder        h1..h6 monotonic, h1 above body size
 *   D6 name/token match      palette + font must match what the theme name claims
 *   D7 reading measure       characters per line for the reading column
 *
 * Consumed by test/suites/project-gates/theme-design.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '../../src/themes');

// ---------------------------------------------------------------- color math
function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  let m = s.match(/^#([0-9a-fA-F]{3})$/);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), alpha: 1 };
  m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) return { r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16), alpha: 1 };
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], alpha: m[4] !== undefined ? +m[4] : 1 };
  if (s === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  return null;
}
const srgbToLinear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function relLum(c) { return 0.2126 * srgbToLinear(c.r / 255) + 0.7152 * srgbToLinear(c.g / 255) + 0.0722 * srgbToLinear(c.b / 255); }
function contrast(fg, bg) { const L1 = relLum(fg), L2 = relLum(bg); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); }
function rgbToXyz(c) {
  const R = srgbToLinear(c.r / 255), G = srgbToLinear(c.g / 255), B = srgbToLinear(c.b / 255);
  return { x: R * 0.4124 + G * 0.3576 + B * 0.1805, y: R * 0.2126 + G * 0.7152 + B * 0.0722, z: R * 0.0193 + G * 0.1192 + B * 0.9505 };
}
function xyzToLab(xyz) {
  const xn = 0.95047, yn = 1, zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(xyz.x / xn), fy = f(xyz.y / yn), fz = f(xyz.z / zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
const lab = (c) => xyzToLab(rgbToXyz(c));
const Lstar = (c) => lab(c).L;
function deltaE(c1, c2) { const a = lab(c1), b = lab(c2); return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b); }
// Lab chroma/hue are stable near white/black where HSL saturation/hue are not.
const chroma = (c) => { const l = lab(c); return Math.hypot(l.a, l.b); };
const labHue = (c) => { const l = lab(c); const h = Math.atan2(l.b, l.a) * 180 / Math.PI; return h < 0 ? h + 360 : h; };
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
function tint(page, hex, ratio) { // page-tint like the alert background formula
  const p = parseColor(page), c = parseColor(hex);
  if (!p || !c) return page;
  const mix = (x, y) => Math.round((1 - ratio) * x + ratio * y);
  return { r: mix(p.r, c.r), g: mix(p.g, c.g), b: mix(p.b, c.b), alpha: 1 };
}

// ---------------------------------------------------------------- load themes
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const registry = readJSON(path.join(ROOT, 'registry.json'));
const load = (sub) => {
  const dir = path.join(ROOT, sub);
  const map = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) map.set(f.replace(/\.json$/, ''), readJSON(path.join(dir, f)));
  return map;
};
const colors = load('color-schemes');
const layouts = load('layout-schemes');
const presets = new Map(registry.themes.map((t) => [t.id, { ...readJSON(path.join(ROOT, 'presets', t.file)), _category: t.category }]));

// ---------------------------------------------------------------- design spec
const ALERTS = { note: '#0969da', tip: '#1a7f37', warning: '#9a6700', important: '#8250df', caution: '#cf222e' };
// Reading measure: mirrors #markdown-page in src/ui/styles.css, which in turn
// mirrors READING_MAX_WIDTH_PX in src/ui/layout-presets.ts. Exported so the
// drift guard (test/suites/project-gates/reading-measure.test.ts) can compare
// the three copies; keep them in sync.
export const READING_MAX_WIDTH = 820;
export const READING_GUTTER = 48;
// Categories where a plain blockquote must stay neutral (a quote must not read
// as an alert). Expressive categories may carry an identity tint.
const NEUTRAL_QUOTE_CATEGORIES = new Set(['classic', 'reading', 'modern', 'chinese']);
// Expected body font (substring) by theme id — the "name says the font" set.
const FONT_EXPECT = {
  palatino: 'Palatino', garamond: 'Garamond', verdana: 'Verdana', heiti: 'Hei',
  typewriter: 'Courier', century: 'Century',
};
// Expected temperature of the dominant tint, by colorScheme (Lab a/b sign test).
// Probe = most-chromatic tinted surface, else accent. Only themes whose NAME
// asserts a colour are listed; neutral/multi/near-white names are omitted.
const COLOR_EXPECT = {
  forest: { test: (l) => l.a < -3, desc: '绿(Lab a<0)' },
  ocean: { test: (l) => l.b < 4, desc: '冷/青(Lab b≤0)' },
  sepia: { test: (l) => l.b > 4, desc: '暖(Lab b>0)' },
  warm: { test: (l) => l.b > 4, desc: '暖(Lab b>0)' },
  sakura: { test: (l) => l.a > 3, desc: '粉(Lab a>0)' },
};

function evalTheme(id, preset) {
  const cs = colors.get(preset.colorScheme);
  const ly = layouts.get(preset.layoutScheme);
  const cat = preset._category;
  const findings = []; // {sev, dim, msg}
  const add = (sev, dim, msg) => findings.push({ sev, dim, msg });
  if (!cs || !ly) { add('ERROR', 'load', `无法解析 colorScheme=${preset.colorScheme} 或 layout=${preset.layoutScheme}`); return { id, name: preset.name, cat, findings }; }

  const bg = cs.background || {};
  const pageC = parseColor(bg.page || '#ffffff');
  const pageL = Lstar(pageC);
  const isDark = pageL < 55;

  // ---- D1 background layering: a surface must differ visibly from page ----
  // Dark themes may inset (darker) or float (lighter) code blocks; only a
  // lighter-than-page block on a light theme reads as a floating white slab.
  for (const [name, hex] of [['code', bg.code], ['blockquote', bg.blockquote]]) {
    const c = parseColor(hex);
    if (!c || c.alpha === 0) continue;
    const dL = Lstar(c) - pageL;
    if (Math.abs(dL) < 1.0) add('WARN', 'D1', `${name}(${hex}) 与 page 几乎无差(ΔL*=${dL.toFixed(1)})，色块难以辨识`);
    else if (!isDark && dL > 1.0) add('WARN', 'D1', `浅色主题里 ${name}(${hex}) 比 page 更亮(ΔL*=${dL.toFixed(1)})，层次悬浮`);
  }

  // ---- D2 quote semantics: only "neutral page + chromatic quote + alert hue" ----
  const quoteC = parseColor(bg.blockquote);
  const pageChroma = chroma(pageC);
  if (quoteC && quoteC.alpha !== 0 && chroma(quoteC) > 6) {
    const qHue = labHue(quoteC);
    for (const [kind, ah] of Object.entries(ALERTS)) {
      const alertBg = tint(bg.page || '#ffffff', ah, 0.1);
      const dHue = hueDist(qHue, labHue(alertBg));
      const dE = deltaE(quoteC, alertBg);
      if (dHue < 28 && dE < 8) {
        if (pageChroma < 4 && NEUTRAL_QUOTE_CATEGORIES.has(cat)) add('ERROR', 'D2', `中性页上的普通引用块(${bg.blockquote}) 撞 ${kind} alert 色相(Δhue=${dHue.toFixed(0)}°, ΔE=${dE.toFixed(1)})`);
        else add('INFO', 'D2', `引用块与 ${kind} alert 同色系（表现型主题的识别色）`);
        break;
      }
    }
  }

  // ---- D3 per-level heading contrast ----
  if (cs.headings && typeof cs.headings === 'object') {
    for (const lvl of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const hc = parseColor(cs.headings[lvl]);
      if (!hc) continue;
      const cr = contrast(hc, pageC);
      if (cr < 3.0) add('ERROR', 'D3', `标题 ${lvl}(${cs.headings[lvl]}) 对 page 仅 ${cr.toFixed(2)}:1 (<3:1，不可读)`);
      else if (cr < 4.5) add('WARN', 'D3', `标题 ${lvl}(${cs.headings[lvl]}) 对 page ${cr.toFixed(2)}:1 (<AA 4.5)`);
    }
  }

  // ---- D4 hue coherence ----
  const tinted = [];
  for (const [name, hex] of [['page', bg.page], ['surface', bg.surface], ['code', bg.code], ['blockquote', bg.blockquote], ['zebraEven', cs.table?.zebraEven], ['zebraOdd', cs.table?.zebraOdd], ['table.header', cs.table?.headerBackground]]) {
    const c = parseColor(hex);
    if (!c || c.alpha === 0) continue;
    if (chroma(c) > 4) tinted.push({ name, hex, h: labHue(c), C: chroma(c) });
  }
  if (tinted.length >= 2) {
    for (const t of tinted) {
      const others = tinted.filter((o) => o !== t);
      const minD = Math.min(...others.map((o) => hueDist(t.h, o.h)));
      if (minD > 55) add('WARN', 'D4', `${t.name}(${t.hex}) 色相 ${t.h.toFixed(0)}° 与其它有色背景相差 ≥${minD.toFixed(0)}°，混入异色`);
    }
  }

  // ---- D5 heading ladder ----
  const sz = (h) => { const v = ly.headings?.[h]?.fontSize; return v ? parseFloat(v) : null; };
  const bodySz = ly.body?.fontSize ? parseFloat(ly.body.fontSize) : null;
  const ladder = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(sz);
  for (let i = 1; i < ladder.length; i++) if (ladder[i] != null && ladder[i - 1] != null && ladder[i] > ladder[i - 1]) add('ERROR', 'D5', `标题阶梯倒挂: h${i + 1}(${ladder[i]}) > h${i}(${ladder[i - 1]})`);
  if (ladder[0] != null && bodySz != null && ladder[0] <= bodySz) add('WARN', 'D5', `h1(${ladder[0]}pt) 不大于正文(${bodySz}pt)`);

  // ---- D7 reading measure (styles.css column width × this theme's font size) ----
  // Reference: Butterick 45–90 / Tailwind prose 65ch. One em ≈ 0.5 latin chars.
  if (bodySz != null) {
    const bodyPx = bodySz * 96 / 72;
    const content = READING_MAX_WIDTH - 2 * READING_GUTTER;
    const cpl = content / (bodyPx * 0.5);
    if (cpl > 105) add('WARN', 'D7', `行长≈${cpl.toFixed(0)} 拉丁字符/行 (>105，超出舒适上限，宜收窄版心或增大字号)`);
    else if (cpl < 42) add('WARN', 'D7', `行长≈${cpl.toFixed(0)} 拉丁字符/行 (<42，过窄)`);
  }

  // ---- D6 name/token match ----
  const bodyFont = preset.fontScheme?.body?.fontFamily || '';
  const expectFont = FONT_EXPECT[id];
  if (expectFont && !bodyFont.toLowerCase().includes(expectFont.toLowerCase())) add('WARN', 'D6', `名称暗示字体含 "${expectFont}"，实际正文字体为 "${bodyFont}"`);
  const colorExpect = COLOR_EXPECT[preset.colorScheme];
  if (colorExpect) {
    const pool = tinted.slice().sort((a, b) => b.C - a.C);
    const probeHex = pool[0] ? pool[0].hex : cs.accent?.link;
    const probeName = pool[0] ? pool[0].name : 'accent';
    const probe = parseColor(probeHex);
    if (probe && !colorExpect.test(lab(probe))) add('WARN', 'D6', `配色 "${preset.colorScheme}" 期望 ${colorExpect.desc}，实测主色 ${probeName}(${probeHex}) Lab a/b=${lab(probe).a.toFixed(0)}/${lab(probe).b.toFixed(0)}`);
  }

  return { id, name: preset.name, cat, isDark, findings };
}

/**
 * Run the full design audit over every registered preset.
 * @returns {{ results: Array, errorCount: number, warnCount: number, infoCount: number }}
 */
export function auditThemes() {
  const results = [];
  for (const [id, preset] of presets) results.push(evalTheme(id, preset));
  let errorCount = 0, warnCount = 0, infoCount = 0;
  for (const r of results) for (const f of r.findings) {
    if (f.sev === 'ERROR') errorCount++;
    else if (f.sev === 'WARN') warnCount++;
    else infoCount++;
  }
  return { results, errorCount, warnCount, infoCount };
}

/** Flatten findings of one severity into `id  dim  msg` lines, for test output. */
export function findingsOf(audit, sev) {
  return audit.results.flatMap((r) => r.findings.filter((f) => f.sev === sev).map((f) => `${r.id}  ${f.dim}  ${f.msg}`));
}
