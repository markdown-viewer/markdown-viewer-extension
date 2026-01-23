// Table conversion for DOCX export

import {
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  TableCell,
  TableRow,
  BorderStyle,
  TableLayoutType,
  VerticalAlign as VerticalAlignTable,
  VerticalMergeType,
  WidthType,
  convertInchesToTwip,
  type IBorderOptions,
  type IParagraphOptions,
  type ITableCellOptions,
  type ParagraphChild,
} from 'docx';
import type { DOCXThemeStyles, DOCXTableNode } from '../types/docx';
import type { InlineResult, InlineNode } from './docx-inline-converter';
import { 
  calculateMergeInfoFromStrings, 
  extractTextFromAstCell,
  type CellMergeInfo 
} from '../utils/table-merge-utils';

type ConvertInlineNodesFunction = (children: InlineNode[], options?: { bold?: boolean; size?: number; color?: string }) => Promise<InlineResult[]>;

interface TableConverterOptions {
  themeStyles: DOCXThemeStyles;
  convertInlineNodes: ConvertInlineNodesFunction;
  /** Enable auto-merge of empty table cells */
  mergeEmptyCells?: boolean;
}

export interface TableConverter {
  convertTable(node: DOCXTableNode, listLevel?: number): Promise<Table>;
  /** Update merge setting at runtime */
  setMergeEmptyCells(enabled: boolean): void;
}

/**
 * Create a table converter
 * @param options - Configuration options
 * @returns Table converter
 */
export function createTableConverter({ themeStyles, convertInlineNodes, mergeEmptyCells = false }: TableConverterOptions): TableConverter {
  // Default table styles
  const defaultMargins = { top: 80, bottom: 80, left: 100, right: 100 };
  
  // Get table styles with defaults
  const tableStyles = themeStyles.tableStyles || {};
  const headerStyles = tableStyles.header || {};
  const cellStyles = tableStyles.cell || {};
  const borderStyles = tableStyles.borders || {};
  const zebraStyles = tableStyles.zebra;
  
  // Mutable merge setting
  let enableMerge = mergeEmptyCells;
  
  /**
   * Extract cell text content matrix from data rows (excluding header)
   */
  function extractCellMatrix(tableRows: DOCXTableNode['children']): string[][] {
    // Skip header row (index 0)
    const dataRows = tableRows.slice(1);
    return dataRows.map(row => {
      const cells = (row.children || []).filter(c => c.type === 'tableCell');
      return cells.map(cell => extractTextFromAstCell(cell));
    });
  }
  
  /**
   * Convert table node to DOCX Table
   * @param node - Table AST node
   * @param listLevel - List nesting level for indentation (default: 0)
   * @returns DOCX Table
   */
  async function convertTable(node: DOCXTableNode, listLevel = 0): Promise<Table> {
    const rows: TableRow[] = [];
    const alignments = (node as unknown as { align?: Array<'left' | 'center' | 'right' | null> }).align || [];
    const tableRows = (node.children || []).filter((row) => row.type === 'tableRow');
    const rowCount = tableRows.length;

    // Calculate merge info for data rows if merge is enabled
    let mergeInfo: CellMergeInfo[][] | null = null;
    if (enableMerge && rowCount > 1) {
      const cellMatrix = extractCellMatrix(tableRows);
      if (cellMatrix.length > 0 && cellMatrix[0].length > 0) {
        mergeInfo = calculateMergeInfoFromStrings(cellMatrix);
      }
    }

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const row = tableRows[rowIndex];
      const isHeaderRow = rowIndex === 0;
      const isLastRow = rowIndex === rowCount - 1;
      const dataRowIndex = rowIndex - 1; // Index in data rows (excluding header)

      if (row.type === 'tableRow') {
        const cells: TableCell[] = [];

        const rowChildren = row.children || [];
        for (let colIndex = 0; colIndex < rowChildren.length; colIndex++) {
          const cell = rowChildren[colIndex];

          if (cell.type === 'tableCell') {
            // Check if this cell should be skipped (merged into cell above)
            if (!isHeaderRow && mergeInfo && dataRowIndex >= 0 && dataRowIndex < mergeInfo.length) {
              const cellInfo = mergeInfo[dataRowIndex]?.[colIndex];
              if (cellInfo && !cellInfo.shouldRender) {
                // Skip this cell - it's merged into the cell above
                continue;
              }
            }
            
            const isBold = isHeaderRow && (headerStyles.bold ?? true);
            const headerColor = isHeaderRow && headerStyles.color ? headerStyles.color : undefined;
            const children = isHeaderRow
              ? await convertInlineNodes((cell.children || []) as InlineNode[], { bold: isBold, size: 20, color: headerColor })
              : await convertInlineNodes((cell.children || []) as InlineNode[], { size: 20 });

            const cellAlignment = alignments[colIndex];
            let paragraphAlignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT;
            if (isHeaderRow) {
              paragraphAlignment = AlignmentType.CENTER;
            } else if (cellAlignment === 'center') {
              paragraphAlignment = AlignmentType.CENTER;
            } else if (cellAlignment === 'right') {
              paragraphAlignment = AlignmentType.RIGHT;
            }

            const paragraphOptions: IParagraphOptions = {
              children: children as ParagraphChild[],
              alignment: paragraphAlignment,
              spacing: { before: 60, after: 60, line: 240 },
            };

            const whiteBorder: IBorderOptions = { style: BorderStyle.SINGLE, size: 0, color: 'FFFFFF' };
            const noneBorder: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
            const isFirstColumn = colIndex === 0;

            let borders: ITableCellOptions['borders'];

            if (borderStyles.all) {
              borders = {
                top: borderStyles.all,
                bottom: borderStyles.all,
                left: borderStyles.all,
                right: borderStyles.all
              };
            } else {
              borders = {
                top: whiteBorder,
                bottom: whiteBorder,
                left: isFirstColumn ? whiteBorder : noneBorder,
                right: noneBorder
              };
            }

            if (isHeaderRow && borderStyles.headerTop && borderStyles.headerTop.style !== BorderStyle.NONE) {
              borders = { ...(borders || {}), top: borderStyles.headerTop };
            }
            if (isHeaderRow && borderStyles.headerBottom && borderStyles.headerBottom.style !== BorderStyle.NONE) {
              borders = { ...(borders || {}), bottom: borderStyles.headerBottom };
            }
            if (!isHeaderRow && borderStyles.insideHorizontal && borderStyles.insideHorizontal.style !== BorderStyle.NONE) {
              // Apply inside horizontal border (will be overridden by lastRowBottom if needed)
              borders = { ...(borders || {}), bottom: borderStyles.insideHorizontal };
            }

            let shading: ITableCellOptions['shading'];
            if (isHeaderRow && headerStyles.shading) {
              shading = headerStyles.shading;
            } else if (rowIndex > 0 && typeof zebraStyles === 'object') {
              const isOddDataRow = ((rowIndex - 1) % 2) === 0;
              const background = isOddDataRow ? zebraStyles.odd : zebraStyles.even;
              if (background !== 'ffffff' && background !== 'FFFFFF') {
                shading = { fill: background };
              }
            }

            // Calculate vertical merge for this cell
            let rowSpan: number | undefined;
            let cellSpansToLastRow = false;
            if (!isHeaderRow && mergeInfo && dataRowIndex >= 0 && dataRowIndex < mergeInfo.length) {
              const cellInfo = mergeInfo[dataRowIndex]?.[colIndex];
              if (cellInfo && cellInfo.rowspan > 1) {
                rowSpan = cellInfo.rowspan;
                // Check if this cell spans to the last data row
                // dataRowIndex is 0-based index in data rows, mergeInfo.length is total data rows
                cellSpansToLastRow = (dataRowIndex + cellInfo.rowspan >= mergeInfo.length);
              }
            }
            
            // Apply last row bottom border if this cell is in last row OR spans to last row
            if (!isHeaderRow && (isLastRow || cellSpansToLastRow)) {
              if (borderStyles.lastRowBottom && borderStyles.lastRowBottom.style !== BorderStyle.NONE) {
                borders = { ...(borders || {}), bottom: borderStyles.lastRowBottom };
              }
            }

            const cellConfig: ITableCellOptions = {
              children: [new Paragraph(paragraphOptions)],
              verticalAlign: VerticalAlignTable.CENTER,
              margins: cellStyles.margins || defaultMargins,
              borders,
              shading,
              rowSpan,  // Add vertical merge span
            };

            cells.push(new TableCell(cellConfig));
          }
        }

        rows.push(new TableRow({
          children: cells,
          tableHeader: isHeaderRow,
        }));
      }
    }

    // For nested tables, add half the indent to the left margin and keep center alignment
    // This creates the visual effect of centering within the indented area
    const indentSize = listLevel > 0 ? convertInchesToTwip(0.5 * listLevel / 2) : undefined;

    return new Table({
      rows: rows,
      layout: TableLayoutType.AUTOFIT,
      alignment: AlignmentType.CENTER,
      indent: indentSize ? { size: indentSize, type: WidthType.DXA } : undefined,
    });
  }
  
  function setMergeEmptyCells(enabled: boolean): void {
    enableMerge = enabled;
  }

  return { convertTable, setMergeEmptyCells };
}
