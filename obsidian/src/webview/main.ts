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
import { initSlidevViewer } from '../../../src/slidev/slidev-viewer';
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
import { findHeadingLine } from '../../../src/utils/heading-slug';
import { printElement } from '../../../src/ui/print-utils';

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
let isSlidevMode = false;

// Pending anchor fragment to scroll to after next render (set when navigating via link with hash)
let pendingFragment: string | null = null;

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

function applyNormalLayoutStyles(container: HTMLElement): void {
  container.style.height = '100%';
  container.style.overflow = 'hidden';

  const root = container.querySelector('#vscode-root') as HTMLElement | null;
  if (root) {
    root.style.height = '100%';
  }

  const content = container.querySelector('#vscode-content') as HTMLElement | null;
  if (content) {
    content.style.height = '100%';
  }

  const wrapper = container.querySelector('#markdown-wrapper') as HTMLElement | null;
  if (wrapper) {
    wrapper.style.marginLeft = '0';
    wrapper.style.marginTop = '0';
    wrapper.style.marginRight = '0';
    wrapper.style.height = '100%';
    wrapper.style.overflowY = 'auto';
    wrapper.style.overflowX = 'hidden';
  }

  const page = container.querySelector('#markdown-page') as HTMLElement | null;
  if (page) {
    page.style.maxWidth = 'none';
  }
}

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

  applyNormalLayoutStyles(container);

  contentContainer = container.querySelector('#markdown-content') as HTMLElement;

  try {
    // Listen for host messages FIRST (remove previous listener to avoid duplicates on re-open)
    if (unsubscribeBridge) {
      unsubscribeBridge();
    }
    unsubscribeBridge = obsidianBridge.addListener((message) => {
      const msg = message as HostMessage;
      handleHostMessage(msg);
    });

    // Initialize platform services
    await platform.init();
    await Localization.init();

    // Load saved theme
    currentThemeId = await themeManager.loadSelectedTheme();

    // Load saved settings from host
    try {
      const loaded = await obsidianBridge.sendRequest<typeof savedSettings>('LOAD_SETTINGS', {});
      if (loaded) {
        savedSettings = { ...savedSettings, ...loaded };
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
    } catch (error) {
      console.warn('[MV Viewer] Failed to load theme:', error);
    }

    // Load dynamic data for settings
    loadThemesForSettings();
    loadLocalesForSettings();

    // Create scroll sync controller
    try {
      scrollSyncController = createViewerScrollSync({
        containerId: 'markdown-content',
        scrollContainerId: 'markdown-wrapper',
        platform,
      });
    } catch {
      // Container may not exist yet
    }

    // Notify host that viewer is ready
    obsidianBridge.postMessage('READY', {});
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
    case 'OPEN_EXPORT_MENU':
      handleOpenExportMenu();
      break;
    case 'PRINT':
      handlePrint();
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

  currentMarkdown = content;
  currentFilename = newFilename;

  // ── Slidev mode: .slides.md files render as presentations ────────────
  if (newFilename.endsWith('.slides.md')) {
    isSlidevMode = true;

    // Hide normal markdown wrapper
    const wrapper = rootContainer?.querySelector('#markdown-wrapper') as HTMLElement;
    if (wrapper) wrapper.style.display = 'none';

    const root = rootContainer?.querySelector('#vscode-root') as HTMLElement;
    if (root) root.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';
    if (rootContainer) rootContainer.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';

    // Reuse or create a slidev container
    let slidevContainer = rootContainer?.querySelector('#slidev-container') as HTMLElement;
    if (!slidevContainer) {
      slidevContainer = document.createElement('div');
      slidevContainer.id = 'slidev-container';
      slidevContainer.style.cssText = 'width:100%;height:100%';
      (root || rootContainer)?.appendChild(slidevContainer);
    }

    // Cache theme bundles for reuse
    let themeBundles: Record<string, { code: string; fonts: Record<string, string>; fontUrl?: string; colorSchema?: string }> | null = null;
    async function fetchBundles() {
      if (!themeBundles) {
        const json = await platform.resource.fetch('slidev-theme-bundles.json');
        themeBundles = JSON.parse(json);
      }
      return themeBundles;
    }

    await initSlidevViewer({
      rawContent: content,
      container: slidevContainer,
      mode: 'list',
      renderDiagram: (type, code) =>
        platform.renderer.render(type, code).then((r) => ({
          base64: r.base64!,
          width: r.width,
          height: r.height,
        })),
      onThemeReady: async (name) => {
        const bundles = await fetchBundles();
        const entry = bundles?.[name];
        if (entry?.fonts) {
          platform.renderer.setThemeConfig({
            ...platform.renderer.getThemeConfig(),
            fontFamily: entry.fonts.sans || entry.fonts.serif || undefined,
            fontUrl: entry.fontUrl,
            colorSchema: entry.colorSchema as 'light' | 'dark' | 'both' | undefined,
          });
        }
      },
      getShellSource: async () => {
        const html = await platform.resource.fetch('slidev-shell-inline.html');
        const blob = new Blob([html], { type: 'text/html' });
        return URL.createObjectURL(blob);
      },
      getThemeCode: async (name) => {
        const bundles = await fetchBundles();
        return bundles?.[name]?.code;
      },
    });
    return;
  }

  // ── Normal markdown mode ─────────────────────────────────────────────
  // Restore normal layout if switching from slidev mode
  if (isSlidevMode) {
    isSlidevMode = false;
    const slidevContainer = rootContainer?.querySelector('#slidev-container');
    if (slidevContainer) slidevContainer.remove();
    const wrapper = rootContainer?.querySelector('#markdown-wrapper') as HTMLElement;
    if (wrapper) wrapper.style.display = '';
    if (rootContainer) {
      applyNormalLayoutStyles(rootContainer);
    }
  }

  const wrappedContent = wrapFileContent(content, newFilename);
  currentMarkdown = wrappedContent;

  setCurrentFileKey(newFilename);

  // Create scroll controller lazily
  if (!scrollSyncController) {
    try {
      scrollSyncController = createViewerScrollSync({
        containerId: 'markdown-content',
        scrollContainerId: 'markdown-wrapper',
        platform,
      });
    } catch { /* container may not be ready */ }
  }

  // Override scroll position with heading line if navigating via anchor link
  let targetScrollLine = scrollLine;
  if (pendingFragment) {
    const headingLine = findHeadingLine(wrappedContent, pendingFragment);
    if (typeof headingLine === 'number') {
      targetScrollLine = headingLine;
    }
    pendingFragment = null;
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
    targetLine: targetScrollLine,
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

async function handlePrint(): Promise<void> {
  const page = rootContainer?.querySelector('#markdown-page') as HTMLElement | null;
  if (!page) {
    return;
  }
  await printElement(page, currentFilename || document.title || 'Markdown Viewer');
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

function handleOpenExportMenu(): void {
  handleExportDocx().catch((error) => {
    console.error('[MV Viewer] DOCX export unhandled error:', error);
    obsidianBridge.postMessage('EXPORT_DOCX_RESULT', {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
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
        const el = document.getElementById(decodeURIComponent(href.slice(1)));
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      } else {
        // Split hash fragment from path (e.g., ./file.md#section → path + fragment)
        const hashIndex = href.indexOf('#');
        if (hashIndex >= 0) {
          pendingFragment = decodeURIComponent(href.slice(hashIndex + 1));
          obsidianBridge.postMessage('OPEN_RELATIVE_FILE', { path: href.slice(0, hashIndex) });
        } else {
          obsidianBridge.postMessage('OPEN_RELATIVE_FILE', { path: href });
        }
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

  const registry = Localization.getLocaleRegistry();
  if (registry) {
    const locales: LocaleOption[] = registry.locales;
    settingsPanel.setLocales(locales);
  } else {
    console.warn('[Obsidian Viewer] Locale registry not available');
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
