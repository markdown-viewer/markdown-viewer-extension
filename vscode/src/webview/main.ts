/**
 * VS Code Webview Entry Point
 * 
 * Main entry point for the webview that renders Markdown content.
 * This runs inside the VS Code webview and uses the platform abstraction.
 * 
 * Shares core rendering logic with Chrome and Mobile platforms.
 */

import { platform, vscodeBridge } from '../../../src/platform/vscode/api-impl';
import { renderMarkdownDocument } from '../../../src/core/viewer/viewer-controller';
import { AsyncTaskManager } from '../../../src/core/markdown-processor';
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

// Declare global types
declare global {
  var platform: PlatformAPI;
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
    // Set resource base URI
    if (window.VSCODE_WEBVIEW_BASE_URI) {
      platform.setResourceBaseUri(window.VSCODE_WEBVIEW_BASE_URI);
    }

    // Initialize platform (includes renderer initialization)
    await platform.init();

    // Initialize localization (shared with Chrome/Mobile)
    await Localization.init();

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

    // Listen for messages from extension host
    vscodeBridge.addListener((message) => {
      handleExtensionMessage(message as ExtensionMessage);
    });

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
}

interface SetThemePayload {
  themeId: string;
  themeData?: ThemeData;
}

interface SetZoomPayload {
  zoom: number;
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

    default:
      // Ignore unknown messages or responses
      break;
  }
}

// ============================================================================
// Content Handling (same logic as Mobile)
// ============================================================================

async function handleUpdateContent(payload: UpdateContentPayload): Promise<void> {
  const { content, filename, themeDataJson } = payload;
  const container = document.getElementById('markdown-content');
  
  if (!container) {
    console.error('[VSCode Webview] Content container not found');
    return;
  }

  // Cancel any pending async tasks from previous render
  if (currentTaskManager) {
    currentTaskManager.abort();
    currentTaskManager = null;
  }

  currentMarkdown = content;
  currentFilename = filename || 'document.md';

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

    // Create task manager
    const taskManager = new AsyncTaskManager((key: string, subs?: string | string[]) => 
      Localization.translate(key, subs)
    );
    currentTaskManager = taskManager;

    // NOTE: Don't eagerly create iframe here!
    // The iframe will be created lazily only when a diagram needs to be rendered.
    // This is handled inside platform.renderer.render() which calls ensureReady() internally.

    const pluginRenderer = createPluginRenderer();

    // Clear container first, then apply theme (avoids flicker)
    container.innerHTML = '';

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

    // Render markdown (same as Mobile)
    const renderResult = await renderMarkdownDocument({
      markdown: content,
      container: container as HTMLElement,
      renderer: pluginRenderer,
      translate: (key: string, subs?: string | string[]) => Localization.translate(key, subs),
      taskManager,
      clearContainer: false,
      processTasks: true,
      onHeadings: (headings) => {
        vscodeBridge.postMessage('HEADINGS_UPDATED', headings);
      },
      onProgress: (completed, total) => {
        if (!taskManager.isAborted()) {
          vscodeBridge.postMessage('RENDER_PROGRESS', { completed, total });
        }
      },
      postProcess: async (el) => {
        await postProcessContent(el);
      },
    });

    if (taskManager.isAborted()) {
      return;
    }

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
// Post-process Content (same as Mobile)
// ============================================================================

async function postProcessContent(container: Element): Promise<void> {
  // Handle all links
  const links = container.querySelectorAll('a[href]');
  for (const link of links) {
    const anchor = link as HTMLAnchorElement;
    const href = anchor.getAttribute('href') || '';
    
    link.addEventListener('click', (e) => {
      e.preventDefault();
      
      // External links (http/https) - open in external browser
      if (href.startsWith('http://') || href.startsWith('https://')) {
        vscodeBridge.postMessage('OPEN_URL', { url: href });
      }
      // Anchor links
      else if (href.startsWith('#')) {
        const targetId = href.slice(1);
        const target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth' });
        }
      }
      // Relative links
      else {
        const isMarkdown = href.endsWith('.md') || href.endsWith('.markdown');
        if (isMarkdown) {
          vscodeBridge.postMessage('OPEN_RELATIVE_FILE', { path: href });
        } else {
          vscodeBridge.postMessage('OPEN_RELATIVE_FILE', { path: href });
        }
      }
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
    loadMarkdown: (content: string, filename?: string, themeDataJson?: string) => void;
    setTheme: (themeId: string) => void;
    setZoom: (zoom: number) => void;
    exportDocx: () => void;
  }
}

window.loadMarkdown = (content: string, filename?: string, themeDataJson?: string) => {
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
// Entry Point
// ============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
