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
import { initSlidevViewer } from '../../../src/slidev/slidev-viewer';
import { getWebExtensionApi } from '../../../src/utils/platform-info';

import type { PluginRenderer, RendererThemeConfig, PlatformAPI } from '../../../src/types/index';

import type { AsyncTaskManager } from '../../../src/core/markdown-processor';
import type { ScrollSyncController } from '../../../src/core/line-based-scroll';
import { escapeHtml } from '../../../src/core/markdown-processor';
import { getCurrentDocumentUrl, saveToHistory } from '../../../src/core/document-utils';
import type { FileState } from '../../../src/types/core';
import { updateProgress, showProcessingIndicator, hideProcessingIndicator } from './ui/progress-indicator';
import { createTocManager } from './ui/toc-manager';
import { createToolbarManager, generateToolbarHTML, layoutIcons } from './ui/toolbar';

// Import shared utilities from viewer-host
import {
  createViewerScrollSync,
  setCurrentFileKey,
  renderMarkdownFlow,
  handleThemeSwitchFlow,
} from '../../../src/core/viewer/viewer-host';
import { setupImageContextMenu } from '../../../src/ui/image-context-menu';
import { findHeadingLine } from '../../../src/utils/heading-slug';

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

  function applyTocPanelSide(swapped: boolean): void {
    document.body.classList.toggle('toc-position-right', swapped);

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
  }

  // Prevent browser from auto-restoring scroll position before our content is ready.
  // Without this, Chrome jumps to its remembered DOM position first (wrong),
  // then our scroll sync corrects it (right) — causing a visible double-jump.
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
  const currentUrl = getCurrentDocumentUrl();
  
  // Set file key for scroll position persistence (used by viewer-host)
  setCurrentFileKey(currentUrl);
  
  const saveFileState = (state: FileState): void => {
    platform.fileState.set(currentUrl, state);
  };
  const getFileState = (): Promise<FileState> => {
    return platform.fileState.get(currentUrl);
  };

  // Initialize scroll sync controller using shared utility
  let scrollSyncController: ScrollSyncController | null = null;
  let currentTaskManager: AsyncTaskManager | null = null;
  let currentThemeId: string | null = null;
  
  function initScrollSyncController(): void {
    try {
      scrollSyncController = createViewerScrollSync({
        containerId: 'markdown-content',
        scrollContainerId: 'markdown-wrapper',
        platform,
        topOffset: 0,
      });
      scrollSyncController.start();
    } catch (error) {
      console.warn('[Chrome] Failed to init scroll sync:', error);
    }
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
  if (/\.slides\.md$/i.test(currentUrl)) {
    // Remove preload style that hides page content (opacity: 0 !important)
    document.getElementById('markdown-viewer-preload')?.remove();

    // Full-screen layout for presentations
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden;opacity:1';
    document.documentElement.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';

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

  // Wrap non-markdown file content (e.g., mermaid, vega) in markdown format
  const rawMarkdown = wrapFileContent(rawContent, currentUrl);

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
    docxExporter,
    cancelScrollRestore: () => {
      // Cancel scroll restoration (not needed with scroll sync controller)
    },
    updateActiveTocItem,
    toolbarPrintDisabledTitle,
    onBeforeZoom: () => {
      // Lock scroll position before zoom change
      // No scroll lock needed in simplified scroll controller.
    },
  });

  toolbarManager.setInitialZoom(initialZoom);

  // UI layout
  document.body.innerHTML = generateToolbarHTML({
    translate,
    escapeHtml,
    initialTocClass,
    initialMaxWidth,
    initialZoom,
  });

  if (!initialTocVisible) {
    document.body.classList.add('toc-hidden');
  }
  applyTocPanelSide(Boolean(initialSwapPanelSide));

  // Initialize scroll sync controller immediately after DOM is ready
  initScrollSyncController();

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

  // Wait a bit for DOM to be ready, then start processing
  setTimeout(async () => {
    let savedScrollLine = initialState.scrollLine ?? 0;

    // Override scroll position with heading line if URL has a hash fragment
    if (window.location.hash) {
      const fragment = decodeURIComponent(window.location.hash.slice(1));
      const headingLine = findHeadingLine(rawMarkdown, fragment);
      if (typeof headingLine === 'number') {
        savedScrollLine = headingLine;
      }
    }

    toolbarManager.initializeToolbar();

    await renderMarkdown(rawMarkdown, savedScrollLine);

    await saveToHistory(platform);
    setupTocToggle();
    toolbarManager.setupKeyboardShortcuts();
    await setupResponsiveToc();
  }, 100);

  // Listen for scroll events and save line number
  // Note: ScrollSyncController handles most scroll tracking, but we also listen for manual saves
  let scrollTimeout: ReturnType<typeof setTimeout>;
  document.getElementById('markdown-wrapper')?.addEventListener('scroll', () => {
    updateActiveTocItem();
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const currentLine = scrollSyncController?.getCurrentLine() ?? 0;
      saveFileState({ scrollLine: currentLine });
    }, 300);
  });

  async function renderMarkdown(markdown: string, savedScrollLine = 0, forceRender?: boolean): Promise<void> {
    const container = document.getElementById('markdown-content') as HTMLElement | null;
    if (!container) {
      // eslint-disable-next-line no-console
      console.error('[Chrome] Content container not found');
      return;
    }

    await renderMarkdownFlow({
      markdown,
      container,
      fileChanged: true, // Chrome: single document per page
      forceRender: forceRender ?? false,
      zoomLevel: toolbarManager.getZoomLevel() / 100,
      scrollController: scrollSyncController,
      renderer: pluginRenderer,
      translate,
      platform,
      currentTaskManagerRef: { current: currentTaskManager },
      targetLine: savedScrollLine,
      onHeadings: (_headings) => {
        // Chrome-specific: Update TOC progressively as chunks are rendered
        void generateTOC();
      },
      onProgress: (completed, total) => {
        updateProgress(completed, total);
      },
      beforeProcessAll: showProcessingIndicator,
      afterProcessAll: hideProcessingIndicator,
      afterRender: updateActiveTocItem,
    });
  }

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
      await handleThemeSwitchFlow({
        themeId,
        scrollController: scrollSyncController,
        applyTheme: loadAndApplyTheme,
        saveTheme: (id) => themeManager.saveSelectedTheme(id),
        rerender: async (scrollLine) => {
          // Re-render content with forceRender to regenerate diagrams
          await renderMarkdown(rawMarkdown, scrollLine, true);
        },
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[Chrome] Theme change failed:', error);
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
          const scrollLine = scrollSyncController?.getCurrentLine() ?? 0;
          void renderMarkdown(rawMarkdown, scrollLine, true);
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
          if (changedUrl === currentUrl && typeof newContent === 'string') {
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
    const container = document.getElementById('markdown-content') as HTMLElement | null;
    if (!container) {
      return;
    }

    // Wrap content if needed (e.g., mermaid, vega files)
    const wrappedContent = wrapFileContent(newContent, currentUrl);

    // Use shared render flow with incremental update
    await renderMarkdownFlow({
      markdown: wrappedContent,
      container,
      fileChanged: false, // Same file, enable incremental update
      forceRender: false,
      zoomLevel: toolbarManager.getZoomLevel() / 100,
      scrollController: scrollSyncController,
      renderer: pluginRenderer,
      translate,
      platform,
      currentTaskManagerRef: { current: currentTaskManager },
      // Preserve current scroll position
      onHeadings: (_headings) => {
        void generateTOC();
      },
      onProgress: (completed, total) => {
        updateProgress(completed, total);
      },
      beforeProcessAll: showProcessingIndicator,
      afterProcessAll: hideProcessingIndicator,
      afterRender: updateActiveTocItem,
    });
  }

  /**
   * Start file change tracking for current document
   */
  async function startFileTracking(): Promise<void> {
    if (!currentUrl.startsWith('file://')) {
      return; // Only track local files
    }

    try {
      await new Promise<void>((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            id: `start-tracking-${Date.now()}`,
            type: 'START_FILE_TRACKING',
            payload: { url: currentUrl },
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
    if (!currentUrl.startsWith('file://')) {
      return;
    }

    chrome.runtime.sendMessage({
      id: `stop-tracking-${Date.now()}`,
      type: 'STOP_FILE_TRACKING',
      payload: { url: currentUrl },
    });
  }

  // Setup message listener for theme/locale/file changes
  setupMessageListener();

  // Setup image context menu (shared cross-platform)
  const contentContainer = document.getElementById('markdown-content');
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
  if (currentUrl.startsWith('file://')) {
    void startFileTracking();

    // Stop tracking when page unloads
    window.addEventListener('beforeunload', () => {
      stopFileTracking();
    });
  }
}

/**
 * Initialize and start the viewer
 * Call this after Localization.init() completes
 */
export function startViewer(options: ViewerMainOptions): void {
  Localization.init()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Localization init failed in main script:', error);
    })
    .finally(() => {
      void initializeViewerMain(options);
    });
}
