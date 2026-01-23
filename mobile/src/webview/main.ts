// Mobile WebView Entry Point
// This is the main entry point for the mobile WebView
// Note: Diagram renderers (mermaid, vega, etc.) run in a separate iframe

import { platform, bridge } from './api-impl';
import Localization from '../../../src/utils/localization';
import themeManager from '../../../src/utils/theme-manager';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';
import type { AsyncTaskManager } from '../../../src/core/markdown-processor';
import type { ScrollSyncController } from '../../../src/core/line-based-scroll';
import type { PlatformBridgeAPI } from '../../../src/types/index';

// Import shared utilities from viewer-host
import {
  createViewerScrollSync,
  createPluginRenderer,
  setCurrentFileKey,
  applyZoom,
  renderMarkdownFlow,
  handleThemeSwitchFlow,
  exportDocxFlow,
} from '../../../src/core/viewer/viewer-host';

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
let currentFilePath = ''; // File path for state persistence (used by FileStateService)
let currentThemeId = 'default'; // Current theme ID (loaded via shared loadAndApplyTheme)
let currentTaskManager: AsyncTaskManager | null = null; // Track current task manager for cancellation
let currentZoomLevel = 1; // Store current zoom level for applying after content render
let scrollSyncController: ScrollSyncController | null = null; // Scroll sync controller

// Create plugin renderer using shared utility
const pluginRenderer = createPluginRenderer(platform);

/**
 * Load markdown payload
 */
interface LoadMarkdownPayload {
  content: string;
  filename?: string;
  filePath?: string;    // File path for state persistence
  themeId?: string;     // Theme ID (WebView loads theme data itself)
  scrollLine?: number;  // Saved scroll position (line number) - legacy, prefer fileState
  forceRender?: boolean; // Force re-render even if file hasn't changed (e.g., theme change)
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

    // Initialize theme manager (loads font-config.json and registry.json)
    // This must complete before we can load themes
    await themeManager.initialize();

    // Load and apply default theme at initialization (consistent with Chrome/VSCode)
    try {
      currentThemeId = await themeManager.loadSelectedTheme();
      await loadAndApplyTheme(currentThemeId);
    } catch (error) {
      console.error('[Mobile] Failed to load theme at init:', error);
    }

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
 * Uses shared createViewerScrollSync from viewer-host
 */
function initScrollSyncController(): void {
  try {
    scrollSyncController = createViewerScrollSync({
      containerId: 'markdown-content',
      platform,
      // Default onUserScroll saves to FileStateService using currentFileKey
      // which is set via setCurrentFileKey() when loading a file
    });
    scrollSyncController.start();
  } catch (error) {
    console.warn('[Mobile] Failed to init scroll sync:', error);
  }
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
  const { content, filename, filePath, themeId, scrollLine, forceRender } = payload;

  // Check if file changed
  const newFilename = filename || 'document.md';
  const newFilePath = filePath || newFilename; // Fallback to filename if no path
  const fileChanged = currentFilename !== newFilename;

  currentMarkdown = content;
  currentFilename = newFilename;
  currentFilePath = newFilePath;

  // Set file key for scroll position persistence (used by viewer-host)
  setCurrentFileKey(newFilePath);

  // Get saved scroll position from FileStateService (fallback to legacy scrollLine param)
  let savedScrollLine = scrollLine ?? 0;
  if (currentFilePath) {
    try {
      const fileState = await platform.fileState.get(currentFilePath);
      if (fileState.scrollLine !== undefined) {
        savedScrollLine = fileState.scrollLine;
      }
    } catch {
      // Use legacy scrollLine on error
    }
  }

  // Update theme if provided (Flutter sends themeId, we load it ourselves)
  if (themeId && themeId !== currentThemeId) {
    currentThemeId = themeId;
    // Theme change will be applied via handleSetTheme, not here
  }

  const container = document.getElementById('markdown-content');
  if (!container) {
    console.error('[Mobile] Content container not found');
    return;
  }

  // Render using shared flow
  await renderMarkdownFlow({
    markdown: content,
    container: container as HTMLElement,
    fileChanged,
    forceRender: forceRender ?? false,
    zoomLevel: currentZoomLevel,
    scrollController: scrollSyncController,
    renderer: pluginRenderer,
    translate: (key: string, subs?: string | string[]) => Localization.translate(key, subs),
    platform,
    currentTaskManagerRef: { current: currentTaskManager },
    targetLine: savedScrollLine,
    onHeadings: (headings) => {
      bridge.postMessage('HEADINGS_UPDATED', headings);
    },
    onProgress: (completed, total) => {
      bridge.postMessage('RENDER_PROGRESS', { completed, total });
    },
  });
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
 * Handle theme change - called when Flutter sends theme ID
 * WebView loads theme data itself using shared loadAndApplyTheme
 */
async function handleSetTheme(payload: SetThemePayload): Promise<void> {
  const { themeId } = payload;
  
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
      rerender: async (scrollLine) => {
        // Re-render if we have content
        if (currentMarkdown) {
          await handleLoadMarkdown({ content: currentMarkdown, filename: currentFilename || '', scrollLine, forceRender: true });
        }
      },
    });
    
    // Notify Flutter of theme change
    bridge.postMessage('THEME_CHANGED', { themeId });
  } catch (error) {
    console.error('[Mobile] Failed to load theme:', error);
  }
}

/**
 * Handle DOCX export
 */
async function handleExportDocx(): Promise<void> {
  await exportDocxFlow({
    markdown: currentMarkdown,
    filename: currentFilename,
    renderer: pluginRenderer,
    onProgress: (completed, total) => {
      bridge.postMessage('EXPORT_PROGRESS', { 
        completed, 
        total,
        phase: 'processing' // processing, packaging, sharing
      });
    },
    onSuccess: () => {
      // Mobile doesn't send success message - Flutter handles the file
    },
    onError: (error) => {
      bridge.postMessage('EXPORT_ERROR', { error });
    },
  });
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
    
    // Re-render content with new locale (for translated error messages, etc.)
    if (currentMarkdown) {
      await handleLoadMarkdown({ content: currentMarkdown, filename: currentFilename || '' });
    }
  } catch (error) {
    console.error('[Mobile] Locale change failed:', error);
  }
}

// Extend Window interface for mobile API
// Most functionality is now on platform object, only expose minimal API for Flutter calls
declare global {
  interface Window {
    // Content loading (Flutter sends themeId, WebView loads theme itself)
    loadMarkdown: (content: string, filename?: string, themeId?: string, scrollLine?: number) => void;
    // Theme change (Flutter sends themeId only)
    setTheme: (themeId: string) => void;
    // Export
    exportDocx: () => void;
    // Display settings
    setFontSize: (size: number) => void;
    setLocale: (locale: string) => void;
    // Re-render with updated settings
    rerender: () => Promise<void>;
    // Platform object has all services: platform.cache, platform.i18n, etc.
  }
}

// Expose API to window for host app to call (e.g. via runJavaScript)
// Supports both object payload and legacy positional arguments
window.loadMarkdown = (
  contentOrPayload: string | LoadMarkdownPayload, 
  filename?: string, 
  themeId?: string, 
  scrollLine?: number
) => {
  // Check if first argument is object payload or string content
  if (typeof contentOrPayload === 'object' && contentOrPayload !== null) {
    handleLoadMarkdown(contentOrPayload);
  } else {
    // Legacy: positional arguments
    handleLoadMarkdown({ content: contentOrPayload, filename, themeId, scrollLine });
  }
};

// Set theme (WebView loads theme data itself using shared loadAndApplyTheme)
window.setTheme = (themeId: string) => {
  handleSetTheme({ themeId });
};

window.exportDocx = () => {
  handleExportDocx();
};

window.setFontSize = (size: number) => {
  try {
    const oldZoom = currentZoomLevel;
    // Use zoom like Chrome extension (size is treated as percentage base)
    // 16pt = 100%, 12pt = 75%, 24pt = 150%
    currentZoomLevel = size / 16;
    
    // Skip if no actual change
    if (oldZoom === currentZoomLevel) return;
    
    // Apply zoom using shared utility (handles scroll lock internally)
    applyZoom({
      zoom: currentZoomLevel * 100,
      containerId: 'markdown-content',
      scrollController: scrollSyncController,
    });
  } catch (error) {
    console.error('[Mobile] Failed to set font size:', error);
  }
};

window.setLocale = (locale: string) => {
  handleSetLocale({ locale });
};

window.rerender = async () => {
  // Re-render current markdown with updated settings
  if (currentMarkdown) {
    await handleLoadMarkdown({ content: currentMarkdown, filename: currentFilename || '', forceRender: true });
  }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
