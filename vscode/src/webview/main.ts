/**
 * VS Code Webview Entry Point
 * 
 * Main entry point for the webview that renders Markdown content.
 * This runs inside the VS Code webview and uses the platform abstraction.
 * 
 * Shares core rendering logic with Chrome and Mobile platforms.
 */

import { platform, vscodeBridge } from './api-impl';
import type { AsyncTaskManager, FrontmatterDisplay, HeadingInfo } from '../../../src/core/markdown-processor';
import { wrapFileContent } from '../../../src/utils/file-wrapper';
import type { ScrollSyncController } from '../../../src/core/line-based-scroll';
import type { EmojiStyle } from '../../../src/types/docx.js';
// Shared modules (same as Chrome/Mobile)
import Localization from '../../../src/utils/localization';
import themeManager, { type FontConfigFile, type ThemeRegistry } from '../../../src/utils/theme-manager';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';
import { initSlidevViewer } from '../../../src/slidev/slidev-viewer';
import { resolveTocPresentation, type ViewerContainerMode } from '../../../src/core/viewer/viewer-session-contract';

// Shared utilities from viewer-host
import {
  createViewerScrollSync,
  createPluginRenderer,
  setCurrentFileKey,
  renderMarkdownFlow,
  handleThemeSwitchFlow,
  exportDocxFlow,
  exportHtmlFlow,
} from '../../../src/core/viewer/viewer-host';

// VSCode-specific UI components
import { createSettingsPanel, type SettingsPanel, type ThemeOption, type LocaleOption } from './settings-panel';
import { createSearchPanel, type SearchPanel, type HighlightMatch, type SearchOptions } from './search-panel';
import { createTocPanel, type TocPanel } from '../../../src/ui/toc-panel';
import { setupImageContextMenu } from '../../../src/ui/image-context-menu';
import { setupDiagramLightbox } from '../../../src/ui/diagram-lightbox';
import { setupCodeBlockCopy } from '../../../src/ui/code-block-copy';
import { createExportMenu, type ExportMenu } from '../../../src/ui/export-menu';
import { printElement } from '../../../src/ui/print-utils';
import { isExternalUrl, splitPathAndFragment } from '../../../src/utils/document-url';

// Declare global types for VSCode-specific variables
declare global {
  var VSCODE_WEBVIEW_BASE_URI: string;
  var VSCODE_NONCE: string;
  var VSCODE_CONFIG: Record<string, unknown>;
  var VSCODE_THEME_BOOTSTRAP: {
    fontConfig?: FontConfigFile | null;
    registry?: ThemeRegistry | null;
  };
}

// Make platform globally available (required by loadAndApplyTheme)
globalThis.platform = platform;

// ============================================================================
// Global State (same pattern as Mobile)
// ============================================================================

interface CurrentDocumentState {
  sourceContent: string;
  renderedMarkdown: string;
  filename: string;
  documentKey: string;
  baseUri: string;
}

const currentDocument: CurrentDocumentState = {
  sourceContent: '',
  renderedMarkdown: '',
  filename: '',
  documentKey: '',
  baseUri: '',
};

let currentThemeId = 'default';
let currentTaskManager: AsyncTaskManager | null = null;
let currentZoomLevel = 1;
let isSlidevMode = false;  // Whether currently showing a Slidev presentation

// Render queue for serializing updates (prevents concurrent update bugs)
let renderQueue: Promise<void> = Promise.resolve();

// UI components
let settingsPanel: SettingsPanel | null = null;
let searchPanel: SearchPanel | null = null;
let tocPanel: TocPanel | null = null;
let exportMenu: ExportMenu | null = null;
let currentHighlights: Map<HTMLElement, HTMLElement> = new Map(); // Original element → wrapper
const VIEWER_CONTAINER_MODE: ViewerContainerMode = 'panel';

// Create plugin renderer using shared utility
const pluginRenderer = createPluginRenderer(platform);
let settingsThemesLoaded = false;
let settingsThemesLoading: Promise<void> | null = null;
let settingsLocalesLoaded = false;

// ============================================================================
// Initialization (similar to Mobile)
// ============================================================================

async function initialize(): Promise<void> {
  try {
    // Set bridge on FileStateService for scroll sync communication
    platform.fileState.setBridge(vscodeBridge);

    // Listen for messages from extension host FIRST - before any async operations
    // This ensures we don't miss early messages like SYNC_HOST_NAVIGATION
    vscodeBridge.addListener((message) => {
      handleExtensionMessage(message as ExtensionMessage);
    });

    // Set resource base URI
    if (window.VSCODE_WEBVIEW_BASE_URI) {
      platform.setResourceBaseUri(window.VSCODE_WEBVIEW_BASE_URI);
    }

    // Initialize platform (includes renderer initialization)
    await platform.init();

    const bootstrap = window.VSCODE_THEME_BOOTSTRAP;
    if (bootstrap?.fontConfig && bootstrap?.registry) {
      themeManager.initializeWithData(bootstrap.fontConfig, null, bootstrap.registry);
    }

    // Initialize localization (shared with Chrome/Mobile)
    await Localization.init();

    // Load saved theme using shared themeManager (same as Chrome)
    // This reads 'selectedTheme' from platform.storage
    // Must be done BEFORE initializeUI() so settingsPanel gets the correct initial theme
    currentThemeId = await themeManager.loadSelectedTheme();

    // Initialize toolbar and settings panel (after theme is loaded)
    initializeUI();

    // Pre-initialize render iframe in background to reduce first diagram/html render latency
    platform.renderer.ensureReady().catch((error: Error) => {
      console.warn('[VSCode Webview] Render frame pre-init failed:', error?.message, error?.stack);
    });

    // Load and apply initial theme (all theme logic is in loadAndApplyTheme)
    try {
      await loadAndApplyTheme(currentThemeId);
    } catch (error) {
      console.warn('[VSCode Webview] Failed to load theme, using defaults:', error);
    }

    // Notify extension that webview is ready
    vscodeBridge.postMessage('READY', {});

    void warmSettingsPanelData();
  } catch (error) {
    console.error('[VSCode Webview] Init failed:', error);
  }
}

async function warmSettingsPanelData(): Promise<void> {
  try {
    await Promise.all([
      loadThemesForSettings(),
      loadLocalesForSettings(),
      loadCacheStats(),
    ]);
  } catch {
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
  documentKey?: string;
  documentBaseUri?: string;
  forceRender?: boolean;
  scrollLine?: number;
}

interface OpenDocumentPayload {
  content: string;
  filename?: string;
  documentKey?: string;
  documentBaseUri?: string;
  scrollLine?: number;
}

interface SetThemePayload {
  themeId: string;
}

interface SetZoomPayload {
  zoom: number;
}

interface SyncHostNavigationPayload {
  line: number;
}

function hasCurrentDocument(): boolean {
  return currentDocument.filename.length > 0
    || currentDocument.documentKey.length > 0
    || currentDocument.sourceContent.length > 0;
}

function getCurrentDocumentPayload(overrides: {
  forceRender?: boolean;
  scrollLine?: number;
} = {}): UpdateContentPayload {
  return {
    content: currentDocument.sourceContent,
    filename: currentDocument.filename,
    documentKey: currentDocument.documentKey,
    documentBaseUri: currentDocument.baseUri || undefined,
    ...overrides,
  };
}

async function rerenderCurrentDocument(overrides: {
  forceRender?: boolean;
  scrollLine?: number;
} = {}): Promise<void> {
  if (!hasCurrentDocument()) {
    return;
  }

  await handleUpdateContent(getCurrentDocumentPayload(overrides));
}

function getCurrentScrollLine(): number {
  return scrollSyncController?.getCurrentLine() ?? 0;
}

async function rerenderCurrentDocumentPreservingScroll(): Promise<void> {
  await rerenderCurrentDocument({ forceRender: true, scrollLine: getCurrentScrollLine() });
}

function handleExtensionMessage(message: ExtensionMessage): void {
  const { type, payload } = message;

  switch (type) {
    case 'UPDATE_CONTENT':
      // Serialize updates to prevent concurrent modification bugs
      // When multiple updates arrive rapidly (e.g., AI editing), they must be processed sequentially
      // to ensure DOM and MarkdownDocument state remain consistent
      renderQueue = renderQueue.then(() => handleUpdateContent(payload as UpdateContentPayload));
      break;

    case 'OPEN_DOCUMENT':
      renderQueue = renderQueue.then(() => handleOpenDocument(payload as OpenDocumentPayload));
      break;

    case 'EXPORT_DOCX':
      handleExportDocx();
      break;

    case 'OPEN_EXPORT_MENU':
      handleOpenExportMenu();
      break;

    case 'PRINT':
      handlePrint(payload as { inlineCSS?: string } | undefined);
      break;

    case 'SET_ZOOM':
      handleSetZoom(payload as SetZoomPayload);
      break;

    case 'OPEN_SETTINGS':
      handleOpenSettings();
      break;

    case 'OPEN_SEARCH':
      handleOpenSearch();
      break;

    case 'SYNC_HOST_NAVIGATION':
      handleSyncHostNavigation(payload as SyncHostNavigationPayload);
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
  await handleDocumentUpdate(payload, false);
}

async function handleOpenDocument(payload: OpenDocumentPayload): Promise<void> {
  await handleDocumentUpdate(payload, true);
}

async function handleDocumentUpdate(
  payload: UpdateContentPayload | OpenDocumentPayload,
  forceOpenDocument: boolean,
): Promise<void> {
  const { content, filename, documentBaseUri, forceRender, scrollLine } = payload;
  const container = document.getElementById('markdown-content');

  if (!container) {
    console.error('[VSCode Webview] Content container not found');
    return;
  }

  // Store document base URI for resolving relative paths
  if (typeof documentBaseUri === 'string') {
    currentDocument.baseUri = documentBaseUri;
  }

  // Update DocumentService with document path and base URI
  // This enables rehype-image-uri plugin to rewrite relative image paths
  if (filename && platform.document) {
    platform.document.setDocumentPath(filename, currentDocument.baseUri);
  }

  // Check if file changed
  const newFilename = filename || 'document.md';
  const newDocumentKey = payload.documentKey || newFilename;
  const fileChanged = forceOpenDocument
    || currentDocument.documentKey !== newDocumentKey
    || currentDocument.filename !== newFilename;

  currentDocument.sourceContent = content;
  currentDocument.filename = newFilename;
  currentDocument.documentKey = newDocumentKey;

  // ── Slidev mode: .slides.md files render as presentations ────────────
  const lowerFilename = newFilename.toLowerCase();
  const isSlidevByExtension = lowerFilename.endsWith('.slides.md');
  if (isSlidevByExtension) {
    try {
      isSlidevMode = true;
      tocPanel?.setHeadings([]);

      // Hide normal markdown wrapper and content container,
      // use vscode-root directly as the slidev viewport
      const wrapper = document.getElementById('markdown-wrapper');
      if (wrapper) wrapper.style.display = 'none';
      const contentArea = document.getElementById('vscode-content');
      if (contentArea) contentArea.style.display = 'none';

      const root = document.getElementById('vscode-root')!;
      root.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';
      document.documentElement.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';
      document.body.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';

      // Reuse or create a slidev container
      let slidevContainer = document.getElementById('slidev-container');
      if (!slidevContainer) {
        slidevContainer = document.createElement('div');
        slidevContainer.id = 'slidev-container';
        slidevContainer.style.cssText = 'width:100%;height:100%';
        root.appendChild(slidevContainer);
      }

      const baseUri = window.VSCODE_WEBVIEW_BASE_URI;
      const nonce = window.VSCODE_NONCE;

      // Cache theme bundles for reuse between getThemeCode and onThemeReady
      let themeBundles: Record<string, { code: string; fonts: Record<string, string>; fontUrl?: string; colorSchema?: string }> | null = null;
      async function fetchBundles() {
        if (!themeBundles) {
          const resp = await fetch(`${baseUri}/slidev-theme-bundles.json`);
          if (resp.ok) themeBundles = await resp.json();
        }
        return themeBundles;
      }

      const SLIDEV_TIMEOUT_MS = 15000;
      await Promise.race([
        initSlidevViewer({
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
        getShellHtml: async () => {
          const resp = await fetch(`${baseUri}/slidev-shell-inline.html`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const html = await resp.text();
          return html.replaceAll('__SLIDEV_NONCE__', nonce);
        },
        getThemeCode: async (name) => {
          const bundles = await fetchBundles();
          return bundles?.[name]?.code;
        },
      }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Slidev init timed out after ${SLIDEV_TIMEOUT_MS}ms`)), SLIDEV_TIMEOUT_MS)
        ),
      ]);
      return;
    } catch (err) {
      console.error('[Slidev] Failed to initialize:', err);
      // Restore normal layout and fall through to regular markdown rendering
      isSlidevMode = false;
      const wrapper = document.getElementById('markdown-wrapper');
      if (wrapper) wrapper.style.display = '';
      const contentArea = document.getElementById('vscode-content');
      if (contentArea) contentArea.style.display = '';
      const root = document.getElementById('vscode-root');
      if (root) root.style.cssText = '';
      document.documentElement.style.cssText = '';
      document.body.style.cssText = '';
      const sc = document.getElementById('slidev-container');
      if (sc) sc.remove();
    }
  }

  // ── Normal markdown mode ─────────────────────────────────────────────
  // Restore normal layout if switching from slidev mode
  if (isSlidevMode) {
    isSlidevMode = false;
    const slidevContainer = document.getElementById('slidev-container');
    if (slidevContainer) slidevContainer.remove();
    const wrapper = document.getElementById('markdown-wrapper');
    if (wrapper) wrapper.style.display = '';
    const contentArea = document.getElementById('vscode-content');
    if (contentArea) contentArea.style.display = '';
    const root = document.getElementById('vscode-root');
    if (root) root.style.cssText = '';
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
  }

  // Wrap non-markdown file content (mermaid, vega, graphviz, infographic)
  const wrappedContent = wrapFileContent(content, newFilename);
  
  currentDocument.renderedMarkdown = wrappedContent;

  // Set file key for scroll position persistence (consistent with Chrome/Mobile)
  setCurrentFileKey(currentDocument.documentKey || newFilename);

  // Render using shared flow
  // VSCode: targetLine is passed as scrollLine for anchor navigation and theme switch,
  // or set via SYNC_HOST_NAVIGATION for normal editor scroll sync
  await renderMarkdownFlow({
    markdown: wrappedContent,
    container: container as HTMLElement,
    fileChanged,
    forceRender: forceRender ?? false,
    zoomLevel: currentZoomLevel,
    scrollController: scrollSyncController,
    renderer: pluginRenderer,
    translate: (key: string, subs?: string[]) => Localization.translate(key, subs),
    platform,
    currentTaskManagerRef: { current: currentTaskManager },
    targetLine: scrollLine,
    deferAsyncRenderUntilFirstPaint: window.VSCODE_CONFIG?.deferAsyncRenderUntilFirstPaint === true,
    onHeadings: (headings) => {
      tocPanel?.setHeadings(headings as HeadingInfo[]);
      updateActiveTocHeading();
      vscodeBridge.postMessage('HEADINGS_UPDATED', headings);
    },
    onProgress: (completed, total) => {
      vscodeBridge.postMessage('RENDER_PROGRESS', { completed, total });
    },
  });

}

function updateActiveTocHeading(): void {
  if (!tocPanel) {
    return;
  }

  const contentDiv = document.getElementById('markdown-content');
  const wrapper = document.getElementById('markdown-wrapper');
  if (!contentDiv || !wrapper) {
    tocPanel.setActiveHeading(null);
    return;
  }

  const headings = contentDiv.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
  if (headings.length === 0) {
    tocPanel.setActiveHeading(null);
    return;
  }

  const scrollTop = wrapper.scrollTop;
  const wrapperRect = wrapper.getBoundingClientRect();
  let activeId: string | null = null;

  for (const heading of headings) {
    const top = heading.getBoundingClientRect().top - wrapperRect.top + scrollTop;
    if (top <= scrollTop + 10) {
      activeId = heading.id || null;
    } else {
      break;
    }
  }

  if (!activeId && headings[0]) {
    activeId = headings[0].id || null;
  }

  tocPanel.setActiveHeading(activeId);
}

function scrollToHeadingById(headingId: string): void {
  const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
  const target = document.getElementById(headingId) as HTMLElement | null;
  if (!wrapper || !target) {
    return;
  }

  const wrapperRect = wrapper.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop = targetRect.top - wrapperRect.top + wrapper.scrollTop;
  wrapper.scrollTo({
    top: Math.max(0, targetTop),
    behavior: 'auto'
  });
}

// ============================================================================
// Theme Handling (similar to Mobile)
// ============================================================================

async function handleSetTheme(payload: SetThemePayload): Promise<void> {
  const { themeId } = payload;

  try {
    currentThemeId = themeId;

    await handleThemeSwitchFlow({
      themeId,
      scrollController: scrollSyncController,
      applyTheme: loadAndApplyTheme,
      saveTheme: (id) => themeManager.saveSelectedTheme(id),
      rerender: async (scrollLine) => {
        // Re-render if we have content - force render to regenerate diagrams
        await rerenderCurrentDocument({ forceRender: true, scrollLine });
      },
    });

    vscodeBridge.postMessage('THEME_CHANGED', { themeId });
  } catch (error) {
    console.error('[VSCode Webview] Theme change failed:', error);
  }
}

// ============================================================================
// DOCX Export (same as Mobile)
// ============================================================================

async function handleExportDocx(): Promise<void> {
  await exportDocxFlow({
    markdown: currentDocument.renderedMarkdown,
    filename: currentDocument.filename,
    renderer: pluginRenderer,
    onProgress: (completed, total) => {
      vscodeBridge.postMessage('EXPORT_PROGRESS', { completed, total, phase: 'processing', format: 'docx' });
    },
    onSuccess: (filename) => {
      vscodeBridge.postMessage('EXPORT_DOCX_RESULT', { success: true, filename });
    },
    onError: (error) => {
      vscodeBridge.postMessage('EXPORT_DOCX_RESULT', { success: false, error });
    },
  });
}

async function handleExportHtml(): Promise<void> {
  const page = document.getElementById('markdown-page') as HTMLElement | null;
  if (!page) {
    return;
  }

  await exportHtmlFlow({
    container: page,
    filename: currentDocument.filename,
    title: currentDocument.filename || document.title || 'Markdown Viewer',
    platform,
    onProgress: (completed, total, phase) => {
      vscodeBridge.postMessage('EXPORT_PROGRESS', {
        completed,
        total,
        phase: phase || 'processing',
        format: 'html',
      });
    },
    onSuccess: (filename) => {
      vscodeBridge.postMessage('EXPORT_HTML_RESULT', { success: true, filename });
    },
    onError: (error) => {
      vscodeBridge.postMessage('EXPORT_HTML_RESULT', { success: false, error });
    },
  });
}

async function handlePrint(): Promise<void> {
  const page = document.getElementById('markdown-page') as HTMLElement | null;
  if (!page) {
    return;
  }
  await printElement(page, currentDocument.filename || document.title || 'Markdown Viewer');
}

// ============================================================================
// Zoom Handling (same as Mobile)
// ============================================================================

function handleSetZoom(payload: SetZoomPayload): void {
  const { zoom } = payload;
  const oldZoom = currentZoomLevel;
  currentZoomLevel = zoom / 100; // Convert percentage to decimal
  
  // Skip if no actual change
  if (oldZoom === currentZoomLevel) return;
  
  // Lock scroll position before zoom change
  // No scroll lock needed in simplified scroll controller.
  
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
    setZoom: (zoom: number) => void;
    exportDocx: () => void;
    openSearch: () => void;
    closeSearch: () => void;
  }
}

window.setZoom = (zoom: number) => {
  handleSetZoom({ zoom });
};

window.exportDocx = () => {
  handleExportDocx();
};

window.openSearch = () => {
  if (searchPanel) {
    searchPanel.show();
  }
};

window.closeSearch = () => {
  if (searchPanel) {
    searchPanel.hide();
  }
};

// ============================================================================
// UI Initialization
// ============================================================================

function initializeUI(): void {
  const usesFloatingToc = resolveTocPresentation(VIEWER_CONTAINER_MODE) === 'floating';

  // Setup keyboard shortcut for search (Cmd/Ctrl+F)
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      handleOpenSearch();
    }
  });

  // Setup keyboard shortcut for TOC drawer (Cmd/Ctrl+B)
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      e.stopPropagation();
      if (usesFloatingToc) {
        tocPanel?.toggle();
      }
    }
  });

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
      
      // External links (http/https/mailto/tel/custom schemes)
      if (isExternalUrl(href)) {
        vscodeBridge.postMessage('OPEN_URL', { url: href });
      }
      // Anchor links
      else if (href.startsWith('#')) {
        const targetId = decodeURIComponent(href.slice(1));
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'auto' });
        }
      }
      // Relative links (including .md files)
      else {
        const { path, fragment } = splitPathAndFragment(href);
        if (fragment !== undefined) {
          vscodeBridge.postMessage('OPEN_RELATIVE_FILE', {
            path,
            fragment: decodeURIComponent(fragment),
          });
        } else {
          vscodeBridge.postMessage('OPEN_RELATIVE_FILE', { path });
        }
      }
    });
  }

  // Create settings panel (needs to be in DOM for positioning)
  settingsPanel = createSettingsPanel({
    currentTheme: currentThemeId,
    currentLocale: window.VSCODE_CONFIG?.locale as string || 'auto',
    docxHrDisplay: (window.VSCODE_CONFIG?.docxHrDisplay as 'pageBreak' | 'line' | 'hide') || 'hide',
    docxEmojiStyle: (window.VSCODE_CONFIG?.docxEmojiStyle as EmojiStyle) || 'system',
    frontmatterDisplay: (window.VSCODE_CONFIG?.frontmatterDisplay as FrontmatterDisplay) || 'hide',
    tableMergeEmpty: window.VSCODE_CONFIG?.tableMergeEmpty !== false,
    tableLayout: (window.VSCODE_CONFIG?.tableLayout as 'left' | 'center' | 'center-full-width') || 'center',
    firstLineIndent: (typeof window.VSCODE_CONFIG?.firstLineIndent === 'number' ? window.VSCODE_CONFIG.firstLineIndent : 2) as number,
    onThemeChange: async (themeId) => {
      // handleSetTheme saves via themeManager.saveSelectedTheme (same as Chrome)
      await handleSetTheme({ themeId });
    },
    onLocaleChange: async (locale) => {
      await Localization.setPreferredLocale(locale);
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'locale', value: locale });
      
      // Update settings panel labels
      settingsPanel?.updateLabels();
      
      // Update search panel localization
      searchPanel?.updateLocalization();

      // Update TOC panel localization
      tocPanel?.updateLocalization();
      
      // Reload themes with new locale names
      await loadThemesForSettings();
      
      // Re-render to apply new locale
      await rerenderCurrentDocument();
    },
    onDocxHrDisplayChange: (display) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'docxHrDisplay', value: display });
    },
    onTableMergeEmptyChange: async (enabled) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'tableMergeEmpty', value: enabled });
      // Re-render to apply new table merge setting
      await rerenderCurrentDocumentPreservingScroll();
    },
    onTableLayoutChange: async (layout) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'tableLayout', value: layout });
      // Re-render to apply new table layout setting
      await rerenderCurrentDocumentPreservingScroll();
    },
    onDocxEmojiStyleChange: (style) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'docxEmojiStyle', value: style });
    },
    onFrontmatterDisplayChange: async (display) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'frontmatterDisplay', value: display });
      // Re-render to apply new frontmatter display setting
      await rerenderCurrentDocumentPreservingScroll();
    },
    onFirstLineIndentChange: async (indent) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'firstLineIndent', value: indent });
      // firstLineIndent is baked into theme CSS via loadAndApplyTheme, so we must
      // re-apply the theme to regenerate text-indent before re-rendering content.
      await loadAndApplyTheme(currentThemeId);
      await rerenderCurrentDocumentPreservingScroll();
    },
    onClearCache: async () => {
      await platform.cache.clear();
      // Reload cache stats
      await loadCacheStats();
    },
    onShow: async () => {
      await Promise.all([
        loadThemesForSettings(),
        loadLocalesForSettings(),
      ]);
      // Refresh cache stats when panel is shown
      await loadCacheStats();
    }
  });
  document.body.appendChild(settingsPanel.getElement());

  exportMenu = createExportMenu({
    translate: (key) => Localization.translate(key),
    onExportDocx: () => handleExportDocx(),
    onExportHtml: () => handleExportHtml(),
  });

  // Create search panel
  searchPanel = createSearchPanel({
    onSearch: (query: string, options: SearchOptions) => {
      return performSearch(query, options);
    },
    onClear: () => {
      clearHighlights();
    },
    onNavigate: (index: number) => {
      scrollToHighlight(index);
    },
    onClose: () => {
      clearHighlights();
    }
  });
  document.body.appendChild(searchPanel.getElement());

  if (usesFloatingToc) {
    tocPanel = createTocPanel({
      onSelectHeading: (headingId) => {
        scrollToHeadingById(headingId);
      }
    });
    document.body.appendChild(tocPanel.getElement());
  }

  const wrapper = document.getElementById('markdown-wrapper');
  if (wrapper) {
    wrapper.addEventListener('scroll', () => {
      updateActiveTocHeading();
    });
  }

  // Setup image context menu for saving images (shared cross-platform implementation)
  if (contentContainer) {
    setupImageContextMenu({
      container: contentContainer,
      onDownload: ({ filename, data, mimeType }) => {
        vscodeBridge.sendRequest('DOWNLOAD_FILE', { filename, data, mimeType });
      },
      translate: (key) => Localization.translate(key),
    });

    // Setup diagram lightbox for click-to-zoom (shared cross-platform)
    setupDiagramLightbox({
      container: contentContainer,
      translate: (key) => Localization.translate(key),
    });

    setupCodeBlockCopy({
      container: contentContainer,
      translate: (key) => Localization.translate(key),
    });
  }
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

function handleOpenExportMenu(): void {
  exportMenu?.showAtPosition(window.innerWidth - 220, 10);
}

/**
 * Handle open search command from extension host
 */
function handleOpenSearch(): void {
  if (searchPanel) {
    if (searchPanel.isVisible()) {
      searchPanel.hide();
    } else {
      searchPanel.show();
      searchPanel.focus();
    }
  }
}

/**
 * Load available themes for settings panel
 */
async function loadThemesForSettings(): Promise<void> {
  if (!settingsPanel) return;
  if (settingsThemesLoaded) return;
  if (settingsThemesLoading) {
    await settingsThemesLoading;
    return;
  }

  settingsThemesLoading = (async () => {
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
    settingsThemesLoaded = true;
  })();

  try {
    await settingsThemesLoading;
  } catch (error) {
    settingsThemesLoading = null;
    console.warn('[VSCode Webview] Failed to load themes:', error);
  }
}

/**
 * Load available locales for settings panel
 */
async function loadLocalesForSettings(): Promise<void> {
  if (!settingsPanel) return;
  if (settingsLocalesLoaded) return;

  const registry = Localization.getLocaleRegistry();
  if (registry) {
    settingsPanel.setLocales(registry.locales);
    settingsLocalesLoaded = true;
  } else {
    console.warn('[VSCode Webview] Locale registry not available');
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
// Search Functions
// ============================================================================

/**
 * Perform search in markdown content
 */
function performSearch(query: string, options: SearchOptions): HighlightMatch[] {
  clearHighlights();
  
  if (!query) {
    return [];
  }

  const container = document.getElementById('markdown-content');
  if (!container) {
    return [];
  }

  const matches: HighlightMatch[] = [];
  
  try {
    // Build regex pattern
    let pattern = query;
    
    if (options.useRegex) {
      // Use query as regex directly
      pattern = query;
    } else {
      // Escape special regex characters
      pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
    // Add case sensitivity and word boundary flags
    let flags = options.caseSensitive ? 'g' : 'gi';
    if (options.wholeWord) {
      pattern = `\\b${pattern}\\b`;
    }
    
    const regex = new RegExp(pattern, flags);
    
    // Walk through text nodes and find matches
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      null
    );

    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue;
      
      // Skip matches in script/style tags
      const parent = node.parentElement;
      if (parent?.closest('script, style, [data-search-ignore]')) {
        continue;
      }

      const text = node.textContent;
      let match;
      
      // Reset regex lastIndex for global matching
      regex.lastIndex = 0;
      
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          element: node as HTMLElement,
          startOffset: match.index,
          endOffset: match.index + match[0].length
        });
      }
    }

    // Apply highlights
    if (matches.length > 0) {
      highlightMatches(matches);
    }
  } catch (error) {
    console.warn('[VSCode Webview] Search error:', error);
  }

  return matches;
}

/**
 * Highlight search matches in the DOM
 */
function highlightMatches(matches: HighlightMatch[]): void {
  if (matches.length === 0) return;

  // Group matches by node for efficient processing
  const matchesByNode = new Map<Node, HighlightMatch[]>();
  
  matches.forEach(match => {
    if (!matchesByNode.has(match.element)) {
      matchesByNode.set(match.element, []);
    }
    matchesByNode.get(match.element)!.push(match);
  });

  // Process each text node and its matches
  matchesByNode.forEach((nodeMatches, node) => {
    try {
      if (node.nodeType !== 3) return; // Skip non-text nodes
      
      const text = node.textContent || '';
      const parent = node.parentElement;
      if (!parent) return;

      // Sort matches by start offset
      nodeMatches.sort((a, b) => a.startOffset - b.startOffset);

      // Build new content with highlights
      const fragment = document.createDocumentFragment();
      let lastEnd = 0;

      nodeMatches.forEach((match, index) => {
        // Add text before match
        if (match.startOffset > lastEnd) {
          fragment.appendChild(
            document.createTextNode(text.substring(lastEnd, match.startOffset))
          );
        }

        // Add highlighted match
        const span = document.createElement('mark');
        span.className = 'vscode-search-highlight';
        if (index === 0) {
          span.classList.add('current');
        }
        span.textContent = text.substring(match.startOffset, match.endOffset);
        fragment.appendChild(span);

        lastEnd = match.endOffset;
      });

      // Add remaining text
      if (lastEnd < text.length) {
        fragment.appendChild(document.createTextNode(text.substring(lastEnd)));
      }

      // Replace node with fragment
      parent.replaceChild(fragment, node);
    } catch (error) {
      console.warn('[VSCode Webview] Failed to highlight match:', error);
    }
  });
}

/**
 * Clear all highlights
 */
function clearHighlights(): void {
  document.querySelectorAll('mark.vscode-search-highlight').forEach(mark => {
    const parent = mark.parentElement;
    if (parent) {
      // Replace mark with its text content
      const textNode = document.createTextNode(mark.textContent || '');
      parent.replaceChild(textNode, mark);
      // Normalize to merge adjacent text nodes
      parent.normalize();
    }
  });
  currentHighlights.clear();
}

/**
 * Scroll to specific highlight
 */
function scrollToHighlight(index: number): void {
  const highlights = document.querySelectorAll('.vscode-search-highlight');
  if (index >= 0 && index < highlights.length) {
    const el = highlights[index] as HTMLElement;
    
    // Remove current class from all highlights
    highlights.forEach(h => h.classList.remove('current'));
    
    // Add current class to selected highlight
    el.classList.add('current');
    
    // Scroll into view
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
  }
}

// ============================================================================
// Scroll Sync Logic (using shared ScrollSyncController)
// ============================================================================

let scrollSyncController: ScrollSyncController | null = null;

/**
 * Initialize scroll sync controller
 * Uses shared createViewerScrollSync from viewer-host.
 * The FileStateService handles communication with extension host:
 * - User scroll → FileStateService.set() → REVEAL_LINE message (Preview → Editor)
 * - Editor scroll → SYNC_HOST_NAVIGATION message → FileStateService → scrollController (Editor → Preview)
 */
function initScrollSyncController(): void {
  // Dispose previous controller if exists
  scrollSyncController?.dispose();
  
  try {
    scrollSyncController = createViewerScrollSync({
      containerId: 'markdown-content',
      scrollContainerId: 'markdown-wrapper',
      platform,
      // Default onUserScroll saves to FileStateService, which sends REVEAL_LINE
    });
    scrollSyncController.start();
  } catch (error) {
    console.warn('[WebView] Failed to init scroll sync:', error);
  }
}

/**
 * Handle scroll to line from editor (Editor → Preview)
 * Updates FileStateService so scroll position can be used by rendering
 */
function handleSyncHostNavigation(payload: SyncHostNavigationPayload): void {
  const { line } = payload;
  
  // Update FileStateService (for consistency with Chrome/Mobile)
  const documentKey = currentDocument.documentKey || currentDocument.filename;
  if (documentKey) {
    platform.fileState.setScrollLineFromHost(documentKey, line);
  }
  
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
