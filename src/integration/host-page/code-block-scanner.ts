/**
 * Code Block Scanner for host-page diagram rendering
 *
 * Scans a third-party web page for diagram code blocks (PlantUML, Mermaid,
 * Vega, DOT, etc.), renders them via the existing offscreen pipeline, and
 * replaces the original code blocks with rendered images.
 *
 * Lifecycle:
 *   1. scan() — query all matching code blocks, dedup by content hash,
 *      insert loading placeholders.
 *   2. For each block: call renderer.render() → get PNG base64 → replace
 *      placeholder with <img> + collapsible source.
 *   3. MutationObserver watches for SPA-navigated content and re-scans.
 *
 * The scanner is idempotent: re-scanning the same DOM skips elements that
 * are already wrapped (data-mdv-state attribute) or pending.
 */

import type { PluginRenderer, RendererThemeConfig } from '../../types/index';
import {
  buildDiagramBlockSelector,
  resolveRenderType,
  SUPPORTED_HOST_PAGE_LANGUAGES,
} from './language-map';
import {
  injectHostPageStyles,
  createLoadingPlaceholder,
  replaceWithRenderedImage,
  replaceWithError,
} from './dom-replacer';

/**
 * Attribute set on wrapper elements to track render state.
 * Values: 'pending' | 'rendered' | 'error'
 */
const STATE_ATTR = 'data-mdv-state';

/**
 * Attribute carrying the content hash for dedup.
 */
const HASH_ATTR = 'data-mdv-hash';

/**
 * Simple synchronous hash for dedup. Not cryptographic — just needs to be
 * stable for the same input string within a page session.
 */
function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Extract the language identifier from a matched DOM element.
 *
 * The selector matches several shapes; this function normalizes them:
 *   - div.highlight.highlight-source-<lang>  →  read from class
 *   - pre[lang="<lang>"]                     →  read from lang attr
 *   - pre[data-canonical-lang="<lang>"]      →  read from data-canonical-lang attr (GitLab)
 *   - pre > code.language-<lang>             →  read from class
 *   - code.language-<lang>                   →  read from class
 */
function extractLanguage(el: HTMLElement): string | null {
  // Shape 1: div.highlight.highlight-source-<lang>
  if (el.tagName === 'DIV') {
    for (const cls of el.classList) {
      if (cls.startsWith('highlight-source-')) {
        return cls.slice('highlight-source-'.length).toLowerCase();
      }
    }
  }

  // Shape 2: pre[data-canonical-lang="..."] or pre[lang="..."]
  if (el.tagName === 'PRE') {
    // GitLab sets lang="plaintext" and stores the actual language in
    // data-canonical-lang. Check it first so it takes precedence.
    const canonicalLang = el.getAttribute('data-canonical-lang');
    if (canonicalLang) return canonicalLang.toLowerCase();

    const lang = el.getAttribute('lang');
    if (lang) return lang.toLowerCase();

    // pre > code.language-<lang>
    const code = el.querySelector('code[class*="language-"]');
    if (code) {
      for (const cls of code.classList) {
        if (cls.startsWith('language-')) {
          return cls.slice('language-'.length).toLowerCase();
        }
      }
    }
  }

  // Shape 3: code.language-<lang> (bare or inside pre)
  if (el.tagName === 'CODE') {
    for (const cls of el.classList) {
      if (cls.startsWith('language-')) {
        return cls.slice('language-'.length).toLowerCase();
      }
    }
  }

  return null;
}

/**
 * Extract the raw code text from a matched element.
 *
 * For <pre> we use textContent to get the raw code.
 * For <div class="highlight"> we look for the inner <pre> or the text content.
 * For <code> we use textContent directly.
 */
function extractCodeText(el: HTMLElement): string {
  if (el.tagName === 'DIV') {
    // GitHub wraps code in <div class="highlight"> ... <pre> ... </pre>
    const pre = el.querySelector('pre');
    if (pre) return pre.textContent || '';
    return el.textContent || '';
  }

  if (el.tagName === 'PRE') {
    // Some renderers put the code inside a child <code>; textContent on <pre>
    // already includes the child text.
    return el.textContent || '';
  }

  if (el.tagName === 'CODE') {
    return el.textContent || '';
  }

  return el.textContent || '';
}

/**
 * Find the "replacement target" — the outermost element that should be
 * replaced by the rendered image wrapper.
 *
 * GitHub wraps code blocks in one of two wrappers, both of which include
 * a copy button that should be removed together with the code:
 *   - <div class="highlight highlight-source-<lang>">  (syntax-highlighted)
 *   - <div class="snippet-clipboard-content">          (no syntax highlighting)
 *
 * GitLab wraps code blocks in:
 *   - <div class="gl-relative markdown-code-block js-markdown-code">
 *
 * If the matched element is inside such a wrapper, we replace the wrapper
 * so the copy button doesn't remain as an orphan.
 *
 * For bare <code> not wrapped in <pre>, the <code> itself is the target.
 */
function findReplacementTarget(el: HTMLElement): HTMLElement {
  // If matched element is a <code>, walk up to its <pre> first.
  if (el.tagName === 'CODE') {
    const pre = el.closest('pre');
    if (pre) {
      el = pre as HTMLElement;
    }
  }

  // Walk up to the code-block wrapper if present.
  // This covers:
  //   - GitHub: div.highlight, div.snippet-clipboard-content
  //   - GitLab: div.gl-relative.markdown-code-block.js-markdown-code
  const wrapper = el.closest(
    'div.snippet-clipboard-content, div.highlight, .gl-relative.markdown-code-block.js-markdown-code',
  );
  if (wrapper && wrapper.parentElement) {
    return wrapper as HTMLElement;
  }

  return el;
}

/**
 * Detect the page's color scheme for theme-aware rendering.
 *
 * Priority:
 *   1. GitHub: <html data-color-mode="dark|light|auto">
 *   2. Generic: <html data-theme="dark"> / class="dark"
 *   3. Fallback: prefers-color-scheme media query
 */
function detectColorSchema(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';

  const root = document.documentElement;

  // GitHub sets data-color-mode on <html>
  const ghMode = root.getAttribute('data-color-mode');
  if (ghMode === 'dark') return 'dark';
  if (ghMode === 'light') return 'light';
  // GitHub 'auto' → defer to prefers-color-scheme
  if (ghMode === 'auto') {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // Generic dark-mode signals
  if (root.getAttribute('data-theme')?.toLowerCase().includes('dark')) return 'dark';
  if (root.classList.contains('dark')) return 'dark';
  if (root.classList.contains('dark-mode')) return 'dark';

  // Fallback to OS preference
  if (typeof matchMedia === 'function') {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  return 'light';
}

/**
 * Build a RendererThemeConfig from the page's current color scheme.
 * Font family is left undefined so renderers use their defaults — host
 * pages have unpredictable font stacks and we don't want to force a
 * specific font on third-party sites.
 */
function buildThemeConfig(): RendererThemeConfig {
  return {
    colorSchema: detectColorSchema(),
  };
}

/**
 * Options for creating a DiagramCodeBlockScanner.
 */
export interface DiagramScannerOptions {
  /** Plugin renderer (proxies to offscreen render worker). */
  renderer: PluginRenderer;
  /**
   * Optional callback to set the renderer theme config before rendering.
   * If provided, the scanner will call this with the page's detected color
   * scheme before each render batch, and again when the page theme changes.
   */
  setThemeConfig?: (config: RendererThemeConfig) => void;
  /** Root element to scan. Defaults to document.body. */
  root?: HTMLElement;
  /** Whether to enable MutationObserver for SPA navigation. Default true. */
  observe?: boolean;
}

/**
 * Scanner that finds diagram code blocks on a host page and renders them.
 *
 * Usage:
 *   const scanner = createDiagramCodeBlockScanner({ renderer });
 *   scanner.scan();          // initial scan
 *   scanner.rescan();        // re-scan after theme change
 *   scanner.destroy();       // detach observer
 */
export interface DiagramCodeBlockScanner {
  /** Perform an initial scan and start observing. */
  scan(): void;
  /** Re-scan the document, re-rendering all blocks (e.g. after theme change). */
  rescan(): void;
  /** Detach the MutationObserver and release resources. */
  destroy(): void;
}

export function createDiagramCodeBlockScanner(
  options: DiagramScannerOptions,
): DiagramCodeBlockScanner {
  const { renderer, setThemeConfig, root, observe = true } = options;
  const scanRoot = root ?? (typeof document !== 'undefined' ? document.body : null);

  let observer: MutationObserver | null = null;
  let rescanTimer: number | null = null;
  let themeObserver: MutationObserver | null = null;
  let mediaQuery: MediaQueryList | null = null;
  // Track in-flight render hashes to avoid duplicate work during rapid re-scans.
  const inFlight = new Set<string>();

  /**
   * Apply the page's current color scheme to the renderer before rendering.
   */
  function applyPageTheme(): void {
    if (setThemeConfig) {
      setThemeConfig(buildThemeConfig());
    }
  }

  /**
   * Render a single code block.
   * Replaces the original element with a loading placeholder, then calls
   * the renderer and swaps in the final image (or error message).
   */
  async function renderBlock(
    target: HTMLElement,
    renderType: string,
    code: string,
  ): Promise<void> {
    const sourceHash = hashString(`${renderType}:${code}`);

    // Skip if already rendered/pending with the same hash
    const existingState = target.getAttribute(STATE_ATTR);
    const existingHash = target.getAttribute(HASH_ATTR);
    if (existingState && existingHash === sourceHash) {
      return;
    }

    // Skip if this hash is already being rendered elsewhere on the page
    if (inFlight.has(sourceHash)) {
      return;
    }
    inFlight.add(sourceHash);

    // Insert loading placeholder
    const placeholder = createLoadingPlaceholder(renderType, sourceHash);
    target.replaceWith(placeholder);

    try {
      const result = await renderer.render(renderType, code);
      if (!result || !result.base64) {
        replaceWithError(placeholder, renderType, 'Renderer returned empty result', sourceHash);
        return;
      }
      replaceWithRenderedImage(
        placeholder,
        renderType,
        result.base64,
        result.width,
        result.height,
        code,
        sourceHash,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      replaceWithError(placeholder, renderType, message, sourceHash);
    } finally {
      inFlight.delete(sourceHash);
    }
  }

  /**
   * Scan the document for diagram code blocks and render them.
   * Skips elements that are already wrapped (data-mdv-state).
   */
  function performScan(): void {
    if (!scanRoot) return;

    const selector = buildDiagramBlockSelector();
    const matches = scanRoot.querySelectorAll<HTMLElement>(selector);

    for (const el of matches) {
      // Skip if already inside a rendered wrapper
      if (el.closest('.mdv-host-diagram')) continue;

      // Skip if this element is itself a wrapper
      if (el.classList.contains('mdv-host-diagram')) continue;

      const lang = extractLanguage(el);
      if (!lang) continue;

      // Double-check via the language map (selector may over-match)
      if (!SUPPORTED_HOST_PAGE_LANGUAGES.has(lang)) {
        continue;
      }

      const renderType = resolveRenderType(lang);
      if (!renderType) continue;

      const code = extractCodeText(el).trim();
      if (!code) continue;

      const target = findReplacementTarget(el);
      // Skip if target already has a render state
      if (target.hasAttribute(STATE_ATTR)) continue;

      void renderBlock(target, renderType, code);
    }
  }

  /**
   * Re-scan and re-render all blocks. Used after theme changes.
   * Removes existing wrappers and re-renders from the original code.
   */
  function performRescan(): void {
    if (!scanRoot) return;

    // Find all existing wrappers and reset them to re-render.
    // We keep the original code inside <details><pre><code>, so we can
    // extract it and re-render.
    const wrappers = scanRoot.querySelectorAll<HTMLElement>('.mdv-host-diagram');
    for (const wrapper of wrappers) {
      const renderType = wrapper.dataset.mdvLang;
      if (!renderType) continue;

      // Extract original code from the preserved <details><pre><code>
      const codeEl = wrapper.querySelector('.mdv-host-diagram__source pre code');
      const code = codeEl?.textContent?.trim() || '';
      if (!code) continue;

      // Reset state and re-render
      wrapper.removeAttribute(STATE_ATTR);
      void renderBlock(wrapper, renderType, code);
    }

    // Also scan for any new blocks that appeared since last scan
    performScan();
  }

  function scan(): void {
    injectHostPageStyles();
    applyPageTheme();
    performScan();

    if (observe && scanRoot && !observer) {
      observer = new MutationObserver(() => {
        // Debounce — GitHub's pjax can fire many mutations in quick succession.
        if (rescanTimer !== null) return;
        rescanTimer = window.setTimeout(() => {
          rescanTimer = null;
          performScan();
        }, 200);
      });
      observer.observe(scanRoot, { childList: true, subtree: true });
    }

    // Watch for page theme changes (GitHub data-color-mode, OS preference).
    startThemeWatcher();
  }

  /**
   * Watch for theme changes on the page and re-render when they occur.
   * - GitHub: <html data-color-mode> attribute changes
   * - OS: prefers-color-scheme media query changes
   */
  function startThemeWatcher(): void {
    if (themeObserver || mediaQuery) return; // already watching
    if (typeof document === 'undefined') return;

    // Watch <html> attribute changes (GitHub toggles data-color-mode)
    themeObserver = new MutationObserver(() => {
      applyPageTheme();
      performRescan();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-mode', 'data-theme', 'class'],
    });

    // Watch OS-level dark mode toggle
    if (typeof matchMedia === 'function') {
      mediaQuery = matchMedia('(prefers-color-scheme: dark)');
      const handler = (): void => {
        applyPageTheme();
        performRescan();
      };
      // addEventListener is standard; addListener is the deprecated Safari fallback.
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handler);
      } else if (typeof (mediaQuery as MediaQueryList).addListener === 'function') {
        (mediaQuery as MediaQueryList).addListener(handler);
      }
    }
  }

  function rescan(): void {
    applyPageTheme();
    performRescan();
  }

  function destroy(): void {
    if (rescanTimer !== null) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    observer?.disconnect();
    observer = null;
    themeObserver?.disconnect();
    themeObserver = null;
    mediaQuery = null;
  }

  return { scan, rescan, destroy };
}
