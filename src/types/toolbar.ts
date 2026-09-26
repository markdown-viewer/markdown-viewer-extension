/**
 * Toolbar Type Definitions
 * Types for UI toolbar
 */

import type { TranslateFunction, EscapeHtmlFunction, FileState } from './core';
import type { DocxExporter } from './docx';
import type { BookExportDocxResult, BookExportEpubResult, BookExportPdfResult, BookExportProgressHandler } from './book-export';

// =============================================================================
// Layout Types
// =============================================================================

/**
 * Layout configuration
 */
export interface LayoutConfig {
  maxWidth: string;
  icon: string;
  title: string;
}

// =============================================================================
// Toolbar Types
// =============================================================================

/**
 * Toolbar manager options
 */
export interface ToolbarManagerOptions {
  translate: TranslateFunction;
  escapeHtml: EscapeHtmlFunction;
  saveFileState: (state: FileState) => void;
  getFileState: () => Promise<FileState>;
  isMobile: boolean;
  rawMarkdown: string;
  /** Get latest original/raw file content for save-file action */
  getRawContent?: () => string;
  docxExporter: DocxExporter;
  cancelScrollRestore: () => void;
  updateActiveTocItem: () => void;
  /** Called before zoom changes to lock scroll position */
  onBeforeZoom?: () => void;
  /** Set TOC visibility from the host/session state owner */
  onSetTocVisibility?: (visible: boolean) => void;
  /** Whether to show source/preview toggle button */
  enableSourceToggle?: boolean;
  /** Toggle between markdown preview and source mode */
  onToggleSourceMode?: () => void;
  /** Get current source mode state */
  getSourceMode?: () => boolean;
  /** Whether current view should save raw file on Ctrl/Cmd+S */
  isSourceModeActive?: () => boolean;
  /** Whether to show remark mode toggle button */
  enableRemarkMode?: boolean;
  /** Get the container for remark annotations (rendered markdown div) */
  getRemarkContainer?: () => HTMLElement | null;
  /** Get raw markdown for remark export */
  getRemarkRawMarkdown?: () => string;
  /** Export the whole GitBook book to a single DOCX (provided when a book is present) */
  onExportBookDocx?: (context: { onProgress: BookExportProgressHandler }) => Promise<BookExportDocxResult> | BookExportDocxResult;
  /** Export the whole GitBook book to a single EPUB (provided when a book is present) */
  onExportBookEpub?: (context: { onProgress: BookExportProgressHandler }) => Promise<BookExportEpubResult> | BookExportEpubResult;
  /** Export the whole GitBook book to PDF via browser print (provided when a book is present) */
  onExportBookPdf?: (context: { onProgress: BookExportProgressHandler }) => Promise<BookExportPdfResult> | BookExportPdfResult;
}

/**
 * Generate toolbar HTML options
 */
export interface GenerateToolbarHTMLOptions {
  translate: TranslateFunction;
  escapeHtml: EscapeHtmlFunction;
  initialTocClass: string;
  initialMaxWidth: string;
  initialZoom: number;
  enableSourceToggle?: boolean;
  enableRemarkMode?: boolean;
}

/**
 * Toolbar manager instance interface
 */
export interface ToolbarManagerInstance {
  layoutIcons: Record<string, string>;
  layoutConfigs: Record<string, LayoutConfig>;
  applyZoom: (newLevel: number, saveState?: boolean) => void;
  getZoomLevel: () => number;
  setInitialZoom: (level: number) => void;
  initializeToolbar: () => void;
  setupToolbarButtons: () => Promise<void>;
  setupKeyboardShortcuts: () => void;
  /** Re-apply translated tooltips/aria-labels after the UI locale changed. */
  applyLocale: () => void;
  /**
   * Per-document state of the source/preview toggle: `supported` follows the
   * current file (markdown only), `sourceMode` follows the resolved view mode.
   */
  setSourceToggleState: (state: { supported: boolean; sourceMode: boolean }) => void;
  /** Show/hide the layout (width) control — hidden while code view is active. */
  setLayoutControlVisible: (visible: boolean) => void;
}
