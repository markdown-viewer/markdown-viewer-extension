// Mobile WebView Entry Point
// This is the main entry point for the mobile WebView
// Note: Diagram renderers (mermaid, vega, etc.) run in a separate iframe

import { platform, bridge, isRenderViewMode } from './api-impl';
import Localization from '../../../src/utils/localization';
import themeManager from '../../../src/utils/theme-manager';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';
import { initSlidevViewer } from '../../../src/slidev/slidev-viewer';
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
  exportEpubFlow,
  exportHtmlFlow,
} from '../../../src/core/viewer/viewer-host';
import { setupImageContextMenu } from '../../../src/ui/image-context-menu';
import { setupTableContextMenu } from '../../../src/ui/table-context-menu';
import { setupDiagramLightbox } from '../../../src/ui/diagram-lightbox';
import { setupCodeBlockCopy } from '../../../src/ui/code-block-copy';
import { findHeadingLine } from '../../../src/utils/heading-slug';
import { isExternalUrl, splitPathAndFragment } from '../../../src/utils/document-url';
import { clearRenderDiagnostics, getRenderDiagnostics } from '../../../src/core/render-diagnostics';

declare global {
  var bridge: PlatformBridgeAPI | undefined;

  /**
   * Bridge traffic the Dart supervisor framed (see
   * mobile/lib/services/relay_chunking.dart): how many frames crossed, how large a
   * single bridge message was, how large the payloads were, and what the bridge's
   * limit is. The L2 suite uses it to prove that a result larger than the limit was
   * carried in frames and reassembled, instead of trusting that the path ran.
   */
  interface RenderSurfaceChunks {
    /** Messages that crossed the bridge (a frame counts once). */
    messagesSent: number;
    messagesReceived: number;
    /** Frames that crossed in each direction. */
    sent: number;
    received: number;
    /** Largest single bridge message — the number the limit bounds. */
    maxMessageSent: number;
    maxMessageReceived: number;
    /** Largest whole payload Dart framed for sending. */
    maxAssembledOut: number;
    limit: number;
    chunkSize: number;
  }

  /**
   * The supervisor's status snapshot, as the page mirrors it for diagnostics and
   * for the E2E harness.
   */
  interface RenderSurfaceStatus {
    state: string;
    renderers: string[];
    readyMs: number | null;
    error: string | null;
    /** Monotonic push sequence: a reader can tell whether a snapshot is newer. */
    push: number | null;
    chunks: RenderSurfaceChunks | null;
    /**
     * Recent supervisor diagnostics (why it framed a payload, dropped a stream,
     * reloaded the surface). The surface has no visible console, so a failing E2E
     * case has nothing else to quote.
     */
    logs?: string[];
  }

  interface Window {
    __mobileWebViewReady?: boolean;
    /** E2E seam: lets the integration harness read what the render pipeline lost. */
    __mvRenderDiagnostics?: {
      get: () => unknown[];
      clear: () => void;
    };
    /** Which render surface Dart told this page to use (see dev/render_view_mode.dart). */
    __mvRenderView?: boolean;
    /**
     * Dart's request to warm the render surface (see `wakeRenderSurface`).
     *
     * Called once, right after Dart publishes `__mvRenderView` and before it injects
     * a document. The page cannot warm the surface on its own: the choice is not
     * known until that publication, and warming too early would freeze it.
     */
    __mvRenderWakeRenderSurface?: () => boolean;
    /**
     * Render-surface status, pushed by the Dart supervisor.
     *
     * The surface has no widget of its own, so this is the only place the app can
     * see whether it is ready, which renderers it announced, and why it failed —
     * the E2E migration cases read it (mobile/integration_test/render_view_test.dart).
     */
    __mvRenderSurface?: RenderSurfaceStatus & {
      /** Test-only: ask the Dart supervisor to reload the surface (Phase 2 case). */
      __debugReloadForTest?: () => boolean;
      /** Test-only: ask the supervisor for a fresh status snapshot. */
      __requestStatusForTest?: () => boolean;
    };
  }
}

// Make platform globally available (same as Chrome)
globalThis.platform = platform;
// Expose bridge for shared plugins that need host file/asset access
globalThis.bridge = bridge;

// Diagnostics sink for the mobile E2E harness (mobile/integration_test): a
// failing case can dump *why* a block was dropped instead of only that the
// selector found nothing. Read-only observation — it never changes rendering.
window.__mvRenderDiagnostics = {
  get: () => getRenderDiagnostics(),
  clear: () => clearRenderDiagnostics(),
};

/**
 * Reads the bridge-traffic counters out of a supervisor status payload.
 *
 * Diagnostics only, and deliberately strict: a malformed snapshot is reported as
 * "no counters" rather than half-filled, so the E2E assertion that reads it cannot
 * pass on garbage.
 */
function readChunkStatus(value: unknown): RenderSurfaceChunks | null {
  const source = (value ?? null) as Record<string, unknown> | null;
  if (!source) return null;
  const numeric = (key: string): number | null => (typeof source[key] === 'number' ? (source[key] as number) : null);
  const messagesSent = numeric('messagesSent');
  const messagesReceived = numeric('messagesReceived');
  const sent = numeric('sent');
  const received = numeric('received');
  const maxMessageSent = numeric('maxMessageSent');
  const maxMessageReceived = numeric('maxMessageReceived');
  const maxAssembledOut = numeric('maxAssembledOut');
  const limit = numeric('limit');
  const chunkSize = numeric('chunkSize');
  if (
    messagesSent === null ||
    messagesReceived === null ||
    sent === null ||
    received === null ||
    maxMessageSent === null ||
    maxMessageReceived === null ||
    maxAssembledOut === null ||
    limit === null ||
    chunkSize === null
  ) {
    return null;
  }
  return {
    messagesSent,
    messagesReceived,
    sent,
    received,
    maxMessageSent,
    maxMessageReceived,
    maxAssembledOut,
    limit,
    chunkSize,
  };
}

/**
 * Applies one status snapshot to the seam.
 *
 * The seam object is mutated, never replaced: the test hooks live on it, and a
 * status update would otherwise wipe them (the restart case calls one of them
 * right after a push). Fields are type-checked individually, because everything
 * that reads this is a diagnostic or a test — a half-filled snapshot must not look
 * like a measurement.
 */
function applyRenderSurfaceStatus(status: Record<string, unknown>): void {
  const seam = window.__mvRenderSurface;
  if (!seam) return;
  seam.state = String(status.state ?? 'unknown');
  seam.renderers = Array.isArray(status.renderers) ? (status.renderers as string[]) : [];
  seam.readyMs = typeof status.readyMs === 'number' ? status.readyMs : null;
  seam.error = status.error == null ? null : String(status.error);
  seam.push = typeof status.push === 'number' ? status.push : null;
  seam.chunks = readChunkStatus(status.chunks);
  seam.logs = Array.isArray(status.logs) ? (status.logs as string[]) : [];
}

// Render-surface status seam. Installed before the relay transport registers its
// own inbox handler; the transport chains to whatever it finds, so both see every
// message (status pushes here, responses there).
window.__mvRenderSurface = {
  state: 'unknown',
  renderers: [],
  readyMs: null,
  error: null,
  push: null,
  chunks: null,
  logs: [],
};

// Test hooks (non-release only). Reload asks the supervisor to restart the surface
// (the recovery case); status asks for a *fresh* snapshot — the counters in it are
// maxima, so a case that renders something has to fetch one rather than read
// whatever the last push left behind.
if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'production') {
  const postToSupervisor = (type: string): boolean => {
    const channel = window.MarkdownViewerRender;
    if (!channel) return false;
    channel.postMessage(JSON.stringify({
      type,
      id: `${type}-${Date.now()}`,
      payload: {},
      timestamp: Date.now(),
    }));
    return true;
  };
  window.__mvRenderSurface.__debugReloadForTest = () => postToSupervisor('RENDER_VIEW_DEBUG_RELOAD');
  window.__mvRenderSurface.__requestStatusForTest = () => postToSupervisor('RENDER_VIEW_STATUS');
}

{
  const previousInbox = window.__receiveRenderMessage;
  window.__receiveRenderMessage = (payload: unknown) => {
    try {
      const message = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const typed = message as { type?: string; payload?: unknown; data?: unknown } | null;
      if (typed?.type === 'RENDER_VIEW_STATUS' && typed.payload && typeof typed.payload === 'object') {
        applyRenderSurfaceStatus(typed.payload as Record<string, unknown>);
      } else if (typed?.type === 'RESPONSE' && typed.data && typeof typed.data === 'object') {
        // The answer to a status request is a snapshot too (`__requestStatusForTest`).
        const data = typed.data as Record<string, unknown>;
        if (typeof data.state === 'string') {
          applyRenderSurfaceStatus(data);
        }
      }
    } catch {
      // Diagnostics only: a malformed push must not break the relay.
    }
    previousInbox?.(payload);
  };
}

interface CurrentDocumentState {
  sourceContent: string;
  filename: string;
  filePath: string;
}

// Global state
const currentDocument: CurrentDocumentState = {
  sourceContent: '',
  filename: '',
  filePath: '',
};
let currentThemeId = 'default'; // Current theme ID (loaded via shared loadAndApplyTheme)
// Stable ref object so renderMarkdownFlow can abort previous renders across calls
const currentTaskManagerRef: { current: AsyncTaskManager | null } = { current: null };
// Every render still streaming, not just the newest one: a superseded render
// whose task manager was displaced from the slot above would otherwise keep
// appending blocks after the newest render finished (the pane then shows the
// previous document while the toolbar already shows the new one).
const activeRenderTasks = new Set<AsyncTaskManager>();
const abortActiveRenders = (): void => {
  for (const task of activeRenderTasks) {
    task.abort();
  }
  activeRenderTasks.clear();
  currentTaskManagerRef.current = null;
};
let currentZoomLevel = 1; // Store current zoom level for applying after content render
let scrollSyncController: ScrollSyncController | null = null; // Scroll sync controller
let isSlidevMode = false; // Whether currently showing a Slidev presentation

// Pending anchor fragment to scroll to after next render (set when navigating via link with hash)
let pendingFragment: string | null = null;

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
  targetLine?: number;  // Explicit target line for rerender/navigation
  forceRender?: boolean; // Force re-render even if file hasn't changed (e.g., theme change)
}

/**
 * Set theme payload
 */
interface SetThemePayload {
  themeId: string;
}

interface SyncHostUiPayload {
  themeId?: string;
  locale?: string;
  settings?: Record<string, unknown>;
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
  payload?: LoadMarkdownPayload | SetThemePayload | UpdateSettingsPayload | SetLocalePayload | SyncHostUiPayload;
}

function hasCurrentDocument(): boolean {
  return currentDocument.filePath.length > 0
    || currentDocument.filename.length > 0
    || currentDocument.sourceContent.length > 0;
}

function getCurrentDocumentPayload(overrides: Partial<LoadMarkdownPayload> = {}): LoadMarkdownPayload {
  return {
    content: currentDocument.sourceContent,
    filename: currentDocument.filename || undefined,
    filePath: currentDocument.filePath || undefined,
    ...overrides,
  };
}

function getCurrentScrollLine(): number {
  return scrollSyncController?.getCurrentLine() ?? 0;
}

async function rerenderCurrentDocument(overrides: Partial<LoadMarkdownPayload> = {}): Promise<void> {
  if (!hasCurrentDocument()) {
    return;
  }

  await handleLoadMarkdown(getCurrentDocumentPayload(overrides));
}

async function rerenderCurrentDocumentPreservingScroll(overrides: Partial<LoadMarkdownPayload> = {}): Promise<void> {
  await rerenderCurrentDocument({
    forceRender: true,
    targetLine: getCurrentScrollLine(),
    ...overrides,
  });
}

async function syncHostUi(payload: SyncHostUiPayload): Promise<void> {
  if (payload.themeId !== undefined) {
    await handleSetTheme({ themeId: payload.themeId });
  }

  if (payload.locale !== undefined) {
    await handleSetLocale({ locale: payload.locale });
  }

  if (payload.settings !== undefined) {
    await handleUpdateSettings({ settings: payload.settings });
  }
}

function isBridgeMessage(message: unknown): message is BridgeMessage {
  if (!message || typeof message !== 'object') return false;
  const obj = message as Record<string, unknown>;
  return typeof obj.type === 'string';
}

/**
 * Warms the render surface, once Dart has said which one to use.
 *
 * The page cannot decide this itself at boot (see the note in `initialize`), so
 * Dart calls this after publishing the mode and before injecting a document:
 *   - iframe mode: pre-load the in-page iframe and let its readiness handshake run
 *     in the background (the first diagram still awaits it through
 *     `RendererService.sendToHost`, which keeps the cold-start retry);
 *   - render-WebView mode: nothing to do here — Dart warms the hidden WebView
 *     itself, after this page is interactive.
 *
 * Deliberately not awaited by Dart: the page's readiness must not depend on
 * another document's boot (plan §2, G2).
 */
function wakeRenderSurface(): boolean {
  if (isRenderViewMode()) {
    return false;
  }
  void platform.renderer.ensureReady();
  return true;
}

// Dart calls this right after it publishes the mode (mobile/lib/main.dart,
// `_markWebViewReady`). Assigned at module scope on purpose: the document must not
// wait for it, so it cannot live inside the awaited part of `initialize()`.
window.__mvRenderWakeRenderSurface = wakeRenderSurface;

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

    // The render surface is *not* warmed here. Which surface this page must use is
    // decided by Dart (mobile/lib/dev/render_view_mode.dart) and published as
    // `window.__mvRenderView`; before that publication the answer is unknown, and
    // any call into the render service would create its host now — freezing the
    // choice at "no mode yet", which means the in-page iframe renders every diagram
    // even under the render-WebView mode. Dart wakes the surface instead, right
    // after it publishes the mode and before it injects a document
    // (`__mvRenderWakeRenderSurface` below).

    // Initialize scroll sync controller FIRST (before message handlers)
    // Uses #markdown-content as container, window scroll for mobile
    initScrollSyncController();

    // Set up link click handling via event delegation
    setupLinkHandling();

    // Setup image context menu (shared cross-platform)
    const contentContainer = document.getElementById('markdown-content');
    if (contentContainer) {
      setupImageContextMenu({
        container: contentContainer,
        onDownload: ({ filename, data, mimeType }) => {
          bridge.sendRequest('DOWNLOAD_FILE', { filename, data, mimeType });
        },
        translate: (key) => Localization.translate(key),
      });

      // Setup table context menu for copy/Excel export (shared cross-platform)
      setupTableContextMenu({
        container: contentContainer,
        onDownload: ({ filename, data, mimeType }) => {
          bridge.sendRequest('DOWNLOAD_FILE', { filename, data, mimeType });
        },
        translate: (key) => Localization.translate(key),
      });

      setupDiagramLightbox({
        container: contentContainer,
        translate: (key) => Localization.translate(key),
      });

      setupCodeBlockCopy({
        container: contentContainer,
        translate: (key) => Localization.translate(key),
      });
    }

    // Suppress the browser/WebView native context menu (which includes "Refresh"
    // that would blank the page). The image context menu above handles img elements
    // and calls preventDefault() itself, so we only suppress for non-img targets.
    document.addEventListener('contextmenu', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('img')) {
        e.preventDefault();
      }
    });

    // Set up message handlers from host app (Flutter)
    setupMessageHandlers();

    // Expose an explicit readiness bit for the Flutter side. Polling for
    // `window.openDocument` is too early because that function is assigned
    // before async initialization and render-worker bootstrapping finish.
    window.__mobileWebViewReady = true;

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
      scrollContainerId: 'markdown-wrapper',
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
        case 'OPEN_DOCUMENT':
          await handleLoadMarkdown(message.payload as LoadMarkdownPayload);
          break;

        case 'UPDATE_CONTENT':
          await handleLoadMarkdown(message.payload as LoadMarkdownPayload);
          break;

        case 'SYNC_HOST_UI':
          await syncHostUi(message.payload as SyncHostUiPayload);
          break;

        case 'EXPORT_DOCX':
          await handleExportDocx();
          break;

        case 'EXPORT_EPUB':
          await handleExportEpub();
          break;

        case 'EXPORT_HTML':
          await handleExportHtml();
          break;

        case 'UPDATE_SETTINGS':
          await handleUpdateSettings(message.payload as UpdateSettingsPayload);
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
  const { content, filename, filePath, themeId, targetLine, forceRender } = payload;

  // Check if file changed
  const newFilename = filename || 'document.md';
  const newFilePath = filePath || newFilename; // Fallback to filename if no path
  const fileChanged = currentDocument.filePath !== newFilePath;

  currentDocument.sourceContent = content;
  currentDocument.filename = newFilename;
  currentDocument.filePath = newFilePath;

  // Set file key for scroll position persistence (used by viewer-host)
  setCurrentFileKey(newFilePath);

  // An explicit targetLine is an immediate navigation request; otherwise restore file state.
  let savedScrollLine = typeof targetLine === 'number' && Number.isFinite(targetLine)
    ? Math.max(0, Math.floor(targetLine))
    : 0;
  if (savedScrollLine === 0 && currentDocument.filePath) {
    try {
      const fileState = await platform.fileState.get(currentDocument.filePath);
      if (fileState.scrollLine !== undefined) {
        savedScrollLine = fileState.scrollLine;
      }
    } catch {
      // Keep default scroll line when file state is unavailable.
    }
  }

  // Apply theme inline if provided and different from current
  // (avoids race condition with separate setTheme call triggering rerender)
  if (themeId && themeId !== currentThemeId) {
    currentThemeId = themeId;
    try {
      await loadAndApplyTheme(themeId);
    } catch (error) {
      console.error('[Mobile] Failed to apply theme in loadMarkdown:', error);
    }
  }

  const container = document.getElementById('markdown-content');
  if (!container) {
    console.error('[Mobile] Content container not found');
    return;
  }

  // ── Slidev mode: .slides.md files render as presentations ────────────
  const lowerFilename = newFilename.toLowerCase();
  const isSlidevByExtension = lowerFilename.endsWith('.slides.md');
  if (isSlidevByExtension) {
    isSlidevMode = true;

    // Hide normal markdown wrapper, use body as container
    const wrapper = document.getElementById('markdown-wrapper');
    if (wrapper) wrapper.style.display = 'none';

    document.documentElement.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';
    document.body.style.cssText = 'margin:0;padding:0;width:100%;height:100%;overflow:hidden';

    // Reuse or create a slidev container
    let slidevContainer = document.getElementById('slidev-container');
    if (!slidevContainer) {
      slidevContainer = document.createElement('div');
      slidevContainer.id = 'slidev-container';
      slidevContainer.style.cssText = 'width:100%;height:100%';
      document.body.appendChild(slidevContainer);
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
        // Use platform.resource.fetch() — native fetch doesn't work reliably
        // with Flutter assets in WKWebView (macOS/iOS)
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
    const slidevContainer = document.getElementById('slidev-container');
    if (slidevContainer) slidevContainer.remove();
    const wrapper = document.getElementById('markdown-wrapper');
    if (wrapper) wrapper.style.display = '';
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
  }

  // Override scroll position with heading line if navigating via anchor link
  if (pendingFragment) {
    const headingLine = findHeadingLine(content, pendingFragment);
    if (typeof headingLine === 'number') {
      savedScrollLine = headingLine;
    }
    pendingFragment = null;
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
    currentTaskManagerRef,
    activeRenderTasks,
    abortActiveRenders,
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

    // External links (http/https/mailto/tel/custom schemes)
    if (isExternalUrl(href)) {
      bridge.postMessage('OPEN_URL', { url: href });
    }
    // Anchor links - in-page navigation
    else if (href.startsWith('#')) {
      const targetEl = document.getElementById(decodeURIComponent(href.slice(1)));
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'auto' });
      }
    }
    // Relative links
    else {
      const { path: pathPart, fragment } = splitPathAndFragment(href);
      if (fragment !== undefined) {
        pendingFragment = decodeURIComponent(fragment);
      }

      // Check if it's a markdown file
      const isMarkdown = pathPart.endsWith('.md') || pathPart.endsWith('.markdown');

      if (isMarkdown) {
        // Load markdown file internally
        bridge.postMessage('LOAD_RELATIVE_MARKDOWN', { path: pathPart });
      } else {
        // For other relative files (images, etc.), try to open with system handler
        bridge.postMessage('OPEN_RELATIVE_FILE', { path: pathPart });
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
        await rerenderCurrentDocument({ targetLine: scrollLine, forceRender: true });
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
    markdown: currentDocument.sourceContent,
    filename: currentDocument.filename,
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
 * Handle HTML export
 */
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
      bridge.postMessage('EXPORT_PROGRESS', {
        completed,
        total,
        phase: phase || 'processing',
        format: 'html',
      });
    },
    onSuccess: () => {
      // Mobile share flow is handled by DOWNLOAD_FILE response pipeline.
    },
    onError: (error) => {
      bridge.postMessage('EXPORT_ERROR', { error });
    },
  });
}

/**
 * Handle EPUB export
 */
async function handleExportEpub(): Promise<void> {
  const page = document.getElementById('markdown-page') as HTMLElement | null;
  if (!page) {
    return;
  }

  await exportEpubFlow({
    container: page,
    filename: currentDocument.filename,
    title: currentDocument.filename || document.title || 'Markdown Viewer',
    platform,
    onProgress: (completed, total, phase) => {
      bridge.postMessage('EXPORT_PROGRESS', {
        completed,
        total,
        phase: phase || 'processing',
        format: 'epub',
      });
    },
    onSuccess: () => {
      // Mobile share flow is handled by DOWNLOAD_FILE response pipeline.
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
    await rerenderCurrentDocument();
  } catch (error) {
    console.error('[Mobile] Locale change failed:', error);
  }
}

// Extend Window interface for mobile API
// Most functionality is now on platform object, only expose minimal API for Flutter calls
declare global {
  interface Window {
    openDocument: (payload: LoadMarkdownPayload) => void;
    updateContent: (payload: LoadMarkdownPayload) => void;
    syncHostUi: (payload: SyncHostUiPayload) => Promise<void>;
    // Export
    exportDocx: () => void;
    exportHtml: () => void;
    // Display settings
    setFontSize: (size: number) => void;
    // Re-render with updated settings
    rerender: () => Promise<void>;
    // Reload theme CSS (for settings baked into theme CSS) then re-render
    reloadThemeAndRerender: () => Promise<void>;
    // Platform object has all services: platform.cache, platform.i18n, etc.
  }
}

// Expose API to window for host app to call (e.g. via runJavaScript)
window.openDocument = (payload: LoadMarkdownPayload) => {
  handleLoadMarkdown(payload);
};

window.updateContent = (payload: LoadMarkdownPayload) => {
  handleLoadMarkdown(payload);
};

window.syncHostUi = async (payload: SyncHostUiPayload) => {
  await syncHostUi(payload);
};

window.exportDocx = () => {
  handleExportDocx();
};

window.exportHtml = () => {
  handleExportHtml();
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

window.rerender = async () => {
  // Re-render current markdown with updated settings
  await rerenderCurrentDocumentPreservingScroll();
};

// Reload theme CSS (for settings baked into theme CSS like firstLineIndent) then re-render
window.reloadThemeAndRerender = async () => {
  try {
    await loadAndApplyTheme(currentThemeId);
  } catch (error) {
    console.error('[Mobile] Failed to reload theme:', error);
  }
  await rerenderCurrentDocumentPreservingScroll();
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
