/**
 * Rehype plugin to merge empty table cells vertically
 * 
 * When enabled, empty cells in table body will be merged with
 * the cell above them using the rowspan attribute.
 * Table headers are not affected.
 */

import { visit } from 'unist-util-visit';
import type { Root, Element, ElementContent } from 'hast';
import { 
  calculateMergeInfoFromStrings, 
  extractTextFromHastCell,
  type CellMergeInfo 
} from '../utils/table-merge-utils';

export interface RehypeTableMergeOptions {
  /** Enable or disable the merge functionality */
  enabled?: boolean;
}

/**
 * Check if an element is a specific HTML tag
 */
function isElement(node: unknown, tagName: string): node is Element {
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as Element).type === 'element' &&
    (node as Element).tagName === tagName
  );
}

/**
 * Find a child element by tag name
 */
function findChild(parent: Element, tagName: string): Element | undefined {
  return parent.children?.find(child => isElement(child, tagName)) as Element | undefined;
}

/**
 * Get all child elements of a specific tag
 */
function getChildElements(parent: Element, tagName: string): Element[] {
  return (parent.children?.filter(child => isElement(child, tagName)) || []) as Element[];
}

/**
 * Extract table data rows (from tbody or directly from table if no tbody)
 */
function getTableBodyRows(table: Element): Element[] {
  const tbody = findChild(table, 'tbody');
  if (tbody) {
    return getChildElements(tbody, 'tr');
  }
  
  // If no tbody, get all tr except those in thead
  const thead = findChild(table, 'thead');
  const theadRows = thead ? getChildElements(thead, 'tr') : [];
  const allRows = getChildElements(table, 'tr');
  
  // Filter out header rows
  if (theadRows.length > 0) {
    return allRows.filter(row => !theadRows.includes(row));
  }
  
  // If no thead, skip the first row (assumed to be header)
  return allRows.slice(1);
}

/**
 * Extract cell text matrix from table rows
 */
function extractCellMatrix(rows: Element[]): string[][] {
  return rows.map(row => {
    const cells = getChildElements(row, 'td');
    return cells.map(cell => extractTextFromHastCell(cell));
  });
}

/**
 * Apply merge information to table rows
 */
function applyMergeToRows(rows: Element[], mergeInfo: CellMergeInfo[][]): void {
  const totalRows = rows.length;
  
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const cells = getChildElements(row, 'td');
    const rowMergeInfo = mergeInfo[rowIndex];
    
    if (!rowMergeInfo) continue;
    
    // Process cells in reverse order so removal doesn't affect indices
    const cellsToRemove: number[] = [];
    
    for (let colIndex = 0; colIndex < cells.length; colIndex++) {
      const cell = cells[colIndex];
      const info = rowMergeInfo[colIndex];
      
      if (!info) continue;
      
      if (!info.shouldRender) {
        // Mark for removal
        cellsToRemove.push(colIndex);
      } else if (info.rowspan > 1) {
        // Add rowspan attribute
        if (!cell.properties) {
          cell.properties = {};
        }
        cell.properties.rowspan = info.rowspan;
        
        // If this cell spans to the last row, add a CSS class for proper border styling
        if (rowIndex + info.rowspan >= totalRows) {
          const existingClass = cell.properties.className;
          if (Array.isArray(existingClass)) {
            existingClass.push('merged-to-last');
          } else if (typeof existingClass === 'string') {
            cell.properties.className = [existingClass, 'merged-to-last'];
          } else {
            cell.properties.className = ['merged-to-last'];
          }
        }
      }
    }
    
    // Remove merged cells (in reverse order to maintain indices)
    for (let i = cellsToRemove.length - 1; i >= 0; i--) {
      const cellIndex = cellsToRemove[i];
      const cell = cells[cellIndex];
      const childIndex = row.children.indexOf(cell as ElementContent);
      if (childIndex !== -1) {
        row.children.splice(childIndex, 1);
      }
    }
  }
}

/**
 * Rehype plugin to automatically merge empty table cells vertically.
 * 
 * @param options - Plugin options
 * @returns Transformer function
 * 
 * @example
 * ```typescript
 * import rehypeTableMerge from './plugins/rehype-table-merge';
 * 
 * unified()
 *   .use(remarkParse)
 *   .use(remarkRehype)
 *   .use(rehypeTableMerge, { enabled: true })
 *   .use(rehypeStringify)
 * ```
 */
export default function rehypeTableMerge(options: RehypeTableMergeOptions = {}) {
  const { enabled = true } = options;

  return (tree: Root) => {
    if (!enabled) return;

    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'table') return;

      // Get data rows (excluding header)
      const dataRows = getTableBodyRows(node);
      
      if (dataRows.length === 0) return;

      // Extract cell text matrix
      const cellMatrix = extractCellMatrix(dataRows);
      
      if (cellMatrix.length === 0 || cellMatrix[0].length === 0) return;

      // Calculate merge information
      const mergeInfo = calculateMergeInfoFromStrings(cellMatrix);

      // Apply merge to DOM
      applyMergeToRows(dataRows, mergeInfo);
    });
  };
}
