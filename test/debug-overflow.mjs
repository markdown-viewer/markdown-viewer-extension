// debug-overflow.mjs — 临时:测量 deck 在 workspace iframe 里的横向溢出
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const EXT_DIR = path.resolve('dist/chrome');
const DECK_DIR = '/Users/lion/works/projects/人工智能/智能体决策支撑网页PPT';
const files = {};
for (const entry of fs.readdirSync(DECK_DIR, { withFileTypes: true })) {
  if (entry.name.startsWith('.')) continue;
  if (entry.isDirectory() && entry.name === 'images') {
    for (const img of fs.readdirSync(path.join(DECK_DIR, 'images'))) {
      files['images/' + img] = { b64: fs.readFileSync(path.join(DECK_DIR, 'images', img)).toString('base64'), mime: 'image/png' };
    }
  } else if (entry.isFile() && entry.name.endsWith('.html')) {
    files[entry.name] = { b64: fs.readFileSync(path.join(DECK_DIR, entry.name)).toString('base64'), mime: 'text/html' };
  }
}

const MOCK = `(spec) => {
  const decode = (b64) => { const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return bytes; };
  const root = { name: 'PPT', kind: 'directory', children: {} };
  for (const [rel, entry] of Object.entries(spec.files)) {
    const segs = rel.split('/'); let dir = root;
    for (let i = 0; i < segs.length - 1; i++) { if (!dir.children[segs[i]]) dir.children[segs[i]] = { name: segs[i], kind: 'directory', children: {} }; dir = dir.children[segs[i]]; }
    dir.children[segs[segs.length - 1]] = { name: segs[segs.length - 1], kind: 'file', mime: entry.mime, bytes: decode(entry.b64) };
  }
  const toHandle = (node) => {
    if (node.kind === 'file') return { name: node.name, kind: 'file', getFile: async () => new File([node.bytes], node.name, { type: node.mime || '' }) };
    const children = {};
    for (const [n, c] of Object.entries(node.children)) children[n] = toHandle(c);
    return { name: node.name, kind: 'directory',
      getFileHandle: async (n) => { if (!children[n]) throw new DOMException('Not found','NotFoundError'); return children[n]; },
      getDirectoryHandle: async (n) => { if (!children[n]) throw new DOMException('Not a directory','TypeMismatchError'); return children[n]; },
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      [Symbol.asyncIterator]: async function* () { for (const [n, h] of Object.entries(children)) yield [n, h]; } };
  };
  window.showDirectoryPicker = async () => toHandle(root);
}`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-dbg-'));
const VW = Number(process.argv[2] || '1440');
const VH = Number(process.argv[3] || '900');
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', headless: true, viewport: { width: VW, height: VH },
  args: ['--disable-extensions-except=' + EXT_DIR, '--load-extension=' + EXT_DIR, '--no-first-run', '--disable-default-apps'],
});
let extId = '';
for (let i = 0; i < 40 && !extId; i++) {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Default', 'Secure Preferences'), 'utf8'));
    for (const [id, info] of Object.entries(prefs?.extensions?.settings || {})) if (info?.path === EXT_DIR) { extId = id; break; }
  } catch {}
  if (!extId) await new Promise((r) => setTimeout(r, 250));
}
const page = await context.newPage();
await page.addInitScript(`(${MOCK})(${JSON.stringify({ files })})`);
await page.goto('chrome-extension://' + extId + '/ui/workspace/workspace.html', { waitUntil: 'load' });
await page.click('#pick-directory');
await page.waitForSelector('.tree-item', { timeout: 30000 });
await page.evaluate(() => {
  [...document.querySelectorAll('.tree-item')].find((el) => el.textContent.trim().endsWith('government.html')).click();
});
await new Promise((r) => setTimeout(r, 3500));

// workspace 侧布局测量
const layout = await page.evaluate(() => {
  const pane = document.querySelector('.preview-pane');
  const frame = document.getElementById('preview-frame');
  const sidebar = document.querySelector('.sidebar');
  const rp = pane.getBoundingClientRect();
  const rf = frame.getBoundingClientRect();
  const rs = sidebar.getBoundingClientRect();
  return {
    viewport: [innerWidth, innerHeight],
    pane: [rp.x, rp.width],
    frame: [rf.x, rf.width],
    sidebar: [rs.x, rs.width],
    frameScrollable: frame.scrollWidth > frame.clientWidth,
  };
});
console.log('workspace layout:', JSON.stringify(layout));

const f = page.frames().find((x) => x.url().includes('html-preview-sandbox'));
await f.waitForSelector('#nav .dot', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1200));

// 无动画模式:revealStatic 会让所有元素落到最终布局位置
await f.evaluate(() => {
  if (window.__setLowPowerMode) window.__setLowPowerMode(true, { persist: false });
  document.body.classList.add('low-power');
  if (window.__playSlide) window.__playSlide(window.__currentSlideIndex || 0);
});
await new Promise((r) => setTimeout(r, 1500));

// 逐页翻,测量每页内内容是否超出该页自身边界(slide 宽 1180)
const perPage = [];
for (let i = 0; i < 20; i++) {
  if (i > 0) {
    await f.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 600));
  }
  const m = await f.evaluate((idx) => {
    const slide = document.querySelectorAll('.slide')[idx];
    const sr = slide.getBoundingClientRect();
    let maxRight = 0;
    let maxLeft = 1e9;
    let worst = null;
    for (const el of slide.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > maxRight) { maxRight = r.right; worst = { tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 30), right: Math.round(r.right), w: Math.round(r.width) }; }
      if (r.left < maxLeft) maxLeft = r.left;
    }
    return {
      idx,
      slideRect: [Math.round(sr.x), Math.round(sr.width)],
      contentMaxRight: Math.round(maxRight),
      contentMinLeft: Math.round(maxLeft),
      overflowRight: Math.round(maxRight - sr.right),
      overflowLeft: Math.round(sr.left - maxLeft),
      worst,
    };
  }, i);
  perPage.push(m);
}
const bad = perPage.filter((p) => p.overflowRight > 2 || p.overflowLeft > 2);
console.log('pages with overflow (low-power):', bad.length);
for (const p of bad) console.log(JSON.stringify(p));
if (!bad.length) console.log('全部 20 页内容均在页内 ✓');
await context.close();
process.exit(0);
