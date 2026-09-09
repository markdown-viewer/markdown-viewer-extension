/**
 * Table → Excel/clipboard serializer contract (pure, no DOM/browser).
 *
 * Covers the shared serializer in src/utils/table-xlsx.ts:
 *  - span flattening into dense grids + merge ranges;
 *  - numeric/string classification (Excel needs real numbers);
 *  - TSV and HTML clipboard fragments (Excel paste semantics);
 *  - the real .xlsx package: unzip with JSZip and assert the OOXML parts.
 *
 * The DOM half (right-click menu on a rendered table) is covered by the
 * installed-extension e2e suite (extension-e2e/context-menu-e2e.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';

import {
  buildXlsxBytes,
  flattenTableCells,
  isNumericCellText,
  normalizeCellText,
  tableDataToHtml,
  tableDataToTsv,
  xlsxBytesToBase64,
  type TableSpanCell,
} from '../../../src/utils/table-xlsx.ts';

// ============================================================================
// Cell text helpers
// ============================================================================

describe('table-xlsx: cell text helpers', () => {
  it('normalizes CRLF/tabs and trims cell text', () => {
    assert.equal(normalizeCellText('  a\r\nb\tc  '), 'a\nb c');
    assert.equal(normalizeCellText(''), '');
    assert.equal(normalizeCellText('   '), '');
  });

  it('classifies numeric-looking cells conservatively', () => {
    for (const numeric of ['12', '0', '-7', '+3', '3.14', '.5', '-2.0', ' 99 ']) {
      assert.equal(isNumericCellText(numeric), true, `${JSON.stringify(numeric)} should be numeric`);
    }
    for (const text of ['', '007', '-007', '00.5', '1,000', '12px', '1e3', 'NaN', 'Infinity', 'abc', '3.14.15']) {
      assert.equal(isNumericCellText(text), false, `${JSON.stringify(text)} should stay text`);
    }
  });
});

// ============================================================================
// Span flattening
// ============================================================================

describe('table-xlsx: span flattening', () => {
  it('expands a plain table into a rectangular grid without merges', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'h1', header: true }, { text: 'h2', header: true }],
      [{ text: 'a' }, { text: '1' }],
    ];
    const data = flattenTableCells(cells);
    assert.equal(data.rowCount, 2);
    assert.equal(data.colCount, 2);
    assert.deepEqual(
      data.rows.map((r) => r.map((c) => c.text)),
      [['h1', 'h2'], ['a', '1']],
    );
    assert.deepEqual(data.merges, []);
  });

  it('flattens a vertical rowspan and records the merge range', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'A', rowspan: 2 }, { text: 'B' }],
      [{ text: 'C' }],
    ];
    const data = flattenTableCells(cells);
    assert.deepEqual(
      data.rows.map((r) => r.map((c) => c.text)),
      [['A', 'B'], ['', 'C']],
    );
    assert.deepEqual(data.merges, [{ r1: 0, c1: 0, r2: 1, c2: 0 }]);
  });

  it('flattens a horizontal colspan and keeps numeric flags at the origin', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'H', colspan: 2, header: true }],
      [{ text: 'x' }, { text: '3.5' }],
    ];
    const data = flattenTableCells(cells);
    assert.deepEqual(
      data.rows.map((r) => r.map((c) => c.text)),
      [['H', ''], ['x', '3.5']],
    );
    assert.deepEqual(data.merges, [{ r1: 0, c1: 0, r2: 0, c2: 1 }]);
    assert.equal(data.rows[1][1].isNumber, true);
    assert.equal(data.rows[0][0].header, true);
  });

  it('clamps spans that would run past the physical table', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'A', rowspan: 99 }],
      [{ text: 'B' }],
    ];
    const data = flattenTableCells(cells);
    assert.deepEqual(data.merges, [{ r1: 0, c1: 0, r2: 1, c2: 0 }]);
  });

  it('pads ragged rows to the widest column count', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'wide', colspan: 3 }],
      [{ text: 'a' }],
    ];
    const data = flattenTableCells(cells);
    assert.equal(data.colCount, 3);
    assert.equal(data.rows[1].length, 3);
    assert.equal(data.rows[1][1].text, '');
  });
});

// ============================================================================
// TSV + HTML fragments
// ============================================================================

describe('table-xlsx: TSV / HTML clipboard fragments', () => {
  it('serializes the dense grid to tab-separated lines', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'Name', header: true }, { text: 'Value', header: true }],
      [{ text: 'Alpha' }, { text: '1' }],
    ];
    assert.equal(tableDataToTsv(flattenTableCells(cells)), 'Name\tValue\nAlpha\t1');
  });

  it('flattens multi-line cell text to spaces in TSV', () => {
    const cells: TableSpanCell[][] = [[{ text: 'line1\nline2' }, { text: 'x' }]];
    assert.equal(tableDataToTsv(flattenTableCells(cells)), 'line1 line2\tx');
  });

  it('emits a RECTANGULAR HTML grid (no spans; blanks in covered slots)', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'H1', colspan: 2, header: true }],
      [{ text: 'A', rowspan: 2 }, { text: '<b>B</b>' }],
      [{ text: 'C' }],
    ];
    const html = tableDataToHtml(flattenTableCells(cells), {
      borderColor: 'rgb(226, 232, 240)',
      headerBg: '#f1f5f9',
    });
    assert.ok(html.startsWith('<table border="1"'), 'HTML must be a table fragment');
    assert.ok(!html.includes('rowspan') && !html.includes('colspan'), 'no span attributes: paste targets that ignore spans must not shift rows');
    assert.ok(html.includes('<th'), 'header cells must be <th>');
    assert.ok(html.includes('border:1px solid #e2e8f0'), 'rgb border must be normalized to hex');
    assert.ok(html.includes('background:#f1f5f9'), 'header background must be inlined');
    assert.ok(html.includes('&lt;b&gt;B&lt;/b&gt;'), 'cell text must be HTML-escaped');
  });

  it('keeps every row at the same width with empty cells for covered slots', () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'A', rowspan: 2 }, { text: 'B' }],
      [{ text: 'C' }],
      [{ text: 'D' }, { text: 'E' }],
    ];
    const html = tableDataToHtml(flattenTableCells(cells));
    const rows = html.split('</tr>').filter((r) => r.includes('<td'));
    assert.equal(rows.length, 3, 'one <tr> per logical row');
    for (const row of rows) {
      const cellCount = (row.match(/<t[dh] /g) || []).length;
      assert.equal(cellCount, 2, `row must stay 2 cells wide (got ${cellCount})`);
    }
    // Row 2 (the span continuation) carries an EMPTY first cell, so its text
    // lands in column 2 for span-ignoring paste engines too.
    const row2 = rows[1];
    assert.ok(/<td[^>]*><\/td>\s*<td[^>]*>C<\/td>/.test(row2), 'covered slot must be an empty cell before C');
  });

  it('converts internal newlines to <br> in the HTML fragment', () => {
    const html = tableDataToHtml(flattenTableCells([[{ text: 'a\nb' }]]));
    assert.ok(html.includes('a<br>b'), 'newlines inside a cell become <br>');
  });
});

// ============================================================================
// .xlsx package
// ============================================================================

async function sheetXml(data: ReturnType<typeof flattenTableCells>, style?: Parameters<typeof buildXlsxBytes>[1]): Promise<string> {
  const bytes = buildXlsxBytes(data, style);
  const zip = await JSZip.loadAsync(Buffer.from(bytes));
  return zip.files['xl/worksheets/sheet1.xml'].async('string');
}

describe('table-xlsx: .xlsx package', () => {
  it('produces a parseable zip with all OOXML parts', async () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'Name', header: true }, { text: 'Value', header: true }],
      [{ text: 'Alpha' }, { text: '12' }],
    ];
    const bytes = buildXlsxBytes(flattenTableCells(cells));
    const zip = await JSZip.loadAsync(Buffer.from(bytes));
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]) {
      assert.ok(zip.files[required], `package must contain ${required}`);
    }
    const sheet = await zip.files['xl/worksheets/sheet1.xml'].async('string');
    assert.ok(sheet.includes('<dimension ref="A1:B2"/>'), 'dimension must cover the grid');
    assert.ok(sheet.includes('<row r="1">'), 'row 1 (header) must exist');
    assert.ok(sheet.includes('t="inlineStr"'), 'text cells must be inline strings');
    assert.ok(sheet.includes('<v>12</v>'), 'numeric cells must carry a raw <v>');
    assert.ok(!sheet.includes('<mergeCells'), 'unmerged table must not emit mergeCells');
  });

  it('keeps 007-style codes as text and numbers as <v>', async () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'Code' }, { text: '007' }],
      [{ text: 'Num' }, { text: '-3.5' }],
    ];
    const sheet = await sheetXml(flattenTableCells(cells));
    assert.ok(sheet.includes('<v>007</v>') === false, '007 must not become a number');
    assert.ok(sheet.includes('007</t>'), '007 must stay an inline string');
    assert.ok(sheet.includes('<v>-3.5</v>'), '-3.5 must be numeric');
  });

  it('writes merges and header styling into the sheet', async () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'Dept', rowspan: 2, header: true }, { text: 'Team', header: true }],
      [{ text: 'FE' }],
      [{ text: 'Facts' }, { text: 'ok' }],
    ];
    const sheet = await sheetXml(flattenTableCells(cells), { headerBg: 'rgb(241, 245, 249)' });
    assert.ok(sheet.includes('<mergeCells count="1">'), 'mergeCells block must exist');
    assert.ok(sheet.includes('<mergeCell ref="A1:A2"/>'), 'rowspan merge ref must be exact');
    const styles = await (async () => {
      const bytes = buildXlsxBytes(flattenTableCells(cells), { headerBg: 'rgb(241, 245, 249)' });
      const zip = await JSZip.loadAsync(Buffer.from(bytes));
      return zip.files['xl/styles.xml'].async('string');
    })();
    assert.ok(styles.includes('applyFont="1" applyFill="1"'), 'styled header xf must be referenced');
    assert.ok(styles.includes('patternType="solid"'), 'header fill must be solid');
    assert.ok(sheet.includes('<c r="A1" s="2"'), 'merged header origin must use the styled xf');
  });

  it('escapes XML specials inside string cells', async () => {
    const cells: TableSpanCell[][] = [[{ text: 'a<b & "c"' }]];
    const sheet = await sheetXml(flattenTableCells(cells));
    assert.ok(sheet.includes('a&lt;b &amp; &quot;c&quot;'), 'XML specials must be escaped');
  });

  it('round-trips through base64', async () => {
    const cells: TableSpanCell[][] = [
      [{ text: 'x' }, { text: '1' }],
    ];
    const bytes = buildXlsxBytes(flattenTableCells(cells));
    const decoded = Buffer.from(xlsxBytesToBase64(bytes), 'base64');
    assert.deepEqual(new Uint8Array(decoded), bytes);
  });

  it('rejects grids beyond Excel limits before serializing', () => {
    assert.throws(
      () => buildXlsxBytes({ rowCount: 1_048_577, colCount: 1, rows: [], merges: [] }),
      RangeError,
    );
    assert.throws(
      () => buildXlsxBytes({ rowCount: 1, colCount: 16_385, rows: [], merges: [] }),
      RangeError,
    );
    // Within limits (empty grid) must not throw.
    buildXlsxBytes({ rowCount: 0, colCount: 0, rows: [], merges: [] });
  });
});
