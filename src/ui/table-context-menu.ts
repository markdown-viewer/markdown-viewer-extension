/**
 * Table Context Menu (Shared)
 *
 * Cross-platform right-click context menu for rendered tables, mirroring
 * the image context menu (`./image-context-menu`). Items:
 *
 *  - "Copy table"          — writes text/html (inline-styled, span-free
 *                            RECTANGULAR grid: merged display rows are
 *                            expanded with empty cells so every paste
 *                            target — Excel/WPS/Sheets/Numbers — keeps each
 *                            value in its own column) plus a text/plain TSV
 *                            fallback over the same grid.
 *  - "Save as Excel"       — real .xlsx (minimal OOXML writer in
 *                            `src/utils/table-xlsx.ts`), delivered through
 *                            the platform onDownload callback like images.
 *                            Merged cells are preserved HERE as real Excel
 *                            merge ranges.
 *
 * Right-clicks on an <img> inside a table are intentionally left to the
 * image context menu (register this module AFTER setupImageContextMenu so
 * that menu stays authoritative for images).
 */

import { showActionMenu } from './action-menu';
import {
  buildXlsxBytes,
  flattenTableCells,
  tableDataToHtml,
  tableDataToTsv,
  xlsxBytesToBase64,
  XLSX_MIME_TYPE,
  normalizeCellText,
  type TableSpanCell,
  type TableVisualStyle,
} from '../utils/table-xlsx';

// ============================================================================
// Types
// ============================================================================

export interface TableContextMenuOptions {
  /** Container element to listen for contextmenu events */
  container: HTMLElement;
  /** Download callback - platform-specific implementation */
  onDownload: (file: { filename: string; data: string; mimeType: string }) => void;
  /** Optional translation function */
  translate?: (key: string) => string;
}

// ============================================================================
// DOM extraction
// ============================================================================

/**
 * Collect one row's cells from a <tr>: text + rowspan/colspan + header flag.
 * table.rows / row.cells only ever see direct rows/cells, so tables nested
 * inside a cell never leak into the extraction.
 */
function collectRowCells(tr: HTMLTableRowElement): TableSpanCell[] {
  return Array.from(tr.cells).map((cell) => {
    const raw = cell.innerText || '';
    let text = raw.trim();
    if (!text) {
      // Replaced content (images) has no innerText — fall back to alt text.
      const img = cell.querySelector('img');
      text = img?.alt?.trim() ?? '';
    }
    const rowspan = parseInt(cell.getAttribute('rowspan') || '', 10);
    const colspan = parseInt(cell.getAttribute('colspan') || '', 10);
    const header = cell.tagName === 'TH' || Boolean(cell.closest('thead'));
    return {
      text: normalizeCellText(text),
      rowspan: Number.isInteger(rowspan) && rowspan > 1 ? rowspan : undefined,
      colspan: Number.isInteger(colspan) && colspan > 1 ? colspan : undefined,
      header,
    };
  });
}

/** Collect per-row span cells from the table (all sections: thead/tbody/tfoot). */
export function collectTableRows(table: HTMLTableElement): TableSpanCell[][] {
  return Array.from(table.rows).map((tr) => collectRowCells(tr));
}

/**
 * Sample the table's visual identity for the clipboard/Excel copies:
 *  - borderColor — first solid visible border found on any cell;
 *  - headerBg    — the header row's background (when it is not transparent).
 */
export function collectTableStyle(table: HTMLTableElement): TableVisualStyle {
  const style: TableVisualStyle = { borderColor: null, headerBg: null };

  const visibleBorderColor = (el: HTMLElement): string | null => {
    const cs = getComputedStyle(el);
    if (
      cs.borderTopStyle !== 'none'
      && cs.borderTopStyle !== 'hidden'
      && parseFloat(cs.borderTopWidth) > 0
    ) {
      const color = cs.borderTopColor;
      if (color && !/rgba\(\s*0,\s*0,\s*0,\s*0\)/.test(color)) return color;
    }
    return null;
  };

  const cells: HTMLElement[] = [];
  for (const tr of Array.from(table.rows)) {
    cells.push(...Array.from(tr.cells));
  }
  for (const cell of cells) {
    const color = visibleBorderColor(cell);
    if (color) {
      style.borderColor = color;
      break;
    }
  }

  const headerCell = table.querySelector('thead th, thead td, tr:first-child th');
  if (headerCell instanceof HTMLElement) {
    const bg = getComputedStyle(headerCell).backgroundColor;
    if (bg && !/rgba\(\s*0,\s*0,\s*0,\s*0\)/.test(bg)) {
      style.headerBg = bg;
    }
  }

  return style;
}

/**
 * Pick a filename base from the nearest heading that precedes the table
 * (fallback: "table"). Pure enough for unit tests.
 */
export function headingTextForTable(heading: Element | null | undefined): string {
  if (!heading) return '';
  return (heading.textContent || '').trim();
}

/** Sanitize a free-text heading into a filename-safe base. */
export function sanitizeFilenameBase(raw: string, fallback = 'table'): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

function findHeadingBeforeTable(
  table: HTMLTableElement,
  container: HTMLElement,
): string {
  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
  let current: Element | null = table;
  while (current && current !== container) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.matches?.(HEADING_SELECTOR)) return headingTextForTable(sibling);
      const heading = sibling.querySelector?.(HEADING_SELECTOR) || null;
      if (heading) return headingTextForTable(heading);
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }
  return '';
}

// ============================================================================
// Clipboard
// ============================================================================

function canWriteClipboardItem(): boolean {
  return typeof ClipboardItem !== 'undefined'
    && typeof navigator.clipboard?.write === 'function';
}

/** Text-only fallback (textarea + execCommand works where ClipboardItem is missing). */
async function writePlainTextFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    textarea.remove();
  }
}

/**
 * Write the table as text/html (rich, cell-preserving paste) with a
 * text/plain TSV fallback. Excel/WPS/Sheets pick the HTML variant; plain
 * editors get tab-separated values that still split into cells when pasted
 * into Excel later.
 */
async function writeTableClipboard(html: string, tsv: string): Promise<void> {
  if (canWriteClipboardItem()) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([tsv], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  await writePlainTextFallback(tsv);
}

// ============================================================================
// Setup
// ============================================================================

/**
 * Set up the table context menu on a container element.
 * Returns a cleanup function to remove event listeners.
 */
export function setupTableContextMenu(options: TableContextMenuOptions): () => void {
  const { container, onDownload, translate: translateFn } = options;

  let hideMenu: (() => void) | null = null;

  function translate(key: string): string {
    return translateFn?.(key) || fallbackTranslation(key);
  }

  function removeContextMenu(): void {
    hideMenu?.();
    hideMenu = null;
  }

  function onScroll(): void {
    removeContextMenu();
  }

  function onContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    // Images inside table cells keep the image context menu.
    if (target.closest('img')) return;
    const table = target.closest('table') as HTMLTableElement | null;
    if (!table) return;

    e.preventDefault();
    removeContextMenu();

    const rows = collectTableRows(table);
    const style = collectTableStyle(table);
    const data = flattenTableCells(rows);
    const html = tableDataToHtml(data, style);
    const tsv = tableDataToTsv(data);
    const baseName = sanitizeFilenameBase(
      findHeadingBeforeTable(table, container),
    );

    const items: Array<{ label: string; onSelect: () => void }> = [
      {
        label: translate('copy_table'),
        onSelect: () => {
          void writeTableClipboard(html, tsv).catch((err) => {
            console.error('[TableContextMenu] Failed to copy table:', err);
          });
        },
      },
      {
        label: translate('save_table_as_xlsx'),
        onSelect: () => {
          try {
            const bytes = buildXlsxBytes(data, style);
            onDownload({
              filename: `${baseName}.xlsx`,
              data: xlsxBytesToBase64(bytes),
              mimeType: XLSX_MIME_TYPE,
            });
          } catch (err) {
            console.error('[TableContextMenu] Failed to save table as Excel:', err);
          }
        },
      },
    ];

    const handle = showActionMenu({
      x: e.clientX,
      y: e.clientY,
      items,
    });
    hideMenu = handle.hide;
  }

  // Event listeners
  document.addEventListener('scroll', onScroll, true);
  container.addEventListener('contextmenu', onContextMenu);

  // Return cleanup function
  return () => {
    removeContextMenu();
    document.removeEventListener('scroll', onScroll, true);
    container.removeEventListener('contextmenu', onContextMenu);
  };
}

/**
 * Fallback translations (used when no translate() is provided or the key
 * is missing from the active locale).
 */
function fallbackTranslation(key: string): string {
  const map: Record<string, string> = {
    copy_table: 'Copy table',
    save_table_as_xlsx: 'Save as Excel (.xlsx)',
  };
  return map[key] || key;
}
