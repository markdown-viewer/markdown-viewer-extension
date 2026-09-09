/**
 * Table → spreadsheet / clipboard serializers (shared, pure)
 *
 * Everything in this module is DOM-free so the exact same code runs in unit
 * tests (fibjs), the CLI and every platform webview. The DOM side (reading
 * cells + computed styles out of a rendered <table>) lives in
 * `src/ui/table-context-menu.ts`.
 *
 * What each serializer is for:
 *
 * - `flattenTableCells` — expand a rowspan/colspan table into a dense grid
 *   plus merge ranges (the canonical logical grid: what a real .xlsx needs
 *   and what every other serializer must reproduce).
 * - `tableDataToHtml` — rebuild the grid as a clean inline-styled <table>
 *   fragment WITHOUT span attributes: every cell occupies exactly one slot,
 *   covered span positions become empty cells. Pasting text/html into
 *   Excel / WPS / Google Sheets / Numbers then lands every value in its own
 *   column on EVERY paste engine (several ignore rowspan/colspan in
 *   clipboard HTML and would otherwise shift the following rows — the
 *   "misaligned copy" bug for smart-merged tables). Merges stay available
 *   through "Save as Excel", which writes real merge ranges.
 * - `tableDataToTsv` — tab-separated fallback over the SAME dense grid.
 *   Excel splits tabs into columns on paste, so plain-text clipboard lands
 *   in cells too.
 * - `buildXlsxBytes` — minimal .xlsx package (STORE-only zip writer, no
 *   external dependencies; browsers, fibjs and node all have TextEncoder).
 *
 * Excel limits are enforced (1_048_576 rows × 16_384 columns); merged
 * ranges and numeric cells use the standard OOXML parts.
 */

// ============================================================================
// Types
// ============================================================================

/** A table cell exactly as it exists in the rendered DOM (spans included). */
export interface TableSpanCell {
  text: string;
  rowspan?: number;
  colspan?: number;
  header?: boolean;
}

/** A cell inside the dense (span-expanded) grid. */
export interface TableCell {
  text: string;
  isNumber: boolean;
  header: boolean;
}

/** 0-based, inclusive merge range. */
export interface MergeRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface TableData {
  rowCount: number;
  colCount: number;
  /** Dense grid: every row has exactly `colCount` cells. */
  rows: TableCell[][];
  merges: MergeRange[];
}

/** Optional visual hints collected from the rendered table. */
export interface TableVisualStyle {
  borderColor?: string | null;
  headerBg?: string | null;
}

export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLS = 16_384;

// ============================================================================
// Cell text helpers
// ============================================================================

/**
 * Normalize raw cell text: CRLF/CR → LF, tabs → spaces, trim the outer
 * whitespace. Internal line breaks are kept (serializers decide how to
 * represent them).
 */
export function normalizeCellText(raw: string): string {
  if (!raw) return '';
  return raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
}

/**
 * Decide whether a cell should become a numeric Excel cell. Conservative:
 * leading zeros ("007"), trailing junk and anything non-numeric stay text.
 */
export function isNumericCellText(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  // Bare integers: "0" is a number, "007" is a code — keep text.
  if (/^[+-]?\d+$/.test(s)) {
    if (s.length > 1 && /^[+-]?0\d/.test(s)) return false;
    return true;
  }
  // Decimals (optionally signed): 3.14 / .5 / -2.0 / 1e3 stays text on purpose
  // (codes like "1E3" are usually identifiers), so exponents are not treated
  // as numbers unless they round-trip cleanly.
  if (!/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(s)) return false;
  if (/^[+-]?0\d/.test(s)) return false; // "00.5" → text
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) < 1e15;
}

// ============================================================================
// Grid flattening
// ============================================================================

function spanValue(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function emptyCell(): TableCell {
  return { text: '', isNumber: false, header: false };
}

/**
 * Expand a per-row cell list (as it appears in the DOM: spans are NOT
 * repeated) into a dense grid plus merge ranges. Cells covered by a
 * rowspan/colspan become blank entries; the visible text stays only at the
 * span origin.
 */
export function flattenTableCells(rowCells: TableSpanCell[][]): TableData {
  const rows: TableCell[][] = [];
  const merges: MergeRange[] = [];
  const rowCount = rowCells.length;
  // How many more rows (including the current one) each column is still
  // covered by a span that started above.
  let remaining: number[] = [];
  let colCount = 0;

  for (let y = 0; y < rowCells.length; y++) {
    const denseRow: TableCell[] = [];
    const next: number[] = [];
    let col = 0;

    const consumeCovered = () => {
      while (col < remaining.length && remaining[col] > 0) {
        denseRow[col] = emptyCell();
        next[col] = remaining[col] - 1;
        col++;
      }
    };

    for (const cell of rowCells[y]) {
      consumeCovered();
      const rowspan = spanValue(cell.rowspan);
      const colspan = spanValue(cell.colspan);
      // Never span past the physical table.
      const rs = Math.min(rowspan, Math.max(rowCount - y, 1));
      const cs = colspan;

      const text = normalizeCellText(cell.text);
      denseRow[col] = text
        ? { text, isNumber: isNumericCellText(text), header: Boolean(cell.header) }
        : emptyCell();

      if (rs > 1 || cs > 1) {
        merges.push({ r1: y, c1: col, r2: y + rs - 1, c2: col + cs - 1 });
      }
      // Same-row coverage (colspan).
      for (let c = col + 1; c < col + cs; c++) {
        denseRow[c] = emptyCell();
      }
      // Vertical coverage for the following rows.
      for (let c = col; c < col + cs; c++) {
        next[c] = Math.max(next[c] ?? 0, rs - 1);
      }
      col += cs;
    }
    // Trailing columns covered by spans from above.
    consumeCovered();

    colCount = Math.max(colCount, denseRow.length);
    rows.push(denseRow);
    remaining = next;
  }

  // Pad ragged rows (a trailing span may start later than the widest row).
  for (const row of rows) {
    while (row.length < colCount) row.push(emptyCell());
  }

  return {
    rowCount: rows.length,
    colCount,
    rows,
    merges,
  };
}

// ============================================================================
// Plain-text serializers
// ============================================================================

/**
 * Tab-separated value table (Excel splits tabs into columns when pasted).
 * Covered span cells become empty fields; line breaks inside a cell are
 * flattened to spaces (TSV cannot carry them).
 */
export function tableDataToTsv(data: TableData): string {
  return data.rows
    .map((row) =>
      row
        .map((cell) => cell.text.replace(/\n/g, ' '))
        .join('\t'),
    )
    .join('\n');
}

// ============================================================================
// HTML clipboard fragment
// ============================================================================

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert an rgb()/rgba()/hex color string (as returned by
 * getComputedStyle) to a #rrggbb hex. Transparent / invalid values become
 * null so callers fall back to their defaults.
 */
export function normalizeCssColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const c = color.trim();
  if (!c || c === 'transparent') return null;
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  const rgb = c.match(
    /^rgba?\(\s*([\d.]+)\s*[,/]\s*([\d.]+)\s*[,/]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
  );
  if (rgb) {
    const alpha = rgb[4];
    if (alpha !== undefined) {
      const a = alpha.endsWith('%')
        ? parseFloat(alpha) / 100
        : parseFloat(alpha);
      if (a <= 0) return null;
    }
    const clamp = (v: string): number => {
      const n = Math.round(parseFloat(v));
      return Math.min(255, Math.max(0, n));
    };
    const toHex = (n: number): string => n.toString(16).padStart(2, '0');
    return `#${toHex(clamp(rgb[1]))}${toHex(clamp(rgb[2]))}${toHex(clamp(rgb[3]))}`;
  }
  return null;
}

/**
 * Rebuild the flattened grid as a clean inline-styled <table> fragment for
 * the clipboard. The grid is emitted RECTANGULAR with no rowspan/colspan:
 * cells covered by a span become empty cells in their exact column slot.
 *
 * Rationale: many paste targets (Excel/WPS/Sheets/Numbers variants) ignore
 * span attributes in clipboard HTML. A span-free fragment keeps every value
 * in its own column everywhere — a merged-looking row that relies on
 * `rowspan` would otherwise collapse and shift all following rows. Merged
 * cells are preserved by the .xlsx export (merge ranges), not by the copy.
 */
export function tableDataToHtml(data: TableData, style?: TableVisualStyle): string {
  const borderColor = normalizeCssColor(style?.borderColor) ?? '#c9c9c9';
  const headerBg = normalizeCssColor(style?.headerBg);
  const cellCss = `border:1px solid ${borderColor};padding:4px 8px;`;

  const rowsHtml = data.rows
    .map((cells) => {
      const cellsHtml = cells
        .map((cell) => {
          const tag = cell.header ? 'th' : 'td';
          const css = cell.header
            ? `${cellCss}font-weight:bold;${headerBg ? `background:${headerBg};` : ''}`
            : cellCss;
          const text = escapeHtmlText(cell.text).replace(/\n/g, '<br>');
          return `<${tag} style="${css}">${text}</${tag}>`;
        })
        .join('');
      return `<tr>${cellsHtml}</tr>`;
    })
    .join('');
  return `<table border="1" cellspacing="0" style="border-collapse:collapse">${rowsHtml}</table>`;
}

// ============================================================================
// Minimal .xlsx writer (STORE zip + OOXML parts)
// ============================================================================

function excelColumnName(col0: number): string {
  let n = col0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXmlText(text: string): string {
  // Strip control chars that would corrupt the XML part.
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  return cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toArgb(hex: string): string {
  return `FF${hex.slice(1)}`.toUpperCase();
}

function buildStylesXml(headerBg: string | null): string {
  const hasBg = Boolean(headerBg);
  const fillXml = hasBg
    ? `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="${toArgb(headerBg!)}"/><bgColor indexed="64"/></patternFill></fill>`
    : `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`;
  const xfXml = hasBg
    ? `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`
    : `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    `<fills count="${hasBg ? 3 : 2}">${fillXml}</fills>` +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${hasBg ? 3 : 2}">${xfXml}</cellXfs>` +
    '</styleSheet>'
  );
}

function buildWorksheetXml(data: TableData, headerBg: string | null): string {
  const headerStyle = headerBg ? 2 : 1;
  const dimension =
    data.colCount > 0 && data.rowCount > 0
      ? `<dimension ref="A1:${excelColumnName(data.colCount - 1)}${data.rowCount}"/>`
      : '<dimension ref="A1"/>';

  const rowXml: string[] = [];
  for (let y = 0; y < data.rows.length; y++) {
    const cells = data.rows[y];
    const cellXml: string[] = [];
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x];
      const text = cell.text;
      if (!text) continue;
      const ref = `${excelColumnName(x)}${y + 1}`;
      const styleAttr = cell.header ? ` s="${headerStyle}"` : '';
      if (cell.isNumber) {
        cellXml.push(`<c r="${ref}"${styleAttr}><v>${text}</v></c>`);
      } else {
        cellXml.push(
          `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`,
        );
      }
    }
    if (cellXml.length > 0) {
      rowXml.push(`<row r="${y + 1}">${cellXml.join('')}</row>`);
    }
  }

  const mergeXml =
    data.merges.length > 0
      ? `<mergeCells count="${data.merges.length}">${data.merges
          .map(
            (m) =>
              `<mergeCell ref="${excelColumnName(m.c1)}${m.r1 + 1}:${excelColumnName(m.c2)}${m.r2 + 1}"/>`,
          )
          .join('')}</mergeCells>`
      : '';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    dimension +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<sheetData>${rowXml.join('')}</sheetData>` +
    mergeXml +
    '</worksheet>'
  );
}

/**
 * Build a real .xlsx file (SPREADSHEETML package) for the given grid.
 * Throws a RangeError when the table exceeds Excel's grid limits.
 */
export function buildXlsxBytes(data: TableData, style?: TableVisualStyle): Uint8Array {
  if (data.rowCount > EXCEL_MAX_ROWS || data.colCount > EXCEL_MAX_COLS) {
    throw new RangeError(
      `Table too large for Excel (${data.rowCount}×${data.colCount} exceeds ${EXCEL_MAX_ROWS}×${EXCEL_MAX_COLS})`,
    );
  }
  const headerBg = normalizeCssColor(style?.headerBg);

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const encoder = new TextEncoder();
  return buildStoreZip([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rootRels) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
    { name: 'xl/styles.xml', data: encoder.encode(buildStylesXml(headerBg)) },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: encoder.encode(buildWorksheetXml(data, headerBg)),
    },
  ]);
}

/** Encode binary bytes as base64 without blowing the call stack. */
export function xlsxBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const sliceSize = 0x8000;
  for (let i = 0; i < bytes.length; i += sliceSize) {
    const slice = bytes.subarray(i, Math.min(i + sliceSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

// ============================================================================
// STORE-only ZIP writer
// ============================================================================

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface StoreZipEntry {
  name: string;
  data: Uint8Array;
}

function buildStoreZip(entries: StoreZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const size = entry.data.length;
    const crc = crc32(entry.data);
    const nameLen = nameBytes.length;

    // Local file header.
    const local = new DataView(new ArrayBuffer(30 + nameLen));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // method: store
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameLen, true);
    local.setUint16(28, 0, true);
    new Uint8Array(local.buffer, 30, nameLen).set(nameBytes);
    const localBytes = new Uint8Array(local.buffer);
    locals.push(localBytes, entry.data);

    // Central directory entry.
    const central = new DataView(new ArrayBuffer(46 + nameLen));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameLen, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true); // external attributes
    central.setUint32(42, offset, true); // local header offset
    new Uint8Array(central.buffer, 46, nameLen).set(nameBytes);
    const centralBytes = new Uint8Array(central.buffer);
    centrals.push(centralBytes);
    centralSize += centralBytes.length;

    // Rewrite offset after we know local header size (append order fixed):
    central.setUint32(42, offset, true);
    offset += localBytes.length + size;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const total =
    locals.reduce((n, b) => n + b.length, 0) + centralSize + end.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of locals) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centrals) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(new Uint8Array(end.buffer), pos);
  return out;
}
