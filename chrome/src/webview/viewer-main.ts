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
import { buildCodeReadingRender, applyCodeViewPresentation } from '../../../src/utils/code-preview';
import { initSlidevViewer } from '../../../src/slidev/slidev-viewer';
import { getWebExtensionApi } from '../../../src/utils/platform-info';

import type { PluginRenderer, RendererThemeConfig, PlatformAPI } from '../../../src/types/index';

import { escapeHtml } from '../../../src/core/markdown-utils';
import { getCurrentDocumentUrl, saveToHistory } from '../../../src/core/document-utils';
import type { FileState } from '../../../src/types/core';
import { showProcessingIndicator, hideProcessingIndicator } from './ui/progress-indicator';
import { createTocManager } from './ui/toc-manager';
import { setupHeadingAnchors, type HeadingAnchorsController } from './ui/heading-anchors';
import { createGitbookPanel } from './ui/gitbook-panel';
import { createToolbarManager, generateToolbarHTML, layoutIcons } from './ui/toolbar';

// Import shared utilities from viewer-host
import {
  setCurrentFileKey,
} from '../../../src/core/viewer/viewer-host';
import {
  createViewerAssembler,
  type ViewerAssembler as ViewerAssemblerRuntime,
} from '../../../src/core/viewer/viewer-assembler';
import { createPersistedStateHostBridge } from '../../../src/core/viewer/viewer-host-bridge';
import {
  createViewerKernel,
  type ViewerKernel,
} from '../../../src/core/viewer/viewer-kernel';
import { createViewerSession } from '../../../src/core/viewer/viewer-session';
import type {
  ViewerDocumentDescriptor,
  ViewerPersistedState,
  ViewerResolvedMode,
} from '../../../src/core/viewer/viewer-session-contract';
import { resolveDefaultTocVisibility } from '../../../src/core/viewer/viewer-session-contract';
import { createViewerSurfacePort } from '../../../src/core/viewer/viewer-surface-port';
import type { ViewerDisplayMode } from '../../../src/core/viewer/viewer-host-adapter';
import { setupImageContextMenu } from '../../../src/ui/image-context-menu';
import { setupDiagramLightbox } from '../../../src/ui/diagram-lightbox';
import { setupCodeBlockCopy } from '../../../src/ui/code-block-copy';

// Extend Window interface for global access
declare global {
  interface Window {
    docxExporter: DocxExporter;
    /** Set by html-to-markdown.ts when the current tab is a rendered HTML page */
    __mvHtmlConvertedMarkdown?: {
      markdown: string;
      title: string;
      url: string;
    };
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

export interface ViewerMainRuntime {
  openDocument(content: string, options?: { scrollLine?: number; anchor?: string }): Promise<void>;
  updateContent(content: string, targetLine?: number): Promise<void>;
  renderSlidev(content: string): Promise<void>;
  setTheme(themeId: string): Promise<void>;
  requestAnchor(anchor: string): Promise<void>;
  setScrollLine(line: number): void;
  getCurrentScrollLine(): number;
}

let currentViewerMainRuntime: ViewerMainRuntime | null = null;

export function getViewerMainRuntime(): ViewerMainRuntime | null {
  return currentViewerMainRuntime;
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

  const webExtensionApi = getWebExtensionApi();
  const isMobile = platform.platform === 'mobile';
  const MIN_SIDEBAR_WIDTH = 160;
  const MAX_SIDEBAR_WIDTH = 560;
  let syncResizeHandlePosition: (() => void) | null = null;

  function constrainSidebarWidth(width: number): number {
    const maxWidth = Math.min(window.innerWidth * 0.5, MAX_SIDEBAR_WIDTH);
    return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, width));
  }

  async function getStoredSidebarWidth(): Promise<number | null> {
    try {
      const value = await platform.settings.get('readerSidebarWidth');
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  async function setStoredSidebarWidth(value: number): Promise<void> {
    try {
      await platform.settings.set('readerSidebarWidth', value);
    } catch {
      // Ignore persistence failures to avoid blocking resize behavior.
    }
  }

  function applyTocPanelSide(swapped: boolean): void {
    document.body.classList.toggle('toc-position-right', swapped);
    document.body.classList.toggle('gitbook-sidebar-left', swapped);

    const toggleTocBtn = document.getElementById('toggle-toc-btn');
    const toolbarLeft = document.querySelector('.toolbar-left');
    const toolbarRight = document.querySelector('.toolbar-right');

    if (!toggleTocBtn || !toolbarLeft || !toolbarRight) {
      return;
    }

    if (swapped) {
      toolbarRight.prepend(toggleTocBtn);
    } else {
      toolbarLeft.prepend(toggleTocBtn);
    }

    syncResizeHandlePosition?.();
  }

  async function initGitbookSidebarResize(): Promise<void> {
    if (isMobile) {
      return;
    }

    const sidebar = document.getElementById('gitbook-sidebar-body') as HTMLElement | null;
    const sidebarHeader = document.getElementById('gitbook-sidebar-header') as HTMLElement | null;
    const resizeHandle = document.getElementById('gitbook-resize-handle') as HTMLElement | null;

    if (!sidebar || !resizeHandle) {
      return;
    }

    const pageContent = document.getElementById('page-content') as HTMLElement | null;
    if (!pageContent) {
      return;
    }

    const updateResizeHandlePosition = (): void => {
      const contentWidth = pageContent.clientWidth;
      const sidebarWidth = sidebar.offsetWidth;
      const handleWidth = resizeHandle.offsetWidth || 4;

      if (contentWidth <= 0 || sidebarWidth <= 0) {
        return;
      }

      const isSidebarLeft = document.body.classList.contains('gitbook-sidebar-left');
      const seamX = isSidebarLeft ? sidebarWidth : contentWidth - sidebarWidth;
      const handleLeft = Math.max(0, Math.min(contentWidth - handleWidth, seamX - handleWidth / 2));
      resizeHandle.style.left = `${handleLeft}px`;
    };

    syncResizeHandlePosition = updateResizeHandlePosition;

    // Apply saved width to both sidebar body and header
    const applySidebarWidth = (px: number): void => {
      sidebar.style.width = `${px}px`;
      if (sidebarHeader) {
        sidebarHeader.style.width = `${px}px`;
      }
    };

    const savedWidth = await getStoredSidebarWidth();
    if (savedWidth !== null) {
      applySidebarWidth(constrainSidebarWidth(savedWidth));
    }
    updateResizeHandlePosition();

    resizeHandle.addEventListener('mousedown', (event: MouseEvent) => {
      event.preventDefault();

      resizeHandle.classList.add('active');
      document.body.classList.add('sidebar-resizing');

      const startX = event.clientX;
      const startWidth = sidebar.offsetWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const isSidebarLeft = document.body.classList.contains('gitbook-sidebar-left');
        const nextWidth = isSidebarLeft ? startWidth + deltaX : startWidth - deltaX;
        const constrained = constrainSidebarWidth(nextWidth);
        applySidebarWidth(constrained);
        updateResizeHandlePosition();
      };

      const onMouseUp = () => {
        resizeHandle.classList.remove('active');
        document.body.classList.remove('sidebar-resizing');
        void setStoredSidebarWidth(sidebar.offsetWidth);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    window.addEventListener('resize', updateResizeHandlePosition);
    window.addEventListener('gitbook-panel-visibility-changed', () => {
      requestAnimationFrame(updateResizeHandlePosition);
    });
  }

  // Prevent browser from auto-restoring scroll position before viewer content is ready.
  // Otherwise, Chrome may jump to a stale DOM offset before markdown-viewer restores
  // the line-based position.
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  const translate = (key: string, substitutions?: string | string[]): string =>
    Localization.translate(key, substitutions);

  // Initialize DOCX exporter
  const docxExporter = new DocxExporter(pluginRenderer);

  // Store exporter for plugins and debugging
  window.docxExporter = docxExporter;

  // Initialize file state service (unified across platforms)
  // In workspace/embed mode the iframe URL is stable while dataset.viewerFilePath changes,
  // so always resolve URL dynamically instead of capturing it once.
  const getActiveDocumentUrl = (): string => getCurrentDocumentUrl();

  // Set initial key for scroll position persistence (used by viewer-host)
  setCurrentFileKey(getActiveDocumentUrl());

  const saveFileState = (state: FileState): void => {
    const activeUrl = getActiveDocumentUrl();
    setCurrentFileKey(activeUrl);
    platform.fileState.set(activeUrl, state);
  };
  const getFileState = (): Promise<FileState> => {
    const activeUrl = getActiveDocumentUrl();
    setCurrentFileKey(activeUrl);
    return platform.fileState.get(activeUrl);
  };

  let mountedViewerRoot: HTMLDivElement | null = null;
  let markdownViewerAdapter: ViewerKernel | null = null;
  let viewerAssembler: ViewerAssemblerRuntime | null = null;
  let lastScrollLine = 0;
  let currentThemeId: string | null = null;
  const logThenPermissionError = (scope: string, error: unknown, extra?: Record<string, unknown>): void => {
    const message = error instanceof Error ? error.message : String(error);
    const isThenPermission = message.includes('Permission denied to access property "then"');
    // eslint-disable-next-line no-console
    console.error(`[MarkdownViewer] ${scope}`, {
      message,
      isThenPermission,
      extra,
      stack: error instanceof Error ? error.stack : undefined,
    });
  };

  window.addEventListener('error', (event) => {
    void event;
  });

  window.addEventListener('unhandledrejection', (event) => {
    void event;
  });

  const getViewerSnapshot = () => viewerAssembler?.getSnapshot() ?? null;

  const logViewerDebug = (scope: string, payload?: Record<string, unknown>): void => {
    void scope;
    void payload;
  };

  const mapResolvedModeToDisplayMode = (resolvedMode: ViewerResolvedMode): ViewerDisplayMode => {
    switch (resolvedMode) {
      case 'source':
        return 'source';
      case 'code-reading':
        return 'auto-code';
      default:
        return 'markdown';
    }
  };

  const getCurrentResolvedMode = (): ViewerResolvedMode => {
    return getViewerSnapshot()?.resolvedMode ?? 'rendered';
  };

  const applyResolvedModePresentation = (resolvedMode: ViewerResolvedMode): void => {
    markdownViewerAdapter?.setDisplayMode(mapResolvedModeToDisplayMode(resolvedMode));
    applyCodeViewPresentation(resolvedMode !== 'rendered');
    logViewerDebug('presentation.apply', {
      resolvedMode,
      displayMode: mapResolvedModeToDisplayMode(resolvedMode),
      snapshot: getViewerSnapshot(),
    });
  };

  const getViewerDocumentLocation = (): string => {
    const workspaceFilePath = document.documentElement.dataset.viewerWorkspaceFilePath;
    const viewerFilename = document.documentElement.dataset.viewerFilename;
    return workspaceFilePath || viewerFilename || getActiveDocumentUrl();
  };

  const toViewerPersistedState = (state: FileState): ViewerPersistedState => {
    const persistedState: ViewerPersistedState = {};

    if (typeof state.scrollLine === 'number') {
      persistedState.scrollLine = state.scrollLine;
    }
    if (typeof state.zoom === 'number') {
      persistedState.zoomPercent = state.zoom;
    }
    if (typeof state.tocVisible === 'boolean') {
      persistedState.tocVisible = state.tocVisible;
    }
    if (typeof state.layoutMode === 'string'
      && (state.layoutMode === 'normal' || state.layoutMode === 'fullscreen' || state.layoutMode === 'narrow')) {
      persistedState.layoutMode = state.layoutMode;
    }

    return persistedState;
  };

  const fromViewerPersistedState = (state: Partial<ViewerPersistedState>): FileState => {
    const nextState: FileState = {};

    if (typeof state.scrollLine === 'number') {
      nextState.scrollLine = state.scrollLine;
    }
    if (typeof state.zoomPercent === 'number') {
      nextState.zoom = state.zoomPercent;
    }
    if (typeof state.tocVisible === 'boolean') {
      nextState.tocVisible = state.tocVisible;
    }
    if (typeof state.layoutMode === 'string') {
      nextState.layoutMode = state.layoutMode;
    }

    return nextState;
  };

  const getDocumentDisplayName = (): string => {
    const location = getViewerDocumentLocation();
    const segments = location.split(/[\\/]/).filter(Boolean);
    return document.title || segments[segments.length - 1] || location;
  };

  const buildViewerDocumentDescriptor = (content: string): ViewerDocumentDescriptor => {
    const documentKey = getActiveDocumentUrl();
    const sourcePath = getViewerDocumentLocation();
    const codeReading = !htmlConverted ? buildCodeReadingRender(content, sourcePath) : null;
    const sourceToggleSupported = isMarkdownSourceToggleEnabled();

    let format: ViewerDocumentDescriptor['format'] = 'diagram';
    if (htmlConverted) {
      format = 'html-converted';
    } else if (codeReading) {
      format = 'code';
    } else if (sourceToggleSupported) {
      format = 'markdown';
    }

    return {
      documentKey,
      displayName: getDocumentDisplayName(),
      sourcePath,
      format,
      language: codeReading?.language,
      sourceToggleSupported,
      containerMode: 'browser',
      embedded: window.parent !== window,
    };
  };

  const isSourceModeEnabled = (): boolean => {
    return getCurrentResolvedMode() === 'source';
  };

  const isCodeViewActive = (): boolean => {
    return getCurrentResolvedMode() !== 'rendered';
  };

  function getOrCreateMountedViewerAdapter(): ViewerKernel {
    if (!markdownViewerAdapter) {
      const contentHost = document.getElementById('markdown-content') as HTMLDivElement | null;
      if (!contentHost) {
        throw new Error('[Viewer] markdown-content container not found');
      }

      contentHost.innerHTML = '';
      mountedViewerRoot = document.createElement('div');
      mountedViewerRoot.className = 'markdown-viewer-content';
      contentHost.appendChild(mountedViewerRoot);

      const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
      markdownViewerAdapter = createViewerKernel({
        container: mountedViewerRoot,
        scrollContainer: wrapper ?? undefined,
        platform,
        renderer: pluginRenderer,
        translate,
        onHeadingPresenceKnown: (hasHeadings) => {
          void viewerAssembler?.reportHeadingPresence(hasHeadings);
        },
        onHeadings: () => {
          if (isCodeViewActive() || isTocDisabledForCurrentFile()) {
            hideTocForCodeView();
            return;
          }
          void generateTOC();
        },
        afterRender: () => {
          updateActiveTocItem();
          refreshHeadingAnchors();
        },
        onScrollLineChange: (line) => {
          lastScrollLine = line;
          saveFileState({ scrollLine: line });
          void viewerAssembler?.reportCurrentLine(line);
          updateActiveTocItem();
          logViewerDebug('scrolllinechange', {
            line,
            resolvedMode: getCurrentResolvedMode(),
            snapshot: getViewerSnapshot(),
          });
        },
        applyTheme: loadAndApplyTheme,
        saveTheme: (id) => themeManager.saveSelectedTheme(id),
      });
      markdownViewerAdapter.setDisplayMode(mapResolvedModeToDisplayMode(getCurrentResolvedMode()));
    }

    return markdownViewerAdapter;
  }

  // Set favicon to extension icon
  function setFavicon(): void {
    // Remove existing favicon if any
    const existingLink = document.querySelector("link[rel*='icon']");
    if (existingLink) {
      existingLink.remove();
    }
    
    // Create new favicon link
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = webExtensionApi.runtime.getURL('icons/icon16.png');
    document.head.appendChild(link);
  }
  setFavicon();

  // Initialize TOC manager
  const tocManager = createTocManager(saveFileState, getFileState, isMobile, {
    getDesiredVisibility: () => getViewerSnapshot()?.tocVisible,
    updateLocationHash: true,
  });
  const { generateTOC, setupTocToggle, updateActiveTocItem, setupResponsiveToc } = tocManager;

  // In-content heading anchor links (hover-revealed "#"). Created lazily once the
  // content container exists; re-injected after every render since incremental
  // block updates replace heading DOM.
  let headingAnchors: HeadingAnchorsController | null = null;
  const refreshHeadingAnchors = (): void => {
    if (!headingAnchors && document.getElementById('markdown-content')) {
      headingAnchors = setupHeadingAnchors((id) => tocManager.navigateToHeading(id));
    }
    headingAnchors?.refresh();
  };

  // Create navigation callback for GitBook panel (will be set after renderMarkdown is defined)
  let onGitbookNavigate: ((url: string, content: string) => Promise<void>) | undefined;

  // Initialize GitBook panel manager
  const gitbookPanel = createGitbookPanel(saveFileState, getFileState, isMobile, {
    currentUrl: getActiveDocumentUrl(),
    readRelativeFile: async (relativePath: string) => {
      if (!platform.document) {
        throw new Error('Document service unavailable');
      }
      return platform.document.readRelativeFile(relativePath);
    },
    onNavigateFile: (url: string, content: string) => {
      if (onGitbookNavigate) {
        return onGitbookNavigate(url, content);
      }
      return Promise.resolve();
    },
  });
  const { generateGitbookPanel, setupResponsivePanel } = gitbookPanel;

  // Get the raw markdown content.
  // When the page is a rendered HTML document the html-to-markdown content
  // script will have already extracted and converted the article content;
  // fall back to document.body.textContent for plain-text / raw files.
  const htmlConverted = window.__mvHtmlConvertedMarkdown;
  const rawContent = htmlConverted?.markdown ?? document.body.textContent ?? '';
  if (htmlConverted?.title) {
    document.title = htmlConverted.title;
  }

  // When taking over an HTML page, strip the original page's stylesheets and
  // inline styles so they don't bleed into the Markdown viewer layout.
  if (htmlConverted) {
    // Remove external stylesheets and <style> blocks (keep our own preload style)
    document.head.querySelectorAll<HTMLElement>('link[rel~="stylesheet"], style').forEach((el) => {
      if (el.id !== 'markdown-viewer-preload') {
        el.remove();
      }
    });
    // Reset any inline styles the original page applied to <html> / <body>
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    // Wipe the existing page content so nothing leaks through during render
    document.body.innerHTML = '';
  }

  // ── Slidev mode: .slides.md files render as presentations ────────────
  const isSlidevFile = (path: string): boolean => /\.slides\.md$/i.test(path);

  const renderSlidevContent = async (content: string): Promise<void> => {
    // Mark that we're in Slidev mode so the embed layer can detect it and
    // trigger a page reload when switching back to a regular file.
    document.documentElement.dataset.slidevActive = '1';

    // Remove preload style that hides page content (opacity: 0 !important)
    document.getElementById('markdown-viewer-preload')?.remove();

    // Full-screen layout for presentations
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden;opacity:1';
    document.documentElement.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';

    // Notify parent workspace that the frame is themed and ready to reveal.
    try {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'VIEWER_RENDERED' }, '*');
      }
    } catch { /* cross-origin parent — ignore */ }

    await initSlidevViewer({
      rawContent: content,
      container: document.body,
      renderDiagram: (type, code) =>
        platform.renderer.render(type, code).then((r) => ({
          base64: r.base64!,
          width: r.width,
          height: r.height,
        })),
      onThemeReady: async (name) => {
        try {
          const resp = await fetch(webExtensionApi.runtime.getURL('slidev-shell/themes/themes.json'));
          if (!resp.ok) return;
          const manifest = await resp.json();
          const entry = manifest[name];
          if (entry?.fonts) {
            platform.renderer.setThemeConfig({
              ...platform.renderer.getThemeConfig(),
              fontFamily: entry.fonts.sans || entry.fonts.serif || undefined,
              fontUrl: entry.fontUrl,
              colorSchema: entry.colorSchema as 'light' | 'dark' | 'both' | undefined,
            });
          }
        } catch { /* ignore */ }
      },
      getShellSource: async () =>
        webExtensionApi.runtime.getURL('slidev-shell/slidev-shell/index.html'),
      getThemeUrl: async (name) =>
        webExtensionApi.runtime.getURL(`slidev-shell/themes/theme-${name}.js`),
      onParsed: ({ title }) => {
        document.title = title;
        saveToHistory(platform);
      },
    });
  };

  const initialUrl = getActiveDocumentUrl();
  if (isSlidevFile(initialUrl)) {
    await renderSlidevContent(rawContent);
    return;
  }

  // ── Non-workspace mode: set tocDisabled based on the document URL ────────
  // Workspace mode already sets data-toc-disabled via applyOpenDocumentMetadata
  // in viewer-embed.ts. For non-workspace mode (direct file open in browser /
  // HTML conversion), derive it from the current URL so the same TOC-hiding
  // logic applies consistently.
  // Note: keep TOC enabled for htmlConverted pages (reading-mode on arbitrary
  // web pages) since their content may still benefit from heading navigation.
  if (document.documentElement.dataset.tocDisabled === undefined && !htmlConverted) {
    const isMd = /\.(md|markdown)$/i.test(initialUrl) && !/\.slides\.md$/i.test(initialUrl);
    if (!isMd) {
      document.documentElement.dataset.tocDisabled = '1';
    }
  }

  // Wrap non-markdown file content (e.g., mermaid, vega) in markdown format.
  // For standalone text/code files detected by content-detector, render as
  // fenced code so syntax highlighting matches workspace behavior.
  const isMarkdownSourceToggleEnabled = (): boolean => {
    if (htmlConverted) {
      return false;
    }
    const activeTarget = getViewerDocumentLocation();
    return /\.(md|markdown)$/i.test(activeTarget) && !/\.slides\.md$/i.test(activeTarget);
  };
  let liveRawContent = rawContent;

  const hideTocForCodeView = (): void => {
    const tocDiv = document.getElementById('table-of-contents') as HTMLElement | null;
    const overlayDiv = document.getElementById('toc-overlay') as HTMLElement | null;

    if (tocDiv) {
      tocDiv.style.display = 'none';
      tocDiv.classList.add('hidden');
    }
    if (overlayDiv) {
      overlayDiv.classList.add('hidden');
    }
    document.body.classList.add('toc-hidden');
  };

  const isTocDisabledForCurrentFile = (): boolean => {
    return document.documentElement.dataset.tocDisabled === '1';
  };

  const applyTocButtonVisibility = (): void => {
    const tocBtn = document.getElementById('toggle-toc-btn');
    if (!tocBtn) return;
    if (isTocDisabledForCurrentFile()) {
      tocBtn.style.display = 'none';
    } else {
      tocBtn.style.display = '';
    }
  };

  const applyPredictedTocLayout = (hasHeadings: boolean | undefined, tocVisible = initialTocVisible): void => {
    applyTocButtonVisibility();

    if (isTocDisabledForCurrentFile()) {
      hideTocForCodeView();
      return;
    }

    if (isCodeViewActive()) {
      hideTocForCodeView();
      return;
    }

    const tocDiv = document.getElementById('table-of-contents') as HTMLElement | null;
    const overlayDiv = document.getElementById('toc-overlay') as HTMLElement | null;
    if (!tocDiv) {
      return;
    }

    if (hasHeadings === false) {
      tocDiv.style.display = 'none';
      tocDiv.classList.add('hidden');
      overlayDiv?.classList.add('hidden');
      document.body.classList.add('toc-hidden');
      return;
    }

    const shouldBeVisible = tocVisible;

    tocDiv.style.display = '';
    tocDiv.classList.toggle('hidden', !shouldBeVisible);
    document.body.classList.toggle('toc-hidden', !shouldBeVisible);

    if (overlayDiv) {
      if (isMobile && shouldBeVisible) {
        overlayDiv.classList.remove('hidden');
      } else {
        overlayDiv.classList.add('hidden');
      }
    }
  };

  const restoreDirectCodeViewScrollAfterRender = (line: number | undefined): void => {
    if (line === undefined) {
      logViewerDebug('codeview.restore.skip', { reason: 'line-undefined' });
      return;
    }

    let attemptsRemaining = 6;
    const retry = (): void => {
      const lineElements = document.querySelectorAll<HTMLElement>('#markdown-content .mv-code-line');
      if (lineElements.length === 0 && attemptsRemaining > 0) {
        logViewerDebug('codeview.restore.retry', {
          requestedLine: line,
          attemptsRemaining,
          reason: 'no-code-lines',
        });
        attemptsRemaining -= 1;
        requestAnimationFrame(retry);
        return;
      }

      if (lineElements.length === 0) {
        logViewerDebug('codeview.restore.abort', {
          requestedLine: line,
          reason: 'no-code-lines-after-retries',
        });
        return;
      }

      const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
      const lineIndex = Math.min(lineElements.length - 1, Math.max(0, Math.floor(line)));
      const lineProgress = Math.max(0, Math.min(0.999999, line - lineIndex));
      const lineElement = lineElements[lineIndex];
      const wrapperRect = wrapper?.getBoundingClientRect();
      const lineRect = lineElement.getBoundingClientRect();
      const lineTop = wrapper && wrapperRect
        ? lineRect.top - wrapperRect.top + wrapper.scrollTop
        : lineRect.top + (window.scrollY || window.pageYOffset || 0);
      const lineHeight = Math.max(lineRect.height, 1);
      const scrollTop = Math.max(0, lineTop + lineHeight * lineProgress);

      if (wrapper) {
        wrapper.scrollTo({ top: scrollTop, behavior: 'auto' });
      } else {
        window.scrollTo({ top: scrollTop, behavior: 'auto' });
      }

      logViewerDebug('codeview.restore.apply', {
        requestedLine: line,
        lineIndex,
        lineProgress,
        renderedLineCount: lineElements.length,
        scrollTop,
      });
    };

    requestAnimationFrame(retry);
  };

  // Get saved state early to prevent any flashing
  const initialState = await getFileState();
  const initialToolbarMarkdown = (() => {
    if (htmlConverted) {
      return rawContent;
    }
    const documentLocation = getViewerDocumentLocation();
    const codeReading = buildCodeReadingRender(rawContent, documentLocation);
    return codeReading ? codeReading.markdown : wrapFileContent(rawContent, documentLocation);
  })();

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
  const initialSwapPanelSide = await platform.settings.get('swapPanelSide');

  // Default TOC visibility based on screen width if no saved state
  let initialTocVisible: boolean;
  if (initialState.tocVisible !== undefined) {
    initialTocVisible = initialState.tocVisible;
  } else {
    initialTocVisible = resolveDefaultTocVisibility('browser');
  }
  const initialTocClass = initialTocVisible ? '' : ' hidden';

  // Initialize toolbar manager
  const toolbarManager = createToolbarManager({
    translate,
    escapeHtml,
    saveFileState,
    getFileState,
    isMobile,
    rawMarkdown: initialToolbarMarkdown,
    getRawContent: () => liveRawContent,
    docxExporter,
    cancelScrollRestore: () => {
      // Scroll restoration is handled by markdown-viewer state.
    },
    updateActiveTocItem,
    onBeforeZoom: () => {
      // Lock scroll position before zoom change
      // No scroll lock needed in simplified scroll controller.
    },
    onSetTocVisibility: (visible) => {
      void viewerAssembler?.setTocVisibility(visible).catch((error) => {
        logThenPermissionError('tocVisibility.failed', error, { visible });
      });
    },
    enableSourceToggle: isMarkdownSourceToggleEnabled(),
    onToggleSourceMode: () => {
      void (async () => {
        if (!viewerAssembler) {
          return;
        }
        const scrollLine = getCurrentScrollLine();
        const reportStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        logViewerDebug('toggleSource.click', {
          scrollLine,
          before: getViewerSnapshot(),
        });
        await viewerAssembler.reportCurrentLine(scrollLine);
        const reportEndedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        logViewerDebug('toggleSource.reportCurrentLine.done', {
          scrollLine,
          durationMs: Number((reportEndedAt - reportStartedAt).toFixed(2)),
          afterReport: getViewerSnapshot(),
        });
        await executeViewerCommand(
          'toggleSource.failed',
          () => viewerAssembler.toggleModeIntent(),
          { scrollLine },
        );
      })();
    },
    getSourceMode: () => isSourceModeEnabled(),
    isSourceModeActive: () => isCodeViewActive(),
    enableRemarkMode: true,
    getRemarkContainer: () => document.getElementById('markdown-content'),
    getRemarkRawMarkdown: () => liveRawContent,
  });

  toolbarManager.setInitialZoom(initialZoom);

  // UI layout
  document.body.innerHTML = generateToolbarHTML({
    translate,
    escapeHtml,
    initialTocClass,
    initialMaxWidth,
    initialZoom,
    enableSourceToggle: isMarkdownSourceToggleEnabled(),
    enableRemarkMode: true,
  });
  if (!initialTocVisible) {
    document.body.classList.add('toc-hidden');
  }
  applyTocPanelSide(Boolean(initialSwapPanelSide));
  applyTocButtonVisibility();

  // If TOC is disabled for the current file (non-.md), ensure the panel starts
  // hidden even though initialTocClass may have rendered it visible.
  if (isTocDisabledForCurrentFile()) {
    hideTocForCodeView();
  }

  await initGitbookSidebarResize();

  getOrCreateMountedViewerAdapter();

  const viewerHostBridge = createPersistedStateHostBridge({
    readPersistedState: async (documentKey) => {
      setCurrentFileKey(documentKey);
      return toViewerPersistedState(await platform.fileState.get(documentKey));
    },
    writePersistedState: async (documentKey, patch) => {
      setCurrentFileKey(documentKey);
      saveFileState(fromViewerPersistedState(patch));
    },
    emit: (event, payload) => {
      if (event === 'scroll-line-changed' && window.parent !== window) {
        const detail = payload && typeof payload === 'object' ? payload as { line?: unknown } : null;
        const line = typeof detail?.line === 'number' && Number.isFinite(detail.line) ? detail.line : undefined;
        window.parent.postMessage({ type: 'VIEWER_SCROLL_LINE_CHANGED', line }, '*');
      }
    },
  });

  const viewerSurface = createViewerSurfacePort({
    render: async (effect) => {
      const viewer = getOrCreateMountedViewerAdapter();

      logViewerDebug('surface.render.start', {
        revision: effect.revision,
        preserveViewport: effect.preserveViewport,
        targetLine: effect.targetLine,
        hasDirectCodeView: Boolean(effect.renderModel.directCodeView),
        markdownLength: effect.renderModel.markdown.length,
        snapshot: getViewerSnapshot(),
      });

      if (effect.targetLine !== undefined) {
        lastScrollLine = effect.targetLine;
      }

      const renderOperation = effect.preserveViewport
        ? viewer.updateContent.bind(viewer)
        : viewer.loadDocument.bind(viewer);

      await renderOperation(effect.renderModel.markdown, {
        fileChanged: !effect.preserveViewport,
        forceRender: false,
        targetLine: effect.targetLine,
        zoomLevel: toolbarManager.getZoomLevel() / 100,
        directCodeView: effect.renderModel.directCodeView,
      });

      if (effect.renderModel.directCodeView) {
        logViewerDebug('surface.render.directCodeView', {
          targetLine: effect.targetLine,
          language: effect.renderModel.directCodeView.language,
          contentLength: effect.renderModel.directCodeView.content.length,
        });
        hideTocForCodeView();
        // Re-apply code view presentation after render so line numbers are
        // decorated on the *new* code block. The earlier call (from the
        // apply-presentation effect) may have found the *old* code block
        // during code→code switches and skipped setting up the observer.
        applyCodeViewPresentation(true);
        restoreDirectCodeViewScrollAfterRender(effect.targetLine);
        return;
      }

      logViewerDebug('surface.render.preview', {
        targetLine: effect.targetLine,
      });
      if (isTocDisabledForCurrentFile()) {
        hideTocForCodeView();
      } else {
        await generateTOC();
      }
      updateActiveTocItem();
      refreshHeadingAnchors();
      restorePreviewScrollAfterRender(effect.targetLine);
    },
    applyTheme: async (themeId) => {
      const viewer = getOrCreateMountedViewerAdapter();
      await viewer.switchThemePreservingScroll(themeId);
      applyResolvedModePresentation(getCurrentResolvedMode());
    },
    applyPresentation: (effect) => {
      applyResolvedModePresentation(effect.resolvedMode);
      applyPredictedTocLayout(effect.predictedHasHeadings, effect.tocVisible);
    },
    readCurrentLine: () => markdownViewerAdapter?.captureCurrentLine() ?? null,
    scrollToLine: (line) => {
      if (isCodeViewActive()) {
        restoreDirectCodeViewScrollAfterRender(line);
        return;
      }

      markdownViewerAdapter?.restorePreviewScroll(line);
    },
    scrollToAnchor: (anchor) => {
      markdownViewerAdapter?.scrollToAnchor(anchor);
    },
  });

  viewerAssembler = createViewerAssembler({
    session: createViewerSession(),
    surface: viewerSurface,
    host: viewerHostBridge,
  });

  // Load theme BEFORE unveiling the body. Doing it the other way around
  // causes a brief flash of the default light body background (~6ms) when
  // the selected theme is dark, because the preload style is removed and
  // opacity flipped to 1 while the theme CSS is still in flight.
  try {
    currentThemeId = await themeManager.loadSelectedTheme();
    // loadAndApplyTheme handles all theme logic including renderer config
    await loadAndApplyTheme(currentThemeId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load theme at init, using defaults:', error);
  }

  // Remove the preload style that hides the page content
  // This should be done after the toolbar is generated but before rendering
  const preloadStyle = document.getElementById('markdown-viewer-preload');
  if (preloadStyle) {
    preloadStyle.remove();
  }

  // Make body visible with a smooth fade-in
  document.body.style.opacity = '1';
  document.body.style.overflow = 'hidden';
  document.body.style.transition = 'none';

  // Notify the parent (workspace page) that the viewer is themed and visible,
  // so it can reveal the iframe. Harmless when this page is not embedded.
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'VIEWER_RENDERED' }, '*');
    }
  } catch { /* cross-origin parent \u2014 ignore */ }

  // Wait for two paint frames, then start processing.
  // This avoids a fixed delay while still letting initial DOM/CSS settle.
  const waitForNextFrame = (): Promise<void> => {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  };

  const runInitialRender = async (): Promise<void> => {
    let savedScrollLine = initialState.scrollLine;
    let pendingAnchor: string | null = null;

    // Prefer anchor-based navigation through markdown-viewer API.
    if (window.location.hash) {
      const fragment = decodeURIComponent(window.location.hash.slice(1)).trim();
      pendingAnchor = fragment.length > 0 ? fragment : null;
      // Footnote anchors are post-processed into the DOM after markdown render.
      // Reusing a stale footnote hash from a previous session causes an initial
      // auto-scroll race that interferes with the first user click. Only honor
      // initial hashes for normal document anchors; let footnotes navigate via
      // explicit click/hashchange after the document is visible.
      if (pendingAnchor?.startsWith('footnote-')) {
        pendingAnchor = null;
      }
    }

    toolbarManager.initializeToolbar();

    await renderMarkdown(liveRawContent, savedScrollLine, pendingAnchor ?? undefined);

    await saveToHistory(platform);
    setupTocToggle();
    toolbarManager.setupKeyboardShortcuts();
    await setupResponsiveToc();
    await setupResponsivePanel();
    await generateGitbookPanel();
  };

  void (async () => {
    await waitForNextFrame();
    await waitForNextFrame();
    await runInitialRender();
  })();

  window.addEventListener('hashchange', () => {
    if (!window.location.hash) return;
    const anchor = decodeURIComponent(window.location.hash.slice(1)).trim();
    if (anchor) {
      void (async () => {
        try {
          if (viewerAssembler) {
            await viewerAssembler.requestAnchor(anchor);
          }
        } catch (error) {
          logThenPermissionError('hashchange.failed', error, { anchor });
        }
      })();
    }
  });

  // scrolllinechange from markdown-viewer is the single source of truth for host persistence.
  const getCurrentScrollLine = (): number => {
    return markdownViewerAdapter?.captureCurrentLine() ?? lastScrollLine;
  };

  const restorePreviewScrollAfterRender = (line: number | undefined): void => {
    if (line === undefined) {
      logViewerDebug('preview.restore.skip', { reason: 'line-undefined' });
      return;
    }

    let attemptsRemaining = 6;
    const retry = (): void => {
      const currentLine = markdownViewerAdapter?.captureCurrentLine() ?? null;

      if (currentLine !== null && Math.abs(currentLine - line) < 1) {
        logViewerDebug('preview.restore.done', {
          requestedLine: line,
          currentLine,
        });
        return;
      }

      markdownViewerAdapter?.restorePreviewScroll(line);

      if (attemptsRemaining <= 0) {
        logViewerDebug('preview.restore.abort', {
          requestedLine: line,
          currentLine,
        });
        return;
      }

      logViewerDebug('preview.restore.retry', {
        requestedLine: line,
        currentLine,
        attemptsRemaining,
      });
      attemptsRemaining -= 1;
      requestAnimationFrame(retry);
    };

    requestAnimationFrame(retry);
  };

  async function executeViewerCommand<T>(
    scope: string,
    run: () => Promise<T>,
    extra?: Record<string, unknown>,
  ): Promise<T> {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    logViewerDebug('command.start', {
      scope,
      before: getViewerSnapshot(),
      extra,
    });
    showProcessingIndicator();
    try {
      const result = await run();
      const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      logViewerDebug('command.success', {
        scope,
        durationMs: Number((endedAt - startedAt).toFixed(2)),
        after: getViewerSnapshot(),
        extra,
      });
      return result;
    } catch (error) {
      const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      logViewerDebug('command.error', {
        scope,
        durationMs: Number((endedAt - startedAt).toFixed(2)),
        after: getViewerSnapshot(),
        extra,
      });
      logThenPermissionError(scope, error, extra);
      throw error;
    } finally {
      hideProcessingIndicator();
    }
  }

  async function renderMarkdown(content: string, savedScrollLine = 0, anchor?: string): Promise<void> {
    const restoreLine = typeof savedScrollLine === 'number' && Number.isFinite(savedScrollLine) && savedScrollLine > 0
      ? savedScrollLine
      : undefined;

    try {
      getOrCreateMountedViewerAdapter();
    } catch (error) {
      logThenPermissionError('renderMarkdown.getOrCreate.failed', error, {
        savedScrollLine: restoreLine,
        markdownLength: content.length,
      });
      throw error;
    }

    if (restoreLine !== undefined) {
      lastScrollLine = restoreLine;
    }

    const descriptor = buildViewerDocumentDescriptor(content);
    const persistedState = toViewerPersistedState(await getFileState());
    if (persistedState.tocVisible === undefined) {
      persistedState.tocVisible = resolveDefaultTocVisibility(descriptor.containerMode);
    }
    logViewerDebug('renderMarkdown.request', {
      contentLength: content.length,
      restoreLine,
      anchor,
      descriptor,
      persistedState,
    });

    if (!viewerAssembler) {
      throw new Error('[Viewer] viewer assembler not initialized');
    }

    await executeViewerCommand(
      'renderMarkdown.failed',
      () => viewerAssembler.openDocument({
        document: descriptor,
        content,
        persistedState,
        targetLine: restoreLine,
        anchor,
      }),
      {
        hasAdapter: Boolean(markdownViewerAdapter),
        resolvedMode: getCurrentResolvedMode(),
      },
    );
  }

  // Setup GitBook navigation handler (navigate without page refresh)
  onGitbookNavigate = async (url: string, content: string): Promise<void> => {
    try {
      // Update document title from URL or filename
      const filename = url.split('/').pop()?.replace(/\.md$/, '') || 'Document';
      document.title = filename;

      // Update page content with new markdown
      await renderMarkdown(content);

      // Save to browser history
      saveToHistory(platform);
    } catch (error) {
      console.error('[Chrome] GitBook navigation failed:', error);
    }
  };

  /**
   * Handle theme change - use handleThemeSwitchFlow (same as VSCode/Mobile)
   */
  async function handleSetTheme(themeId: string): Promise<void> {
    // Skip if same theme
    if (themeId === currentThemeId) {
      return;
    }

    currentThemeId = themeId;

    try {
      if (viewerAssembler) {
        await viewerAssembler.setTheme(themeId);
      }

      // Theme switch may recreate or rewrite code DOM; refresh line numbers in source/code view.
      applyResolvedModePresentation(getCurrentResolvedMode());
    } catch (error) {
      logThenPermissionError('theme.failed', error, {
        themeId,
        hasAdapter: Boolean(markdownViewerAdapter),
      });
    }
  }

  /**
   * Setup message listener for locale/theme/file changes
   */
  function setupMessageListener(): void {
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

      if (msg.type === 'SETTING_CHANGED') {
        const payload = msg.payload && typeof msg.payload === 'object' ? (msg.payload as Record<string, unknown>) : null;
        const key = payload?.key as string | undefined;
        const value = payload?.value;
        
        if (key === 'themeId' && typeof value === 'string') {
          void handleSetTheme(value);
        } else if (key === 'swapPanelSide') {
          applyTocPanelSide(Boolean(value));
        } else if (key === 'firstLineIndent') {
          // Regenerate theme CSS to apply new text-indent value
          void loadAndApplyTheme(currentThemeId ?? '');
        } else {
          // Other settings changed - just re-render with scroll preservation
          if (viewerAssembler) {
            const scrollLine = getCurrentScrollLine();
            void (async () => {
              await viewerAssembler.reportCurrentLine(scrollLine);
              await executeViewerCommand(
                'settingsChange.failed',
                () => viewerAssembler.rerender('settings-change'),
                { scrollLine },
              );
            })();
          }
        }
        return;
      }

      // Handle file content changes from background script
      if (msg.type === 'FILE_CHANGED') {
        const payload = msg.payload && typeof msg.payload === 'object' ? (msg.payload as Record<string, unknown>) : null;
        if (payload) {
          const changedUrl = payload.url as string;
          const newContent = payload.content as string;
          
          // Verify it's for the current document
          if (changedUrl === getActiveDocumentUrl() && typeof newContent === 'string') {
            void handleFileChanged(newContent);
          }
        }
        return;
      }

      // Handle auto refresh settings changes
      if (msg.type === 'AUTO_REFRESH_SETTINGS_CHANGED') {
        const payload = msg.payload && typeof msg.payload === 'object' ? (msg.payload as Record<string, unknown>) : null;
        if (payload) {
          const enabled = payload.enabled as boolean;
          if (enabled) {
            void startFileTracking();
          } else {
            stopFileTracking();
          }
        }
        return;
      }
    });
  }

  /**
   * Handle file content change (incremental update)
   */
  async function handleFileChanged(newContent: string): Promise<void> {
    try {
      getOrCreateMountedViewerAdapter();
    } catch (error) {
      logThenPermissionError('fileChanged.getOrCreate.failed', error, {
        contentLength: newContent.length,
      });
      throw error;
    }

    liveRawContent = newContent;

    if (!viewerAssembler) {
      throw new Error('[Viewer] viewer assembler not initialized');
    }

    const scrollLine = getCurrentScrollLine();
    await viewerAssembler.reportCurrentLine(scrollLine);
    await executeViewerCommand(
      'fileChanged.failed',
      () => viewerAssembler.updateContent(newContent, scrollLine),
      {
        hasAdapter: Boolean(markdownViewerAdapter),
        resolvedMode: getCurrentResolvedMode(),
      },
    );
  }

  currentViewerMainRuntime = {
    openDocument: (content, runtimeOptions) => {
      return renderMarkdown(content, runtimeOptions?.scrollLine ?? 0, runtimeOptions?.anchor);
    },
    updateContent: (content, targetLine) => handleFileChanged(content.length >= 0 ? content : '').then(async () => {
      if (typeof targetLine === 'number' && Number.isFinite(targetLine) && viewerAssembler) {
        await viewerAssembler.requestTargetLine(targetLine);
      }
    }),
    renderSlidev: (content) => renderSlidevContent(content),
    setTheme: (themeId) => handleSetTheme(themeId),
    requestAnchor: async (anchor) => {
      if (!viewerAssembler) {
        throw new Error('[Viewer] viewer assembler not initialized');
      }
      await viewerAssembler.requestAnchor(anchor);
    },
    setScrollLine: (line) => {
      if (!Number.isFinite(line)) {
        return;
      }
      if (isCodeViewActive()) {
        restoreDirectCodeViewScrollAfterRender(line);
        return;
      }
      markdownViewerAdapter?.restorePreviewScroll(line);
    },
    getCurrentScrollLine: () => getCurrentScrollLine(),
  };

  /**
   * Start file change tracking for current document
   */
  async function startFileTracking(): Promise<void> {
    const activeUrl = getActiveDocumentUrl();
    if (!activeUrl.startsWith('file://')) {
      return; // Only track local files
    }

    try {
      await new Promise<void>((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            id: `start-tracking-${Date.now()}`,
            type: 'START_FILE_TRACKING',
            payload: { url: activeUrl },
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response && response.ok) {
              resolve();
            } else {
              reject(new Error(response?.error?.message || 'Failed to start tracking'));
            }
          }
        );
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[Chrome] Failed to start file tracking:', error);
    }
  }

  /**
   * Stop file change tracking
   */
  function stopFileTracking(): void {
    const activeUrl = getActiveDocumentUrl();
    if (!activeUrl.startsWith('file://')) {
      return;
    }

    try {
      chrome.runtime.sendMessage({
        id: `stop-tracking-${Date.now()}`,
        type: 'STOP_FILE_TRACKING',
        payload: { url: activeUrl },
      });
    } catch {
      // Context invalidated after extension reload
    }
  }

  window.addEventListener('beforeunload', () => {
    currentViewerMainRuntime = null;
    mountedViewerRoot = null;
    markdownViewerAdapter?.destroy();
    markdownViewerAdapter = null;
  });

  // Setup message listener for theme/locale/file changes
  setupMessageListener();

  // Setup image context menu (shared cross-platform)
  const contentContainer = document.getElementById('markdown-content');
  if (contentContainer) {
    setupImageContextMenu({
      container: contentContainer,
      onDownload: ({ filename, data, mimeType }) => {
        // Use <a download> for browser-based download
        const blob = new Blob(
          [Uint8Array.from(atob(data), c => c.charCodeAt(0))],
          { type: mimeType }
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
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

  // Start file tracking for local files
  if (getActiveDocumentUrl().startsWith('file://') && !document.documentElement.dataset.viewerFilename) {
    void startFileTracking();

    // Stop tracking when page unloads
    window.addEventListener('beforeunload', () => {
      stopFileTracking();
    });
  }
}

/**
 * Initialize and start the viewer
 * Call this after the shared viewer base initialization completes
 */
export function startViewer(options: ViewerMainOptions): void {
  void initializeViewerMain(options);
}
