/**
 * Toolbar Manager
 * Handles toolbar initialization and button event handlers
 */

import { getFilenameFromURL, getDocumentFilename, toMarkdownFilename } from '../../../../src/core/document-utils';
import { applyZoom as applyZoomCore, exportEpubFlow, exportHtmlFlow } from '../../../../src/core/viewer/viewer-host';
import { createExportMenu } from '../../../../src/ui/export-menu';
import { showActionMenu } from '../../../../src/ui/action-menu';
import { printElement, isPrintAvailable, PRINT_BLOCKED_BY_SANDBOX } from '../../../../src/ui/print-utils';
import type {
  TranslateFunction,
  EscapeHtmlFunction,
  FileState,
  DocxExporter,
  LayoutConfig,
  ToolbarManagerOptions,
  ToolbarManagerInstance,
  GenerateToolbarHTMLOptions
} from '../../../../src/types/index';
import type { BookExportPhase } from '../../../../src/types/book-export';
import { createRemarkMode } from '../../../../src/ui/remark-mode';
import type { RemarkModeController } from '../../../../src/ui/remark-mode';
import { BookExportProgressModel } from './book-export-progress';

// SVG icons for different layouts
export const layoutIcons: Record<string, string> = {
  normal: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
    <rect x="3" y="4" width="14" height="12" stroke-width="2" rx="1"/>
    <line x1="3" y1="7" x2="17" y2="7" stroke-width="2"/>
  </svg>`,
  fullscreen: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
    <rect x="2" y="2" width="16" height="16" stroke-width="2" rx="1"/>
    <line x1="2" y1="6" x2="18" y2="6" stroke-width="2"/>
  </svg>`,
  narrow: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
    <rect x="6" y="3" width="8" height="14" stroke-width="2" rx="1"/>
    <line x1="6" y1="6" x2="14" y2="6" stroke-width="2"/>
  </svg>`
};

/**
 * Creates a toolbar manager for handling toolbar functionality.
 * @param options - Configuration options
 * @returns Toolbar manager instance
 */
export function createToolbarManager(options: ToolbarManagerOptions): ToolbarManagerInstance {
  const {
    translate,
    escapeHtml,
    saveFileState,
    getFileState,
    isMobile,
    rawMarkdown,
    getRawContent,
    docxExporter,
    cancelScrollRestore,
    updateActiveTocItem,
    onBeforeZoom,
    onSetTocVisibility,
    enableSourceToggle,
    onToggleSourceMode,
    getSourceMode,
    isSourceModeActive,
    enableRemarkMode,
    getRemarkContainer,
    getRemarkRawMarkdown,
    onExportBookDocx,
    onExportBookEpub,
    onExportBookPdf,
  } = options;

  // Layout configurations
  const layoutTitles: Record<string, string> = {
    normal: translate('toolbar_layout_title_normal'),
    fullscreen: translate('toolbar_layout_title_fullscreen'),
    narrow: translate('toolbar_layout_title_narrow')
  };

  const layoutConfigs: Record<string, LayoutConfig> = {
    normal: { maxWidth: '1360px', icon: layoutIcons.normal, title: layoutTitles.normal },
    fullscreen: { maxWidth: '100%', icon: layoutIcons.fullscreen, title: layoutTitles.fullscreen },
    narrow: { maxWidth: '680px', icon: layoutIcons.narrow, title: layoutTitles.narrow }
  };

  // Global zoom state
  let currentZoomLevel = 100;

  // Current layout mode (normal | fullscreen | narrow). Lives at manager scope
  // so applyLocale can refresh the layout button tooltip without a reload.
  let currentLayout = 'normal';

  // Remark Mode controller
  let remarkController: RemarkModeController | null = null;
  if (enableRemarkMode && getRemarkContainer) {
    remarkController = createRemarkMode({
      getContainer: getRemarkContainer,
      getRawMarkdown: getRemarkRawMarkdown || (() => rawMarkdown),
      translate,
      onModeChange: (isActive: boolean) => {
        const btn = document.getElementById('toggle-remark-btn');
        if (!btn) return;
        btn.classList.toggle('remark-active', isActive);
        const title = isActive
          ? translate('remark_exit_mode')
          : translate('remark_mode');
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.setAttribute('aria-pressed', String(isActive));
      },
      onAnnotationCountChange: (count: number) => {
        const badge = document.getElementById('remark-count-badge');
        if (badge) {
          badge.textContent = count > 0 ? String(count) : '';
          badge.style.display = count > 0 ? 'flex' : 'none';
        }
      },
    });
  }

  async function exportDocxFromToolbar(): Promise<void> {
    const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement | null;
    if (!downloadBtn || downloadBtn.disabled) {
      return;
    }

    // Request downloads permission only for remote files (local files use <a download> fallback)
    if (!window.location.protocol.startsWith('file')) {
      try {
        await chrome.runtime.sendMessage({ type: 'REQUEST_DOWNLOADS_PERMISSION' });
      } catch {
        // Ignore - background will fall back if permission denied
      }
    }

    try {
      downloadBtn.disabled = true;
      downloadBtn.classList.add('downloading');

      const originalContent = downloadBtn.innerHTML;
      downloadBtn.setAttribute('data-original-content', originalContent);
      const progressHTML = `
        <svg class="progress-circle" width="18" height="18" viewBox="0 0 18 18">
          <circle class="progress-circle-bg" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none" opacity="0.3"/>
          <circle class="download-progress-circle" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none"
                  stroke-dasharray="43.98" stroke-dashoffset="43.98" transform="rotate(-90 9 9)"/>
        </svg>
      `;
      downloadBtn.innerHTML = progressHTML;

      const markdown = rawMarkdown;
      const filename = getDocumentFilename();
      const exportErrorFallback = translate('docx_export_failed_default');
      const result = await docxExporter.exportToDocx(markdown, filename, (completed, total) => {
        const progressCircle = downloadBtn.querySelector('.download-progress-circle');
        if (progressCircle && total > 0) {
          const progress = completed / total;
          const circumference = 43.98;
          const offset = circumference * (1 - progress);
          (progressCircle as SVGCircleElement).style.strokeDashoffset = String(offset);
        }
      });

      if (!result.success) {
        throw new Error(result.error || exportErrorFallback);
      }

      downloadBtn.innerHTML = originalContent;
      downloadBtn.disabled = false;
      downloadBtn.classList.remove('downloading');
      downloadBtn.removeAttribute('data-original-content');
    } catch (error) {
      console.error('Export error:', error);
      const alertDetail = (error as Error)?.message ? `: ${(error as Error).message}` : '';
      const alertMessage = translate('docx_export_failed_alert', [alertDetail])
        || `Export failed${alertDetail}`;
      alert(alertMessage);

      const originalContent = downloadBtn.getAttribute('data-original-content') || `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3v10m0 0l-3-3m3 3l3-3M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      downloadBtn.innerHTML = originalContent;
      downloadBtn.disabled = false;
      downloadBtn.classList.remove('downloading');
      downloadBtn.removeAttribute('data-original-content');
    }
  }

  async function exportHtmlFromToolbar(): Promise<void> {
    const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement | null;
    if (!downloadBtn || downloadBtn.disabled) {
      return;
    }

    const page = document.getElementById('markdown-page') as HTMLElement | null;
    if (!page) {
      return;
    }

    // Request downloads permission only for remote files (local files use <a download> fallback)
    if (!window.location.protocol.startsWith('file')) {
      try {
        await chrome.runtime.sendMessage({ type: 'REQUEST_DOWNLOADS_PERMISSION' });
      } catch {
        // Ignore - background will fall back if permission denied
      }
    }

    const originalContent = downloadBtn.innerHTML;
    let exportError: string | null = null;

    try {
      downloadBtn.disabled = true;
      downloadBtn.classList.add('downloading');
      downloadBtn.setAttribute('data-original-content', originalContent);
      const progressHTML = `
        <svg class="progress-circle" width="18" height="18" viewBox="0 0 18 18">
          <circle class="progress-circle-bg" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none" opacity="0.3"/>
          <circle class="download-progress-circle" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none"
                  stroke-dasharray="43.98" stroke-dashoffset="43.98" transform="rotate(-90 9 9)"/>
        </svg>
      `;
      downloadBtn.innerHTML = progressHTML;

      await exportHtmlFlow({
        container: page,
        filename: getFilenameFromURL(),
        title: document.title || getFilenameFromURL(),
        platform: globalThis.platform,
        onProgress: (completed, total) => {
          const progressCircle = downloadBtn.querySelector('.download-progress-circle');
          if (progressCircle && total > 0) {
            const progress = completed / total;
            const circumference = 43.98;
            const offset = circumference * (1 - progress);
            (progressCircle as SVGCircleElement).style.strokeDashoffset = String(offset);
          }
        },
        onError: (error) => {
          exportError = error;
        },
      });

      if (exportError) {
        throw new Error(exportError);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(`Export HTML failed: ${message}`);
    } finally {
      const fallbackIcon = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3v10m0 0l-3-3m3 3l3-3M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      downloadBtn.innerHTML = downloadBtn.getAttribute('data-original-content') || fallbackIcon;
      downloadBtn.disabled = false;
      downloadBtn.classList.remove('downloading');
      downloadBtn.removeAttribute('data-original-content');
    }
  }

  async function exportEpubFromToolbar(): Promise<void> {
    const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement | null;
    if (!downloadBtn || downloadBtn.disabled) {
      return;
    }

    if (!window.location.protocol.startsWith('file')) {
      try {
        await chrome.runtime.sendMessage({ type: 'REQUEST_DOWNLOADS_PERMISSION' });
      } catch {
        // Ignore - background will fall back if permission denied
      }
    }

    const originalContent = downloadBtn.innerHTML;
    let exportError: string | null = null;

    try {
      downloadBtn.disabled = true;
      downloadBtn.classList.add('downloading');
      downloadBtn.setAttribute('data-original-content', originalContent);
      const progressHTML = `
        <svg class="progress-circle" width="18" height="18" viewBox="0 0 18 18">
          <circle class="progress-circle-bg" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none" opacity="0.3"/>
          <circle class="download-progress-circle" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none"
                  stroke-dasharray="43.98" stroke-dashoffset="43.98" transform="rotate(-90 9 9)"/>
        </svg>
      `;
      downloadBtn.innerHTML = progressHTML;

      const page = document.getElementById('markdown-page') as HTMLElement | null;
      if (!page) {
        throw new Error('Rendered page not found');
      }

      await exportEpubFlow({
        container: page,
        filename: getFilenameFromURL(),
        title: document.title || getFilenameFromURL(),
        platform: globalThis.platform,
        onProgress: (completed, total) => {
          const progressCircle = downloadBtn.querySelector('.download-progress-circle');
          if (progressCircle && total > 0) {
            const progress = completed / total;
            const circumference = 43.98;
            const offset = circumference * (1 - progress);
            (progressCircle as SVGCircleElement).style.strokeDashoffset = String(offset);
          }
        },
        onError: (error) => {
          exportError = error;
        },
      });

      if (exportError) {
        throw new Error(exportError);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(`Export EPUB failed: ${message}`);
    } finally {
      const fallbackIcon = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3v10m0 0l-3-3m3 3l3-3M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      downloadBtn.innerHTML = downloadBtn.getAttribute('data-original-content') || fallbackIcon;
      downloadBtn.disabled = false;
      downloadBtn.classList.remove('downloading');
      downloadBtn.removeAttribute('data-original-content');
    }
  }

  const exportMenu = createExportMenu({
    translate,
    onExportDocx: () => exportDocxFromToolbar(),
    onExportEpub: () => exportEpubFromToolbar(),
    onExportHtml: () => exportHtmlFromToolbar(),
    onSaveFile: () => triggerSaveFile(),
    onPrint: () => triggerPrint(),
    getPrintDisabledTitle: () => isPrintAvailable() ? null : translate('toolbar_print_disabled_title'),
  });

  function getScrollContainer(): HTMLElement | null {
    return document.getElementById('markdown-wrapper') as HTMLElement | null;
  }

  /**
   * Apply zoom level to content and update UI
   * @param newLevel - New zoom level percentage (e.g. 100, 150)
   * @param saveState - Whether to save state to storage
   */
  function applyZoom(newLevel: number, saveState = true): void {
    const oldLevel = currentZoomLevel;
    currentZoomLevel = Math.max(50, Math.min(400, newLevel));
    
    // Skip if no actual change
    if (oldLevel === currentZoomLevel) return;
    
    // Core rendering logic - use shared function
    // Note: onBeforeZoom locks scroll position, passed as scrollController.lock equivalent
    onBeforeZoom?.();
    applyZoomCore({ zoom: currentZoomLevel });
    
    // UI updates (Chrome-specific)
    const zoomLevelSpan = document.getElementById('zoom-level');
    if (zoomLevelSpan) {
      zoomLevelSpan.textContent = currentZoomLevel + '%';
    }
    
    // Update scroll-margin-top for all headings to account for zoom
    const contentDiv = document.getElementById('markdown-content');
    if (contentDiv) {
      const scrollMargin = 12 / (currentZoomLevel / 100);
      const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
      headings.forEach(heading => {
        (heading as HTMLElement).style.scrollMarginTop = scrollMargin + 'px';
      });
    }
    
    // Save zoom level
    if (saveState) {
      saveFileState({ zoom: currentZoomLevel });
    }
    
    // Update TOC active state since zoom affects scroll positions
    updateActiveTocItem();
  }

  /**
   * Get current zoom level
   * @returns Current zoom level
   */
  function getZoomLevel(): number {
    return currentZoomLevel;
  }

  /**
   * Set initial zoom level without saving
   * @param level - Zoom level to set
   */
  function setInitialZoom(level: number): void {
    currentZoomLevel = level;
  }

  /**
   * Initialize toolbar with file name
   */
  function initializeToolbar(): void {
    // Set file name from URL
    const fileNameSpan = document.getElementById('file-name');
    if (fileNameSpan) {
      const fileName = getFilenameFromURL();
      fileNameSpan.textContent = fileName;
      
      // Click file name to scroll to top
      fileNameSpan.addEventListener('click', () => {
        cancelScrollRestore();
        const scrollContainer = getScrollContainer();
        if (scrollContainer) {
          scrollContainer.scrollTo({ top: 0, behavior: 'auto' });
        }
      });
    }

    // Setup toolbar button handlers
    setupToolbarButtons();
  }

  /**
   * Toggle TOC visibility (shared by the toolbar button and the Ctrl/Cmd+B
   * keyboard shortcut). Delegates to the host callback when provided, else
   * toggles the DOM state directly.
   */
  function setTocVisibility(visible: boolean): void {
    if (onSetTocVisibility) {
      onSetTocVisibility(visible);
      return;
    }

    const tocDiv = document.getElementById('table-of-contents');
    const overlayDiv = document.getElementById('toc-overlay');
    if (!tocDiv || !overlayDiv) {
      return;
    }

    tocDiv.classList.toggle('hidden', !visible);
    document.body.classList.toggle('toc-hidden', !visible);
    if (isMobile && visible) {
      overlayDiv.classList.remove('hidden');
    } else {
      overlayDiv.classList.add('hidden');
    }

    saveFileState({
      tocVisible: visible,
    });
  }

  /**
   * Setup toolbar button event handlers
   */
  async function setupToolbarButtons(): Promise<void> {
    // Get saved state first
    const savedState = await getFileState();
    
    // Toggle TOC button
    const toggleTocBtn = document.getElementById('toggle-toc-btn');
    const tocDiv = document.getElementById('table-of-contents');
    const overlayDiv = document.getElementById('toc-overlay');

    if (toggleTocBtn && tocDiv && overlayDiv) {
      toggleTocBtn.addEventListener('click', () => {
        // If TOC has no content (no headings), do nothing
        if (tocDiv.style.display === 'none') {
          return;
        }

        const nextVisible = tocDiv.classList.contains('hidden');
        setTocVisibility(nextVisible);
      });
    }

    // Zoom controls
    const zoomLevelSpan = document.getElementById('zoom-level');
    
    // Initialize zoom display
    if (zoomLevelSpan) {
      zoomLevelSpan.textContent = currentZoomLevel + '%';
    }

    // Click zoom level to reset to 100%
    if (zoomLevelSpan) {
      zoomLevelSpan.style.cursor = 'pointer';
      zoomLevelSpan.addEventListener('click', () => {
        applyZoom(100);
      });
    }

    const zoomInBtn = document.getElementById('zoom-in-btn');
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        applyZoom(currentZoomLevel + 10);
      });
    }

    const zoomOutBtn = document.getElementById('zoom-out-btn');
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        applyZoom(currentZoomLevel - 10);
      });
    }

    // Layout toggle button
    const layoutBtn = document.getElementById('layout-toggle-btn');
    const pageDiv = document.getElementById('markdown-page');
    const layoutSequence = ['normal', 'fullscreen', 'narrow'];

    if (layoutBtn && pageDiv) {
      const applyLayout = (layout: string, saveState = true): void => {
        const config = layoutConfigs[layout];
        if (!config) {
          return;
        }
        currentLayout = layout;
        pageDiv.style.maxWidth = config.maxWidth;
        layoutBtn.innerHTML = config.icon;
        layoutBtn.title = config.title;
        
        // Save layout mode
        if (saveState) {
          saveFileState({ layoutMode: layout });
        }
      };

      applyLayout('normal', false);

      layoutBtn.addEventListener('click', () => {
        if (!layoutSequence.includes(currentLayout)) {
          applyLayout(layoutSequence[0]);
          return;
        }

        const currentIndex = layoutSequence.indexOf(currentLayout);
        const nextLayout = layoutSequence[(currentIndex + 1) % layoutSequence.length];
        applyLayout(nextLayout);
      });
      
      // Restore layout and zoom state after toolbar setup
      (async () => {
        // Restore layout mode
        if (savedState.layoutMode && layoutConfigs[savedState.layoutMode]) {
          applyLayout(savedState.layoutMode, false);
        }
        
        // Restore zoom level
        if (savedState.zoom && typeof savedState.zoom === 'number') {
          applyZoom(savedState.zoom, false);
        }
      })();
    }

    // Source/preview toggle button (.md only)
    const sourceToggleBtn = document.getElementById('toggle-source-view-btn');
    if (sourceToggleBtn && enableSourceToggle && onToggleSourceMode && getSourceMode) {
      const sourceIcon = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="M7 6 3 10l4 4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m13 6 4 4-4 4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      const previewIcon = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" stroke-width="2"/><circle cx="10" cy="10" r="2" stroke-width="2"/></svg>`;

      const updateSourceToggleUI = (): void => {
        const sourceMode = getSourceMode();
        sourceToggleBtn.innerHTML = sourceMode ? previewIcon : sourceIcon;
        sourceToggleBtn.title = sourceMode ? 'Preview Mode' : 'Source Mode';
        sourceToggleBtn.setAttribute('aria-label', sourceToggleBtn.title);
      };

      updateSourceToggleUI();
      sourceToggleBtn.addEventListener('click', () => {
        onToggleSourceMode();
        updateSourceToggleUI();
        // Exit remark mode when entering source mode
        if (getSourceMode() && remarkController?.isActive()) {
          remarkController.exit();
          updateRemarkToggleUI();
        }
      });
    }

    // Remark Mode toggle button
    const remarkToggleBtn = document.getElementById('toggle-remark-btn');
    function updateRemarkToggleUI(): void {
      if (!remarkToggleBtn) return;
      const isActive = remarkController?.isActive() ?? false;
      remarkToggleBtn.classList.toggle('remark-active', isActive);
      remarkToggleBtn.title = isActive
        ? translate('remark_exit_mode')
        : translate('remark_mode');
      remarkToggleBtn.setAttribute('aria-label', remarkToggleBtn.title);
      remarkToggleBtn.setAttribute('aria-pressed', String(isActive));
    }

    if (remarkToggleBtn && remarkController) {
      // Load persisted annotations on init
      void remarkController.loadAnnotations();
      updateRemarkToggleUI();
      remarkToggleBtn.addEventListener('click', () => {
        if (remarkController!.isActive()) {
          remarkController!.exit();
        } else {
          // Don't enter remark mode while in source mode
          if (getSourceMode?.()) return;
          remarkController!.enter();
        }
        updateRemarkToggleUI();
      });
    }

    const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement | null;
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        exportMenu.showAtAnchor(downloadBtn);
      });

      downloadBtn.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          exportMenu.showAtAnchor(downloadBtn);
        } else if (event.key === 'Escape') {
          exportMenu.hide();
        }
      });
    }

    setupBookExportButton();

    setupPrintButton();
  }

  /**
   * Setup print button handler
   */
  function setupPrintButton(): void {
    // Print availability is handled by the shared export menu.
  }

  // ========================================================================
  // Whole-book export (GitBook SUMMARY panel)
  // ========================================================================

  function setBookExportProgressRatio(btn: HTMLElement, ratio: number): void {
    const circle = btn.querySelector('.download-progress-circle');
    if (!circle) {
      return;
    }

    const clamped = Math.max(0, Math.min(1, ratio));
    const circumference = 43.98;
    (circle as SVGCircleElement).style.strokeDashoffset = String(circumference * (1 - clamped));
  }

  /**
   * Run a whole-book export (DOCX, EPUB or PDF) with the button progress ring.
   */
  async function runBookExport(kind: 'docx' | 'epub' | 'pdf'): Promise<void> {
    const btn = document.getElementById('book-export-btn') as HTMLButtonElement | null;
    if (!btn || btn.disabled) {
      return;
    }
    if (kind === 'docx' && !onExportBookDocx) {
      return;
    }
    if (kind === 'epub' && !onExportBookEpub) {
      return;
    }
    if (kind === 'pdf' && !onExportBookPdf) {
      return;
    }

    // Request downloads permission only for remote files (local files use <a download> fallback)
    if (kind !== 'pdf' && !window.location.protocol.startsWith('file')) {
      try {
        await chrome.runtime.sendMessage({ type: 'REQUEST_DOWNLOADS_PERMISSION' });
      } catch {
        // Ignore - background will fall back if permission denied
      }
    }

    const originalContent = btn.innerHTML;
    const progressHTML = `
      <svg class="progress-circle" width="18" height="18" viewBox="0 0 18 18">
        <circle class="progress-circle-bg" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none" opacity="0.3"/>
        <circle class="download-progress-circle" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none"
                stroke-dasharray="43.98" stroke-dashoffset="43.98" transform="rotate(-90 9 9)"/>
      </svg>
    `;
    let timerId: number | null = null;

    try {
      btn.disabled = true;
      btn.classList.add('downloading');
      btn.innerHTML = progressHTML;
      const progressModel = new BookExportProgressModel(kind);
      timerId = window.setInterval(() => {
        setBookExportProgressRatio(btn, progressModel.tick(performance.now()));
      }, 100);

      const onProgress = (phase: BookExportPhase, done: number, total: number): void => {
        setBookExportProgressRatio(btn, progressModel.onPhaseProgress(phase, done, total, performance.now()));
      };

      if (kind === 'docx') {
        const result = await onExportBookDocx!({ onProgress });
        setBookExportProgressRatio(btn, progressModel.complete());
        if (!result.success) {
          const detail = result.error ? `: ${result.error}` : '';
          alert(translate('book_export_failed', [detail]));
          return;
        }
        if (result.skippedCount && result.skippedCount > 0) {
          alert(translate('book_export_skipped_pages', [String(result.skippedCount)]));
        }
      } else if (kind === 'epub') {
        const result = await onExportBookEpub!({ onProgress });
        setBookExportProgressRatio(btn, progressModel.complete());
        if (!result.success) {
          const detail = result.error ? `: ${result.error}` : '';
          alert(translate('book_export_failed', [detail]));
          return;
        }
        if (result.skippedCount && result.skippedCount > 0) {
          alert(translate('book_export_skipped_pages', [String(result.skippedCount)]));
        }
      } else {
        const result = await onExportBookPdf!({ onProgress });
        setBookExportProgressRatio(btn, progressModel.complete());
        if (!result.success) {
          const detail = result.error ? `: ${result.error}` : '';
          alert(translate('book_export_failed', [detail]));
        }
      }
    } catch (error) {
      console.error('Book export error:', error);
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg === PRINT_BLOCKED_BY_SANDBOX) {
        alert(translate('toolbar_print_disabled_title'));
      } else {
        alert(translate('book_export_failed', [`: ${errMsg}`]));
      }
    } finally {
      if (timerId !== null) {
        window.clearInterval(timerId);
      }
      btn.innerHTML = originalContent;
      btn.disabled = false;
      btn.classList.remove('downloading');
    }
  }

  /**
   * Wire the SUMMARY panel header export button (dropdown with DOCX/EPUB/PDF items).
   */
  function setupBookExportButton(): void {
    const btn = document.getElementById('book-export-btn') as HTMLButtonElement | null;
    if (!btn || (!onExportBookDocx && !onExportBookEpub && !onExportBookPdf)) {
      return;
    }

    const openMenu = (): void => {
      // Position like the main toolbar export menu (anchor branch): below the
      // button, right-aligned to its right edge. rightAligned here would pin
      // the menu to the top of the viewport instead.
      showActionMenu({
        anchor: btn,
        className: 'book-export-menu',
        items: [
          ...(onExportBookDocx ? [{
            label: translate('book_export_docx'),
            onSelect: () => runBookExport('docx'),
          }] : []),
          ...(onExportBookEpub ? [{
            label: translate('book_export_epub'),
            onSelect: () => runBookExport('epub'),
          }] : []),
          ...(onExportBookPdf ? [{
            label: translate('book_export_pdf'),
            onSelect: () => runBookExport('pdf'),
          }] : []),
        ],
      });
    };

    btn.addEventListener('click', openMenu);
    btn.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu();
      }
    });
  }

  function triggerSaveFile(): void {
    const filename = toMarkdownFilename(getFilenameFromURL());
    const fileContent = getRawContent ? getRawContent() : rawMarkdown;
    const blob = new Blob([fileContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function triggerPrint(): Promise<void> {
    const contentDiv = document.getElementById('markdown-page') as HTMLElement | null;
    if (!contentDiv) {
      return;
    }

    try {
      await printElement(contentDiv, document.title || getFilenameFromURL());
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg === PRINT_BLOCKED_BY_SANDBOX) {
        alert(translate('toolbar_print_disabled_title'));
      } else {
        console.error('Print request failed:', error);
        alert(`Failed to open print preview: ${errMsg}`);
      }
    }
  }

  /**
   * Setup global keyboard shortcuts
   */
  function setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Ctrl/Cmd + B: Toggle TOC
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        const tocDiv = document.getElementById('table-of-contents');
        if (tocDiv) {
          const nextVisible = tocDiv.classList.contains('hidden');
          setTocVisibility(nextVisible);
        }
        return;
      }

      // Ctrl/Cmd + S: Download as DOCX
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const shouldSaveRawFile = isSourceModeActive ? isSourceModeActive() : Boolean(getSourceMode?.());
        if (shouldSaveRawFile) {
          triggerSaveFile();
        } else {
          void exportDocxFromToolbar();
        }
        return;
      }

      // Ctrl/Cmd + P: Print (browser default, but we ensure it's enabled)
      // No need to prevent default for print, browser handles it well
    });
  }

  /**
   * Re-apply translated tooltips/aria-labels after the UI locale changed.
   * Toolbar text is baked into the DOM at init time, so without this the
   * tooltips would stay in the old language until the page reloads.
   */
  function applyLocale(): void {
    // Rebuild translated layout titles (button tooltip follows current mode).
    layoutConfigs.normal.title = translate('toolbar_layout_title_normal');
    layoutConfigs.fullscreen.title = translate('toolbar_layout_title_fullscreen');
    layoutConfigs.narrow.title = translate('toolbar_layout_title_narrow');

    const setTitle = (id: string, title: string): void => {
      const el = document.getElementById(id);
      if (!el) return;
      el.setAttribute('title', title);
      el.setAttribute('aria-label', title);
    };

    setTitle('toggle-toc-btn', translate('toolbar_toggle_toc_title'));
    setTitle('zoom-out-btn', translate('toolbar_zoom_out_title'));
    setTitle('zoom-in-btn', translate('toolbar_zoom_in_title'));
    setTitle('download-btn', translate('toolbar_download_title'));
    setTitle('book-export-btn', translate('book_export_title'));

    const layoutBtnEl = document.getElementById('layout-toggle-btn');
    if (layoutBtnEl) {
      const config = layoutConfigs[currentLayout] || layoutConfigs.normal;
      layoutBtnEl.setAttribute('title', config.title);
      layoutBtnEl.setAttribute('aria-label', config.title);
    }

    // Remark toggle tooltip depends on its active state.
    const remarkBtn = document.getElementById('toggle-remark-btn');
    if (remarkBtn) {
      const isActive = remarkBtn.getAttribute('aria-pressed') === 'true';
      const title = translate(isActive ? 'remark_exit_mode' : 'remark_mode');
      remarkBtn.setAttribute('title', title);
      remarkBtn.setAttribute('aria-label', title);
    }

    // Refresh an open remark sidebar (header/tooltips/placeholders) in place.
    remarkController?.applyLocale();
  }

  return {
    layoutIcons,
    layoutConfigs,
    applyZoom,
    getZoomLevel,
    setInitialZoom,
    initializeToolbar,
    setupToolbarButtons,
    setupKeyboardShortcuts,
    applyLocale
  };
}

/**
 * Generate toolbar HTML
 * @param options - Options for toolbar generation
 * @returns Toolbar HTML
 */
export function generateToolbarHTML(options: GenerateToolbarHTMLOptions): string {
  const {
    translate,
    escapeHtml,
    initialTocClass,
    initialMaxWidth,
    initialZoom,
    enableSourceToggle,
    enableRemarkMode,
  } = options;

  const toolbarLayoutTitleNormal = translate('toolbar_layout_title_normal');
  const toolbarToggleTocTitle = translate('toolbar_toggle_toc_title');
  const toolbarZoomOutTitle = translate('toolbar_zoom_out_title');
  const toolbarZoomInTitle = translate('toolbar_zoom_in_title');
  const toolbarDownloadTitle = translate('toolbar_download_title');
  const toolbarPrintTitle = translate('toolbar_print_title');
  const remarkModeTitle = translate('remark_mode');
  const toolbarToggleGitbookTitle = 'Toggle GitBook Panel';

  const layoutTitleAttr = escapeHtml(toolbarLayoutTitleNormal);
  const toggleTocTitleAttr = escapeHtml(toolbarToggleTocTitle);
  const zoomOutTitleAttr = escapeHtml(toolbarZoomOutTitle);
  const zoomInTitleAttr = escapeHtml(toolbarZoomInTitle);
  const downloadTitleAttr = escapeHtml(toolbarDownloadTitle);
  const printTitleAttr = escapeHtml(toolbarPrintTitle);
  const remarkModeTitleAttr = escapeHtml(remarkModeTitle);
  const toggleGitbookTitleAttr = escapeHtml(toolbarToggleGitbookTitle);
  const bookExportTitleAttr = escapeHtml(translate('book_export_title'));

  return `
  <div id="page-shell">
    <div id="page-header">
      <div id="toolbar">
        <div class="toolbar-left">
          <button id="toggle-toc-btn" class="toolbar-btn" title="${toggleTocTitleAttr}">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <span id="file-name" class="file-name"></span>
          <div id="processing-indicator" class="processing-indicator hidden">
            <svg class="progress-circle" width="18" height="18" viewBox="0 0 18 18">
              <circle class="progress-circle-bg" cx="9" cy="9" r="7" stroke="#666" stroke-width="2" fill="none"/>
              <circle class="progress-circle-progress" cx="9" cy="9" r="7" stroke="#00d4aa" stroke-width="2" fill="none"
                      stroke-dasharray="43.98" stroke-dashoffset="43.98" transform="rotate(-90 9 9)"/>
            </svg>
          </div>
        </div>
        <div class="toolbar-center">
          <button id="zoom-out-btn" class="toolbar-btn" title="${zoomOutTitleAttr}">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M5 10h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <span id="zoom-level" class="zoom-level">100%</span>
          <button id="zoom-in-btn" class="toolbar-btn" title="${zoomInTitleAttr}">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 5v10M5 10h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
          <button id="layout-toggle-btn" class="toolbar-btn" title="${layoutTitleAttr}">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
              <rect x="3" y="4" width="14" height="12" stroke-width="2" rx="1"/>
              <line x1="3" y1="7" x2="17" y2="7" stroke-width="2"/>
            </svg>
          </button>
          ${enableSourceToggle ? `
          <button id="toggle-source-view-btn" class="toolbar-btn" title="Source Mode" aria-label="Source Mode">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
              <path d="M7 6 3 10l4 4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="m13 6 4 4-4 4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>` : ''}
        </div>
        <div class="toolbar-right">
          ${enableRemarkMode ? `
          <div style="position:relative;display:inline-flex;">
          <button id="toggle-remark-btn" class="toolbar-btn" title="${remarkModeTitleAttr}" aria-label="${remarkModeTitleAttr}" aria-pressed="false">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
              <path d="M13.5 3.5l3 3L7 16H4v-3L13.5 3.5Z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <span id="remark-count-badge" class="remark-count-badge" style="display:none;position:absolute;top:2px;right:2px;background:#6b7280;color:#fff;font-size:9px;font-weight:700;min-width:14px;height:14px;border-radius:7px;align-items:center;justify-content:center;padding:0 3px;line-height:1;pointer-events:none;"></span>
          </div>` : ''}
          <button id="download-btn" class="toolbar-btn toolbar-menu-trigger" title="${downloadTitleAttr}" aria-haspopup="menu" aria-expanded="false">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 3v10m0 0l-3-3m3 3l3-3M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <svg class="toolbar-menu-caret" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div id="gitbook-sidebar-header" class="hidden">
        <span class="gitbook-sidebar-title">SUMMARY.md</span>
        <div class="gitbook-sidebar-actions">
          <button id="book-export-btn" class="toolbar-btn toolbar-menu-trigger" title="${bookExportTitleAttr}" aria-label="${bookExportTitleAttr}" aria-haspopup="menu" aria-expanded="false">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 13V7"/>
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>
              <path d="m9 10 3 3 3-3"/>
            </svg>
            <svg class="toolbar-menu-caret" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div id="page-content">
      <div id="viewer-main-column">
        <div id="markdown-wrapper">
          <div id="markdown-page" style="max-width: ${initialMaxWidth};">
            <div id="markdown-content" style="zoom: ${initialZoom / 100};"></div>
          </div>
        </div>
      </div>
      <div id="gitbook-resize-handle" class="hidden" aria-hidden="true"></div>
      <aside id="gitbook-sidebar-body" class="hidden">
        <div id="gitbook-panel"></div>
      </aside>
    </div>
  </div>
  <div id="table-of-contents" class="${initialTocClass}"></div>
  <div id="toc-overlay" class="hidden"></div>
  <div id="remark-sidebar" class="remark-sidebar remark-sidebar-closed"></div>
`;
}
