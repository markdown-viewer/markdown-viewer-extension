/**
 * DOM Replacer for host-page diagram code blocks
 *
 * Replaces a diagram code block on a third-party page with the rendered
 * image, while preserving the original source in a collapsible <details>.
 *
 * The replacement structure:
 *
 *   <div class="mdv-host-diagram" data-mdv-lang="plantuml">
 *     <div class="mdv-host-diagram__image">
 *       <img src="data:image/png;base64,..." alt="plantuml diagram" />
 *     </div>
 *     <details class="mdv-host-diagram__source">
 *       <summary>Source</summary>
 *       <pre><code>...original code...</code></pre>
 *     </details>
 *   </div>
 *
 * Design notes:
 *   - We keep the original <pre> inside <details> so users can copy the
 *     source and so page-level "copy code" buttons still work.
 *   - The wrapper carries data attributes for re-scanning dedup and for
 *     theme re-render.
 *   - Styles are injected once per document via injectHostPageStyles().
 */

const HOST_PAGE_STYLE_ID = 'mdv-host-page-diagram-style';

/**
 * CSS injected into the host page to style rendered diagrams.
 * Kept minimal and self-contained to avoid clashing with site styles.
 */
const HOST_PAGE_STYLE_CSS = `
.mdv-host-diagram {
  margin: 16px 0;
  border: 1px solid var(--border-color, #d0d7de);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-color, #ffffff);
}
.mdv-host-diagram__image {
  padding: 16px;
  text-align: center;
  background: transparent;
}
.mdv-host-diagram__image img {
  max-width: 100%;
  height: auto;
}
.mdv-host-diagram__source {
  border-top: 1px solid var(--border-color, #d0d7de);
  background: var(--bg-color-muted, #f6f8fa);
}
.mdv-host-diagram__source summary {
  padding: 8px 16px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fg-color-muted, #57606a);
  user-select: none;
}
.mdv-host-diagram__source summary:hover {
  background: var(--bg-color-hover, #eaeef2);
}
.mdv-host-diagram__source pre {
  margin: 0;
  padding: 12px 16px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: transparent;
  border: 0;
}
.mdv-host-diagram__error {
  padding: 12px 16px;
  background: #ffeef0;
  color: #82071e;
  border-left: 4px solid #ff7b72;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.mdv-host-diagram__loading {
  padding: 24px;
  text-align: center;
  color: var(--fg-color-muted, #57606a);
  font-size: 13px;
}
.mdv-host-diagram__loading::before {
  content: "";
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-right: 8px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  vertical-align: middle;
  animation: mdv-host-spin 0.8s linear infinite;
}
@keyframes mdv-host-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-color-scheme: dark) {
  .mdv-host-diagram {
    border-color: var(--border-color, #30363d);
    background: var(--bg-color, #0d1117);
  }
  .mdv-host-diagram__source {
    border-color: var(--border-color, #30363d);
    background: var(--bg-color-muted, #161b22);
  }
  .mdv-host-diagram__source summary {
    color: var(--fg-color-muted, #8b949e);
  }
  .mdv-host-diagram__source summary:hover {
    background: var(--bg-color-hover, #21262d);
  }
  .mdv-host-diagram__loading {
    color: var(--fg-color-muted, #8b949e);
  }
}
`;

/**
 * Inject the host-page diagram styles into the document head.
 * Idempotent — safe to call multiple times.
 */
export function injectHostPageStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(HOST_PAGE_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = HOST_PAGE_STYLE_ID;
  style.textContent = HOST_PAGE_STYLE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Escape HTML special characters in a string.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Create the loading placeholder that replaces the code block while
 * rendering is in progress. The placeholder carries the same data
 * attributes as the final replacement so the scanner can find it.
 */
export function createLoadingPlaceholder(
  renderType: string,
  sourceHash: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'mdv-host-diagram mdv-host-diagram--loading';
  wrapper.dataset.mdvLang = renderType;
  wrapper.dataset.mdvHash = sourceHash;
  wrapper.dataset.mdvState = 'pending';

  const loading = document.createElement('div');
  loading.className = 'mdv-host-diagram__loading';
  loading.textContent = `Rendering ${renderType}...`;
  wrapper.appendChild(loading);

  return wrapper;
}

/**
 * Replace a loading placeholder (or original code block) with the rendered
 * image and a collapsible source viewer.
 *
 * @param target - The placeholder element or original code block to replace
 * @param renderType - Internal render type (e.g. 'plantuml')
 * @param base64 - PNG base64 data (without data: prefix)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param originalCode - Original source code to preserve in <details>
 * @param sourceHash - Content hash for dedup
 */
export function replaceWithRenderedImage(
  target: HTMLElement,
  renderType: string,
  base64: string,
  width: number,
  height: number,
  originalCode: string,
  sourceHash: string,
): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'mdv-host-diagram';
  wrapper.dataset.mdvLang = renderType;
  wrapper.dataset.mdvHash = sourceHash;
  wrapper.dataset.mdvState = 'rendered';

  // Image container
  const imageBox = document.createElement('div');
  imageBox.className = 'mdv-host-diagram__image';

  const img = document.createElement('img');
  img.src = `data:image/png;base64,${base64}`;
  img.alt = `${renderType} diagram`;
  // Renderer outputs PNG at 4x for retina sharpness; display at 1/4.
  const displayWidth = Math.round(width / 4);
  if (displayWidth > 0) {
    img.style.width = `${displayWidth}px`;
  }
  img.style.maxWidth = '100%';
  img.style.height = 'auto';
  imageBox.appendChild(img);

  wrapper.appendChild(imageBox);

  // Collapsible source
  const details = document.createElement('details');
  details.className = 'mdv-host-diagram__source';

  const summary = document.createElement('summary');
  summary.textContent = 'Source';
  details.appendChild(summary);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = originalCode;
  pre.appendChild(code);
  details.appendChild(pre);

  wrapper.appendChild(details);

  target.replaceWith(wrapper);
}

/**
 * Replace a loading placeholder with an error message.
 *
 * @param target - The placeholder element to replace
 * @param renderType - Internal render type
 * @param errorMessage - Error message to display
 * @param sourceHash - Content hash for dedup
 */
export function replaceWithError(
  target: HTMLElement,
  renderType: string,
  errorMessage: string,
  sourceHash: string,
): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'mdv-host-diagram';
  wrapper.dataset.mdvLang = renderType;
  wrapper.dataset.mdvHash = sourceHash;
  wrapper.dataset.mdvState = 'error';

  const errorBox = document.createElement('div');
  errorBox.className = 'mdv-host-diagram__error';
  errorBox.textContent = `${renderType} render failed: ${errorMessage}`;
  wrapper.appendChild(errorBox);

  target.replaceWith(wrapper);
}
