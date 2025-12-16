// Toolbar Manager
// Handles toolbar initialization and button event handlers

import { getFilenameFromURL, getDocumentFilename } from '../file-state.js';

// SVG icons for different layouts
export const layoutIcons = {
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
 * @param {Object} options - Configuration options
 * @returns {Object} Toolbar manager instance
 */
export function createToolbarManager(options) {
  const {
    translate,
    escapeHtml,
    saveFileState,
    getFileState,
    rawMarkdown,
    docxExporter,
    cancelScrollRestore,
    updateActiveTocItem,
    toolbarPrintDisabledTitle
  } = options;

  // Layout configurations
  const layoutTitles = {
    normal: translate('toolbar_layout_title_normal'),
    fullscreen: translate('toolbar_layout_title_fullscreen'),
    narrow: translate('toolbar_layout_title_narrow')
  };

  const layoutConfigs = {
    normal: { maxWidth: '1360px', icon: layoutIcons.normal, title: layoutTitles.normal },
    fullscreen: { maxWidth: '100%', icon: layoutIcons.fullscreen, title: layoutTitles.fullscreen },
    narrow: { maxWidth: '680px', icon: layoutIcons.narrow, title: layoutTitles.narrow }
  };

  // Global zoom state
  let currentZoomLevel = 100;

  /**
   * Apply zoom level to content and update UI
   * @param {number} newLevel - New zoom level percentage (e.g. 100, 150)
   * @param {boolean} saveState - Whether to save state to storage
   */
  function applyZoom(newLevel, saveState = true) {
    currentZoomLevel = Math.max(50, Math.min(400, newLevel));
    
    const zoomLevelSpan = document.getElementById('zoom-level');
    const contentDiv = document.getElementById('markdown-content');
    
    if (zoomLevelSpan) {
      zoomLevelSpan.textContent = currentZoomLevel + '%';
    }
    
    if (contentDiv) {
      // Apply zoom using CSS zoom property (like browser zoom)
      contentDiv.style.zoom = (currentZoomLevel / 100);
      
      // Update scroll-margin-top for all headings to account for zoom
      // Formula: 50px (toolbar height) / zoom ratio
      const scrollMargin = 50 / (currentZoomLevel / 100);
      const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
      headings.forEach(heading => {
        heading.style.scrollMarginTop = scrollMargin + 'px';
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
   * @returns {number} Current zoom level
   */
  function getZoomLevel() {
    return currentZoomLevel;
  }

  /**
   * Set initial zoom level without saving
   * @param {number} level - Zoom level to set
   */
  function setInitialZoom(level) {
    currentZoomLevel = level;
  }

  /**
   * Initialize toolbar with file name
   */
  function initializeToolbar() {
    // Set file name from URL
    const fileNameSpan = document.getElementById('file-name');
    if (fileNameSpan) {
      const fileName = getFilenameFromURL();
      fileNameSpan.textContent = fileName;
      
      // Click file name to scroll to top
      fileNameSpan.addEventListener('click', () => {
        cancelScrollRestore();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    // Setup toolbar button handlers
    setupToolbarButtons();
  }

  /**
   * Setup toolbar button event handlers
   */
  async function setupToolbarButtons() {
    // Get saved state first
    const savedState = await getFileState();
    
    // Toggle TOC button
    const toggleTocBtn = document.getElementById('toggle-toc-btn');
    const tocDiv = document.getElementById('table-of-contents');
    const overlayDiv = document.getElementById('toc-overlay');

    if (toggleTocBtn && tocDiv && overlayDiv) {
      toggleTocBtn.addEventListener('click', () => {
        const willBeHidden = !tocDiv.classList.contains('hidden');
        tocDiv.classList.toggle('hidden');
        document.body.classList.toggle('toc-hidden');
        overlayDiv.classList.toggle('hidden');
        
        // Save TOC visibility state
        saveFileState({
          tocVisible: !willBeHidden
        });
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
    let currentLayout = 'normal'; // normal, fullscreen, narrow
    const layoutSequence = ['normal', 'fullscreen', 'narrow'];

    if (layoutBtn && pageDiv) {
      const applyLayout = (layout, saveState = true) => {
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

    // Download button (DOCX export)
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', async () => {
        // Prevent multiple clicks
        if (downloadBtn.disabled) {
          return;
        }

        try {
          // Disable button and show progress indicator
          downloadBtn.disabled = true;
          downloadBtn.classList.add('downloading');

          // Add progress indicator to button
          const originalContent = downloadBtn.innerHTML;
          const progressHTML = `
          <svg class="progress-circle" width="18" height="18" viewBox="0 0 18 18">
            <circle class="progress-circle-bg" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none" opacity="0.3"/>
            <circle class="download-progress-circle" cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" fill="none"
                    stroke-dasharray="43.98" stroke-dashoffset="43.98" transform="rotate(-90 9 9)"/>
          </svg>
        `;
          downloadBtn.innerHTML = progressHTML;

          // Get the original markdown content
          const markdown = rawMarkdown;

          // Generate filename from document title or URL
          const filename = getDocumentFilename();

          // Export to DOCX with progress callback
          const exportErrorFallback = translate('docx_export_failed_default');
          const result = await docxExporter.exportToDocx(markdown, filename, (completed, total) => {
            // Update progress circle
            const progressCircle = downloadBtn.querySelector('.download-progress-circle');
            if (progressCircle && total > 0) {
              const progress = completed / total;
              const circumference = 43.98; // 2 * PI * 7
              const offset = circumference * (1 - progress);
              progressCircle.style.strokeDashoffset = offset;
            }
          });

          if (!result.success) {
            throw new Error(result.error || exportErrorFallback);
          }

          // Restore button after successful download
          downloadBtn.innerHTML = originalContent;
          downloadBtn.disabled = false;
          downloadBtn.classList.remove('downloading');
        } catch (error) {
          console.error('Export error:', error);
          const alertDetail = error?.message ? `: ${error.message}` : '';
          const alertMessage = translate('docx_export_failed_alert', [alertDetail])
            || `Export failed${alertDetail}`;
          alert(alertMessage);

          // Restore button on error
          const originalContent = `
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 3v10m0 0l-3-3m3 3l3-3M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        `;
          downloadBtn.innerHTML = originalContent;
          downloadBtn.disabled = false;
          downloadBtn.classList.remove('downloading');
        }
      });
    }

    // Print button
    const printBtn = document.getElementById('print-btn');
    if (printBtn) {
      // Check if this is a remote file - disable print for remote files
      const isLocalFile = document.location.protocol === 'file:';
      
      if (!isLocalFile) {
        printBtn.disabled = true;
        printBtn.title = toolbarPrintDisabledTitle;
        printBtn.style.opacity = '0.5';
        printBtn.style.cursor = 'not-allowed';
      } else {
        printBtn.addEventListener('click', async () => {
          const contentDiv = document.getElementById('markdown-content');
          if (!contentDiv) {
            return;
          }

          try {
            if (printBtn.disabled) {
              return;
            }
            printBtn.disabled = true;

            // For local files, use simple browser print
            window.print();
          } catch (error) {
            console.error('Print request failed:', error);
            alert(`Failed to open print preview: ${error.message}`);
          } finally {
            printBtn.disabled = false;
          }
        });
      }
    }
  }

  /**
   * Setup global keyboard shortcuts
   */
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + B: Toggle TOC
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        const tocDiv = document.getElementById('table-of-contents');
        const overlayDiv = document.getElementById('toc-overlay');
        if (tocDiv && overlayDiv) {
          const willBeHidden = !tocDiv.classList.contains('hidden');
          tocDiv.classList.toggle('hidden');
          document.body.classList.toggle('toc-hidden');
          overlayDiv.classList.toggle('hidden');
          
          // Save TOC visibility state
          saveFileState({
            tocVisible: !willBeHidden
          });
        }
        return;
      }

      // Ctrl/Cmd + S: Download as DOCX
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const downloadBtn = document.getElementById('download-btn');
        if (downloadBtn && !downloadBtn.disabled) {
          downloadBtn.click();
        }
        return;
      }

      // Ctrl/Cmd + P: Print (browser default, but we ensure it's enabled)
      // No need to prevent default for print, browser handles it well
    });
  }

  return {
    layoutIcons,
    layoutConfigs,
    applyZoom,
    getZoomLevel,
    setInitialZoom,
    initializeToolbar,
    setupToolbarButtons,
    setupKeyboardShortcuts
  };
}

/**
 * Generate toolbar HTML
 * @param {Object} options - Options for toolbar generation
 * @returns {string} Toolbar HTML
 */
export function generateToolbarHTML(options) {
  const {
    translate,
    escapeHtml,
    initialTocClass,
    initialMaxWidth,
    initialZoom
  } = options;

  const toolbarLayoutTitleNormal = translate('toolbar_layout_title_normal');
  const toolbarToggleTocTitle = translate('toolbar_toggle_toc_title');
  const toolbarZoomOutTitle = translate('toolbar_zoom_out_title');
  const toolbarZoomInTitle = translate('toolbar_zoom_in_title');
  const toolbarDownloadTitle = translate('toolbar_download_title');
  const toolbarPrintTitle = translate('toolbar_print_title');

  const layoutTitleAttr = escapeHtml(toolbarLayoutTitleNormal);
  const toggleTocTitleAttr = escapeHtml(toolbarToggleTocTitle);
  const zoomOutTitleAttr = escapeHtml(toolbarZoomOutTitle);
  const zoomInTitleAttr = escapeHtml(toolbarZoomInTitle);
  const downloadTitleAttr = escapeHtml(toolbarDownloadTitle);
  const printTitleAttr = escapeHtml(toolbarPrintTitle);

  return `
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
    </div>
    <div class="toolbar-right">
      <button id="download-btn" class="toolbar-btn" title="${downloadTitleAttr}">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3v10m0 0l-3-3m3 3l3-3M3 16h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button id="print-btn" class="toolbar-btn" title="${printTitleAttr}">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path d="M5 7V3h10v4M5 14H3V9h14v5h-2M5 14v3h10v-3M5 14h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </div>
  <div id="table-of-contents" class="${initialTocClass}"></div>
  <div id="toc-overlay" class="hidden"></div>
  <div id="markdown-wrapper">
    <div id="markdown-page" style="max-width: ${initialMaxWidth};">
      <div id="markdown-content" style="zoom: ${initialZoom / 100};"></div>
    </div>
  </div>
`;
}
