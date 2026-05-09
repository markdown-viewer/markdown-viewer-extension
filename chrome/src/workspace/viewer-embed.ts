// Embedded viewer for workspace mode
// Receives file content via postMessage, then runs the full viewer pipeline

import { platform } from '../webview/index';
import { startViewer } from '../webview/viewer-main';
import { initializeViewerBase } from '../../../src/core/viewer/viewer-bootstrap';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';
import { applyCodeViewPresentation } from '../../../src/utils/code-preview';
import { createTocPanel } from '../../../src/ui/toc-panel';
import type { TocPanel } from '../../../src/ui/toc-panel';
import { extractHeadings } from '../../../src/core/markdown-utils';

interface RenderFileMessage {
  type: 'RENDER_FILE';
  content?: string;
  filename?: string;
  fileDir?: string;
  codeView?: boolean;
}

interface SetEmbedUiMessage {
  type: 'SET_EMBED_UI';
  toc?: 'none' | 'sidebar' | 'floating';
  tocDepth?: number;
}

interface ScrollAnchorMessage {
  type: 'SCROLL_TO_ANCHOR';
  anchor?: string;
}

interface SetThemeMessage {
  type: 'SET_THEME';
  themeId?: string;
}

interface WorkspaceLayoutChangedMessage {
  type: 'WORKSPACE_LAYOUT_CHANGED';
}

type ViewerEmbedMessage = RenderFileMessage | SetEmbedUiMessage | ScrollAnchorMessage | SetThemeMessage | WorkspaceLayoutChangedMessage;

let initialized = false;
let latestFileDir = '';
let latestEmbedUi: SetEmbedUiMessage = {
  type: 'SET_EMBED_UI',
};
const EMBED_MODE = new URLSearchParams(window.location.search).get('embed') === '1';

// Floating TOC panel (for toc='floating' mode)
let floatingTocPanel: TocPanel | null = null;
let floatingScrollListener: (() => void) | null = null;
let floatingContentObserver: MutationObserver | null = null;
let floatingUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let resizeWheelFallbackArmed = false;
let wrapperInteractionFixesAttached = false;
let handlingManualWheelScroll = false;

// Inject embed-mode CSS when loaded with ?embed=1 (from element.ts custom element iframe).
// This hides the toolbar and shifts the TOC panel up so it fills the full iframe height.
// In workspace-preview context (no ?embed=1 param) nothing is injected and the native
// toolbar + TOC layout is preserved.
if (EMBED_MODE) {
  // Mark body so that internal TOC manager skips its saved-state restoration.
  document.body.dataset.mvEmbed = '1';

  const style = document.createElement('style');
  style.id = 'embed-mode-styles';
  style.textContent = [
    '#page-header { display: none !important; }',
    '#table-of-contents { top: 0 !important; height: 100vh !important; }',
    'body.toc-hidden #markdown-wrapper { margin-left: 0 !important; margin-right: 0 !important; }',
    'body:not(.toc-hidden) #markdown-wrapper { margin-left: 280px !important; margin-right: 0 !important; }',
    'body.toc-position-right:not(.toc-hidden) #markdown-wrapper { margin-left: 0 !important; margin-right: 280px !important; }',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

// ─── Floating TOC panel helpers ─────────────────────────────────────────────

function scrollToHeadingById(headingId: string): void {
  const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
  const target = document.getElementById(headingId) as HTMLElement | null;
  if (!wrapper || !target) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  wrapper.scrollTo({ top: Math.max(0, targetRect.top - wrapperRect.top + wrapper.scrollTop), behavior: 'smooth' });
}

function updateFloatingTocActiveHeading(): void {
  if (!floatingTocPanel) return;
  const contentDiv = document.getElementById('markdown-content');
  const wrapper = document.getElementById('markdown-wrapper');
  if (!contentDiv || !wrapper) { floatingTocPanel.setActiveHeading(null); return; }

  const headings = contentDiv.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
  if (headings.length === 0) { floatingTocPanel.setActiveHeading(null); return; }

  const scrollTop = wrapper.scrollTop;
  const wrapperRect = wrapper.getBoundingClientRect();
  let activeId: string | null = null;
  for (const heading of headings) {
    const top = heading.getBoundingClientRect().top - wrapperRect.top + scrollTop;
    if (top <= scrollTop + 10) activeId = heading.id || null;
    else break;
  }
  if (!activeId && headings[0]) activeId = headings[0].id || null;
  floatingTocPanel.setActiveHeading(activeId);
}

function updateFloatingTocHeadings(): void {
  if (!floatingTocPanel) return;
  const contentDiv = document.getElementById('markdown-content');
  if (!contentDiv) return;
  const maxDepth = typeof latestEmbedUi.tocDepth === 'number' && Number.isFinite(latestEmbedUi.tocDepth)
    ? Math.max(1, Math.min(6, Math.floor(latestEmbedUi.tocDepth)))
    : 6;
  const all = extractHeadings(contentDiv);
  floatingTocPanel.setHeadings(all.filter(h => h.level <= maxDepth));
  updateFloatingTocActiveHeading();
}

function scheduleFloatingTocHeadingsUpdate(): void {
  if (!floatingTocPanel) return;
  if (floatingUpdateTimer !== null) clearTimeout(floatingUpdateTimer);
  floatingUpdateTimer = setTimeout(() => {
    floatingUpdateTimer = null;
    updateFloatingTocHeadings();
  }, 150);
}

function ensureFloatingTocPanel(): TocPanel {
  if (!floatingTocPanel) {
    floatingTocPanel = createTocPanel({ onSelectHeading: scrollToHeadingById });
    document.body.appendChild(floatingTocPanel.getElement());

    const wrapper = document.getElementById('markdown-wrapper');
    if (wrapper && !floatingScrollListener) {
      floatingScrollListener = () => updateFloatingTocActiveHeading();
      wrapper.addEventListener('scroll', floatingScrollListener);
    }

    // Watch content for heading changes (progressive render)
    const contentDiv = document.getElementById('markdown-content');
    if (contentDiv && !floatingContentObserver) {
      floatingContentObserver = new MutationObserver(() => scheduleFloatingTocHeadingsUpdate());
      floatingContentObserver.observe(contentDiv, { childList: true, subtree: true });
    }
  }
  return floatingTocPanel;
}

function destroyFloatingTocPanel(): void {
  if (floatingUpdateTimer !== null) { clearTimeout(floatingUpdateTimer); floatingUpdateTimer = null; }
  if (floatingContentObserver) { floatingContentObserver.disconnect(); floatingContentObserver = null; }
  if (floatingScrollListener) {
    document.getElementById('markdown-wrapper')?.removeEventListener('scroll', floatingScrollListener);
    floatingScrollListener = null;
  }
  if (floatingTocPanel) { floatingTocPanel.dispose(); floatingTocPanel = null; }
}

function normalizeWheelDelta(event: WheelEvent, wrapper: HTMLElement): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * wrapper.clientHeight;
  }
  return event.deltaY;
}

function focusWrapperAfterLayoutChange(): void {
  const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
  if (!wrapper) {
    return;
  }

  if (!wrapper.hasAttribute('tabindex')) {
    wrapper.tabIndex = -1;
  }

  window.focus();
  wrapper.focus({ preventScroll: true });
}

function attachWrapperInteractionFixes(): void {
  const install = () => {
    const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
    if (!wrapper || wrapperInteractionFixesAttached) {
      return;
    }

    wrapperInteractionFixesAttached = true;

    wrapper.addEventListener('scroll', () => {
      if (handlingManualWheelScroll) {
        handlingManualWheelScroll = false;
        return;
      }

      resizeWheelFallbackArmed = false;
    }, { passive: true });

    wrapper.addEventListener('wheel', (event) => {
      if (!resizeWheelFallbackArmed) {
        return;
      }

      if (event.defaultPrevented || event.ctrlKey || event.metaKey) {
        return;
      }

      const maxScrollTop = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
      if (maxScrollTop <= 0) {
        return;
      }

      const beforeScrollTop = wrapper.scrollTop;
      const nextScrollTop = Math.max(
        0,
        Math.min(maxScrollTop, beforeScrollTop + normalizeWheelDelta(event, wrapper))
      );

      if (Math.abs(nextScrollTop - beforeScrollTop) < 0.5) {
        return;
      }

      event.preventDefault();
      handlingManualWheelScroll = true;
      wrapper.scrollTop = nextScrollTop;
    }, { passive: false });
  };

  requestAnimationFrame(install);
  window.setTimeout(install, 150);
}

// ─── Apply embed UI ─────────────────────────────────────────────────────────

function applyEmbedUi(message: SetEmbedUiMessage): void {
  latestEmbedUi = {
    ...latestEmbedUi,
    ...message,
    type: 'SET_EMBED_UI',
  };

  const tocDiv = document.getElementById('table-of-contents') as HTMLElement | null;
  const overlayDiv = document.getElementById('toc-overlay') as HTMLElement | null;
  const tocMode = latestEmbedUi.toc;

  if (tocMode === 'floating') {
    // Hide sidebar TOC; use full-width layout (toc-hidden = no sidebar margin)
    if (tocDiv) { tocDiv.classList.add('hidden'); tocDiv.style.display = 'none'; }
    document.body.classList.add('toc-hidden');
    if (overlayDiv) overlayDiv.classList.add('hidden');
    // Mount floating FAB panel and seed headings
    ensureFloatingTocPanel();
    updateFloatingTocHeadings();
  } else if (tocMode === 'sidebar') {
    // Remove floating panel, restore sidebar
    destroyFloatingTocPanel();
    if (tocDiv) {
      tocDiv.classList.remove('hidden');
      tocDiv.style.display = '';
    }
    document.body.classList.remove('toc-hidden');
    if (overlayDiv) overlayDiv.classList.add('hidden');
    // Apply depth filter to existing sidebar items
    if (tocDiv && typeof latestEmbedUi.tocDepth === 'number' && Number.isFinite(latestEmbedUi.tocDepth)) {
      const maxDepth = Math.max(1, Math.min(6, Math.floor(latestEmbedUi.tocDepth)));
      tocDiv.querySelectorAll('li').forEach((item) => {
        const marginLeft = Number.parseInt((item as HTMLElement).style.marginLeft || '0', 10);
        const level = Math.floor(marginLeft / 20) + 1;
        (item as HTMLElement).style.display = level > maxDepth ? 'none' : '';
      });
    }
  } else {
    // none — hide everything
    destroyFloatingTocPanel();
    if (tocDiv) { tocDiv.classList.add('hidden'); tocDiv.style.display = 'none'; }
    document.body.classList.add('toc-hidden');
  }
}

function scrollToAnchor(anchor: string): void {
  const normalized = decodeURIComponent(anchor || '').replace(/^#/, '').trim();
  if (!normalized) return;

  const target = document.getElementById(normalized);
  if (!target) return;

  const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
  if (!wrapper) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const containerRect = wrapper.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = targetRect.top - containerRect.top + wrapper.scrollTop;
  wrapper.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

async function renderFile(message: RenderFileMessage): Promise<void> {
  const content = String(message.content || '');
  const filename = String(message.filename || 'inline.md');
  const fileDir = String(message.fileDir || '');
  const codeView = Boolean(message.codeView);
  latestFileDir = fileDir;

  // Note: #markdown-viewer-preload style is now injected statically in
  // viewer-embed.html so the body stays hidden from first paint (before JS
  // even runs). viewer-main will remove it after the theme is applied.

  // Simulate how Chrome opens a plain text file:
  // body contains raw text inside a <pre> element
  if (!initialized) {
    document.body.textContent = content;
  }

  // Override location-based URL detection by setting a data attribute
  // so the viewer can determine file type from filename
  document.documentElement.dataset.viewerFilename = filename;
  document.documentElement.dataset.viewerFilePath = `${fileDir || ''}${filename}`;

  applyCodeViewPresentation(codeView);

  if (!initialized) {
    await initializeViewerBase(platform).then((pluginRenderer) => {
      startViewer({
        platform,
        pluginRenderer,
        themeConfigRenderer: platform.renderer,
      });
      initialized = true;
      attachWrapperInteractionFixes();
    }).catch((error) => {
      console.error('[viewer-embed] viewer base init failed', error);
    });
  } else {
    const viewer = document.querySelector('markdown-viewer') as { render?: (markdown: string) => Promise<void> } | null;
    if (viewer?.render) {
      await viewer.render(content);
    }
  }

  // Resolve relative images via parent workspace
  if (fileDir !== undefined) {
    resolveWorkspaceImages(fileDir);
    setupWorkspaceFileReader();
  }

  // The initial bootstrap path may reset document.body content.
  // Re-apply embed UI so floating TOC/FAB state stays consistent after render.
  applyEmbedUi(latestEmbedUi);

  window.parent.postMessage({ type: 'VIEWER_RENDERED' }, '*');
}

// Wait for commands from parent host.
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as ViewerEmbedMessage | undefined;
  if (!data || typeof data !== 'object' || !('type' in data)) {
    return;
  }

  if (data.type === 'RENDER_FILE') {
    void renderFile(data);
    return;
  }

  if (data.type === 'SET_EMBED_UI') {
    applyEmbedUi(data);
    return;
  }

  if (data.type === 'SCROLL_TO_ANCHOR') {
    if (data.anchor) {
      scrollToAnchor(data.anchor);
    }
    return;
  }

  if (data.type === 'SET_THEME') {
    if (data.themeId) {
      void loadAndApplyTheme(data.themeId);
    }
    return;
  }

  if (data.type === 'WORKSPACE_LAYOUT_CHANGED') {
    resizeWheelFallbackArmed = true;
    requestAnimationFrame(() => {
      focusWrapperAfterLayoutChange();
    });
  }
});

// ─── Resolve relative images via parent workspace ───
function isRelativeSrc(src: string): boolean {
  return !!src && !src.startsWith('http://') && !src.startsWith('https://') &&
    !src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('file:') &&
    !src.includes('://');
}

function resolveWorkspaceImages(fileDir: string) {
  let idCounter = 0;
  const pending = new Map<number, HTMLImageElement>();

  // Listen for resolved blob URLs from parent
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'IMAGE_RESOLVED') return;
    const img = pending.get(e.data.id);
    if (img) {
      img.src = e.data.url;
      pending.delete(e.data.id);
    }
  });

  function requestImage(img: HTMLImageElement) {
    const src = img.getAttribute('src');
    if (!src || !isRelativeSrc(src)) return;
    const id = ++idCounter;
    pending.set(id, img);
    window.parent.postMessage({ type: 'RESOLVE_IMAGE', src, id }, '*');
  }

  // Watch for img elements added by the rendering pipeline
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLImageElement) {
          requestImage(node);
        } else if (node instanceof HTMLElement) {
          for (const img of node.querySelectorAll<HTMLImageElement>('img')) {
            requestImage(img);
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also handle images already in the DOM
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    requestImage(img);
  }
}

// ─── Workspace file reader (for readRelativeFile in workspace mode) ───
function setupWorkspaceFileReader() {
  const documentService = platform.document as import('../webview/api-impl').ChromeDocumentService;
  let idCounter = 0;
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'FILE_RESOLVED') return;
    const entry = pending.get(e.data.id);
    if (entry) {
      pending.delete(e.data.id);
      if (e.data.error) {
        entry.reject(new Error(e.data.error));
      } else {
        entry.resolve(e.data.content);
      }
    }
  });

  documentService.setWorkspaceFileReader((relativePath: string, binary: boolean) => {
    return new Promise((resolve, reject) => {
      const id = ++idCounter;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ type: 'RESOLVE_FILE', path: relativePath, id, binary }, '*');
    });
  });
}

// Notify parent that the viewer frame is ready to receive content
window.parent.postMessage({ type: 'VIEWER_READY' }, '*');
