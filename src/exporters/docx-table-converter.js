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
} from 'docx';
import { VerticalAlign as VerticalAlignTable } from 'docx';

/**
 * Create a table converter
 * @param {Object} options - Configuration options
 * @param {Object} options.themeStyles - Theme styles
 * @param {Function} options.convertInlineNodes - Function to convert inline nodes
 * @returns {Object} Table converter
 */
export function createTableConverter({ themeStyles, convertInlineNodes }) {
  /**
   * Convert table node to DOCX Table
   * @param {Object} node - Table AST node
   * @returns {Promise<Table>} DOCX Table
   */
  async function convertTable(node) {
    const rows = [];
    const alignments = node.align || [];
    const tableRows = node.children.filter((row) => row.type === 'tableRow');
    const rowCount = tableRows.length;
    const tableStyles = themeStyles.tableStyles;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const row = tableRows[rowIndex];
      const isHeaderRow = rowIndex === 0;
      const isLastRow = rowIndex === rowCount - 1;

      if (row.type === 'tableRow') {
        const cells = [];

        for (let colIndex = 0; colIndex < row.children.length; colIndex++) {
          const cell = row.children[colIndex];

          if (cell.type === 'tableCell') {
            const isBold = isHeaderRow && tableStyles.header.bold;
            const children = isBold
              ? await convertInlineNodes(cell.children, { bold: true, size: 20 })
              : await convertInlineNodes(cell.children, { size: 20 });

            const cellAlignment = alignments[colIndex];
            let paragraphAlignment = AlignmentType.LEFT;
            if (isHeaderRow) {
              paragraphAlignment = AlignmentType.CENTER;
            } else if (cellAlignment === 'center') {
              paragraphAlignment = AlignmentType.CENTER;
            } else if (cellAlignment === 'right') {
              paragraphAlignment = AlignmentType.RIGHT;
            }

            const cellConfig = {
              children: [new Paragraph({
                children: children,
                alignment: paragraphAlignment,
                spacing: { before: 60, after: 60, line: 240 },
              })],
              verticalAlign: VerticalAlignTable.CENTER,
              margins: tableStyles.cell.margins,
            };

            const whiteBorder = { style: BorderStyle.SINGLE, size: 0, color: 'FFFFFF' };
            const noneBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
            const isFirstColumn = colIndex === 0;

            if (tableStyles.borders.all) {
              cellConfig.borders = {
                top: tableStyles.borders.all,
                bottom: tableStyles.borders.all,
                left: tableStyles.borders.all,
                right: tableStyles.borders.all
              };
            } else {
              cellConfig.borders = {
                top: whiteBorder,
                bottom: whiteBorder,
                left: isFirstColumn ? whiteBorder : noneBorder,
                right: noneBorder
              };
            }

            if (isHeaderRow && tableStyles.borders.headerTop && tableStyles.borders.headerTop.style !== BorderStyle.NONE) {
              cellConfig.borders.top = tableStyles.borders.headerTop;
            }
            if (isHeaderRow && tableStyles.borders.headerBottom && tableStyles.borders.headerBottom.style !== BorderStyle.NONE) {
              cellConfig.borders.bottom = tableStyles.borders.headerBottom;
            }
            if (!isHeaderRow) {
              if (isLastRow && tableStyles.borders.lastRowBottom && tableStyles.borders.lastRowBottom.style !== BorderStyle.NONE) {
                cellConfig.borders.bottom = tableStyles.borders.lastRowBottom;
              } else if (tableStyles.borders.insideHorizontal && tableStyles.borders.insideHorizontal.style !== BorderStyle.NONE) {
                cellConfig.borders.bottom = tableStyles.borders.insideHorizontal;
              }
            }

            if (isHeaderRow && tableStyles.header.shading) {
              cellConfig.shading = tableStyles.header.shading;
            } else if (tableStyles.zebra && rowIndex > 0) {
              const isOddDataRow = ((rowIndex - 1) % 2) === 0;
              const background = isOddDataRow ? tableStyles.zebra.odd : tableStyles.zebra.even;
              if (background !== 'ffffff' && background !== 'FFFFFF') {
                cellConfig.shading = { fill: background };
              }
            }

            cells.push(new TableCell(cellConfig));
          }
        }

        rows.push(new TableRow({
          children: cells,
          tableHeader: isHeaderRow,
        }));
      }
    }

    return new Table({
      rows: rows,
      layout: TableLayoutType.AUTOFIT,
      alignment: AlignmentType.CENTER,
    });
  }

  return { convertTable };
}
