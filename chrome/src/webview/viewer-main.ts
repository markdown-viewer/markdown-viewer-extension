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

import type { PluginRenderer, RendererThemeConfig, PlatformAPI } from '../../../src/types/index';

import { renderMarkdownDocument, getDocument } from '../../../src/core/viewer/viewer-controller';
import { createScrollSyncController, type ScrollSyncController } from '../../../src/core/line-based-scroll';
import { escapeHtml } from '../../../src/core/markdown-processor';
import { createFileStateManager, getCurrentDocumentUrl, saveToHistory } from '../../../src/core/file-state';
import { updateProgress, showProcessingIndicator, hideProcessingIndicator } from './ui/progress-indicator';
import { createTocManager } from './ui/toc-manager';
import { createToolbarManager, generateToolbarHTML, layoutIcons } from './ui/toolbar';

// Extend Window interface for global access
declare global {
  interface Window {
    docxExporter: DocxExporter;
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

  const translate = (key: string, substitutions?: string | string[]): string =>
    Localization.translate(key, substitutions);

  // Initialize DOCX exporter
  const docxExporter = new DocxExporter(pluginRenderer);

  // Store exporter for plugins and debugging
  window.docxExporter = docxExporter;

  // Initialize file state manager
  const { saveFileState, getFileState } = createFileStateManager(platform);

  // Initialize scroll sync controller (line-based, using shared implementation)
  let scrollSyncController: ScrollSyncController | null = null;
  
  function initScrollSyncController(): void {
    const container = document.getElementById('markdown-content');
    if (!container) {
      console.warn('[Chrome] markdown-content container not found!');
      return;
    }
    
    scrollSyncController = createScrollSyncController({
      container,
      getLineMapper: getDocument,
      useWindowScroll: true,  // Chrome uses window scroll
      userScrollDebounceMs: 10,  // Reduced for faster reverse sync feedback
      onUserScroll: (line) => {
        // Save scroll position for history/restore
        saveFileState({ scrollLine: line });
      },
    });
    
    scrollSyncController.start();
  }

  // Initialize TOC manager
  const tocManager = createTocManager(saveFileState, getFileState);
  const { generateTOC, setupTocToggle, updateActiveTocItem, setupResponsiveToc } = tocManager;

  // Get the raw markdown content
  const rawContent = document.body.textContent || '';
  
  // Get the current document URL to determine file type
  const currentUrl = getCurrentDocumentUrl();
  
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

  // Default TOC visibility based on screen width if no saved state
  let initialTocVisible: boolean;
  if (initialState.tocVisible !== undefined) {
    initialTocVisible = initialState.tocVisible;
  } else {
    initialTocVisible = window.innerWidth > 1024;
  }
  const initialTocClass = initialTocVisible ? '' : ' hidden';

  const toolbarPrintDisabledTitle = translate('toolbar_print_disabled_title');

  // Initialize toolbar manager
  const toolbarManager = createToolbarManager({
    translate,
    escapeHtml,
    saveFileState,
    getFileState,
    rawMarkdown,
    docxExporter,
    cancelScrollRestore: () => {
      // Cancel scroll restoration (not needed with scroll sync controller)
    },
    updateActiveTocItem,
    toolbarPrintDisabledTitle,
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

  // Remove the preload style that hides the page content
  // This should be done after the toolbar is generated but before rendering
  const preloadStyle = document.getElementById('markdown-viewer-preload');
  if (preloadStyle) {
    preloadStyle.remove();
  }

  // Make body visible with a smooth fade-in
  document.body.style.opacity = '1';
  document.body.style.overflow = '';
  document.body.style.transition = 'opacity 0.15s ease-in';

  // Initialize scroll sync controller immediately after DOM is ready
  initScrollSyncController();

  // Wait a bit for DOM to be ready, then start processing
  setTimeout(async () => {
    const savedScrollLine = initialState.scrollLine ?? 0;

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
  window.addEventListener('scroll', () => {
    updateActiveTocItem();
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const currentLine = scrollSyncController?.getCurrentLine() ?? 0;
      saveFileState({ scrollLine: currentLine });
    }, 300);
  });

  async function renderMarkdown(markdown: string, savedScrollLine = 0): Promise<void> {
    const contentDiv = document.getElementById('markdown-content') as HTMLElement | null;
    if (!contentDiv) {
      // eslint-disable-next-line no-console
      console.error('markdown-content div not found!');
      return;
    }

    // Set target scroll line immediately - MutationObserver will auto-reposition when DOM changes
    if (scrollSyncController) {
      scrollSyncController.setTargetLine(savedScrollLine);
    }

    // Load and apply theme
    try {
      const themeId = await themeManager.loadSelectedTheme();
      const theme = await themeManager.loadTheme(themeId);
      await loadAndApplyTheme(themeId);

      if (theme && theme.fontScheme && theme.fontScheme.body && themeConfigRenderer) {
        const fontFamily = themeManager.buildFontFamily(theme.fontScheme.body.fontFamily);
        const fontSize = parseFloat(theme.fontScheme.body.fontSize);
        const themeConfig: RendererThemeConfig = { fontFamily, fontSize };
        themeConfigRenderer.setThemeConfig(themeConfig);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load theme, using defaults:', error);
    }

    // Render markdown using shared orchestration
    const result = await renderMarkdownDocument({
      markdown,
      container: contentDiv,
      renderer: pluginRenderer,
      translate,
      clearContainer: true,
      onHeadings: () => {
        // Update TOC progressively as chunks are rendered
        void generateTOC();
      },
      onStreamingComplete: () => {
        // Streaming is complete, all initial DOM content is ready
        // Apply zoom (scroll is handled by MutationObserver)
        toolbarManager.applyZoom(toolbarManager.getZoomLevel(), false);
        setTimeout(updateActiveTocItem, 100);
      },
    });

    // Process async tasks after the initial render (keeps the page responsive)
    setTimeout(async () => {
      showProcessingIndicator();
      try {
        await result.taskManager.processAll((completed, total) => {
          updateProgress(completed, total);
        });
      } finally {
        hideProcessingIndicator();
      }
    }, 200);
  }
}

/**
 * Setup message listener for locale/theme changes
 */
export function setupMessageListener(platform: PlatformAPI): void {
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

    if (msg.type === 'THEME_CHANGED') {
      window.location.reload();
      return;
    }
  });
}

/**
 * Create a PluginRenderer from a render function
 */
export function createPluginRenderer(
  renderFn: (type: string, content: string) => Promise<{
    base64: string;
    width: number;
    height: number;
    format?: string;
    error?: string;
  }>
): PluginRenderer {
  return {
    render: async (type: string, content: string | object) => {
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
      const result = await renderFn(type, contentStr);

      if (result && result.error) {
        throw new Error(result.error || 'Render failed');
      }

      if (typeof result.width !== 'number' || typeof result.height !== 'number') {
        throw new Error('Render result missing dimensions');
      }

      const format = typeof result.format === 'string' && result.format.length > 0 ? result.format : 'png';

      return {
        base64: result.base64,
        width: result.width,
        height: result.height,
        format,
        error: result.error,
      };
    },
  };
}

/**
 * Initialize and start the viewer
 * Call this after Localization.init() completes
 */
export function startViewer(options: ViewerMainOptions): void {
  setupMessageListener(options.platform);
  
  Localization.init()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Localization init failed in main script:', error);
    })
    .finally(() => {
      void initializeViewerMain(options);
    });
}
