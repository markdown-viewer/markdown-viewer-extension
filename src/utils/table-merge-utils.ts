/**
 * Table Merge Utilities
 * 
 * Provides functions to calculate and apply vertical cell merging
 * for tables with empty cells.
 */

/**
 * Merge information for a single cell
 */
export interface CellMergeInfo {
  /** Number of rows this cell spans (1 = no merge) */
  rowspan: number;
  /** Whether this cell should be rendered (false = merged into cell above) */
  shouldRender: boolean;
}

/**
 * Generic cell content interface
 */
export interface CellContent {
  /** Text content of the cell */
  text: string;
  /** Original node/element (for reference) */
  node?: unknown;
}

/**
 * Check if a cell is considered empty
 * @param cell - Cell content to check
 * @returns true if the cell is empty
 */
export function isCellEmpty(cell: CellContent): boolean {
  if (!cell.text) return true;
  return cell.text.trim() === '';
}

/**
 * Check if a cell content string is empty
 * @param text - Text content to check
 * @returns true if empty or whitespace only
 */
export function isTextEmpty(text: string | null | undefined): boolean {
  if (!text) return true;
  return text.trim() === '';
}

/**
 * Calculate merge information for a table's data rows.
 * Empty cells will be merged with the cell above them.
 * 
 * @param rows - 2D array of cell contents (data rows only, excluding header)
 * @returns 2D array of merge information matching the input structure
 * 
 * @example
 * ```
 * const rows = [
 *   [{ text: 'A' }, { text: 'B' }],
 *   [{ text: '' },  { text: 'C' }],
 *   [{ text: '' },  { text: '' }],
 * ];
 * const mergeInfo = calculateMergeInfo(rows);
 * // Result:
 * // [
 * //   [{ rowspan: 3, shouldRender: true },  { rowspan: 1, shouldRender: true }],
 * //   [{ rowspan: 1, shouldRender: false }, { rowspan: 2, shouldRender: true }],
 * //   [{ rowspan: 1, shouldRender: false }, { rowspan: 1, shouldRender: false }],
 * // ]
 * ```
 */
export function calculateMergeInfo(rows: CellContent[][]): CellMergeInfo[][] {
  if (rows.length === 0) {
    return [];
  }

  const rowCount = rows.length;
  const colCount = rows[0]?.length || 0;

  // Initialize merge info with defaults
  const mergeInfo: CellMergeInfo[][] = rows.map(row =>
    row.map(() => ({ rowspan: 1, shouldRender: true }))
  );

  // Process each column independently
  for (let col = 0; col < colCount; col++) {
    // Track the current "anchor" cell that non-empty cells merge into
    let anchorRow = 0;

    for (let row = 0; row < rowCount; row++) {
      const cell = rows[row]?.[col];
      
      if (!cell || isCellEmpty(cell)) {
        // Empty cell: merge into anchor (if anchor exists and is different row)
        if (row > anchorRow) {
          mergeInfo[row][col].shouldRender = false;
          mergeInfo[anchorRow][col].rowspan = row - anchorRow + 1;
        }
      } else {
        // Non-empty cell: this becomes the new anchor
        anchorRow = row;
      }
    }
  }

  return mergeInfo;
}

/**
 * Calculate merge information from a simple string matrix.
 * Convenience wrapper for calculateMergeInfo.
 * 
 * @param rows - 2D array of string contents
 * @returns 2D array of merge information
 */
export function calculateMergeInfoFromStrings(rows: string[][]): CellMergeInfo[][] {
  const cellRows: CellContent[][] = rows.map(row =>
    row.map(text => ({ text }))
  );
  return calculateMergeInfo(cellRows);
}

/**
 * Extract text content from HAST table cell element
 * @param cell - HAST element node
 * @returns Text content of the cell
 */
export function extractTextFromHastCell(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return '';
  
  const node = cell as { children?: unknown[]; value?: string; type?: string };
  
  // Direct text value
  if (node.type === 'text' && typeof node.value === 'string') {
    return node.value;
  }
  
  // Recursively extract from children
  if (Array.isArray(node.children)) {
    return node.children
      .map(child => extractTextFromHastCell(child))
      .join('');
  }
  
  return '';
}

/**
 * Extract text content from MDAST/DOCX AST table cell node
 * @param cell - AST node
 * @returns Text content of the cell
 */
export function extractTextFromAstCell(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return '';
  
  const node = cell as { 
    children?: unknown[]; 
    value?: string; 
    type?: string;
  };
  
  // Direct text value
  if (node.type === 'text' && typeof node.value === 'string') {
    return node.value;
  }
  
  // Recursively extract from children
  if (Array.isArray(node.children)) {
    return node.children
      .map(child => extractTextFromAstCell(child))
      .join('');
  }
  
  return '';
}
