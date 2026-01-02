/**
 * VS Code Webview Entry Point
 * 
 * Main entry point for the webview that renders Markdown content.
 * This runs inside the VS Code webview and uses the platform abstraction.
 * 
 * Shares core rendering logic with Chrome and Mobile platforms.
 */

import { platform, vscodeBridge } from './api-impl';
import { renderMarkdownDocument, getDocument } from '../../../src/core/viewer/viewer-controller';
import { AsyncTaskManager } from '../../../src/core/markdown-processor';
import { wrapFileContent } from '../../../src/utils/file-wrapper';
import { createScrollSyncController, type ScrollSyncController } from '../../../src/core/line-based-scroll';
// Shared modules (same as Chrome/Mobile)
import Localization from '../../../src/utils/localization';
import themeManager from '../../../src/utils/theme-manager';
import DocxExporter from '../../../src/exporters/docx-exporter';
import {
  loadAndApplyTheme,
  applyThemeFromData,
  type ThemeConfig,
  type TableStyleConfig,
  type CodeThemeConfig,
  type SpacingScheme,
  type FontConfig
} from '../../../src/utils/theme-to-css';
import type { PluginRenderer, PlatformAPI } from '../../../src/types/index';
import type { FontConfigFile } from '../../../src/utils/theme-manager';

// VSCode-specific UI components
import { createSettingsPanel, type SettingsPanel, type ThemeOption, type LocaleOption } from './settings-panel';

// Declare global types for VSCode-specific variables
declare global {
  var VSCODE_WEBVIEW_BASE_URI: string;
  var VSCODE_CONFIG: Record<string, unknown>;
}

// Make platform globally available (same as Chrome/Mobile)
globalThis.platform = platform as unknown as PlatformAPI;

// ============================================================================
// Global State (same pattern as Mobile)
// ============================================================================

let currentMarkdown = '';
let currentFilename = '';
let currentThemeId = 'default';
let currentTaskManager: AsyncTaskManager | null = null;
let currentZoomLevel = 1;
let lastRenderedFilename = '';  // Track last rendered file for incremental updates
let currentDocumentBaseUri = '';  // Base URI for resolving relative paths (images, links)

// UI components
let settingsPanel: SettingsPanel | null = null;

/**
 * Theme data structure (same as Mobile)
 */
interface ThemeData {
  fontConfig?: FontConfig;
  theme?: ThemeConfig & { id?: string };
  tableStyle?: TableStyleConfig;
  codeTheme?: CodeThemeConfig;
  spacing?: SpacingScheme;
}

let currentThemeData: ThemeData | null = null;

// ============================================================================
// Plugin Renderer (shared pattern)
// ============================================================================

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

// ============================================================================
// Initialization (similar to Mobile)
// ============================================================================

async function initialize(): Promise<void> {
  try {
    // Listen for messages from extension host FIRST - before any async operations
    // This ensures we don't miss early messages like SCROLL_TO_LINE
    vscodeBridge.addListener((message) => {
      handleExtensionMessage(message as ExtensionMessage);
    });

    // Set resource base URI
    if (window.VSCODE_WEBVIEW_BASE_URI) {
      platform.setResourceBaseUri(window.VSCODE_WEBVIEW_BASE_URI);
    }

    // Initialize platform (includes renderer initialization)
    await platform.init();

    // Initialize localization (shared with Chrome/Mobile)
    await Localization.init();

    // Initialize toolbar and settings panel
    initializeUI();

    // Render iframe is lazily created on first render request
    // No pre-initialization needed - ensureReady() is called in render()

    // Load saved theme from config (default to 'default' theme)
    if (window.VSCODE_CONFIG?.theme && window.VSCODE_CONFIG.theme !== 'auto') {
      currentThemeId = window.VSCODE_CONFIG.theme as string;
    } else {
      currentThemeId = 'default';
    }

    // Try to load and apply initial theme
    try {
      await loadAndApplyTheme(currentThemeId);
    } catch (error) {
      console.warn('[VSCode Webview] Failed to load theme, using defaults:', error);
    }

    // Load themes and locales for settings panel
    loadThemesForSettings();
    loadLocalesForSettings();
    loadCacheStats();

    // Notify extension that webview is ready
    vscodeBridge.postMessage('READY', {});
  } catch (error) {
    console.error('[VSCode Webview] Init failed:', error);
  }
}

// ============================================================================
// Message Handlers (similar to Mobile)
// ============================================================================

interface ExtensionMessage {
  type?: string;
  payload?: unknown;
}

interface UpdateContentPayload {
  content: string;
  filename?: string;
  themeDataJson?: string;
  documentBaseUri?: string;
}

interface SetThemePayload {
  themeId: string;
  themeData?: ThemeData;
}

interface SetZoomPayload {
  zoom: number;
}

interface ScrollToLinePayload {
  line: number;
}

function handleExtensionMessage(message: ExtensionMessage): void {
  const { type, payload } = message;

  switch (type) {
    case 'UPDATE_CONTENT':
      handleUpdateContent(payload as UpdateContentPayload);
      break;

    case 'EXPORT_DOCX':
      handleExportDocx();
      break;

    case 'SET_THEME':
      handleSetTheme(payload as SetThemePayload);
      break;

    case 'SET_ZOOM':
      handleSetZoom(payload as SetZoomPayload);
      break;

    case 'OPEN_SETTINGS':
      handleOpenSettings();
      break;

    case 'SCROLL_TO_LINE':
      handleScrollToLine(payload as ScrollToLinePayload);
      break;

    default:
      // Ignore unknown messages or responses
      break;
  }
}

// ============================================================================
// Content Handling (same logic as Mobile)
// ============================================================================

async function handleUpdateContent(payload: UpdateContentPayload): Promise<void> {
  const { content, filename, themeDataJson, documentBaseUri } = payload;
  const container = document.getElementById('markdown-content');
  
  if (!container) {
    console.error('[VSCode Webview] Content container not found');
    return;
  }

  // Store document base URI for resolving relative paths
  currentDocumentBaseUri = documentBaseUri || '';

  // Update DocumentService with document path and base URI
  // This enables rehype-image-uri plugin to rewrite relative image paths
  if (filename && platform.document) {
    platform.document.setDocumentPath(filename, documentBaseUri);
  }

  // Check if file changed
  const newFilename = filename || 'document.md';
  const fileChanged = currentFilename !== newFilename;

  // Only abort on file switch - incremental updates let old tasks complete naturally
  // (old tasks will find their placeholder gone and silently discard results)
  if (fileChanged && currentTaskManager) {
    currentTaskManager.abort();
    currentTaskManager = null;
  }

  // Wrap non-markdown file content (mermaid, vega, graphviz, infographic)
  const wrappedContent = wrapFileContent(content, newFilename);
  
  currentMarkdown = wrappedContent;
  currentFilename = newFilename;

  try {
    // If theme data is provided with content, apply it (same as Mobile)
    if (themeDataJson) {
      try {
        const data = JSON.parse(themeDataJson) as ThemeData;
        currentThemeData = data;
        
        // Initialize themeManager with font config
        if (data.fontConfig && typeof data.fontConfig === 'object' && 'fonts' in data.fontConfig) {
          themeManager.initializeWithData(data.fontConfig as unknown as FontConfigFile);
        }
      } catch (e) {
        console.error('[VSCode Webview] Failed to parse theme data:', e);
      }
    }

    // Capture theme data at render time (same pattern as Mobile)
    const renderThemeData = currentThemeData;

    // Create task manager with onAbort callback to cancel pending renderer requests
    const taskManager = new AsyncTaskManager(
      (key: string, subs?: string | string[]) => Localization.translate(key, subs),
      { onAbort: () => platform.renderer.cancelPending?.() }
    );
    currentTaskManager = taskManager;

    // NOTE: Don't eagerly create iframe here!
    // The iframe will be created lazily only when a diagram needs to be rendered.
    // This is handled inside platform.renderer.render() which calls ensureReady() internally.

    const pluginRenderer = createPluginRenderer();

    // Only clear container when file changes (for incremental update support)
    if (fileChanged) {
      // Check if this is a real file switch (has existing content) vs initial load
      const isRealFileSwitch = container.childNodes.length > 0;
      
      container.innerHTML = '';
      
      // Only reset scroll state on real file switch, not initial load
      // Initial load: SCROLL_TO_LINE arrives before UPDATE_CONTENT, targetLine already set
      // File switch: need to reset to avoid old targetLine interfering with new document
      if (isRealFileSwitch) {
        scrollSyncController?.resetTargetLine();
      }
    }

    // Apply theme CSS if we have theme data
    if (renderThemeData) {
      const { fontConfig, theme, tableStyle, codeTheme, spacing } = renderThemeData;

      if (theme && tableStyle && codeTheme && spacing) {
        applyThemeFromData(theme, tableStyle, codeTheme, spacing, fontConfig);
      }

      // Set renderer theme config for diagrams
      if (theme?.fontScheme?.body) {
        const fontFamily = themeManager.buildFontFamily(theme.fontScheme.body.fontFamily);
        const fontSize = parseFloat(theme.fontScheme.body.fontSize || '16');
        await platform.renderer.setThemeConfig({ fontFamily, fontSize });
      }
    }

    // Apply zoom level before rendering
    if (currentZoomLevel !== 1) {
      (container as HTMLElement).style.zoom = String(currentZoomLevel);
    }

    // Determine incremental update conditions
    const shouldIncremental = !fileChanged && container.childNodes.length > 0;

    // Render markdown (same as Mobile)
    // Use incremental update only if same file and container has existing content
    const renderResult = await renderMarkdownDocument({
      markdown: wrappedContent,
      container: container as HTMLElement,
      renderer: pluginRenderer,
      translate: (key: string, subs?: string | string[]) => Localization.translate(key, subs),
      taskManager,
      clearContainer: fileChanged,  // Clear only when file changes
      onHeadings: (headings) => {
        vscodeBridge.postMessage('HEADINGS_UPDATED', headings);
      },
    });

    // Track the file we just rendered
    if (!taskManager.isAborted()) {
      lastRenderedFilename = currentFilename;
    }

    if (taskManager.isAborted()) {
      return;
    }

    // Process async tasks after initial render (same pattern as Chrome/Mobile)
    // This renders diagrams, charts, etc.
    await renderResult.taskManager.processAll((completed, total) => {
      if (!taskManager.isAborted()) {
        vscodeBridge.postMessage('RENDER_PROGRESS', { completed, total });
      }
    });

    // Clear task manager reference
    if (currentTaskManager === taskManager) {
      currentTaskManager = null;
    }

    // Notify extension host
    vscodeBridge.postMessage('RENDER_COMPLETE', {
      filename: currentFilename,
      title: renderResult.title || currentFilename
    });

  } catch (error) {
    console.error('[VSCode Webview] Render failed:', error);
    vscodeBridge.postMessage('RENDER_ERROR', {
      error: (error as Error).message
    });
  }
}

// ============================================================================
// Theme Handling (similar to Mobile)
// ============================================================================

async function handleSetTheme(payload: SetThemePayload): Promise<void> {
  const { themeId, themeData } = payload;

  try {
    currentThemeId = themeId;

    if (themeData) {
      // Use provided theme data (same as Mobile applyThemeData)
      currentThemeData = themeData;

      if (themeData.fontConfig && typeof themeData.fontConfig === 'object' && 'fonts' in themeData.fontConfig) {
        themeManager.initializeWithData(themeData.fontConfig as unknown as FontConfigFile);
      }
    } else {
      // Load theme from resources (same as Chrome)
      await loadAndApplyTheme(themeId);
    }

    vscodeBridge.postMessage('THEME_CHANGED', { themeId });

    // Re-render if we have content
    if (currentMarkdown) {
      await handleUpdateContent({ content: currentMarkdown, filename: currentFilename });
    }
  } catch (error) {
    console.error('[VSCode Webview] Theme change failed:', error);
  }
}

// ============================================================================
// DOCX Export (same as Mobile)
// ============================================================================

async function handleExportDocx(): Promise<void> {
  try {
    // Convert filename
    let docxFilename = currentFilename || 'document.docx';
    if (docxFilename.toLowerCase().endsWith('.md')) {
      docxFilename = docxFilename.slice(0, -3) + '.docx';
    } else if (docxFilename.toLowerCase().endsWith('.markdown')) {
      docxFilename = docxFilename.slice(0, -9) + '.docx';
    } else if (!docxFilename.toLowerCase().endsWith('.docx')) {
      docxFilename = docxFilename + '.docx';
    }

    const exporter = new DocxExporter(createPluginRenderer());

    // Report progress
    const onProgress = (completed: number, total: number) => {
      vscodeBridge.postMessage('EXPORT_PROGRESS', { completed, total, phase: 'processing' });
    };

    const result = await exporter.exportToDocx(currentMarkdown, docxFilename, onProgress);

    if (!result.success) {
      throw new Error(result.error || 'Export failed');
    }

    vscodeBridge.postMessage('EXPORT_DOCX_RESULT', { success: true, filename: docxFilename });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[VSCode Webview] DOCX export failed:', errMsg);
    vscodeBridge.postMessage('EXPORT_DOCX_RESULT', { success: false, error: errMsg });
  }
}

// ============================================================================
// Zoom Handling (same as Mobile)
// ============================================================================

function handleSetZoom(payload: SetZoomPayload): void {
  const { zoom } = payload;
  currentZoomLevel = zoom / 100; // Convert percentage to decimal
  
  const container = document.getElementById('markdown-content');
  if (container) {
    (container as HTMLElement).style.zoom = String(currentZoomLevel);
  }
}

// ============================================================================
// Window API (for extension host to call directly, same pattern as Mobile)
// ============================================================================

declare global {
  interface Window {
    loadMarkdown: (content: string, filename?: string, themeDataJson?: string, scrollLine?: number) => void;
    setTheme: (themeId: string) => void;
    setZoom: (zoom: number) => void;
    exportDocx: () => void;
  }
}

window.loadMarkdown = (content: string, filename?: string, themeDataJson?: string, _scrollLine?: number) => {
  // scrollLine is ignored in VSCode - scroll sync is handled via SCROLL_TO_LINE messages
  handleUpdateContent({ content, filename, themeDataJson });
};

window.setTheme = (themeId: string) => {
  handleSetTheme({ themeId });
};

window.setZoom = (zoom: number) => {
  handleSetZoom({ zoom });
};

window.exportDocx = () => {
  handleExportDocx();
};

// ============================================================================
// UI Initialization
// ============================================================================

function initializeUI(): void {
  // Setup link click handling via event delegation
  // This ensures all links (including dynamically added ones) are handled
  const contentContainer = document.getElementById('markdown-content');
  if (contentContainer) {
    contentContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      
      const href = anchor.getAttribute('href') || '';
      e.preventDefault();
      e.stopPropagation();
      
      // External links (http/https) - open in external browser
      if (href.startsWith('http://') || href.startsWith('https://')) {
        vscodeBridge.postMessage('OPEN_URL', { url: href });
      }
      // Anchor links
      else if (href.startsWith('#')) {
        const targetId = href.slice(1);
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth' });
        }
      }
      // Relative links (including .md files)
      else {
        vscodeBridge.postMessage('OPEN_RELATIVE_FILE', { path: href });
      }
    });
  }

  // Create settings panel (needs to be in DOM for positioning)
  settingsPanel = createSettingsPanel({
    currentTheme: currentThemeId,
    currentLocale: window.VSCODE_CONFIG?.locale as string || 'auto',
    docxHrAsPageBreak: window.VSCODE_CONFIG?.docxHrAsPageBreak !== false,
    onThemeChange: async (themeId) => {
      await handleSetTheme({ themeId });
      // Save to extension settings
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'theme', value: themeId });
    },
    onLocaleChange: async (locale) => {
      await Localization.setPreferredLocale(locale);
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'locale', value: locale });
      
      // Update settings panel labels
      settingsPanel?.updateLabels();
      
      // Reload themes with new locale names
      await loadThemesForSettings();
      
      // Re-render to apply new locale
      if (currentMarkdown) {
        await handleUpdateContent({ content: currentMarkdown, filename: currentFilename });
      }
    },
    onDocxSettingChange: (hrAsPageBreak) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'docxHrAsPageBreak', value: hrAsPageBreak });
    },
    onClearCache: async () => {
      await platform.cache.clear();
      // Reload cache stats
      await loadCacheStats();
    },
    onShow: () => {
      // Refresh cache stats when panel is shown
      loadCacheStats();
    }
  });
  document.body.appendChild(settingsPanel.getElement());
}

/**
 * Handle open settings command from extension host
 */
function handleOpenSettings(): void {
  if (settingsPanel) {
    if (settingsPanel.isVisible()) {
      settingsPanel.hide();
    } else {
      // Show settings panel at a fixed position (top-right corner)
      settingsPanel.showAtPosition(window.innerWidth - 300, 10);
    }
  }
}

/**
 * Load available themes for settings panel
 */
async function loadThemesForSettings(): Promise<void> {
  if (!settingsPanel) return;

  try {
    // Fetch theme registry
    const registryUrl = platform.resource.getURL('themes/registry.json');
    const response = await fetch(registryUrl);
    const registry = await response.json() as {
      categories: Record<string, { name: string; name_en: string; order?: number }>;
      themes: Array<{ id: string; file: string; category: string; order?: number }>;
    };

    // Load theme metadata
    const themePromises = registry.themes.map(async (info) => {
      try {
        const url = platform.resource.getURL(`themes/presets/${info.file}`);
        const res = await fetch(url);
        const data = await res.json() as { id: string; name: string; name_en: string };
        const locale = Localization.getLocale();
        const useEnglish = !locale.startsWith('zh');
        const categoryInfo = registry.categories[info.category];
        return {
          id: data.id,
          name: useEnglish ? data.name_en : data.name,
          category: categoryInfo
            ? (useEnglish ? categoryInfo.name_en : categoryInfo.name)
            : info.category,
          categoryOrder: categoryInfo?.order ?? 999,
          themeOrder: info.order ?? 999
        } as ThemeOption & { categoryOrder: number; themeOrder: number };
      } catch {
        return null;
      }
    });

    const themes = (await Promise.all(themePromises))
      .filter((t): t is ThemeOption & { categoryOrder: number; themeOrder: number } => t !== null)
      // Sort by category order, then by theme order
      .sort((a, b) => {
        if (a.categoryOrder !== b.categoryOrder) {
          return a.categoryOrder - b.categoryOrder;
        }
        return a.themeOrder - b.themeOrder;
      });
    
    settingsPanel.setThemes(themes);
  } catch (error) {
    console.warn('[VSCode Webview] Failed to load themes:', error);
  }
}

/**
 * Load available locales for settings panel
 */
async function loadLocalesForSettings(): Promise<void> {
  if (!settingsPanel) return;

  try {
    const url = platform.resource.getURL('_locales/registry.json');
    const response = await fetch(url);
    const registry = await response.json() as {
      locales: Array<{ code: string; name: string }>;
    };

    settingsPanel.setLocales(registry.locales);
  } catch (error) {
    console.warn('[VSCode Webview] Failed to load locales:', error);
  }
}

/**
 * Load cache statistics for settings panel
 */
async function loadCacheStats(): Promise<void> {
  if (!settingsPanel) return;

  try {
    const stats = await platform.cache.getStats();
    if (stats) {
      settingsPanel.setCacheStats({
        itemCount: stats.itemCount,
        totalSizeMB: stats.totalSizeMB,
        maxItems: stats.maxItems
      });
    }
  } catch (error) {
    console.warn('[VSCode Webview] Failed to load cache stats:', error);
  }
}

// ============================================================================
// Scroll Sync Logic (using shared ScrollSyncController)
// ============================================================================

let scrollSyncController: ScrollSyncController | null = null;

/**
 * Initialize scroll sync controller
 */
function initScrollSyncController(): void {
  const container = document.getElementById('vscode-content');
  if (!container) {
    console.warn('[WebView] vscode-content container not found!');
    return;
  }
  
  // Dispose previous controller if exists
  scrollSyncController?.dispose();
  
  scrollSyncController = createScrollSyncController({
    container,
    getLineMapper: getDocument,
    useWindowScroll: false,
    userScrollDebounceMs: 10,  // Reduced for faster reverse sync feedback
    onUserScroll: (line) => {
      // Report user scroll to extension for reverse sync (Preview → Editor)
      vscodeBridge.postMessage('REVEAL_LINE', { line });
    },
  });
  
  scrollSyncController.start();
}

/**
 * Handle scroll to line from editor (Editor → Preview)
 */
function handleScrollToLine(payload: ScrollToLinePayload): void {
  const { line } = payload;
  
  if (scrollSyncController) {
    scrollSyncController.setTargetLine(line);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // Initialize scroll sync controller FIRST so it's ready for early messages
    initScrollSyncController();
    initialize();
  });
} else {
  // Initialize scroll sync controller FIRST so it's ready for early messages
  initScrollSyncController();
  initialize();
}
