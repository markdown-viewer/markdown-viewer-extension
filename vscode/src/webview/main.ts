/**
 * VS Code Webview Entry Point
 * 
 * Main entry point for the webview that renders Markdown content.
 * This runs inside the VS Code webview and uses the platform abstraction.
 * 
 * Shares core rendering logic with Chrome and Mobile platforms.
 */

import { platform, vscodeBridge } from './api-impl';
import type { AsyncTaskManager, FrontmatterDisplay } from '../../../src/core/markdown-processor';
import { wrapFileContent } from '../../../src/utils/file-wrapper';
import type { ScrollSyncController } from '../../../src/core/line-based-scroll';
import type { EmojiStyle } from '../../../src/types/docx.js';
// Shared modules (same as Chrome/Mobile)
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

// VSCode-specific UI components
import { createSettingsPanel, type SettingsPanel, type ThemeOption, type LocaleOption } from './settings-panel';
import { createSearchPanel, type SearchPanel, type HighlightMatch, type SearchOptions } from './search-panel';

// Declare global types for VSCode-specific variables
declare global {
  var VSCODE_WEBVIEW_BASE_URI: string;
  var VSCODE_CONFIG: Record<string, unknown>;
}

// Make platform globally available (required by loadAndApplyTheme)
globalThis.platform = platform;

// ============================================================================
// Global State (same pattern as Mobile)
// ============================================================================

let currentMarkdown = '';
let currentFilename = '';
let currentThemeId = 'default';
let currentTaskManager: AsyncTaskManager | null = null;
let currentZoomLevel = 1;
let currentDocumentBaseUri = '';  // Base URI for resolving relative paths (images, links)

// Render queue for serializing updates (prevents concurrent update bugs)
let renderQueue: Promise<void> = Promise.resolve();

// UI components
let settingsPanel: SettingsPanel | null = null;
let searchPanel: SearchPanel | null = null;
let currentHighlights: Map<HTMLElement, HTMLElement> = new Map(); // Original element → wrapper

// Create plugin renderer using shared utility
const pluginRenderer = createPluginRenderer(platform);

// ============================================================================
// Initialization (similar to Mobile)
// ============================================================================

async function initialize(): Promise<void> {
  try {
    // Set bridge on FileStateService for scroll sync communication
    platform.fileState.setBridge(vscodeBridge);

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

    // Load saved theme using shared themeManager (same as Chrome)
    // This reads 'selectedTheme' from platform.storage
    // Must be done BEFORE initializeUI() so settingsPanel gets the correct initial theme
    currentThemeId = await themeManager.loadSelectedTheme();

    // Initialize toolbar and settings panel (after theme is loaded)
    initializeUI();

    // Render iframe is lazily created on first render request
    // No pre-initialization needed - ensureReady() is called in render()

    // Load and apply initial theme (all theme logic is in loadAndApplyTheme)
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
  documentBaseUri?: string;
  forceRender?: boolean;
  scrollLine?: number;
}

interface SetThemePayload {
  themeId: string;
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
      // Serialize updates to prevent concurrent modification bugs
      // When multiple updates arrive rapidly (e.g., AI editing), they must be processed sequentially
      // to ensure DOM and MarkdownDocument state remain consistent
      renderQueue = renderQueue.then(() => handleUpdateContent(payload as UpdateContentPayload));
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

    case 'OPEN_SEARCH':
      handleOpenSearch();
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
  const { content, filename, documentBaseUri, forceRender, scrollLine } = payload;
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

  // Wrap non-markdown file content (mermaid, vega, graphviz, infographic)
  const wrappedContent = wrapFileContent(content, newFilename);
  
  currentMarkdown = wrappedContent;
  currentFilename = newFilename;

  // Set file key for scroll position persistence (consistent with Chrome/Mobile)
  setCurrentFileKey(newFilename);

  // Render using shared flow
  // VSCode: targetLine is set via SCROLL_TO_LINE message before UPDATE_CONTENT,
  // or passed as scrollLine parameter during theme switch
  await renderMarkdownFlow({
    markdown: wrappedContent,
    container: container as HTMLElement,
    fileChanged,
    forceRender: forceRender ?? false,
    zoomLevel: currentZoomLevel,
    scrollController: scrollSyncController,
    renderer: pluginRenderer,
    translate: (key: string, subs?: string | string[]) => Localization.translate(key, subs),
    platform,
    currentTaskManagerRef: { current: currentTaskManager },
    // When scrollLine is provided (e.g., theme switch), use it; otherwise undefined
    targetLine: scrollLine,
    onHeadings: (headings) => {
      vscodeBridge.postMessage('HEADINGS_UPDATED', headings);
    },
    onProgress: (completed, total) => {
      vscodeBridge.postMessage('RENDER_PROGRESS', { completed, total });
    },
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
        if (currentMarkdown) {
          await handleUpdateContent({ content: currentMarkdown, filename: currentFilename, forceRender: true, scrollLine });
        }
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
    markdown: currentMarkdown,
    filename: currentFilename,
    renderer: pluginRenderer,
    onProgress: (completed, total) => {
      vscodeBridge.postMessage('EXPORT_PROGRESS', { completed, total, phase: 'processing' });
    },
    onSuccess: (filename) => {
      vscodeBridge.postMessage('EXPORT_DOCX_RESULT', { success: true, filename });
    },
    onError: (error) => {
      vscodeBridge.postMessage('EXPORT_DOCX_RESULT', { success: false, error });
    },
  });
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
    loadMarkdown: (content: string, filename?: string, themeId?: string, scrollLine?: number) => void;
    setTheme: (themeId: string) => void;
    setZoom: (zoom: number) => void;
    exportDocx: () => void;
    openSearch: () => void;
    closeSearch: () => void;
  }
}

window.loadMarkdown = (content: string, filename?: string, _themeId?: string, _scrollLine?: number) => {
  // themeId and scrollLine are ignored in VSCode - theme is managed separately
  // and scroll sync is handled via SCROLL_TO_LINE messages
  renderQueue = renderQueue.then(() => handleUpdateContent({ content, filename }));
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
  // Setup keyboard shortcut for search (Cmd/Ctrl+F)
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      handleOpenSearch();
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
    docxEmojiStyle: (window.VSCODE_CONFIG?.docxEmojiStyle as EmojiStyle) || 'system',
    frontmatterDisplay: (window.VSCODE_CONFIG?.frontmatterDisplay as FrontmatterDisplay) || 'hide',
    tableMergeEmpty: window.VSCODE_CONFIG?.tableMergeEmpty !== false,
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
    onTableMergeEmptyChange: async (enabled) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'tableMergeEmpty', value: enabled });
      // Re-render to apply new table merge setting
      if (currentMarkdown) {
        const scrollLine = scrollSyncController?.getCurrentLine() ?? 0;
        await handleUpdateContent({ content: currentMarkdown, filename: currentFilename, forceRender: true, scrollLine });
      }
    },
    onDocxEmojiStyleChange: (style) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'docxEmojiStyle', value: style });
    },
    onFrontmatterDisplayChange: async (display) => {
      vscodeBridge.postMessage('SAVE_SETTING', { key: 'frontmatterDisplay', value: display });
      // Re-render to apply new frontmatter display setting
      if (currentMarkdown) {
        const scrollLine = scrollSyncController?.getCurrentLine() ?? 0;
        await handleUpdateContent({ content: currentMarkdown, filename: currentFilename, forceRender: true, scrollLine });
      }
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
      
      // Skip matches in code blocks or pre tags
      const parent = node.parentElement;
      if (parent?.closest('code, pre, script, style, [data-search-ignore]')) {
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
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
 * - Editor scroll → SCROLL_TO_LINE message → FileStateService → scrollController (Editor → Preview)
 */
function initScrollSyncController(): void {
  // Dispose previous controller if exists
  scrollSyncController?.dispose();
  
  try {
    scrollSyncController = createViewerScrollSync({
      containerId: 'vscode-content',
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
function handleScrollToLine(payload: ScrollToLinePayload): void {
  const { line } = payload;
  
  // Update FileStateService (for consistency with Chrome/Mobile)
  if (currentFilename) {
    platform.fileState.setScrollLineFromHost(currentFilename, line);
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
