/**
 * ViewerHost - Unified utilities for viewer WebView across all platforms
 *
 * This module provides shared functionality for Chrome, VSCode, and Mobile platforms.
 * Each function is designed to be independently usable, allowing incremental adoption.
 *
 * Step 1: Basic utility functions
 * - createViewerScrollSync: Scroll sync controller with unified state persistence
 * - createPluginRenderer: Plugin renderer for diagrams (Mermaid, Vega, etc.)
 * - getFrontmatterDisplay: Read frontmatter display setting
 * - applyZoom: Apply zoom level with scroll position preservation
 *
 * Step 2: Unified render flow
 * - renderMarkdownFlow: Main render function used by all platforms
 */

import { createScrollSyncController, type ScrollSyncController } from '../line-based-scroll';
import { getDocument, renderMarkdownDocument } from './viewer-controller';
import { AsyncTaskManager } from '../markdown-processor';
import type { PluginRenderer, PlatformAPI } from '../../types/index';
import type { FrontmatterDisplay } from './viewer-controller';

// ============================================================================
// File Key Management (for scroll position persistence)
// ============================================================================

let currentFileKey = '';

/**
 * Set the current file key for scroll position persistence.
 * Call this when loading a new file.
 *
 * @param key - File identifier (URL for Chrome, filename for VSCode, filePath for Mobile)
 */
export function setCurrentFileKey(key: string): void {
  currentFileKey = key;
}

/**
 * Get the current file key.
 */
export function getCurrentFileKey(): string {
  return currentFileKey;
}

// ============================================================================
// Scroll Sync Controller
// ============================================================================

export interface ViewerScrollSyncOptions {
  /** Container element ID (default: 'markdown-content') */
  containerId?: string;
  /** Platform API instance */
  platform: PlatformAPI;
  /**
   * Custom callback for user scroll events.
   * If not provided, defaults to saving scroll position to FileStateService.
   */
  onUserScroll?: (line: number) => void;
  /** Offset from viewport top (e.g., fixed toolbar height) */
  topOffset?: number;
}

/**
 * Create a scroll sync controller with unified state persistence.
 *
 * By default, the controller saves scroll position to FileStateService
 * using the key set via setCurrentFileKey().
 *
 * For VSCode, pass a custom onUserScroll to send REVEAL_LINE messages instead.
 *
 * @example
 * ```typescript
 * // Chrome/Mobile: auto-save to FileStateService
 * setCurrentFileKey(documentUrl);
 * const scrollController = createViewerScrollSync({ platform });
 *
 * // VSCode: custom behavior
 * const scrollController = createViewerScrollSync({
 *   platform,
 *   onUserScroll: (line) => vscodeBridge.postMessage('REVEAL_LINE', { line }),
 * });
 * ```
 */
export function createViewerScrollSync(options: ViewerScrollSyncOptions): ScrollSyncController {
  const {
    containerId = 'markdown-content',
    platform,
    onUserScroll,
    topOffset,
  } = options;

  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`[ViewerHost] Container '${containerId}' not found`);
  }

  // Default behavior: save to FileStateService
  const defaultOnUserScroll = (line: number) => {
    if (currentFileKey) {
      platform.fileState.set(currentFileKey, { scrollLine: line });
    }
  };

  return createScrollSyncController({
    container,
    getLineMapper: getDocument,
    onUserScroll: onUserScroll ?? defaultOnUserScroll,
    topOffset,
  });
}

// ============================================================================
// Plugin Renderer
// ============================================================================

/**
 * Create a plugin renderer for diagrams (Mermaid, Vega, GraphViz, etc.).
 *
 * This wraps the platform's renderer API in the PluginRenderer interface
 * expected by the markdown processor.
 *
 * @example
 * ```typescript
 * const pluginRenderer = createPluginRenderer(platform);
 * const result = await pluginRenderer.render('mermaid', 'graph TD; A-->B');
 * ```
 */
export function createPluginRenderer(platform: PlatformAPI): PluginRenderer {
  return {
    render: async (type: string, content: string | object) => {
      const result = await platform.renderer.render(type, content);
      return {
        base64: result.base64,
        width: result.width,
        height: result.height,
        format: result.format,
        error: undefined,
        svg: result.svg,
        drawioXml: result.drawioXml,
      };
    },
  };
}

// ============================================================================
// Settings
// ============================================================================

/**
 * Get the frontmatter display setting.
 * Uses platform.settings service exclusively.
 *
 * @returns 'hide' | 'show' | 'fold'
 */
export async function getFrontmatterDisplay(platform: PlatformAPI): Promise<FrontmatterDisplay> {
  try {
    return await platform.settings.get('frontmatterDisplay');
  } catch {
    return 'hide';
  }
}

/**
 * Get the table merge empty setting.
 * Uses platform.settings service exclusively.
 *
 * @returns boolean (default: true)
 */
export async function getTableMergeEmpty(platform: PlatformAPI): Promise<boolean> {
  try {
    return await platform.settings.get('tableMergeEmpty');
  } catch {
    return true;
  }
}

/**
 * Get the table layout setting.
 * Uses platform.settings service exclusively.
 *
 * @returns 'left' | 'center' (default: 'center')
 */
export async function getTableLayout(platform: PlatformAPI): Promise<'left' | 'center'> {
  try {
    const layout = await platform.settings.get('tableLayout');
    return layout === 'left' ? 'left' : 'center';
  } catch {
    return 'center';
  }
}

// ============================================================================
// Zoom
// ============================================================================

export interface ApplyZoomOptions {
  /** Zoom level as percentage (e.g., 100, 150, 200) */
  zoom: number;
  /** Container element ID (default: 'markdown-content') */
  containerId?: string;
  /** Scroll controller to lock during zoom (optional) */
  scrollController?: ScrollSyncController | null;
}

/**
 * Apply zoom level to the container with scroll position preservation.
 *
 * @returns The applied zoom level as a decimal (e.g., 1.0, 1.5, 2.0)
 *
 * @example
 * ```typescript
 * const zoomLevel = applyZoom({ zoom: 150, scrollController });
 * // zoomLevel = 1.5
 * ```
 */
export function applyZoom(options: ApplyZoomOptions): number {
  const {
    zoom,
    containerId = 'markdown-content',
    scrollController,
  } = options;

  const zoomLevel = zoom / 100;

  // Lock scroll position before zoom change
  // No scroll lock needed in simplified scroll controller.

  const container = document.getElementById(containerId);
  if (container) {
    applyZoomToElement(container as HTMLElement, zoomLevel);
  }

  return zoomLevel;
}

/**
 * Apply zoom to an element using CSS zoom or transform: scale() fallback.
 * iOS WKWebView does not support CSS zoom, so we use transform: scale()
 * with width compensation to avoid horizontal overflow.
 */
function applyZoomToElement(el: HTMLElement, zoomLevel: number): void {
  if (supportsCSSZoom()) {
    el.style.zoom = String(zoomLevel);
  } else {
    // Use transform: scale() for iOS WKWebView
    // transform doesn't affect layout size, so we must compensate height
    // on the parent to avoid blank space (zoom < 1) or clipping (zoom > 1).
    const parent = el.parentElement;
    if (zoomLevel === 1) {
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.width = '';
      if (parent) parent.style.height = '';
    } else {
      el.style.transform = `scale(${zoomLevel})`;
      el.style.transformOrigin = 'top left';
      // Compensate width so scaled content doesn't overflow
      el.style.width = `${100 / zoomLevel}%`;
      // Compensate parent height: layout height stays original,
      // but visual height = scrollHeight * zoomLevel
      if (parent) {
        const updateHeight = () => {
          parent.style.height = `${el.scrollHeight * zoomLevel}px`;
        };
        updateHeight();
        // Re-measure after content may have reflowed
        requestAnimationFrame(updateHeight);
      }
    }
  }
}

/** Detect CSS zoom support (iOS WKWebView claims support but doesn't scale text correctly) */
function supportsCSSZoom(): boolean {
  const ua = navigator.userAgent;
  // iOS WKWebView reports CSS.supports('zoom') = true but zoom only affects
  // replaced elements (images), not text. Detect iOS specifically.
  if (/iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document)) {
    return false;
  }
  return true;
}

// ============================================================================
// Render Markdown Flow
// ============================================================================

/**
 * Translate function type for localization
 */
export type TranslateFn = (key: string, subs?: string | string[]) => string;

/**
 * Options for the unified render markdown flow.
 * 
 * This abstracts the common rendering logic across Chrome/VSCode/Mobile,
 * with platform-specific behavior controlled via callbacks.
 */
export interface RenderMarkdownFlowOptions {
  /** Markdown content to render */
  markdown: string;
  
  /** Container element to render into */
  container: HTMLElement;
  
  /** Whether the file has changed (new file loaded) */
  fileChanged: boolean;
  
  /** Force re-render even if file hasn't changed (e.g., theme change) */
  forceRender: boolean;
  
  /** Current zoom level as decimal (1.0 = 100%) */
  zoomLevel: number;
  
  /** Scroll sync controller (optional) */
  scrollController: ScrollSyncController | null;
  
  /** Plugin renderer for diagrams */
  renderer: PluginRenderer;
  
  /** Translate function for localization */
  translate: TranslateFn;
  
  /** Platform API */
  platform: PlatformAPI;
  
  /** 
   * Reference to current task manager for abort handling.
   * The function will set currentTaskManagerRef.current during rendering.
   */
  currentTaskManagerRef: { current: AsyncTaskManager | null };
  
  /**
   * Target line for scroll sync.
   * - Chrome/Mobile: Pass the saved scroll line
   * - VSCode: Pass undefined (uses message-driven targetLine set before render)
   */
  targetLine?: number;
  
  /**
   * Callback when headings are extracted during render.
   * - Chrome: Update TOC progressively
   * - VSCode/Mobile: Send to host
   */
  onHeadings?: (headings: Array<{ level: number; text: string; id: string }>) => void;
  
  /**
   * Callback for async task progress (diagrams, charts).
   * - VSCode/Mobile: Send RENDER_PROGRESS to host
   * - Chrome: Update progress indicator
   */
  onProgress?: (completed: number, total: number) => void;
  
  /**
   * Called before processing async tasks.
   * - Chrome: Show processing indicator
   */
  beforeProcessAll?: () => void;
  
  /**
   * Called after processing async tasks.
   * - Chrome: Hide processing indicator
   */
  afterProcessAll?: () => void;
  
  /**
   * Called after render completes successfully.
   * - Chrome: Update active TOC item
   */
  afterRender?: () => void;
}

/**
 * Unified markdown rendering flow for all platforms.
 * 
 * This function handles:
 * 1. Task manager lifecycle (create, abort previous, cleanup)
 * 2. Container clearing and scroll reset logic
 * 3. Zoom application
 * 4. Markdown rendering with streaming
 * 5. Async task processing (diagrams, charts)
 * 
 * Platform-specific behavior is controlled via callbacks.
 * 
 * @example
 * ```typescript
 * // Chrome
 * await renderMarkdownFlow({
 *   markdown,
 *   container,
 *   fileChanged: true,
 *   forceRender: false,
 *   zoomLevel: 1.5,
 *   scrollController,
 *   renderer: pluginRenderer,
 *   translate: Localization.translate,
 *   platform,
 *   currentTaskManagerRef: { current: currentTaskManager },
 *   targetLine: savedScrollLine,
 *   onHeadings: () => generateTOC(),
 *   beforeProcessAll: showProcessingIndicator,
 *   afterProcessAll: hideProcessingIndicator,
 *   afterRender: updateActiveTocItem,
 * });
 * 
 * // VSCode (targetLine undefined - set via message)
 * await renderMarkdownFlow({
 *   markdown,
 *   container,
 *   fileChanged,
 *   forceRender,
 *   zoomLevel: currentZoomLevel,
 *   scrollController,
 *   renderer: pluginRenderer,
 *   translate: Localization.translate,
 *   platform,
 *   currentTaskManagerRef: { current: currentTaskManager },
 *   onHeadings: (h) => vscodeBridge.postMessage('HEADINGS_UPDATED', h),
 *   onProgress: (c, t) => vscodeBridge.postMessage('RENDER_PROGRESS', { completed: c, total: t }),
 * });
 * ```
 */
export async function renderMarkdownFlow(options: RenderMarkdownFlowOptions): Promise<void> {
  const {
    markdown,
    container,
    fileChanged,
    forceRender,
    zoomLevel,
    scrollController,
    renderer,
    translate,
    platform,
    currentTaskManagerRef,
    targetLine,
    onHeadings,
    onProgress,
    beforeProcessAll,
    afterProcessAll,
    afterRender,
  } = options;

  // Abort any previous rendering task
  if (currentTaskManagerRef.current) {
    currentTaskManagerRef.current.abort();
    currentTaskManagerRef.current = null;
  }

  try {
    // Create task manager
    const taskManager = new AsyncTaskManager(translate);
    currentTaskManagerRef.current = taskManager;

    // Determine if we need to clear container
    const shouldClear = fileChanged || forceRender;

    if (shouldClear) {
      // Check if this is a real file switch (has existing content) vs initial load
      const isRealFileSwitch = container.childNodes.length > 0;

      // Clear container
      container.innerHTML = '';

      // Only reset scroll state on real file switch, not initial load
      if (isRealFileSwitch && fileChanged) {
        scrollController?.reset();
      }
    }

    // Set target line for scroll sync
    // VSCode: targetLine is undefined, uses message-driven value (setTargetLine called from events)
    // Chrome/Mobile: targetLine is passed BUT we do NOT scroll yet — wait for processAll.
    //   Scrolling before diagrams render gives wrong pixel position (block heights differ).
    //   The single correct scroll happens after processAll below.
    if (targetLine === undefined) {
      // VSCode-driven: message handler already called setTargetLine; nothing to do here.
    }
    // (Chrome/Mobile: intentionally skip pre-render setTargetLine)

    // Apply zoom level before rendering
    if (zoomLevel !== 1) {
      applyZoomToElement(container, zoomLevel);
    }

    // Get frontmatter display setting
    const frontmatterDisplay = await getFrontmatterDisplay(platform);

    // Get table merge empty setting
    const tableMergeEmpty = await getTableMergeEmpty(platform);

    // Get table layout setting
    const tableLayout = await getTableLayout(platform);

    // Apply table layout class to container
    container.classList.remove('table-layout-left', 'table-layout-center');
    container.classList.add(`table-layout-${tableLayout}`);

    // Render markdown
    const renderResult = await renderMarkdownDocument({
      markdown,
      container,
      renderer,
      translate,
      taskManager,
      clearContainer: false, // Already cleared above if needed
      frontmatterDisplay,
      tableMergeEmpty,
      tableLayout,
      onHeadings,
      // onChunkComplete / onStreamingComplete: used for event-driven scroll retries
      // (when setTargetLine is called from a SCROLL_TO_LINE event, onStreamingComplete
      //  retries the scroll after each chunk until the target block enters the DOM).
      // When targetLine is passed directly (anchor navigation, theme switch),
      // call setTargetLine as soon as streaming finishes so the scroll happens
      // immediately — before waiting for diagrams to render.
      onChunkComplete: () => {
        scrollController?.onStreamingComplete();
      },
      onStreamingComplete: () => {
        if (targetLine !== undefined && scrollController) {
          scrollController.setTargetLine(targetLine);
        }
        scrollController?.onStreamingComplete();
      },
    });

    if (taskManager.isAborted()) {
      return;
    }

    // Platform-specific: called after streaming, before async tasks
    // Chrome uses this to update TOC active state
    if (afterRender) {
      setTimeout(afterRender, 100);
    }

    // Process async tasks (diagrams, charts).
    // When targetLine is set, scroll as soon as all diagrams UP TO targetLine are done —
    // no need to wait for diagrams further down the page.
    let scrolledToTarget = false;
    const tryScrollToTarget = (): void => {
      if (scrolledToTarget || targetLine === undefined || !scrollController) return;
      // Check if all blocks at or before targetLine still have pending placeholders.
      // Tasks run in parallel, so some earlier blocks may finish before later ones.
      const blocks = container.querySelectorAll<HTMLElement>('[data-block-id][data-line]');
      for (const block of Array.from(blocks)) {
        const blockLine = Number(block.getAttribute('data-line'));
        if (blockLine > targetLine) break;
        if (block.querySelector('.async-placeholder')) return; // still pending
      }
      // All blocks up to targetLine have rendered their diagrams
      scrolledToTarget = true;
      scrollController.setTargetLine(targetLine);
    };

    beforeProcessAll?.();
    try {
      await renderResult.taskManager.processAll((completed, total) => {
        if (!taskManager.isAborted()) {
          onProgress?.(completed, total);
          tryScrollToTarget();
        }
      });
    } finally {
      afterProcessAll?.();
    }

    // Final scroll: either targetLine wasn't reached above (no diagrams before it,
    // or targetLine is undefined), or we need to land accurately after all content settles.
    if (!taskManager.isAborted() && targetLine !== undefined && !scrolledToTarget) {
      scrollController?.setTargetLine(targetLine);
    }

    // After async tasks (diagrams etc.) may have changed content height,
    // re-compensate parent height for transform: scale() on iOS
    if (!supportsCSSZoom() && zoomLevel !== 1) {
      const parent = container.parentElement;
      if (parent) {
        requestAnimationFrame(() => {
          parent.style.height = `${container.scrollHeight * zoomLevel}px`;
        });
      }
    }

    // Clear task manager reference
    if (currentTaskManagerRef.current === taskManager) {
      currentTaskManagerRef.current = null;
    }

  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[ViewerHost] Render failed:', error);
  }
}

// ============================================================================
// Theme Switch Flow
// ============================================================================

/**
 * Options for the unified theme switch flow.
 */
export interface ThemeSwitchFlowOptions {
  /** New theme ID */
  themeId: string;
  
  /** Scroll sync controller (optional) */
  scrollController: ScrollSyncController | null;
  
  /**
   * Apply theme callback - called to load and apply CSS.
   * Typically: loadAndApplyTheme(themeId)
   */
  applyTheme: (themeId: string) => Promise<void>;
  
  /**
   * Save theme callback - called after successful apply.
   * Typically: themeManager.saveSelectedTheme(themeId)
   */
  saveTheme?: (themeId: string) => Promise<void>;
  
  /**
   * Re-render callback - called to re-render content with new theme.
   * Receives the saved scroll line to restore position.
   */
  rerender?: (scrollLine: number) => Promise<void>;
}

/**
 * Unified theme switch flow for all platforms (Chrome, VSCode, Mobile).
 * 
 * This function handles:
 * 1. Save current scroll position
 * 2. Reset scroll controller and set target line
 * 3. Apply the new theme
 * 4. Optionally save the theme selection
 * 5. Re-render content if needed
 * 
 * @example
 * ```typescript
 * await handleThemeSwitchFlow({
 *   themeId: 'github-dark',
 *   scrollController,
 *   applyTheme: (id) => loadAndApplyTheme(id),
 *   saveTheme: (id) => themeManager.saveSelectedTheme(id),
 *   rerender: (line) => handleUpdateContent({ content, filename, forceRender: true }),
 * });
 * ```
 */
export async function handleThemeSwitchFlow(options: ThemeSwitchFlowOptions): Promise<void> {
  const {
    themeId,
    scrollController,
    applyTheme,
    saveTheme,
    rerender,
  } = options;

  // Save current reading position before reset
  const savedLine = scrollController?.getCurrentLine() ?? 0;
  
  // Only reset scroll controller - don't call setTargetLine here
  // because DOM hasn't been updated yet. Let renderMarkdownFlow handle
  // setTargetLine after the DOM is updated with new theme.
  scrollController?.reset();

  // Load and apply theme
  await applyTheme(themeId);

  // Save theme selection if callback provided
  if (saveTheme) {
    await saveTheme(themeId);
  }

  // Re-render content if callback provided
  if (rerender) {
    await rerender(savedLine);
  }
}

// ============================================================================
// DOCX Export Flow
// ============================================================================

/**
 * Options for the unified DOCX export flow.
 */
export interface DocxExportFlowOptions {
  /** Markdown content to export */
  markdown: string;
  
  /** Original filename (will be converted to .docx) */
  filename: string;
  
  /** Plugin renderer for diagrams */
  renderer: PluginRenderer;
  
  /**
   * Progress callback during export.
   * @param completed - Number of completed items
   * @param total - Total number of items
   */
  onProgress?: (completed: number, total: number) => void;
  
  /**
   * Success callback with the generated filename.
   */
  onSuccess?: (filename: string) => void;
  
  /**
   * Error callback with error message.
   */
  onError?: (error: string) => void;
}

/**
 * Convert filename to .docx extension.
 * Handles .md, .markdown, and other extensions.
 */
export function toDocxFilename(filename: string): string {
  let docxFilename = filename || 'document.docx';
  if (docxFilename.toLowerCase().endsWith('.md')) {
    docxFilename = docxFilename.slice(0, -3) + '.docx';
  } else if (docxFilename.toLowerCase().endsWith('.markdown')) {
    docxFilename = docxFilename.slice(0, -9) + '.docx';
  } else if (!docxFilename.toLowerCase().endsWith('.docx')) {
    docxFilename = docxFilename + '.docx';
  }
  return docxFilename;
}

/**
 * Unified DOCX export flow for VSCode and Mobile.
 * 
 * This function handles:
 * 1. Convert filename to .docx
 * 2. Create exporter with plugin renderer
 * 3. Export with progress reporting
 * 4. Call success/error callbacks
 * 
 * @example
 * ```typescript
 * await exportDocxFlow({
 *   markdown: currentMarkdown,
 *   filename: currentFilename,
 *   renderer: pluginRenderer,
 *   onProgress: (c, t) => bridge.postMessage('EXPORT_PROGRESS', { completed: c, total: t }),
 *   onSuccess: (f) => bridge.postMessage('EXPORT_DOCX_RESULT', { success: true, filename: f }),
 *   onError: (e) => bridge.postMessage('EXPORT_DOCX_RESULT', { success: false, error: e }),
 * });
 * ```
 */
export async function exportDocxFlow(options: DocxExportFlowOptions): Promise<void> {
  const {
    markdown,
    filename,
    renderer,
    onProgress,
    onSuccess,
    onError,
  } = options;

  try {
    const docxFilename = toDocxFilename(filename);

    // Dynamically import DocxExporter to avoid circular dependencies
    const DocxExporterModule = await import('../../exporters/docx-exporter');
    const DocxExporter = DocxExporterModule.default;
    const exporter = new DocxExporter(renderer);

    const result = await exporter.exportToDocx(markdown, docxFilename, onProgress);

    if (!result.success) {
      throw new Error(result.error || 'Export failed');
    }

    onSuccess?.(docxFilename);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // Silently ignore user cancellation
    if (errMsg === 'Download cancelled by user') return;
    // eslint-disable-next-line no-console
    console.error('[ViewerHost] DOCX export failed:', errMsg);
    onError?.(errMsg);
  }
}
