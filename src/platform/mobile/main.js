// Mobile WebView Entry Point
// This is the main entry point for the mobile WebView
// Note: Diagram renderers (mermaid, vega, etc.) run in a separate iframe

import { platform, bridge } from './api-impl.js';
import Localization from '../../utils/localization.js';
import themeManager from '../../utils/theme-manager.js';
import { applyThemeFromData } from '../../utils/theme-to-css.js';
import {
  processMarkdownToHtml,
  AsyncTaskManager,
  extractTitle,
  extractHeadings,
  renderHtmlIncrementally
} from '../../core/markdown-processor.js';

// Make platform globally available (same as Chrome)
globalThis.platform = platform;

// Global state
let currentMarkdown = '';
let currentFilename = '';
let currentThemeData = null; // Store theme data for applying during render
let currentTaskManager = null; // Track current task manager for cancellation

/**
 * Initialize the mobile viewer
 */
async function initialize() {
  try {
    // Initialize localization (will use fallback if fetch fails)
    await Localization.init();

    // Theme will be loaded from Flutter via applyThemeData
    // Don't try to load theme here - Flutter will send it after WebView is ready

    // Pre-initialize render iframe (don't wait, let it load in background)
    platform.renderer.ensureIframe().catch(err => {
      console.warn('[Mobile] Render frame pre-init failed:', err);
    });

    // Set up message handlers from host app (Flutter)
    setupMessageHandlers();

    // Notify host app that WebView is ready
    platform.notifyReady();
  } catch (error) {
    console.error('[Mobile] Initialization failed:', error);
  }
}

/**
 * Set up handlers for messages from host app
 */
function setupMessageHandlers() {
  bridge.addListener(async (message) => {
    if (!message || !message.type) return;

    try {
      switch (message.type) {
        case 'LOAD_MARKDOWN':
          await handleLoadMarkdown(message.payload);
          break;

        case 'SET_THEME':
          await handleSetTheme(message.payload);
          break;

        case 'EXPORT_DOCX':
          await handleExportDocx();
          break;

        case 'UPDATE_SETTINGS':
          await handleUpdateSettings(message.payload);
          break;

        case 'SET_LOCALE':
          await handleSetLocale(message.payload);
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
async function handleLoadMarkdown({ content, filename, themeDataJson }) {
  // Abort any pending async tasks from previous render
  if (currentTaskManager) {
    currentTaskManager.abort();
    currentTaskManager = null;
  }

  currentMarkdown = content;
  currentFilename = filename || 'document.md';

  try {
    // If theme data is provided with content, set it first (avoids race condition)
    if (themeDataJson) {
      try {
        const data = JSON.parse(themeDataJson);
        currentThemeData = data;
        
        // Initialize themeManager with font config
        if (data.fontConfig) {
          themeManager.initialize(data.fontConfig);
        }
      } catch (e) {
        console.error('[Mobile] Failed to parse theme data:', e);
      }
    }

    // Create task manager for async rendering and store reference for potential cancellation
    const taskManager = new AsyncTaskManager((key, subs) => Localization.translate(key, subs));
    currentTaskManager = taskManager;
    // Process markdown to HTML using shared processor
    // Use platform.renderer which has all renderers registered
    const html = await processMarkdownToHtml(content, {
      renderer: platform.renderer,
      taskManager,
      translate: (key, subs) => Localization.translate(key, subs)
    });
    
    // Check if aborted during HTML processing
    if (taskManager.isAborted()) {
      return;
    }

    // Render to DOM incrementally to avoid blocking the main thread
    const container = document.getElementById('markdown-content');
    if (container) {
      // Clear container FIRST, then apply theme (avoids flicker from old content with new style)
      container.innerHTML = ''; // Clear previous content
      
      // Now apply theme CSS (container is empty, no flicker)
      if (currentThemeData) {
        const { fontConfig, theme, tableStyle, codeTheme, spacing } = currentThemeData;
        applyThemeFromData(theme, tableStyle, codeTheme, spacing, fontConfig);
        
        // Also set renderer theme config for diagrams
        if (theme && theme.fontScheme && theme.fontScheme.body) {
          const fontFamily = themeManager.buildFontFamily(theme.fontScheme.body.fontFamily);
          const fontSize = parseFloat(theme.fontScheme.body.fontSize);
          await platform.renderer.setThemeConfig({
            fontFamily: fontFamily,
            fontSize: fontSize
          });
          
          // Initialize Mermaid with new font
          if (window.mermaid && typeof window.mermaid.initialize === 'function') {
            window.mermaid.initialize({
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

      await renderHtmlIncrementally(container, html, { batchSize: 200, yieldDelay: 0 });
      
      // Check if aborted during incremental render
      if (taskManager.isAborted()) {
        return;
      }

      // Extract headings from DOM after rendering
      const headings = extractHeadings(container);
      bridge.postMessage('HEADINGS_UPDATED', headings);

      // Process async tasks (diagram rendering)
      const completed = await taskManager.processAll(
        (completed, total) => {
          if (!taskManager.isAborted()) {
            bridge.postMessage('RENDER_PROGRESS', { completed, total });
          }
        }
      );
      
      // Check if aborted during async tasks
      if (taskManager.isAborted() || !completed) {
        return;
      }

      // Post-process: initialize any interactive elements
      await postProcessContent(container);
    }

    // Clear task manager reference after successful completion
    if (currentTaskManager === taskManager) {
      currentTaskManager = null;
    }

    // Notify host app that rendering is complete
    bridge.postMessage('RENDER_COMPLETE', {
      filename: currentFilename,
      title: extractTitle(content) || currentFilename
    });

  } catch (error) {
    console.error('[Mobile] Markdown processing failed:', error);
    bridge.postMessage('RENDER_ERROR', {
      error: error.message
    });
  }
}

/**
 * Post-process rendered content
 */
async function postProcessContent(container) {
  // Make external links open in system browser
  const links = container.querySelectorAll('a[href^="http"]');
  for (const link of links) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      bridge.postMessage('OPEN_URL', { url: link.href });
    });
  }
}

/**
 * Handle theme change - called when Flutter sends theme data
 * @deprecated Use applyThemeData instead - Flutter now sends complete theme data
 */
async function handleSetTheme({ themeId }) {
  // This is now a no-op - theme changes come through applyThemeData
  console.warn('[Mobile] handleSetTheme called but theme loading is now handled by Flutter');
  bridge.postMessage('THEME_CHANGED', { themeId });
}

/**
 * Apply theme data received from Flutter
 * Flutter loads theme JSON from assets and sends it to WebView
 */
async function applyThemeData(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    const { fontConfig, theme } = data;
    
    // Check if this is the same theme we already have
    const previousThemeId = currentThemeData?.theme?.id;

    // Store theme data for use during render (don't apply CSS here to avoid flicker)
    currentThemeData = data;

    // Initialize themeManager with font config (needed for buildFontFamily)
    if (fontConfig) {
      themeManager.initialize(fontConfig);
    }

    // NOTE: Don't set renderer theme config or apply CSS here!
    // It will be done in handleLoadMarkdown right before clearing the container

    bridge.postMessage('THEME_CHANGED', { themeId: theme.id });

    // Only re-render if we already have content AND the theme actually changed
    if (currentMarkdown && previousThemeId && previousThemeId !== theme.id) {
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
async function handleExportDocx() {
  try {
    // Dynamic import to avoid loading docx library until needed
    const { exportToDocx } = await import('../../exporters/docx-exporter.js');

    const result = await exportToDocx(currentMarkdown, {
      filename: currentFilename,
      theme: themeManager.getCurrentTheme()
    });

    // Use unified file service for download
    const outputFilename = currentFilename.replace(/\.md$/i, '.docx');
    await platform.file.download(
      result.base64,
      outputFilename,
      { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    );

  } catch (error) {
    console.error('[Mobile] DOCX export failed:', error);
    bridge.postMessage('EXPORT_ERROR', { error: error.message });
  }
}

/**
 * Handle settings update
 */
async function handleUpdateSettings({ settings }) {
  // Reserved for future settings; keep handler to avoid breaking host messages.
}

/**
 * Handle locale change
 */
async function handleSetLocale({ locale }) {
  try {
    await Localization.setPreferredLocale(locale);
    bridge.postMessage('LOCALE_CHANGED', { locale });
  } catch (error) {
    console.error('[Mobile] Locale change failed:', error);
  }
}

// Expose API to window for host app to call (e.g. via runJavaScript)
window.loadMarkdown = (content, filename, themeDataJson) => {
  handleLoadMarkdown({ content, filename, themeDataJson });
};

window.setTheme = (themeId) => {
  handleSetTheme({ themeId });
};

// Apply theme data from Flutter (Flutter loads JSON, sends to WebView)
window.applyThemeData = (jsonString) => {
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

window.setFontSize = async (size) => {
  try {
    // Use zoom like Chrome extension (size is treated as percentage base)
    // 16pt = 100%, 12pt = 75%, 24pt = 150%
    const zoomLevel = size / 16;
    const container = document.getElementById('markdown-content');
    if (container) {
      container.style.zoom = zoomLevel;
    }
  } catch (error) {
    console.error('[Mobile] Failed to set font size:', error);
  }
};

window.setLineBreaks = async (enabled) => {
  try {
    // Store setting for next render
    window.__lineBreaksEnabled = enabled;
    // Re-render if we have content
    if (currentMarkdown) {
      handleLoadMarkdown({ content: currentMarkdown, filename: currentFilename });
    }
  } catch (error) {
    console.error('[Mobile] Failed to set line breaks:', error);
  }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
