/**
 * Obsidian Webview Module
 *
 * Renders markdown content inside a container element in the Obsidian panel.
 * Follows the same pattern as vscode/src/webview/main.ts, reusing
 * the shared core rendering pipeline.
 *
 * Exports an `initializeViewer()` function called by the host (preview-view.ts)
 * instead of self-bootstrapping via DOMContentLoaded.
 */

import { platform, obsidianBridge } from './api-impl';
import type { AsyncTaskManager, FrontmatterDisplay } from '../../../src/core/markdown-processor';
import { wrapFileContent } from '../../../src/utils/file-wrapper';
import type { ScrollSyncController } from '../../../src/core/line-based-scroll';
import type { EmojiStyle } from '../../../src/types/docx.js';

// Shared modules
import Localization from '../../../src/utils/localization';
import themeManager from '../../../src/utils/theme-manager';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';

// Shared utilities from viewer-host
import {
  createViewerScrollSync,
  createPluginRenderer,
  setCurrentFileKey,
  renderMarkdownFlow,
  handleThemeSwitchFlow,
  exportDocxFlow,
} from '../../../src/core/viewer/viewer-host';

// Settings panel (reused from VSCode)
import { createSettingsPanel, type SettingsPanel, type ThemeOption, type LocaleOption } from '../../../vscode/src/webview/settings-panel';

// Make platform globally available (required by loadAndApplyTheme)
globalThis.platform = platform;

// ============================================================================
// Global State
// ============================================================================

// Container element passed in from the host
let rootContainer: HTMLElement | null = null;
let contentContainer: HTMLElement | null = null;

let currentMarkdown = '';
let currentFilename = '';
let currentThemeId = 'default';
let currentTaskManager: AsyncTaskManager | null = null;
let currentZoomLevel = 1;

// Saved settings (loaded from host on init)
let savedSettings: {
  locale: string;
  docxHrDisplay: string;
  docxEmojiStyle: string;
  frontmatterDisplay: string;
  tableMergeEmpty: boolean;
  tableLayout: string;
} = {
  locale: 'auto',
  docxHrDisplay: 'hide',
  docxEmojiStyle: 'system',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: true,
  tableLayout: 'center',
};

// Render queue for serializing updates
let renderQueue: Promise<void> = Promise.resolve();

// UI
let settingsPanel: SettingsPanel | null = null;

// Listener cleanup
let unsubscribeBridge: (() => void) | null = null;

// Plugin renderer
const pluginRenderer = createPluginRenderer(platform);

// Scroll sync controller (created after DOM ready)
let scrollSyncController: ScrollSyncController | null = null;

// ============================================================================
// Initialization (called by host)
// ============================================================================

/**
 * Initialize the viewer inside the given container element.
 * Called by preview-view.ts after creating the DOM structure.
 */
export async function initializeViewer(container: HTMLElement): Promise<void> {
  rootContainer = container;

  // Build DOM structure inside the container
  container.innerHTML = `
    <div id="vscode-root">
      <div id="vscode-content">
        <div id="markdown-wrapper">
          <div id="markdown-page">
            <div id="markdown-content"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  contentContainer = container.querySelector('#markdown-content') as HTMLElement;

  try {
    console.debug('[MV Viewer] initialize() start');

    // Listen for host messages FIRST (remove previous listener to avoid duplicates on re-open)
    if (unsubscribeBridge) {
      unsubscribeBridge();
    }
    unsubscribeBridge = obsidianBridge.addListener((message) => {
      const msg = message as HostMessage;
      console.debug('[MV Viewer] ◀ Received from host:', msg.type);
      handleHostMessage(msg);
    });

    // Initialize platform services
    console.debug('[MV Viewer] platform.init()...');
    await platform.init();
    console.debug('[MV Viewer] platform.init() done');

    console.debug('[MV Viewer] Localization.init()...');
    await Localization.init();
    console.debug('[MV Viewer] Localization.init() done');

    // Load saved theme
    currentThemeId = await themeManager.loadSelectedTheme();
    console.debug('[MV Viewer] Theme loaded:', currentThemeId);

    // Load saved settings from host
    try {
      const loaded = await obsidianBridge.sendRequest<typeof savedSettings>('LOAD_SETTINGS', {});
      if (loaded) {
        savedSettings = { ...savedSettings, ...loaded };
        console.debug('[MV Viewer] Settings loaded:', savedSettings);
      }
      // Apply saved locale
      if (savedSettings.locale && savedSettings.locale !== 'auto') {
        await Localization.setPreferredLocale(savedSettings.locale);
      }
    } catch (error) {
      console.warn('[MV Viewer] Failed to load settings:', error);
    }

    // Initialize UI (settings panel)
    initializeUI();

    // Apply theme
    try {
      await loadAndApplyTheme(currentThemeId);
      console.debug('[MV Viewer] Theme applied');
    } catch (error) {
      console.warn('[MV Viewer] Failed to load theme:', error);
    }

    // Load dynamic data for settings
    loadThemesForSettings();
    loadLocalesForSettings();

    // Create scroll sync controller
    try {
      scrollSyncController = createViewerScrollSync({ platform });
    } catch {
      // Container may not exist yet
    }

    // Notify host that viewer is ready
    console.debug('[MV Viewer] ▶ Sending READY to host');
    obsidianBridge.postMessage('READY', {});
    console.debug('[MV Viewer] Initialization complete!');
  } catch (error) {
    console.error('[MV Viewer] Init failed:', error);
  }
}

// ============================================================================
// Message Handling
// ============================================================================

interface HostMessage {
  type?: string;
  payload?: unknown;
}

interface UpdateContentPayload {
  content: string;
  filename?: string;
  documentPath?: string;
  documentBaseUri?: string;
  forceRender?: boolean;
  scrollLine?: number;
}

function handleHostMessage(message: HostMessage): void {
  const { type, payload } = message;

  switch (type) {
    case 'UPDATE_CONTENT':
      renderQueue = renderQueue.then(() => handleUpdateContent(payload as UpdateContentPayload));
      break;
    case 'EXPORT_DOCX':
      handleExportDocx().catch((error) => {
        console.error('[MV Viewer] DOCX export unhandled error:', error);
        obsidianBridge.postMessage('EXPORT_DOCX_RESULT', {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      break;
    case 'SET_THEME':
      handleSetTheme((payload as { themeId: string }).themeId);
      break;
    case 'OPEN_SETTINGS':
      handleOpenSettings();
      break;
    case 'SCROLL_TO_LINE':
      if (scrollSyncController && payload) {
        scrollSyncController.scrollToLine((payload as { line: number }).line);
      }
      break;
    default:
      break;
  }
}

// ============================================================================
// Image Inlining (Obsidian-specific)
// ============================================================================

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

/**
 * Check if src is a local relative path (not absolute, not data/blob/http)
 */
function isLocalRelativeSrc(src: string): boolean {
  if (!src) return false;
  const lower = src.toLowerCase();
  if (lower.startsWith('data:') || lower.startsWith('blob:') ||
      lower.startsWith('http://') || lower.startsWith('https://') ||
      lower.startsWith('//') || lower.startsWith('file:') ||
      lower.startsWith('app:')) {
    return false;
  }
  return !(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src));
}

/**
 * After rendering, walk the DOM and replace local image src with data URLs.
 * This avoids relying on app:// URLs which are unreliable in Obsidian.
 */
async function inlineLocalImages(container: HTMLElement): Promise<void> {
  const docService = platform.document;
  if (!docService) return;

  const images = Array.from(container.querySelectorAll('img[src]'));
  const tasks = images.map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || !isLocalRelativeSrc(src)) return;

    try {
      // Read binary via host (handleReadLocalFile resolves relative paths)
      const base64 = await docService.readFile(src, { binary: true });
      const ext = (src.split('?')[0]?.split('#')[0] || '').split('.').pop()?.toLowerCase() || '';
      const mimeType = IMAGE_MIME_TYPES[ext] || 'image/png';
      img.setAttribute('src', `data:${mimeType};base64,${base64}`);
    } catch {
      // Leave original src — image will show broken icon
    }
  });

  await Promise.all(tasks);
}

// ============================================================================
// Content Rendering
// ============================================================================

async function handleUpdateContent(payload: UpdateContentPayload): Promise<void> {
  console.debug('[MV Viewer] handleUpdateContent:', payload?.filename, 'length:', payload?.content?.length);
  const { content, filename, documentPath, documentBaseUri, forceRender, scrollLine } = payload;
  const container = contentContainer;
  if (!container) {
    console.error('[MV Viewer] #markdown-content container not found!');
    return;
  }

  // Update document service path with resource base URI
  if (documentPath && platform.document) {
    platform.setDocumentPath(documentPath, documentBaseUri);
  }

  const newFilename = filename || 'document.md';
  const fileChanged = currentFilename !== newFilename;

  const wrappedContent = wrapFileContent(content, newFilename);
  currentMarkdown = wrappedContent;
  currentFilename = newFilename;

  setCurrentFileKey(newFilename);

  // Create scroll controller lazily
  if (!scrollSyncController) {
    try {
      scrollSyncController = createViewerScrollSync({ platform });
    } catch { /* container may not be ready */ }
  }

  await renderMarkdownFlow({
    markdown: wrappedContent,
    container: container as HTMLElement,
    fileChanged,
    forceRender: forceRender ?? false,
    zoomLevel: currentZoomLevel,
    scrollController: scrollSyncController,
    renderer: pluginRenderer,
    translate: (key, subs) => Localization.translate(key, subs),
    platform,
    currentTaskManagerRef: { current: currentTaskManager },
    targetLine: scrollLine,
    onProgress: (completed, total) => {
      obsidianBridge.postMessage('RENDER_PROGRESS', { completed, total });
    },
  });

  // Post-render: inline local images as data URLs
  await inlineLocalImages(container as HTMLElement);
}

// ============================================================================
// Theme
// ============================================================================

async function handleSetTheme(themeId: string): Promise<void> {
  try {
    currentThemeId = themeId;
    await handleThemeSwitchFlow({
      themeId,
      scrollController: scrollSyncController,
      applyTheme: loadAndApplyTheme,
      saveTheme: (id) => themeManager.saveSelectedTheme(id),
      rerender: async (scrollLine) => {
        if (currentMarkdown) {
          await handleUpdateContent({
            content: currentMarkdown,
            filename: currentFilename,
            forceRender: true,
            scrollLine,
          });
        }
      },
    });
    obsidianBridge.postMessage('THEME_CHANGED', { themeId });
  } catch (error) {
    console.error('[Obsidian Webview] Theme change failed:', error);
  }
}

// ============================================================================
// DOCX Export
// ============================================================================

async function handleExportDocx(): Promise<void> {
  await exportDocxFlow({
    markdown: currentMarkdown,
    filename: currentFilename,
    renderer: pluginRenderer,
    onProgress: (completed, total) => {
      obsidianBridge.postMessage('EXPORT_PROGRESS', { completed, total, phase: 'processing' });
    },
    onSuccess: (filename) => {
      obsidianBridge.postMessage('EXPORT_DOCX_RESULT', { success: true, filename });
    },
    onError: (error) => {
      obsidianBridge.postMessage('EXPORT_DOCX_RESULT', { success: false, error });
    },
  });
}

// ============================================================================
// Settings Panel
// ============================================================================

function handleOpenSettings(): void {
  if (settingsPanel) {
    if (settingsPanel.isVisible()) {
      settingsPanel.hide();
    } else {
      settingsPanel.showAtPosition(window.innerWidth - 300, 40);
    }
  }
}

// ============================================================================
// UI Initialisation
// ============================================================================

function initializeUI(): void {
  // Link click handling via event delegation
  if (contentContainer) {
    contentContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute('href') || '';
      e.preventDefault();
      e.stopPropagation();

      if (href.startsWith('http://') || href.startsWith('https://')) {
        obsidianBridge.postMessage('OPEN_URL', { url: href });
      } else if (href.startsWith('#')) {
        const el = document.getElementById(href.slice(1));
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      } else {
        obsidianBridge.postMessage('OPEN_RELATIVE_FILE', { path: href });
      }
    });
  }

  // Settings panel
  settingsPanel = createSettingsPanel({
    currentTheme: currentThemeId,
    currentLocale: savedSettings.locale,
    docxHrDisplay: savedSettings.docxHrDisplay as 'pageBreak' | 'line' | 'hide',
    docxEmojiStyle: savedSettings.docxEmojiStyle as EmojiStyle,
    frontmatterDisplay: savedSettings.frontmatterDisplay as FrontmatterDisplay,
    tableMergeEmpty: savedSettings.tableMergeEmpty,
    tableLayout: savedSettings.tableLayout as 'left' | 'center',
    onThemeChange: async (themeId) => {
      await handleSetTheme(themeId);
    },
    onLocaleChange: async (locale) => {
      await Localization.setPreferredLocale(locale);
      await platform.settings.set('locale', locale);
      settingsPanel?.updateLabels();
      await loadThemesForSettings();
      if (currentMarkdown) {
        await handleUpdateContent({ content: currentMarkdown, filename: currentFilename });
      }
    },
    onDocxHrDisplayChange: async (display) => {
      await platform.settings.set('docxHrDisplay', display);
    },
    onDocxEmojiStyleChange: async (style) => {
      await platform.settings.set('docxEmojiStyle', style);
    },
    onFrontmatterDisplayChange: async (display) => {
      await platform.settings.set('frontmatterDisplay', display);
      if (currentMarkdown) {
        const scrollLine = scrollSyncController?.getCurrentLine() ?? 0;
        await handleUpdateContent({ content: currentMarkdown, filename: currentFilename, forceRender: true, scrollLine });
      }
    },
    onTableMergeEmptyChange: async (enabled) => {
      await platform.settings.set('tableMergeEmpty', enabled);
      if (currentMarkdown) {
        const scrollLine = scrollSyncController?.getCurrentLine() ?? 0;
        await handleUpdateContent({ content: currentMarkdown, filename: currentFilename, forceRender: true, scrollLine });
      }
    },
    onTableLayoutChange: async (layout) => {
      await platform.settings.set('tableLayout', layout);
      if (currentMarkdown) {
        const scrollLine = scrollSyncController?.getCurrentLine() ?? 0;
        await handleUpdateContent({ content: currentMarkdown, filename: currentFilename, forceRender: true, scrollLine });
      }
    },
    onClearCache: async () => {
      await platform.cache.clear();
      await loadCacheStats();
    },
    onShow: () => {
      loadCacheStats();
    },
  });
  if (rootContainer) {
    rootContainer.appendChild(settingsPanel.getElement());
  }
}

// ============================================================================
// Dynamic Settings Data
// ============================================================================

async function loadThemesForSettings(): Promise<void> {
  if (!settingsPanel) return;
  try {
    const registryJson = await platform.resource.fetch('themes/registry.json');
    const registry = JSON.parse(registryJson) as {
      categories: Record<string, { name: string; name_en: string; order?: number }>;
      themes: Array<{ id: string; file: string; category: string; order?: number }>;
    };

    const themePromises = registry.themes.map(async (info) => {
      try {
        const data = JSON.parse(await platform.resource.fetch(`themes/presets/${info.file}`)) as {
          id: string; name: string; name_en: string;
        };
        const locale = Localization.getLocale();
        const useEnglish = !locale.startsWith('zh');
        const cat = registry.categories[info.category];
        return {
          id: data.id,
          name: useEnglish ? data.name_en : data.name,
          category: cat ? (useEnglish ? cat.name_en : cat.name) : info.category,
          categoryOrder: cat?.order ?? 999,
          themeOrder: info.order ?? 999,
        } as ThemeOption & { categoryOrder: number; themeOrder: number };
      } catch { return null; }
    });

    const themes = (await Promise.all(themePromises))
      .filter((t): t is ThemeOption & { categoryOrder: number; themeOrder: number } => t !== null)
      .sort((a, b) => a.categoryOrder !== b.categoryOrder
        ? a.categoryOrder - b.categoryOrder
        : a.themeOrder - b.themeOrder);

    settingsPanel.setThemes(themes);
  } catch (error) {
    console.warn('[Obsidian Viewer] Failed to load themes:', error);
  }
}

async function loadLocalesForSettings(): Promise<void> {
  if (!settingsPanel) return;
  try {
    const registryJson = await platform.resource.fetch('_locales/registry.json');
    const registry = JSON.parse(registryJson) as {
      locales: Array<{ code: string; name: string }>;
    };
    const locales: LocaleOption[] = registry.locales;
    settingsPanel.setLocales(locales);
  } catch (error) {
    console.warn('[Obsidian Viewer] Failed to load locales:', error);
  }
}

// ============================================================================
// Cache Stats
// ============================================================================

async function loadCacheStats(): Promise<void> {
  if (!settingsPanel) return;
  try {
    const stats = await platform.cache.getStats();
    if (stats) {
      settingsPanel.setCacheStats({
        itemCount: stats.itemCount,
        totalSizeMB: stats.totalSizeMB,
        maxItems: stats.maxItems,
      });
    }
  } catch (error) {
    console.warn('[Obsidian Viewer] Failed to load cache stats:', error);
  }
}

// Re-export hostTransport for use by preview-view.ts
export { obsidianHostTransport } from './api-impl';
