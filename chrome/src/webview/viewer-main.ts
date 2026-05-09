/**
 * Shared Viewer Main Controller
 * 
 * This module contains the shared logic for initializing the Markdown viewer.
 * Both Chrome and Firefox extensions use this module with platform-specific renderers.
 */

import DocxExporter from '../../../src/exporters/docx-exporter';
import Localization, { DEFAULT_SETTING_LOCALE } from '../../../src/utils/localization';
import themeManager from '../../../src/utils/theme-manager';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';
import { wrapFileContent } from '../../../src/utils/file-wrapper';
import { buildCodeReadingRender, applyCodeViewPresentation, toFencedCode } from '../../../src/utils/code-preview';
import { initSlidevViewer } from '../../../src/slidev/slidev-viewer';
import { getWebExtensionApi } from '../../../src/utils/platform-info';

import type { PluginRenderer, RendererThemeConfig, PlatformAPI } from '../../../src/types/index';

import { escapeHtml } from '../../../src/core/markdown-utils';
import { getCurrentDocumentUrl, saveToHistory } from '../../../src/core/document-utils';
import type { FileState } from '../../../src/types/core';
import type { MarkdownViewerElement } from '../../../src/integration/types';
import { showProcessingIndicator, hideProcessingIndicator } from './ui/progress-indicator';
import { createTocManager } from './ui/toc-manager';
import { createGitbookPanel } from './ui/gitbook-panel';
import { createToolbarManager, generateToolbarHTML, layoutIcons } from './ui/toolbar';

// Import shared utilities from viewer-host
import {
  createMountedViewer,
  type MountedViewerController,
  setCurrentFileKey,
} from '../../../src/core/viewer/viewer-host';
import { setupImageContextMenu } from '../../../src/ui/image-context-menu';

// Extend Window interface for global access
declare global {
  interface Window {
    docxExporter: DocxExporter;
    /** Set by html-to-markdown.ts when the current tab is a rendered HTML page */
    __mvHtmlConvertedMarkdown?: {
      markdown: string;
      title: string;
      url: string;
    };
  }
}

/**
 * Layout configuration
 */
interface LayoutConfig {
  maxWidth: string;
  icon: string;
  title: string;
}

/**
 * Layout titles interface
 */
interface LayoutTitles {
  normal: string;
  fullscreen: string;
  narrow: string;
}

/**
 * Layout configurations map
 */
interface LayoutConfigs {
  normal: LayoutConfig;
  fullscreen: LayoutConfig;
  narrow: LayoutConfig;
}

/**
 * Renderer interface for theme configuration
 */
interface ThemeConfigurable {
  setThemeConfig(config: RendererThemeConfig): void;
}

/**
 * Options for initializing the viewer
 */
export interface ViewerMainOptions {
  /** Platform API instance */
  platform: PlatformAPI;
  /** Plugin renderer for rendering diagrams */
  pluginRenderer: PluginRenderer;
  /** Optional renderer that supports theme configuration */
  themeConfigRenderer?: ThemeConfigurable;
}

/**
 * Incoming message from background (broadcast events)
 */
interface IncomingBroadcastMessage {
  type?: string;
  payload?: unknown;
}

/**
 * Initialize the viewer with platform-specific options
 */
export async function initializeViewerMain(options: ViewerMainOptions): Promise<void> {
  const { platform, pluginRenderer, themeConfigRenderer } = options;

  const webExtensionApi = getWebExtensionApi();
  const isMobile = platform.platform === 'mobile';
  const MIN_SIDEBAR_WIDTH = 160;
  const MAX_SIDEBAR_WIDTH = 560;
  let syncResizeHandlePosition: (() => void) | null = null;

  function constrainSidebarWidth(width: number): number {
    const maxWidth = Math.min(window.innerWidth * 0.5, MAX_SIDEBAR_WIDTH);
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, width));
  }

  async function getStoredSidebarWidth(): Promise<number | null> {
    try {
      const value = await platform.settings.get('readerSidebarWidth');
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  async function setStoredSidebarWidth(value: number): Promise<void> {
    try {
      await platform.settings.set('readerSidebarWidth', value);
    } catch {
      // Ignore persistence failures to avoid blocking resize behavior.
    }
  }

  function applyTocPanelSide(swapped: boolean): void {
    document.body.classList.toggle('toc-position-right', swapped);
    document.body.classList.toggle('gitbook-sidebar-left', swapped);

    const toggleTocBtn = document.getElementById('toggle-toc-btn');
    const toolbarLeft = document.querySelector('.toolbar-left');
    const toolbarRight = document.querySelector('.toolbar-right');

    if (!toggleTocBtn || !toolbarLeft || !toolbarRight) {
      return;
    }

    if (swapped) {
      toolbarRight.prepend(toggleTocBtn);
    } else {
      toolbarLeft.prepend(toggleTocBtn);
    }

    syncResizeHandlePosition?.();
  }

  async function initGitbookSidebarResize(): Promise<void> {
    if (isMobile) {
      return;
    }

    const sidebar = document.getElementById('gitbook-sidebar-body') as HTMLElement | null;
    const sidebarHeader = document.getElementById('gitbook-sidebar-header') as HTMLElement | null;
    const resizeHandle = document.getElementById('gitbook-resize-handle') as HTMLElement | null;

    if (!sidebar || !resizeHandle) {
      return;
    }

    const pageContent = document.getElementById('page-content') as HTMLElement | null;
    if (!pageContent) {
      return;
    }

    const updateResizeHandlePosition = (): void => {
      const contentWidth = pageContent.clientWidth;
      const sidebarWidth = sidebar.offsetWidth;
      const handleWidth = resizeHandle.offsetWidth || 4;

      if (contentWidth <= 0 || sidebarWidth <= 0) {
        return;
      }

      const isSidebarLeft = document.body.classList.contains('gitbook-sidebar-left');
      const seamX = isSidebarLeft ? sidebarWidth : contentWidth - sidebarWidth;
      const handleLeft = Math.max(0, Math.min(contentWidth - handleWidth, seamX - handleWidth / 2));
      resizeHandle.style.left = `${handleLeft}px`;
    };

    syncResizeHandlePosition = updateResizeHandlePosition;

    // Apply saved width to both sidebar body and header
    const applySidebarWidth = (px: number): void => {
      sidebar.style.width = `${px}px`;
      if (sidebarHeader) {
        sidebarHeader.style.width = `${px}px`;
      }
    };

    const savedWidth = await getStoredSidebarWidth();
    if (savedWidth !== null) {
      applySidebarWidth(constrainSidebarWidth(savedWidth));
    }
    updateResizeHandlePosition();

    resizeHandle.addEventListener('mousedown', (event: MouseEvent) => {
      event.preventDefault();

      resizeHandle.classList.add('active');
      document.body.classList.add('sidebar-resizing');

      const startX = event.clientX;
      const startWidth = sidebar.offsetWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const isSidebarLeft = document.body.classList.contains('gitbook-sidebar-left');
        const nextWidth = isSidebarLeft ? startWidth + deltaX : startWidth - deltaX;
        const constrained = constrainSidebarWidth(nextWidth);
        applySidebarWidth(constrained);
        updateResizeHandlePosition();
      };

      const onMouseUp = () => {
        resizeHandle.classList.remove('active');
        document.body.classList.remove('sidebar-resizing');
        void setStoredSidebarWidth(sidebar.offsetWidth);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    window.addEventListener('resize', updateResizeHandlePosition);
    window.addEventListener('gitbook-panel-visibility-changed', () => {
      requestAnimationFrame(updateResizeHandlePosition);
    });
  }

  // Prevent browser from auto-restoring scroll position before viewer content is ready.
  // Otherwise, Chrome may jump to a stale DOM offset before markdown-viewer restores
  // the line-based position.
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  const translate = (key: string, substitutions?: string | string[]): string =>
    Localization.translate(key, substitutions);

  // Initialize DOCX exporter
  const docxExporter = new DocxExporter(pluginRenderer);

  // Store exporter for plugins and debugging
  window.docxExporter = docxExporter;

  // Initialize file state service (unified across platforms)
  // In workspace/embed mode the iframe URL is stable while dataset.viewerFilePath changes,
  // so always resolve URL dynamically instead of capturing it once.
  const getActiveDocumentUrl = (): string => getCurrentDocumentUrl();

  // Set initial key for scroll position persistence (used by viewer-host)
  setCurrentFileKey(getActiveDocumentUrl());

  const saveFileState = (state: FileState): void => {
    const activeUrl = getActiveDocumentUrl();
    setCurrentFileKey(activeUrl);
    platform.fileState.set(activeUrl, state);
  };
  const getFileState = (): Promise<FileState> => {
    const activeUrl = getActiveDocumentUrl();
    setCurrentFileKey(activeUrl);
    return platform.fileState.get(activeUrl);
  };

  let markdownViewerElement: MarkdownViewerElement | null = null;
  let markdownViewerAdapter: MountedViewerController | null = null;
  let lastScrollLine = 0;
  let currentThemeId: string | null = null;
  let lastWrapperScrollLogTime = 0;

  const logDebug = (scope: string, detail?: unknown): void => {
    void scope;
    void detail;
  };
  const logThenPermissionError = (scope: string, error: unknown, extra?: Record<string, unknown>): void => {
    const message = error instanceof Error ? error.message : String(error);
    const isThenPermission = message.includes('Permission denied to access property "then"');
    // eslint-disable-next-line no-console
    console.error(`[MarkdownViewer] ${scope}`, {
      message,
      isThenPermission,
      extra,
      stack: error instanceof Error ? error.stack : undefined,
    });
  };

  logDebug('initialize.start', {
    platform: platform.platform,
    hasThemeRenderer: Boolean(themeConfigRenderer),
  });

  window.addEventListener('error', (event) => {
    logDebug('window.error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      hasAdapter: Boolean(markdownViewerAdapter),
      hasElement: Boolean(markdownViewerElement),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    logDebug('window.unhandledrejection', {
      message,
      isThenPermission: message.includes('Permission denied to access property "then"'),
      hasAdapter: Boolean(markdownViewerAdapter),
      hasElement: Boolean(markdownViewerElement),
      renderType: markdownViewerElement ? typeof markdownViewerElement.render : 'n/a',
    });
  });

  function attachMountedViewerAdapter(element: MarkdownViewerElement): void {
    if (typeof element.render === 'function') {
      logDebug('adapter.skip.attach', { reason: 'element-already-has-render' });
      return;
    }

    if (!markdownViewerAdapter) {
      const innerContainer = document.createElement('div');
      innerContainer.className = 'markdown-viewer-content';
      element.innerHTML = '';
      element.appendChild(innerContainer);

      const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
      markdownViewerAdapter = createMountedViewer({
        container: innerContainer,
        scrollContainer: wrapper ?? undefined,
        platform,
        renderer: pluginRenderer,
        translate,
        onHeadings: () => {
          void generateTOC();
        },
        afterRender: updateActiveTocItem,
        onScrollLineChange: (line) => {
          logDebug('scrollSync.onScrollLineChange', {
            line,
            wrapperScrollTop: wrapper?.scrollTop ?? null,
          });
          lastScrollLine = line;
          saveFileState({ scrollLine: line });
          element.dispatchEvent(new CustomEvent('scrolllinechange', {
            detail: { line },
            bubbles: true,
            composed: true,
          }));
        },
        applyTheme: loadAndApplyTheme,
        saveTheme: (id) => themeManager.saveSelectedTheme(id),
      });
      logDebug('adapter.created', { hasAdapter: Boolean(markdownViewerAdapter) });

      if (wrapper) {
        wrapper.addEventListener('scroll', () => {
          const now = Date.now();
          if (now - lastWrapperScrollLogTime < 500) {
            return;
          }
          lastWrapperScrollLogTime = now;
          logDebug('wrapper.scroll', {
            scrollTop: wrapper.scrollTop,
            scrollHeight: wrapper.scrollHeight,
            clientHeight: wrapper.clientHeight,
          });
        }, { passive: true });
      } else {
        logDebug('wrapper.scroll.listener.skip', {
          reason: 'markdown-wrapper not found',
        });
      }
    }

    const target = element as unknown as Record<string, unknown>;

    Object.defineProperty(target, 'scrollLine', {
      configurable: true,
      enumerable: true,
      get: () => {
        const attr = element.getAttribute('scroll-line');
        if (!attr) return undefined;
        const line = Number.parseInt(attr, 10);
        return Number.isFinite(line) ? line : undefined;
      },
      set: (value: unknown) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          element.setAttribute('scroll-line', String(value));
          markdownViewerAdapter?.setScrollLine(value);
        } else {
          element.removeAttribute('scroll-line');
        }
      },
    });

    target.render = async (markdown: string) => {
      const attr = element.getAttribute('scroll-line');
      const parsedTargetLine = attr ? Number.parseInt(attr, 10) : undefined;
      const targetLine = typeof parsedTargetLine === 'number' && Number.isFinite(parsedTargetLine)
        ? parsedTargetLine
        : undefined;
      logDebug('adapter.render.start', {
        targetLine: targetLine ?? null,
        markdownLength: markdown.length,
      });
      await markdownViewerAdapter?.render(markdown, {
        fileChanged: true,
        forceRender: false,
        targetLine,
        zoomLevel: toolbarManager.getZoomLevel() / 100,
      });
      logDebug('adapter.render.done');
    };

    target.getCurrentLine = () => markdownViewerAdapter?.getCurrentLine() ?? null;
    target.switchTheme = async (themeId: string) => {
      await markdownViewerAdapter?.switchTheme(themeId);
    };
    target.scrollToAnchor = (anchor: string) => {
      markdownViewerAdapter?.scrollToAnchor(anchor);
    };
  }

  async function getOrCreateMarkdownViewerElement(): Promise<MarkdownViewerElement> {
    if (markdownViewerElement) {
      return markdownViewerElement;
    }

    const contentHost = document.getElementById('markdown-content');
    const allMarkdownContent = document.querySelectorAll('#markdown-content');
    logDebug('markdown-content.lookup', {
      found: Boolean(contentHost),
      count: allMarkdownContent.length,
      firstTag: contentHost?.tagName || null,
    });
    if (!contentHost) {
      throw new Error('[Viewer] markdown-content container not found');
    }

    const element = document.createElement('markdown-viewer') as MarkdownViewerElement;
    contentHost.innerHTML = '';
    contentHost.appendChild(element);
    logDebug('element.created');

    const registry = globalThis.customElements;
    if (registry) {
      logDebug('element.registry.state', {
        hasDefinition: Boolean(registry.get('markdown-viewer')),
      });
    }

    element.addEventListener('scrolllinechange', (event: Event) => {
      const detail = (event as CustomEvent<{ line?: number }>).detail;
      const line = typeof detail?.line === 'number' ? detail.line : null;
      logDebug('element.scrolllinechange.event', {
        line,
      });
      if (line === null || Number.isNaN(line)) {
        return;
      }
      lastScrollLine = line;
      saveFileState({ scrollLine: line });
      updateActiveTocItem();
      logDebug('toc.sync.from-scrolllinechange', { line });
    });

    markdownViewerElement = element;

    attachMountedViewerAdapter(markdownViewerElement);
    logDebug('element.ready', {
      hasAdapter: Boolean(markdownViewerAdapter),
      renderType: typeof markdownViewerElement.render,
      switchThemeType: typeof markdownViewerElement.switchTheme,
    });

    if (typeof markdownViewerElement.render !== 'function') {
      throw new Error('[Viewer] markdown-viewer API attachment failed');
    }

    return markdownViewerElement;
  }

  // Set favicon to extension icon
  function setFavicon(): void {
    // Remove existing favicon if any
    const existingLink = document.querySelector("link[rel*='icon']");
    if (existingLink) {
      existingLink.remove();
    }
    
    // Create new favicon link
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = webExtensionApi.runtime.getURL('icons/icon16.png');
    document.head.appendChild(link);
  }
  setFavicon();

  // Initialize TOC manager
  const tocManager = createTocManager(saveFileState, getFileState, isMobile);
  const { generateTOC, setupTocToggle, updateActiveTocItem, setupResponsiveToc } = tocManager;

  // Create navigation callback for GitBook panel (will be set after renderMarkdown is defined)
  let onGitbookNavigate: ((url: string, content: string) => Promise<void>) | undefined;

  // Initialize GitBook panel manager
  const gitbookPanel = createGitbookPanel(saveFileState, getFileState, isMobile, {
    currentUrl: getActiveDocumentUrl(),
    readRelativeFile: async (relativePath: string) => {
      if (!platform.document) {
        throw new Error('Document service unavailable');
      }
      return platform.document.readRelativeFile(relativePath);
    },
    onNavigateFile: (url: string, content: string) => {
      if (onGitbookNavigate) {
        return onGitbookNavigate(url, content);
      }
      return Promise.resolve();
    },
  });
  const { generateGitbookPanel, setupResponsivePanel } = gitbookPanel;

  // Get the raw markdown content.
  // When the page is a rendered HTML document the html-to-markdown content
  // script will have already extracted and converted the article content;
  // fall back to document.body.textContent for plain-text / raw files.
  const htmlConverted = window.__mvHtmlConvertedMarkdown;
  const rawContent = htmlConverted?.markdown ?? document.body.textContent ?? '';
  if (htmlConverted?.title) {
    document.title = htmlConverted.title;
  }

  // When taking over an HTML page, strip the original page's stylesheets and
  // inline styles so they don't bleed into the Markdown viewer layout.
  if (htmlConverted) {
    // Remove external stylesheets and <style> blocks (keep our own preload style)
    document.head.querySelectorAll<HTMLElement>('link[rel~="stylesheet"], style').forEach((el) => {
      if (el.id !== 'markdown-viewer-preload') {
        el.remove();
      }
    });
    // Reset any inline styles the original page applied to <html> / <body>
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    // Wipe the existing page content so nothing leaks through during render
    document.body.innerHTML = '';
  }

  // ── Slidev mode: .slides.md files render as presentations ────────────
  const initialUrl = getActiveDocumentUrl();
  if (/\.slides\.md$/i.test(initialUrl)) {
    // Remove preload style that hides page content (opacity: 0 !important)
    document.getElementById('markdown-viewer-preload')?.remove();

    // Full-screen layout for presentations
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden;opacity:1';
    document.documentElement.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';

    // Notify parent workspace that the frame is themed and ready to reveal.
    // The normal markdown path does this after theme setup; Slidev must do the
    // same here because it returns early and never reaches that code.
    try {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'VIEWER_RENDERED' }, '*');
      }
    } catch { /* cross-origin parent — ignore */ }

    await initSlidevViewer({
      rawContent,
      container: document.body,
      renderDiagram: (type, code) =>
        platform.renderer.render(type, code).then((r) => ({
          base64: r.base64!,
          width: r.width,
          height: r.height,
        })),
      onThemeReady: async (name) => {
        try {
          const resp = await fetch(webExtensionApi.runtime.getURL('slidev-shell/themes/themes.json'));
          if (!resp.ok) return;
          const manifest = await resp.json();
          const entry = manifest[name];
          if (entry?.fonts) {
            platform.renderer.setThemeConfig({
              ...platform.renderer.getThemeConfig(),
              fontFamily: entry.fonts.sans || entry.fonts.serif || undefined,
              fontUrl: entry.fontUrl,
              colorSchema: entry.colorSchema as 'light' | 'dark' | 'both' | undefined,
            });
          }
        } catch { /* ignore */ }
      },
      getShellSource: async () =>
        webExtensionApi.runtime.getURL('slidev-shell/index.html'),
      getThemeUrl: async (name) =>
        webExtensionApi.runtime.getURL(`slidev-shell/themes/theme-${name}.js`),
      onParsed: ({ title }) => {
        document.title = title;
        saveToHistory(platform);
      },
    });
    return;
  }

  // Wrap non-markdown file content (e.g., mermaid, vega) in markdown format.
  // For standalone text/code files detected by content-detector, render as
  // fenced code so syntax highlighting matches workspace behavior.
  const isMarkdownSourceToggleEnabled = (): boolean => {
    if (htmlConverted) {
      return false;
    }
    const activeUrl = getActiveDocumentUrl();
    return /\.md$/i.test(activeUrl) && !/\.slides\.md$/i.test(activeUrl);
  };
  let sourceModeEnabled = false;
  let liveRawContent = rawContent;

  const computeRenderState = (content: string): { markdown: string; codeView: boolean } => {
    const codeReading = !htmlConverted ? buildCodeReadingRender(content, initialUrl) : null;
    return {
      markdown: codeReading ? codeReading.markdown : wrapFileContent(content, initialUrl),
      codeView: Boolean(codeReading),
    };
  };

  let renderState = computeRenderState(liveRawContent);
  const getDisplayMarkdown = (): string => {
    if (isMarkdownSourceToggleEnabled() && sourceModeEnabled) {
      return toFencedCode(liveRawContent, 'markdown');
    }
    return renderState.markdown;
  };
  const updateCodeViewPresentation = (): void => {
    applyCodeViewPresentation((isMarkdownSourceToggleEnabled() && sourceModeEnabled) || renderState.codeView);
  };

  updateCodeViewPresentation();
  const rawMarkdown = renderState.markdown;

  // Get saved state early to prevent any flashing
  const initialState = await getFileState();

  // Layout configurations
  const layoutTitles: LayoutTitles = {
    normal: translate('toolbar_layout_title_normal'),
    fullscreen: translate('toolbar_layout_title_fullscreen'),
    narrow: translate('toolbar_layout_title_narrow'),
  };

  const layoutConfigs: LayoutConfigs = {
    normal: { maxWidth: '1360px', icon: layoutIcons.normal, title: layoutTitles.normal },
    fullscreen: { maxWidth: '100%', icon: layoutIcons.fullscreen, title: layoutTitles.fullscreen },
    narrow: { maxWidth: '680px', icon: layoutIcons.narrow, title: layoutTitles.narrow },
  };

  type LayoutMode = keyof LayoutConfigs;
  const initialLayout: LayoutMode =
    initialState.layoutMode && layoutConfigs[initialState.layoutMode as LayoutMode]
      ? (initialState.layoutMode as LayoutMode)
      : 'normal';
  const initialMaxWidth = layoutConfigs[initialLayout].maxWidth;
  const initialZoom = initialState.zoom || 100;
  const initialSwapPanelSide = await platform.settings.get('swapPanelSide');

  // Default TOC visibility based on screen width if no saved state
  let initialTocVisible: boolean;
  if (initialState.tocVisible !== undefined) {
    initialTocVisible = initialState.tocVisible;
  } else {
    initialTocVisible = !isMobile;
  }
  const initialTocClass = initialTocVisible ? '' : ' hidden';

  const toolbarPrintDisabledTitle = translate('toolbar_print_disabled_title');

  // Initialize toolbar manager
  const toolbarManager = createToolbarManager({
    translate,
    escapeHtml,
    saveFileState,
    getFileState,
    isMobile,
    rawMarkdown,
    getRawContent: () => liveRawContent,
    docxExporter,
    cancelScrollRestore: () => {
      // Scroll restoration is handled by markdown-viewer state.
    },
    updateActiveTocItem,
    toolbarPrintDisabledTitle,
    onBeforeZoom: () => {
      // Lock scroll position before zoom change
      // No scroll lock needed in simplified scroll controller.
    },
    enableSourceToggle: isMarkdownSourceToggleEnabled(),
    onToggleSourceMode: () => {
      sourceModeEnabled = !sourceModeEnabled;
      const scrollLine = getCurrentScrollLine();
      updateCodeViewPresentation();
      void renderMarkdown(getDisplayMarkdown(), scrollLine);
    },
    getSourceMode: () => sourceModeEnabled,
    isSourceModeActive: () => (isMarkdownSourceToggleEnabled() && sourceModeEnabled) || renderState.codeView,
  });

  toolbarManager.setInitialZoom(initialZoom);

  // UI layout
  document.body.innerHTML = generateToolbarHTML({
    translate,
    escapeHtml,
    initialTocClass,
    initialMaxWidth,
    initialZoom,
    enableSourceToggle: isMarkdownSourceToggleEnabled(),
  });
  if (!initialTocVisible) {
    document.body.classList.add('toc-hidden');
  }
  applyTocPanelSide(Boolean(initialSwapPanelSide));
  await initGitbookSidebarResize();

  await getOrCreateMarkdownViewerElement();

  // Load theme BEFORE unveiling the body. Doing it the other way around
  // causes a brief flash of the default light body background (~6ms) when
  // the selected theme is dark, because the preload style is removed and
  // opacity flipped to 1 while the theme CSS is still in flight.
  try {
    currentThemeId = await themeManager.loadSelectedTheme();
    // loadAndApplyTheme handles all theme logic including renderer config
    await loadAndApplyTheme(currentThemeId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load theme at init, using defaults:', error);
  }

  // Remove the preload style that hides the page content
  // This should be done after the toolbar is generated but before rendering
  const preloadStyle = document.getElementById('markdown-viewer-preload');
  if (preloadStyle) {
    preloadStyle.remove();
  }

  // Make body visible with a smooth fade-in
  document.body.style.opacity = '1';
  document.body.style.overflow = 'hidden';
  document.body.style.transition = 'opacity 0.15s ease-in';

  // Notify the parent (workspace page) that the viewer is themed and visible,
  // so it can reveal the iframe. Harmless when this page is not embedded.
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'VIEWER_RENDERED' }, '*');
    }
  } catch { /* cross-origin parent \u2014 ignore */ }

  // Wait for two paint frames, then start processing.
  // This avoids a fixed delay while still letting initial DOM/CSS settle.
  const waitForNextFrame = (): Promise<void> => {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  };

  const runInitialRender = async (): Promise<void> => {
    let savedScrollLine = initialState.scrollLine;
    let pendingAnchor: string | null = null;

    // Prefer anchor-based navigation through markdown-viewer API.
    if (window.location.hash) {
      const fragment = decodeURIComponent(window.location.hash.slice(1)).trim();
      pendingAnchor = fragment.length > 0 ? fragment : null;
    }

    toolbarManager.initializeToolbar();

    await renderMarkdown(getDisplayMarkdown(), savedScrollLine);

    if (pendingAnchor) {
      await getOrCreateMarkdownViewerElement();
      if (markdownViewerAdapter) {
        markdownViewerAdapter.scrollToAnchor(pendingAnchor);
      } else {
        markdownViewerElement!.scrollToAnchor(pendingAnchor);
      }
    }

    await saveToHistory(platform);
    setupTocToggle();
    toolbarManager.setupKeyboardShortcuts();
    await setupResponsiveToc();
    await setupResponsivePanel();
    await generateGitbookPanel();
  };

  void (async () => {
    await waitForNextFrame();
    await waitForNextFrame();
    await runInitialRender();
  })();

  window.addEventListener('hashchange', () => {
    if (!window.location.hash) return;
    const anchor = decodeURIComponent(window.location.hash.slice(1)).trim();
    if (anchor) {
      void (async () => {
        try {
          await getOrCreateMarkdownViewerElement();
          if (markdownViewerAdapter) {
            logDebug('hashchange.path.adapter', { anchor });
            markdownViewerAdapter.scrollToAnchor(anchor);
          } else {
            logDebug('hashchange.path.element', { anchor });
            markdownViewerElement!.scrollToAnchor(anchor);
          }
        } catch (error) {
          logThenPermissionError('hashchange.failed', error, { anchor });
        }
      })();
    }
  });

  // scrolllinechange from markdown-viewer is the single source of truth for host persistence.
  const getCurrentScrollLine = (): number => {
    if (markdownViewerAdapter) {
      return markdownViewerAdapter.getCurrentLine() ?? lastScrollLine;
    }
    if (markdownViewerElement) {
      return markdownViewerElement.getCurrentLine() ?? lastScrollLine;
    }
    return lastScrollLine;
  };

  async function renderMarkdown(markdown: string, savedScrollLine = 0): Promise<void> {
    const restoreLine = typeof savedScrollLine === 'number' && Number.isFinite(savedScrollLine) && savedScrollLine > 0
      ? savedScrollLine
      : undefined;

    let viewer: MarkdownViewerElement;
    try {
      viewer = await getOrCreateMarkdownViewerElement();
    } catch (error) {
      logThenPermissionError('renderMarkdown.getOrCreate.failed', error, {
        savedScrollLine: restoreLine,
        markdownLength: markdown.length,
      });
      throw error;
    }

    if (restoreLine !== undefined) {
      lastScrollLine = restoreLine;
    }

    showProcessingIndicator();
    try {
      if (markdownViewerAdapter) {
        logDebug('renderMarkdown.path.adapter', {
          savedScrollLine: restoreLine,
          markdownLength: markdown.length,
        });
        if (restoreLine !== undefined) {
          markdownViewerAdapter.setScrollLine(restoreLine);
        }
        await markdownViewerAdapter.render(markdown, {
          fileChanged: true,
          forceRender: false,
          targetLine: restoreLine,
          zoomLevel: toolbarManager.getZoomLevel() / 100,
        });
      } else {
        logDebug('renderMarkdown.path.element', {
          savedScrollLine: restoreLine,
          markdownLength: markdown.length,
          renderType: typeof viewer.render,
        });
        if (restoreLine !== undefined) {
          viewer.scrollLine = restoreLine;
        }
        await viewer.render(markdown);
      }
      await generateTOC();
      updateActiveTocItem();
      logDebug('renderMarkdown.done');
    } catch (error) {
      logThenPermissionError('renderMarkdown.failed', error, {
        hasAdapter: Boolean(markdownViewerAdapter),
      });
      throw error;
    } finally {
      hideProcessingIndicator();
    }
  }

  // Setup GitBook navigation handler (navigate without page refresh)
  onGitbookNavigate = async (url: string, content: string): Promise<void> => {
    try {
      // Update document title from URL or filename
      const filename = url.split('/').pop()?.replace(/\.md$/, '') || 'Document';
      document.title = filename;

      // Update page content with new markdown
      await renderMarkdown(content);

      // Save to browser history
      saveToHistory(platform);
    } catch (error) {
      console.error('[Chrome] GitBook navigation failed:', error);
    }
  };

  /**
   * Handle theme change - use handleThemeSwitchFlow (same as VSCode/Mobile)
   */
  async function handleSetTheme(themeId: string): Promise<void> {
    // Skip if same theme
    if (themeId === currentThemeId) {
      return;
    }

    currentThemeId = themeId;

    try {
      await getOrCreateMarkdownViewerElement();
      if (markdownViewerAdapter) {
        logDebug('theme.path.adapter', { themeId });
        await markdownViewerAdapter.switchTheme(themeId);
      } else {
        logDebug('theme.path.element', {
          themeId,
          switchThemeType: typeof markdownViewerElement!.switchTheme,
        });
        await markdownViewerElement!.switchTheme(themeId);
      }

      // Theme switch may recreate or rewrite code DOM; refresh line numbers in source/code view.
      updateCodeViewPresentation();

      logDebug('theme.done', { themeId });
    } catch (error) {
      logThenPermissionError('theme.failed', error, {
        themeId,
        hasAdapter: Boolean(markdownViewerAdapter),
      });
    }
  }

  /**
   * Setup message listener for locale/theme/file changes
   */
  function setupMessageListener(): void {
    platform.message.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const msg = message as IncomingBroadcastMessage;

      const nextLocale = (locale: string) => {
        Localization.setPreferredLocale(locale)
          .catch((error) => {
            // eslint-disable-next-line no-console
            console.error('Failed to update locale in main script:', error);
          })
          .finally(() => {
            window.location.reload();
          });
      };

      if (msg.type === 'LOCALE_CHANGED') {
        const payload = msg.payload && typeof msg.payload === 'object' ? (msg.payload as Record<string, unknown>) : null;
        const locale = payload && typeof payload.locale === 'string' && payload.locale.length > 0 ? payload.locale : DEFAULT_SETTING_LOCALE;
        nextLocale(locale);
        return;
      }

      if (msg.type === 'SETTING_CHANGED') {
        const payload = msg.payload && typeof msg.payload === 'object' ? (msg.payload as Record<string, unknown>) : null;
        const key = payload?.key as string | undefined;
        const value = payload?.value;
        
        if (key === 'themeId' && typeof value === 'string') {
          void handleSetTheme(value);
        } else if (key === 'swapPanelSide') {
          applyTocPanelSide(Boolean(value));
        } else {
          // Other settings changed - just re-render with scroll preservation
          const scrollLine = getCurrentScrollLine();
          void renderMarkdown(getDisplayMarkdown(), scrollLine);
        }
        return;
      }

      // Handle file content changes from background script
      if (msg.type === 'FILE_CHANGED') {
        const payload = msg.payload && typeof msg.payload === 'object' ? (msg.payload as Record<string, unknown>) : null;
        if (payload) {
          const changedUrl = payload.url as string;
          const newContent = payload.content as string;
          
          // Verify it's for the current document
          if (changedUrl === getActiveDocumentUrl() && typeof newContent === 'string') {
            void handleFileChanged(newContent);
          }
        }
        return;
      }

      // Handle auto refresh settings changes
      if (msg.type === 'AUTO_REFRESH_SETTINGS_CHANGED') {
        const payload = msg.payload && typeof msg.payload === 'object' ? (msg.payload as Record<string, unknown>) : null;
        if (payload) {
          const enabled = payload.enabled as boolean;
          if (enabled) {
            void startFileTracking();
          } else {
            stopFileTracking();
          }
        }
        return;
      }
    });
  }

  /**
   * Handle file content change (incremental update)
   */
  async function handleFileChanged(newContent: string): Promise<void> {
    let viewer: MarkdownViewerElement;
    try {
      viewer = await getOrCreateMarkdownViewerElement();
    } catch (error) {
      logThenPermissionError('fileChanged.getOrCreate.failed', error, {
        contentLength: newContent.length,
      });
      throw error;
    }

    liveRawContent = newContent;
    renderState = computeRenderState(liveRawContent);
    const displayMarkdown = getDisplayMarkdown();
    updateCodeViewPresentation();

    showProcessingIndicator();
    try {
      if (markdownViewerAdapter) {
        logDebug('fileChanged.path.adapter', {
          contentLength: displayMarkdown.length,
        });
        await markdownViewerAdapter.render(displayMarkdown, {
          fileChanged: false,
          forceRender: false,
          zoomLevel: toolbarManager.getZoomLevel() / 100,
        });
      } else {
        logDebug('fileChanged.path.element', {
          contentLength: displayMarkdown.length,
          renderType: typeof viewer.render,
        });
        await viewer.render(displayMarkdown);
      }
      await generateTOC();
      updateActiveTocItem();
      logDebug('fileChanged.done');
    } catch (error) {
      logThenPermissionError('fileChanged.failed', error, {
        hasAdapter: Boolean(markdownViewerAdapter),
      });
      throw error;
    } finally {
      hideProcessingIndicator();
    }
  }

  /**
   * Start file change tracking for current document
   */
  async function startFileTracking(): Promise<void> {
    const activeUrl = getActiveDocumentUrl();
    if (!activeUrl.startsWith('file://')) {
      return; // Only track local files
    }

    try {
      await new Promise<void>((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            id: `start-tracking-${Date.now()}`,
            type: 'START_FILE_TRACKING',
            payload: { url: activeUrl },
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response && response.ok) {
              resolve();
            } else {
              reject(new Error(response?.error?.message || 'Failed to start tracking'));
            }
          }
        );
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[Chrome] Failed to start file tracking:', error);
    }
  }

  /**
   * Stop file change tracking
   */
  function stopFileTracking(): void {
    const activeUrl = getActiveDocumentUrl();
    if (!activeUrl.startsWith('file://')) {
      return;
    }

    chrome.runtime.sendMessage({
      id: `stop-tracking-${Date.now()}`,
      type: 'STOP_FILE_TRACKING',
      payload: { url: activeUrl },
    });
  }

  window.addEventListener('beforeunload', () => {
    markdownViewerElement = null;
    markdownViewerAdapter?.destroy();
    markdownViewerAdapter = null;
  });

  // Setup message listener for theme/locale/file changes
  setupMessageListener();

  // Setup image context menu (shared cross-platform)
  const contentContainer = document.getElementById('markdown-content');
  logDebug('markdown-content.context-menu.lookup', {
    found: Boolean(contentContainer),
    count: document.querySelectorAll('#markdown-content').length,
  });
  if (contentContainer) {
    setupImageContextMenu({
      container: contentContainer,
      onDownload: ({ filename, data, mimeType }) => {
        // Use <a download> for browser-based download
        const blob = new Blob(
          [Uint8Array.from(atob(data), c => c.charCodeAt(0))],
          { type: mimeType }
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      },
      translate: (key) => Localization.translate(key),
    });
  }

  // Start file tracking for local files
  if (getActiveDocumentUrl().startsWith('file://') && !document.documentElement.dataset.viewerFilename) {
    void startFileTracking();

    // Stop tracking when page unloads
    window.addEventListener('beforeunload', () => {
      stopFileTracking();
    });
  }
}

/**
 * Initialize and start the viewer
 * Call this after the shared viewer base initialization completes
 */
export function startViewer(options: ViewerMainOptions): void {
  void initializeViewerMain(options);
}
