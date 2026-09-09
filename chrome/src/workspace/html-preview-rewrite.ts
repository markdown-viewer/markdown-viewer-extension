/**
 * HTML 文件预览改写(workspace 模式专用)
 *
 * 背景:workspace 用 iframe 预览本地 .html 文件时,内容由 manifest 声明的
 * sandbox 页承载(独立 CSP,放行 unsafe-inline,内联脚本可执行)。但 sandbox
 * 页 origin 为 null,无法加载扩展页创建的 blob: URL(被当作本地资源禁止),
 * 也无法解析相对路径 —— 所以本地资源一律改写为 data: URL,随 HTML 一起
 * 交给沙箱页渲染,不依赖任何 origin 权限。
 *
 * 本模块负责改写:解析 HTML,把所有本地相对/根相对资源 URL(src/href/内联
 * style url())读取为 data: URL(通过 File System Access API 句柄读取兄弟
 * 文件)。远程 URL(http/https/data:/mailto:/tel:/javascript:/#fragment)
 * 原样保留;越出 workspace 根目录的相对路径(../ 逃逸)放弃改写。
 *
 * 限制(预览语义,非缺陷):
 *   - <script src="本地.js"> 不会加载:script-src 不放行 data: URL,
 *     内联脚本才是沙箱里的正路(单文件 deck 都是内联)
 *   - <a href="other.html"> 跳转后其内部相对链接失去目录上下文
 *   - <img srcset> 不处理(本地 deck 极少使用)
 *   - file:// 绝对路径无法通过句柄解析,原样保留
 */

export type PreviewResourceResolver = (relativePath: string) => Promise<File | null>;

export interface HtmlPreviewRewriteResult {
  html: string;
  revoke: () => void; // data: URL 无需回收,保留接口以兼容调用方
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  txt: 'text/plain',
};

/** 需要改写的「标签 + 属性」组合 */
const URL_ATTRS: ReadonlyArray<readonly [string, string]> = [
  ['img', 'src'],
  ['script', 'src'],
  ['link', 'href'],
  ['iframe', 'src'],
  ['source', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['input', 'src'],
  ['embed', 'src'],
  ['object', 'data'],
  ['a', 'href'],
  ['area', 'href'],
];

const SKIP_SCHEMES = /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|about:|#)/i;
const SKIP_PROTOCOL_RELATIVE = /^\/\//;

function mimeForFile(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] || '';
}

/**
 * 改写 HTML 中所有本地资源引用为 blob: URL。
 * @param html        原始 HTML 文本
 * @param resolveFile 给定「已解析到 workspace 根目录内的相对路径」返回 File;
 *                    返回 null 表示文件不存在(保留原 URL)
 */
export async function rewriteHtmlForPreview(
  html: string,
  resolveFile: PreviewResourceResolver,
): Promise<HtmlPreviewRewriteResult> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('parsererror')) {
    // 解析失败(罕见),原样返回
    return { html, revoke: () => { /* noop */ } };
  }

  const createdUrls: string[] = [];
  const blobByRel = new Map<string, string | null>();
  const pending: Promise<void>[] = [];

  /** 二进制 → base64(data: URL 用;分块避免大文件爆调用栈) */
  function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function toDataUrl(rel: string): Promise<string | null> {
    if (blobByRel.has(rel)) return blobByRel.get(rel) ?? null;
    let file: File | null = null;
    try {
      file = await resolveFile(rel);
    } catch {
      file = null;
    }
    if (!file) {
      blobByRel.set(rel, null);
      return null;
    }
    const mime = file.type || mimeForFile(file.name) || 'application/octet-stream';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = `data:${mime};base64,${toBase64(bytes)}`;
    blobByRel.set(rel, url);
    return url;
  }

  // ── 1. 标签属性(img/src/script/src/link/href …) ──
  for (const [tag, attr] of URL_ATTRS) {
    const elements = doc.querySelectorAll(`${tag}[${attr}]`);
    for (const el of elements) {
      const raw = (el.getAttribute(attr) || '').trim();
      if (!raw || SKIP_SCHEMES.test(raw) || SKIP_PROTOCOL_RELATIVE.test(raw)) {
        continue; // 空 / 远程 / data: / blob: / 锚点 / 协议相对 → 原样保留
      }
      let rel = raw;
      if (rel.startsWith('/')) rel = rel.slice(1); // 站点根相对 → workspace 根
      pending.push(
        toDataUrl(rel).then((dataUrl) => {
          if (dataUrl) el.setAttribute(attr, dataUrl);
        }),
      );
    }
  }

  // ── 2. 内联 style 属性 + <style> 块里的 url(...) ──
  const STYLE_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  async function rewriteStyleText(css: string): Promise<string> {
    const matches = [...css.matchAll(STYLE_URL_RE)];
    if (matches.length === 0) return css;
    let out = css;
    for (const m of matches) {
      const raw = m[2].trim();
      if (!raw || SKIP_SCHEMES.test(raw) || SKIP_PROTOCOL_RELATIVE.test(raw) || raw.startsWith('/')) continue;
      const dataUrl = await toDataUrl(raw);
      if (dataUrl) out = out.replace(m[0], `url(${dataUrl})`);
    }
    return out;
  }

  const styledElements = [...doc.querySelectorAll('[style]')];
  for (const el of styledElements) {
    const attr = el.getAttribute('style');
    if (attr) {
      pending.push(
        rewriteStyleText(attr).then((out) => {
          if (out !== attr) el.setAttribute('style', out);
        }),
      );
    }
  }
  for (const styleEl of doc.querySelectorAll('style')) {
    const css = styleEl.textContent || '';
    pending.push(
      rewriteStyleText(css).then((out) => {
        if (out !== css) styleEl.textContent = out;
      }),
    );
  }

  // ── 3. 移除 <base>:改写完的文档里它只会让后续相对 URL 解析错乱 ──
  doc.querySelectorAll('base').forEach((el) => el.remove());

  await Promise.all(pending);

  return {
    // 用 HTML 序列化而非 XMLSerializer:后者会把 script/style 里的 `<`、`&`
    // 转义成 &lt;/&amp;,沙箱页再解析时脚本内容损坏(SyntaxError)
    html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML,
    revoke: () => {
      // data: URL 无需回收(仅保留接口以兼容调用方)
      blobByRel.clear();
      createdUrls.length = 0;
    },
  };
}
