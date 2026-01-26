/**
 * Table Merge Utilities
 * 
 * Provides functions to calculate and apply vertical cell merging
 * for tables with empty cells.
 * 
 * Uses table-structure-analyzer to detect table types and determine
 * which columns should have cells merged.
 */

import { 
  analyzeTableStructure, 
  mightNeedAnalysis,
  type TableAnalysisResult 
} from './table-structure-analyzer';

/**
 * Merge information for a single cell
 */
export interface CellMergeInfo {
  /** Number of rows this cell spans (1 = no merge) */
  rowspan: number;
  /** Number of columns this cell spans (1 = no merge) */
  colspan: number;
  /** Whether this cell should be rendered (false = merged into cell above/left) */
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
 * 
 * This function uses table structure analysis to determine:
 * - Whether merging should be applied at all
 * - Which columns are tree columns (eligible for merge)
 * - Which rows are group headers (merge boundaries)
 * 
 * Only tree-structure columns have empty cells merged.
 * Group header rows act as merge boundaries.
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
 * // Result depends on structure analysis
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
    row.map(() => ({ rowspan: 1, colspan: 1, shouldRender: true }))
  );

  // Convert to string matrix for analysis
  const stringMatrix = rows.map(row => row.map(cell => cell.text || ''));
  
  // Quick check: if no empty cells, no merge needed
  if (!mightNeedAnalysis(stringMatrix)) {
    return mergeInfo;
  }

  // Analyze table structure
  const analysis = analyzeTableStructure(stringMatrix);
  
  // If table shouldn't be merged, return default (no merge)
  if (!analysis.shouldMerge) {
    return mergeInfo;
  }

  // Get tree columns and group header rows
  const treeColumns = new Set(analysis.tree.columns);
  const groupHeaderRows = new Set(analysis.groupHeaders.rows);

  // Process each tree column independently
  for (const col of treeColumns) {
    if (col >= colCount) continue;
    
    // Track the current "anchor" cell that empty cells merge into
    let anchorRow = -1;

    for (let row = 0; row < rowCount; row++) {
      // Group header row: reset anchor, don't merge
      if (groupHeaderRows.has(row)) {
        anchorRow = -1;
        continue;
      }
      
      const cell = rows[row]?.[col];
      
      if (!cell || isCellEmpty(cell)) {
        // Empty cell: merge into anchor (if anchor exists)
        if (anchorRow >= 0 && row > anchorRow) {
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
 * Calculate merge information with analysis result returned.
 * Useful when caller needs to know the table structure.
 * 
 * @param rows - 2D array of cell contents (data rows only, excluding header)
 * @returns Merge information and analysis result
 */
export function calculateMergeInfoWithAnalysis(rows: CellContent[][]): {
  mergeInfo: CellMergeInfo[][];
  analysis: TableAnalysisResult | null;
} {
  if (rows.length === 0) {
    return { mergeInfo: [], analysis: null };
  }

  const rowCount = rows.length;
  const colCount = rows[0]?.length || 0;

  // Initialize merge info with defaults
  const mergeInfo: CellMergeInfo[][] = rows.map(row =>
    row.map(() => ({ rowspan: 1, colspan: 1, shouldRender: true }))
  );

  // Convert to string matrix for analysis
  const stringMatrix = rows.map(row => row.map(cell => cell.text || ''));
  
  // Quick check: if no empty cells, no merge needed
  if (!mightNeedAnalysis(stringMatrix)) {
    return { mergeInfo, analysis: null };
  }

  // Analyze table structure
  const analysis = analyzeTableStructure(stringMatrix);
  
  // If table shouldn't be merged, return default (no merge)
  if (!analysis.shouldMerge) {
    return { mergeInfo, analysis };
  }

  // Get tree columns and group header rows
  const treeColumns = new Set(analysis.tree.columns);
  const groupHeaderRows = new Set(analysis.groupHeaders.rows);

  // Process group header rows for horizontal merge (colspan)
  for (const row of groupHeaderRows) {
    if (row >= rowCount) continue;
    
    // Find the first non-empty cell and merge all trailing empty cells
    let anchorCol = -1;
    for (let col = 0; col < colCount; col++) {
      const cell = rows[row]?.[col];
      const isEmpty = !cell || isCellEmpty(cell);
      
      if (!isEmpty) {
        // If we had a previous anchor, finish its colspan
        if (anchorCol >= 0 && col > anchorCol + 1) {
          mergeInfo[row][anchorCol].colspan = col - anchorCol;
        }
        anchorCol = col;
      } else if (anchorCol >= 0) {
        // Empty cell after anchor: mark as not rendered (merged left)
        mergeInfo[row][col].shouldRender = false;
      }
    }
    // Handle trailing empty cells
    if (anchorCol >= 0 && anchorCol < colCount - 1) {
      // Check if all remaining cells are empty
      let allEmpty = true;
      for (let col = anchorCol + 1; col < colCount; col++) {
        const cell = rows[row]?.[col];
        if (cell && !isCellEmpty(cell)) {
          allEmpty = false;
          break;
        }
      }
      if (allEmpty) {
        mergeInfo[row][anchorCol].colspan = colCount - anchorCol;
      }
    }
  }

  // Process each tree column independently for vertical merge (rowspan)
  for (const col of treeColumns) {
    if (col >= colCount) continue;
    
    let anchorRow = -1;

    for (let row = 0; row < rowCount; row++) {
      if (groupHeaderRows.has(row)) {
        anchorRow = -1;
        continue;
      }
      
      const cell = rows[row]?.[col];
      
      if (!cell || isCellEmpty(cell)) {
        if (anchorRow >= 0 && row > anchorRow) {
          mergeInfo[row][col].shouldRender = false;
          mergeInfo[anchorRow][col].rowspan = row - anchorRow + 1;
        }
      } else {
        anchorRow = row;
      }
    }
  }

  return { mergeInfo, analysis };
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
 * Calculate merge information from strings with analysis result.
 * 
 * @param rows - 2D array of string contents
 * @returns Merge information and analysis result
 */
export function calculateMergeInfoFromStringsWithAnalysis(rows: string[][]): {
  mergeInfo: CellMergeInfo[][];
  analysis: TableAnalysisResult | null;
} {
  const cellRows: CellContent[][] = rows.map(row =>
    row.map(text => ({ text }))
  );
  return calculateMergeInfoWithAnalysis(cellRows);
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
