// Mobile WebView Entry Point
// This is the main entry point for the mobile WebView
// Note: Diagram renderers (mermaid, vega, etc.) run in a separate iframe

import { platform, bridge } from './api-impl';
import Localization from '../../../src/utils/localization';
import themeManager from '../../../src/utils/theme-manager';
import DocxExporter from '../../../src/exporters/docx-exporter';
import {
  applyThemeFromData,
  type ThemeConfig,
  type TableStyleConfig,
  type CodeThemeConfig,
  type SpacingScheme,
  type FontConfig
} from '../../../src/utils/theme-to-css';
import { AsyncTaskManager } from '../../../src/core/markdown-processor';
import { renderMarkdownDocument, getDocument } from '../../../src/core/viewer/viewer-controller';
import { createScrollSyncController, type ScrollSyncController } from '../../../src/core/line-based-scroll';
import type { PluginRenderer } from '../../../src/types/index';
import type { PlatformBridgeAPI } from '../../../src/types/index';
import type { FontConfigFile } from '../../../src/utils/theme-manager';

declare global {
  var bridge: PlatformBridgeAPI | undefined;
}

// Make platform globally available (same as Chrome)
globalThis.platform = platform;
// Expose bridge for shared plugins that need host file/asset access
globalThis.bridge = bridge;

// Global state
let currentMarkdown = '';
let currentFilename = '';
let currentThemeData: ThemeData | null = null; // Store theme data for applying during render
let currentTaskManager: AsyncTaskManager | null = null; // Track current task manager for cancellation
let currentZoomLevel = 1; // Store current zoom level for applying after content render
let scrollSyncController: ScrollSyncController | null = null; // Scroll sync controller

/**
 * Theme data from Flutter
 */
interface ThemeData {
  fontConfig?: FontConfig;
  theme?: ThemeConfig & { id?: string };
  tableStyle?: TableStyleConfig;
  codeTheme?: CodeThemeConfig;
  spacing?: SpacingScheme;
}

function createPluginRenderer(): PluginRenderer {
  return {
    render: async (type, content, _context) => {
      const result = await platform.renderer.render(type, content);

      return {
        base64: result.base64,
        width: result.width,
        height: result.height,
        format: result.format,
        error: undefined
      };
    }
  };
}

/**
 * Load markdown payload
 */
interface LoadMarkdownPayload {
  content: string;
  filename?: string;
  themeDataJson?: string;
  scrollLine?: number;  // Saved scroll position (line number)
}

/**
 * Set theme payload
 */
interface SetThemePayload {
  themeId: string;
}

/**
 * Update settings payload
 */
interface UpdateSettingsPayload {
  settings: Record<string, unknown>;
}

/**
 * Set locale payload
 */
interface SetLocalePayload {
  locale: string;
}

/**
 * Bridge message type
 */
interface BridgeMessage {
  type?: string;
  payload?: LoadMarkdownPayload | SetThemePayload | UpdateSettingsPayload | SetLocalePayload;
}

function isBridgeMessage(message: unknown): message is BridgeMessage {
  if (!message || typeof message !== 'object') return false;
  const obj = message as Record<string, unknown>;
  return typeof obj.type === 'string';
}

/**
 * Initialize the mobile viewer
 */
async function initialize(): Promise<void> {
  try {
    // Initialize localization (will use fallback if fetch fails)
    await Localization.init();

    // Theme will be loaded from Flutter via applyThemeData
    // Don't try to load theme here - Flutter will send it after WebView is ready

    // Pre-initialize render iframe (don't wait, let it load in background)
    platform.renderer.ensureReady().catch((err: Error) => {
      console.warn('[Mobile] Render frame pre-init failed:', err?.message, err?.stack);
    });

    // Initialize scroll sync controller FIRST (before message handlers)
    // Uses #markdown-content as container, window scroll for mobile
    initScrollSyncController();

    // Set up link click handling via event delegation
    setupLinkHandling();

    // Set up message handlers from host app (Flutter)
    setupMessageHandlers();

    // Notify host app that WebView is ready
    platform.notifyReady();
  } catch (error) {
    console.error('[Mobile] Initialization failed:', error);
  }
}

/**
 * Initialize scroll sync controller (singleton, created once at startup)
 */
function initScrollSyncController(): void {
  const container = document.getElementById('markdown-content');
  if (!container) {
    console.warn('[Mobile] markdown-content container not found!');
    return;
  }

  scrollSyncController = createScrollSyncController({
    container,
    getLineMapper: getDocument,
    useWindowScroll: true,  // Mobile uses window scroll
    userScrollDebounceMs: 10,  // Reduced for faster reverse sync feedback
    onUserScroll: (line) => {
      // Report scroll position to host app for saving
      bridge.postMessage('SCROLL_LINE_CHANGED', { line });
    },
  });

  scrollSyncController.start();
}

/**
 * Set up handlers for messages from host app
 */
function setupMessageHandlers(): void {
  bridge.addListener(async (message: unknown) => {
    if (!isBridgeMessage(message) || !message.type) return;

    try {
      switch (message.type) {
        case 'LOAD_MARKDOWN':
          await handleLoadMarkdown(message.payload as LoadMarkdownPayload);
          break;

        case 'SET_THEME':
          await handleSetTheme(message.payload as SetThemePayload);
          break;

        case 'EXPORT_DOCX':
          await handleExportDocx();
          break;

        case 'UPDATE_SETTINGS':
          await handleUpdateSettings(message.payload as UpdateSettingsPayload);
          break;

        case 'SET_LOCALE':
          await handleSetLocale(message.payload as SetLocalePayload);
          break;

        default:
          // Ignore unknown message types (RENDER_FRAME_LOG, RESPONSE, etc.)
          break;
      }
    } catch (error) {
      console.error('[Mobile] Message handler error:', error);
    }
  });
}

/**
 * Handle loading Markdown content
 */
async function handleLoadMarkdown(payload: LoadMarkdownPayload): Promise<void> {
  const { content, filename, themeDataJson, scrollLine } = payload;

  // Check if file changed
  const newFilename = filename || 'document.md';
  const fileChanged = currentFilename !== newFilename;

  // Only abort on file switch - incremental updates let old tasks complete naturally
  // (old tasks will find their placeholder gone and silently discard results)
  if (fileChanged && currentTaskManager) {
    currentTaskManager.abort();
    currentTaskManager = null;
  }
  
  // Set target scroll line immediately - MutationObserver will auto-reposition when DOM changes
  if (scrollSyncController) {
    scrollSyncController.setTargetLine(scrollLine ?? 0);
  }

  currentMarkdown = content;
  currentFilename = newFilename;

  try {
    // If theme data is provided with content, set it first (avoids race condition)
    if (themeDataJson) {
      try {
        const data = JSON.parse(themeDataJson) as ThemeData;
        currentThemeData = data;
        
        // Initialize themeManager with font config
        if (data.fontConfig) {
          if (typeof data.fontConfig === 'object' && data.fontConfig !== null && 'fonts' in data.fontConfig) {
            themeManager.initializeWithData(data.fontConfig as unknown as FontConfigFile);
          }
        }
      } catch (e) {
        console.error('[Mobile] Failed to parse theme data:', e);
      }
    }

    // Capture theme data at the start of this render cycle
    // This ensures we use the correct theme even if it changes during async operations
    const renderThemeData = currentThemeData;

    // Create task manager with onAbort callback to cancel pending renderer requests
    const taskManager = new AsyncTaskManager(
      (key: string, subs?: string | string[]) => Localization.translate(key, subs),
      { onAbort: () => platform.renderer.cancelPending?.() }
    );
    currentTaskManager = taskManager;

    const pluginRenderer = createPluginRenderer();
    const container = document.getElementById('markdown-content');

    let titleForHost = currentFilename;

    if (container) {
      // Clear container FIRST, then apply theme (avoids flicker from old content with new style)
      container.innerHTML = '';

      // Now apply theme CSS (container is empty, no flicker)
      // Use captured renderThemeData instead of currentThemeData
      if (renderThemeData) {
        const { fontConfig, theme, tableStyle, codeTheme, spacing } = renderThemeData;

        if (theme && tableStyle && codeTheme && spacing) {
          applyThemeFromData(theme, tableStyle, codeTheme, spacing, fontConfig);
        }

        // Also set renderer theme config for diagrams
        if (theme && theme.fontScheme && theme.fontScheme.body) {
          const fontFamily = themeManager.buildFontFamily(theme.fontScheme.body.fontFamily);
          const fontSize = parseFloat(theme.fontScheme.body.fontSize || '16');
          await platform.renderer.setThemeConfig({
            fontFamily: fontFamily,
            fontSize: fontSize
          });

          // Initialize Mermaid with new font
          const mermaidGlobal = (window as { mermaid?: { initialize?: (config: Record<string, unknown>) => void } }).mermaid;
          if (mermaidGlobal && typeof mermaidGlobal.initialize === 'function') {
            mermaidGlobal.initialize({
              startOnLoad: false,
              securityLevel: 'loose',
              lineHeight: 1.6,
              themeVariables: {
                fontFamily: fontFamily,
                background: 'transparent'
              },
              flowchart: {
                htmlLabels: true,
                curve: 'basis'
              }
            });
          }
        }
      }

      // Apply saved zoom level before rendering to avoid flicker
      if (currentZoomLevel !== 1) {
        (container as HTMLElement).style.zoom = String(currentZoomLevel);
      }

      const renderResult = await renderMarkdownDocument({
        markdown: content,
        container: container as HTMLElement,
        renderer: pluginRenderer,
        translate: (key: string, subs?: string | string[]) => Localization.translate(key, subs),
        taskManager,
        clearContainer: false,
        onHeadings: (headings) => {
          bridge.postMessage('HEADINGS_UPDATED', headings);
        },
      });

      if (taskManager.isAborted()) {
        return;
      }

      titleForHost = renderResult.title || currentFilename;

      // Process async tasks after initial render (same pattern as Chrome)
      await renderResult.taskManager.processAll((completed, total) => {
        if (!taskManager.isAborted()) {
          bridge.postMessage('RENDER_PROGRESS', { completed, total });
        }
      });
    }

    // Clear task manager reference after successful completion
    if (currentTaskManager === taskManager) {
      currentTaskManager = null;
    }

    // Notify host app that rendering is complete
    bridge.postMessage('RENDER_COMPLETE', {
      filename: currentFilename,
      title: titleForHost
    });

  } catch (error) {
    const err = error as Error;
    console.error('[Mobile] Markdown processing failed:', err.message, err.stack);
    bridge.postMessage('RENDER_ERROR', {
      error: err.message
    });
  }
}

/**
 * Set up link click handling via event delegation
 */
function setupLinkHandling(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute('href') || '';
    e.preventDefault();

    // External links (http/https) - open in system browser
    if (href.startsWith('http://') || href.startsWith('https://')) {
      bridge.postMessage('OPEN_URL', { url: href });
    }
    // Relative links
    else {
      // Check if it's a markdown file
      const isMarkdown = href.endsWith('.md') || href.endsWith('.markdown');

      if (isMarkdown) {
        // Load markdown file internally
        bridge.postMessage('LOAD_RELATIVE_MARKDOWN', { path: href });
      } else {
        // For other relative files (images, etc.), try to open with system handler
        bridge.postMessage('OPEN_RELATIVE_FILE', { path: href });
      }
    }
  });
}

/**
 * Handle theme change - called when Flutter sends theme data
 * @deprecated Use applyThemeData instead - Flutter now sends complete theme data
 */
async function handleSetTheme(payload: SetThemePayload): Promise<void> {
  // This is now a no-op - theme changes come through applyThemeData
  console.warn('[Mobile] handleSetTheme called but theme loading is now handled by Flutter');
  bridge.postMessage('THEME_CHANGED', { themeId: payload.themeId });
}

/**
 * Apply theme data received from Flutter
 * Flutter loads theme JSON from assets and sends it to WebView
 */
async function applyThemeData(jsonString: string): Promise<void> {
  try {
    const data = JSON.parse(jsonString) as ThemeData;
    const { fontConfig, theme } = data;
    
    // Check if this is the same theme we already have
    const previousThemeId = currentThemeData?.theme?.id;

    // Store theme data for use during render (don't apply CSS here to avoid flicker)
    currentThemeData = data;

    // Initialize themeManager with font config (needed for buildFontFamily)
    if (fontConfig) {
      if (typeof fontConfig === 'object' && fontConfig !== null && 'fonts' in fontConfig) {
        themeManager.initializeWithData(fontConfig as unknown as FontConfigFile);
      }
    }

    // NOTE: Don't set renderer theme config or apply CSS here!
    // It will be done in handleLoadMarkdown right before clearing the container

    bridge.postMessage('THEME_CHANGED', { themeId: theme?.id });

    // Only re-render if we already have content AND the theme actually changed
    if (currentMarkdown && previousThemeId && previousThemeId !== theme?.id) {
      await handleLoadMarkdown({ content: currentMarkdown, filename: currentFilename || '' });
    } else if (currentMarkdown && !previousThemeId) {
      // First theme load with existing content - need to re-render
      await handleLoadMarkdown({ content: currentMarkdown, filename: currentFilename || '' });
    }
  } catch (error) {
    console.error('[Mobile] applyThemeData failed:', error);
  }
}

/**
 * Handle DOCX export
 */
async function handleExportDocx(): Promise<void> {
  try {
    // Convert filename from .md to .docx
    let docxFilename = currentFilename || 'document.docx';
    if (docxFilename.toLowerCase().endsWith('.md')) {
      docxFilename = docxFilename.slice(0, -3) + '.docx';
    } else if (docxFilename.toLowerCase().endsWith('.markdown')) {
      docxFilename = docxFilename.slice(0, -9) + '.docx';
    } else if (!docxFilename.toLowerCase().endsWith('.docx')) {
      docxFilename = docxFilename + '.docx';
    }

    const exporter = new DocxExporter(createPluginRenderer());
    
    // Report progress to Flutter
    const onProgress = (completed: number, total: number) => {
      bridge.postMessage('EXPORT_PROGRESS', { 
        completed, 
        total,
        phase: 'processing' // processing, packaging, sharing
      });
    };
    
    const result = await exporter.exportToDocx(currentMarkdown, docxFilename, onProgress);

    if (!result.success) {
      throw new Error(result.error || 'Export failed');
    }

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : '';
    console.error('[Mobile] DOCX export failed:', errMsg, errStack);
    bridge.postMessage('EXPORT_ERROR', { error: errMsg });
  }
}

/**
 * Handle settings update
 */
async function handleUpdateSettings(payload: UpdateSettingsPayload): Promise<void> {
  // Reserved for future settings; keep handler to avoid breaking host messages.
}

/**
 * Handle locale change
 */
async function handleSetLocale(payload: SetLocalePayload): Promise<void> {
  try {
    await Localization.setPreferredLocale(payload.locale);
    bridge.postMessage('LOCALE_CHANGED', { locale: payload.locale });
  } catch (error) {
    console.error('[Mobile] Locale change failed:', error);
  }
}

// Extend Window interface for mobile API
declare global {
  interface Window {
    loadMarkdown: (content: string, filename?: string, themeDataJson?: string, scrollLine?: number) => void;
    setTheme: (themeId: string) => void;
    applyThemeData: (jsonString: string) => void;
    exportDocx: () => void;
    getAvailableThemes: () => Promise<unknown>;
    clearCache: () => Promise<boolean>;
    getCacheStats: () => Promise<string | null>;
    setFontSize: (size: number) => Promise<void>;
  }
}

// Expose API to window for host app to call (e.g. via runJavaScript)
window.loadMarkdown = (content: string, filename?: string, themeDataJson?: string, scrollLine?: number) => {
  handleLoadMarkdown({ content, filename, themeDataJson, scrollLine });
};

window.setTheme = (themeId: string) => {
  handleSetTheme({ themeId });
};

// Apply theme data from Flutter (Flutter loads JSON, sends to WebView)
window.applyThemeData = (jsonString: string) => {
  applyThemeData(jsonString);
};

window.exportDocx = () => {
  handleExportDocx();
};

window.getAvailableThemes = async () => {
  return themeManager.getAvailableThemes();
};

window.clearCache = async () => {
  try {
    await platform.cache.clear();
    return true;
  } catch (error) {
    console.error('[Mobile] Failed to clear cache:', error);
    return false;
  }
};

window.getCacheStats = async () => {
  try {
    const stats = await platform.cache.getStats();
    return JSON.stringify(stats);
  } catch (error) {
    console.error('[Mobile] Failed to get cache stats:', error);
    return null;
  }
};

window.setFontSize = async (size: number) => {
  try {
    // Use zoom like Chrome extension (size is treated as percentage base)
    // 16pt = 100%, 12pt = 75%, 24pt = 150%
    currentZoomLevel = size / 16;
    const container = document.getElementById('markdown-content');
    if (container) {
      (container as HTMLElement).style.zoom = String(currentZoomLevel);
    }
  } catch (error) {
    console.error('[Mobile] Failed to set font size:', error);
  }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
