/**
 * workspace HTML 预览修复的回归验证(真实扩展 + 真实文件)
 *
 * 背景:workspace 用 blob: URL 在 iframe 里预览本地 .html。blob 文档继承
 * 扩展页 CSP 且相对路径资源无法解析 —— 修复前:内联脚本全被拦(翻页失效)、
 * images/ 全 404(背景大图丢失)。修复(html-preview-rewrite.ts + manifest
 * extension_pages 放行 'unsafe-inline' + unpkg/jsdelivr)后,单文件交互式
 * deck 应能完整工作:翻页、动效、图片、WebGL 背景。
 *
 * 运行前置:先 `node chrome/build.js` 产出 dist/chrome。
 * 用法:node test/workspace-html-preview-e2e.mjs [--headed] [--dir=<PPT目录>]
 *
 * 覆盖场景:
 *   1. 根目录 government.html:翻页/图片/背景全部正常,CSP 违规为 0
 *   2. 嵌套子目录 sub/government.html:相对资源按文件自身目录解析(回归
 *      nested-dir 场景,防止"相对路径解析到根目录"的经典错误)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const EXT_DIR = path.resolve('dist/chrome');
const DEFAULT_DECK_DIR = '/Users/lion/works/projects/人工智能/智能体决策支撑网页PPT';

const HEADED = process.argv.includes('--headed');
const deckDirArg = process.argv.find((a) => a.startsWith('--dir='));
const DECK_DIR = deckDirArg ? deckDirArg.split('=').slice(1).join('=') : DEFAULT_DECK_DIR;

const MIME_BY_EXT = { html: 'text/html', htm: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', gif: 'image/gif', webp: 'image/webp', css: 'text/css', js: 'text/javascript', json: 'application/json' };

/* ── 1. 收集真实文件夹内容,构建 mock picker 数据 ── */
function collectFiles(dir, prefix = '', out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFiles(path.join(dir, entry.name), rel, out);
    } else {
      const buf = fs.readFileSync(path.join(dir, entry.name));
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
      out[rel] = { b64: buf.toString('base64'), mime: MIME_BY_EXT[ext] || '' };
    }
  }
  return out;
}

const files = collectFiles(DECK_DIR);
assert.ok(files['government.html'], `未找到 ${path.join(DECK_DIR, 'government.html')}`);
assert.ok(Object.keys(files).some((k) => k.startsWith('images/')), '未找到 images/ 目录');

// 合成嵌套目录副本:sub/government.html + sub/images/* —— 验证相对路径按文件自身目录解析
for (const [rel, entry] of Object.entries(files)) {
  if (rel.startsWith('images/')) files[`sub/images/${rel.slice('images/'.length)}`] = entry;
}
files['sub/government.html'] = files['government.html'];

const MOCK_PICKER_JS = `(spec) => {
  const decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const root = { name: spec.rootName, kind: 'directory', children: {} };
  for (const [rel, entry] of Object.entries(spec.files)) {
    const segs = rel.split('/');
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!dir.children[segs[i]]) dir.children[segs[i]] = { name: segs[i], kind: 'directory', children: {} };
      dir = dir.children[segs[i]];
    }
    dir.children[segs[segs.length - 1]] = { name: segs[segs.length - 1], kind: 'file', mime: entry.mime, bytes: decode(entry.b64) };
  }
  const toHandle = (node) => {
    if (node.kind === 'file') {
      return { name: node.name, kind: 'file', getFile: async () => new File([node.bytes], node.name, { type: node.mime || '' }) };
    }
    const children = {};
    for (const [n, c] of Object.entries(node.children)) children[n] = toHandle(c);
    return {
      name: node.name, kind: 'directory',
      getFileHandle: async (n) => {
        if (!children[n]) throw new DOMException('Not found', 'NotFoundError');
        return children[n];
      },
      getDirectoryHandle: async (n) => {
        if (!children[n]) throw new DOMException('Not a directory', 'TypeMismatchError');
        return children[n];
      },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      [Symbol.asyncIterator]: async function* () {
        for (const [n, h] of Object.entries(children)) yield [n, h];
      },
    };
  };
  window.showDirectoryPicker = async () => toHandle(root);
}`;

/* ── 2. 启动真实扩展 ── */
assert.ok(fs.existsSync(path.join(EXT_DIR, 'manifest.json')), 'dist/chrome 不存在 — 先运行 node chrome/build.js');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const csp = manifest.content_security_policy?.extension_pages || '';
assert.ok(csp.includes("'unsafe-inline'"), 'manifest extension_pages 未包含 unsafe-inline(先重新构建)');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-html-preview-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !HEADED,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    '--disable-default-apps',
    '--allow-file-access-from-files',
  ],
});

async function waitForExtensionId(ctx, profileDir) {
  // 从 Chrome 的扩展注册表里读已加载扩展的 id。新版 Chrome(127+)把
  // extensions.settings 写在 Default/Secure Preferences,旧版在 Preferences。
  // extension_pages 的 SW 是惰性启动的,不能依赖等待 SW。
  const candidates = [
    path.join(profileDir, 'Default', 'Secure Preferences'),
    path.join(profileDir, 'Default', 'Preferences'),
  ];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const file of candidates) {
      try {
        const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
        const settings = prefs?.extensions?.settings || {};
        for (const [id, info] of Object.entries(settings)) {
          // unpacked 扩展不落 manifest.name,按加载路径匹配最可靠
          if (info?.path === EXT_DIR && /^[a-p]{32}$/.test(id)) {
            return id;
          }
        }
      } catch { /* 文件尚未就绪 */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('extension id not found in Secure Preferences/Preferences (timeout 20s)');
}
const extensionId = await waitForExtensionId(context, userDataDir);

/* ── 3. 打开 workspace,进入 PPT 目录 ── */
const page = await context.newPage();
const consoleProblems = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') consoleProblems.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

await page.addInitScript(`(${MOCK_PICKER_JS})(${JSON.stringify({ rootName: 'PPT', files })})`);
await page.goto(`chrome-extension://${extensionId}/ui/workspace/workspace.html`, { waitUntil: 'load' });
await page.click('#pick-directory');
await page.waitForSelector('.tree-item', { timeout: 30000 });

async function clickTreeItem(name) {
  await page.evaluate((target) => {
    const items = [...document.querySelectorAll('.tree-item')];
    const hit = items.find((el) => (el.textContent || '').trim().endsWith(target));
    if (!hit) throw new Error('tree item not found: ' + target);
    hit.click();
  }, name);
}

function previewFrame() {
  // 修复后:HTML 预览在 manifest sandbox 页里(旧实现是 blob: URL)
  return page.frames().find((f) => f.url().includes('html-preview-sandbox')) || null;
}

/** 等待沙箱帧加载并渲染出 deck 内容(用 ?t= 时间戳区分新旧帧) */
async function waitForPreviewFrame(timeoutMs = 20000, previousSrc = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = previewFrame();
    if (frame) {
      const state = await frame.evaluate(() => ({
        href: location.href,
        hasNav: Boolean(document.querySelector('#nav')),
      })).catch(() => null);
      if (state && state.hasNav && state.href !== previousSrc) return frame;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('sandbox preview frame not found');
}

/* ── 4. 断言工具 ── */
async function assertDeckHealthy(frame, label) {
  await frame.waitForSelector('#nav .dot', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1200)); // 等首屏动效/图标

  const before = await frame.evaluate(() => {
    const deck = document.getElementById('deck');
    const dots = [...document.querySelectorAll('#nav .dot')];
    const bg = document.getElementById('bg-grid');
    return {
      dots: dots.length,
      transform: deck ? getComputedStyle(deck).transform : null,
      bgPresent: bg !== null,
      bgSize: bg ? `${bg.width}x${bg.height}` : null,
    };
  });

  // 键盘翻页(合成 keydown,deck 监听在 window 上)
  await frame.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  });
  await new Promise((r) => setTimeout(r, 900));

  const after = await frame.evaluate(() => {
    const deck = document.getElementById('deck');
    const dots = [...document.querySelectorAll('#nav .dot')];
    return {
      active: dots.findIndex((d) => d.classList.contains('active')),
      transform: deck ? getComputedStyle(deck).transform : null,
    };
  });

  const imgs = await frame.evaluate(() =>
    [...document.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src')?.slice(0, 30) || '', ok: i.complete && i.naturalWidth > 0 })));

  const cspErrors = consoleProblems.filter((t) => /content security policy/i.test(t));

  console.log(`\n[${label}]`);
  console.log('  页码指示点      :', before.dots, '(期望 20)');
  console.log('  翻页(按→)      :', before.transform, '→', after.transform, '| 激活点', after.active, '(期望 0→1)');
  console.log('  #bg-grid       :', before.bgPresent ? `存在 ${before.bgSize}(未初始化=脚本没跑)` : '已被JS移除(canvas-mode 设计如此)', '(期望:被JS移除或已初始化)');
  console.log('  图片            :', imgs.filter((i) => i.ok).length, '/', imgs.length, '张加载成功(期望全部)');
  imgs.filter((i) => !i.ok).forEach((i) => console.log('    ✘ 失败:', i.src));
  console.log('  CSP 违规        :', cspErrors.length, '条(期望 0)');
  console.log('  pageerror       :', pageErrors.length, '个(期望 0)', pageErrors[0] || '');

  assert.equal(before.dots, 20, `${label}: 导航点应为 20 个(脚本未执行)`);
  assert.equal(after.active, 1, `${label}: 按→后应切到第 2 页`);
  assert.notEqual(after.transform, before.transform, `${label}: deck transform 应变化`);
  assert.equal(imgs.filter((i) => !i.ok).length, 0, `${label}: 有图片加载失败`);
  assert.equal(cspErrors.length, 0, `${label}: 不应有 CSP 违规`);
  assert.equal(pageErrors.length, 0, `${label}: 不应有未捕获异常`);
}

try {
  // 场景 1:根目录 deck
  await clickTreeItem('government.html');
  const frame1 = await waitForPreviewFrame();
  await assertDeckHealthy(frame1, '场景1 根目录 government.html');
  const frame1Src = frame1.url();

  // 场景 2:嵌套子目录 deck(相对路径应按 sub/ 自身目录解析)
  await clickTreeItem('sub');
  // 等 sub 目录真正展开(树里出现第二个 government.html)再点击
  await page.waitForFunction(
    () => [...document.querySelectorAll('.tree-item')].filter((el) => el.textContent.trim().endsWith('government.html')).length >= 2,
    { timeout: 10000 },
  );
  await clickTreeItem('government.html');
  const frame2 = await waitForPreviewFrame(20000, frame1Src);
  await assertDeckHealthy(frame2, '场景2 嵌套 sub/government.html');

  await page.screenshot({ path: path.join(os.tmpdir(), 'html-preview-fixed.png') });
  console.log('\n✅ 全部通过:HTML 预览修复生效(翻页 / 图片 / 背景 / 无 CSP 违规)');
} finally {
  await context.close();
}
