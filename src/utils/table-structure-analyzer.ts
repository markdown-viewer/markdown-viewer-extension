/**
 * Table Structure Analyzer
 * 
 * Analyzes table structure to determine:
 * 1. Whether it's a tree-structured table (hierarchical data)
 * 2. Which rows are group headers (section separators)
 * 3. Which columns participate in the tree hierarchy
 * 4. Overall table type classification
 * 
 * This information is used to decide whether and how to merge empty cells.
 */

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Table structure type classification
 */
export type TableType = 
  | 'tree'        // Hierarchical/tree structure - should merge
  | 'grouped'     // Has group headers but not strictly tree - partial merge
  | 'sparse'      // Random empty cells - should NOT merge
  | 'comparison'  // Feature comparison table - should NOT merge
  | 'normal';     // Regular table, no special structure

/**
 * Comprehensive table structure analysis result
 */
export interface TableAnalysisResult {
  /** Classified table type */
  tableType: TableType;
  
  /** Whether the table should have cells merged */
  shouldMerge: boolean;
  
  /** Tree structure specific results (if applicable) */
  tree: {
    /** Whether the table is a valid tree structure */
    isTree: boolean;
    /** Number of columns that participate in tree hierarchy */
    columnCount: number;
    /** Indices of tree columns (from left) */
    columns: number[];
    /** Tree structure confidence score (0-1) */
    score: number;
  };
  
  /** Group header detection results */
  groupHeaders: {
    /** Indices of rows that are group headers */
    rows: number[];
    /** Whether the table uses group header pattern */
    hasGroupHeaders: boolean;
  };
  
  /** Basic statistics */
  stats: {
    totalRows: number;
    totalCols: number;
    emptyCount: number;
    emptyRatio: number;
  };
}

/**
 * Internal row analysis result
 */
interface RowAnalysis {
  rowIndex: number;
  nonEmptyCount: number;
  lastNonEmptyCol: number;
  emptyPrefix: number;
  isGroupHeader: boolean;
  isValidTreeRow: boolean;
  isCompletelyEmpty: boolean;
  hasGap: boolean;  // non-empty → empty → non-empty pattern in leftmost columns
  gapStartCol: number;  // Column where gap starts (-1 if no gap)
}

/**
 * Internal column analysis result
 */
interface ColumnAnalysis {
  colIndex: number;
  segmentCount: number;
  maxSegmentLength: number;
  hasMultiRowSegment: boolean;
  isTreeColumn: boolean;
}

/**
 * Merge segment: anchor + consecutive empty cells
 */
interface MergeSegment {
  anchorRow: number;
  length: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a cell value is empty
 */
function isEmpty(value: string | null | undefined): boolean {
  if (value == null) return true;
  return value.trim() === '';
}

/**
 * Check if a value is a marker symbol (used in comparison tables)
 * Common markers: ✓, ✗, ×, ○, ●, √, -, etc.
 */
function isMarkerSymbol(value: string | null | undefined): boolean {
  if (value == null) return false;
  const trimmed = value.trim();
  return /^[✓✗×○●√\-+*·•◦▪▫☐☑☒✔✕✖⬤◯]{1,3}$/.test(trimmed);
}

// ============================================================================
// Row Analysis
// ============================================================================

/**
 * Analyze a single row for structure patterns
 */
function analyzeRow(row: string[], rowIndex: number, totalCols: number): RowAnalysis {
  let emptyPrefix = 0;
  let nonEmptyCount = 0;
  let lastNonEmptyCol = -1;
  
  let seenNonEmpty = false;
  let seenEmptyAfterNonEmpty = false;
  let hasGap = false;
  let gapStartCol = -1;
  
  for (let col = 0; col < totalCols; col++) {
    const cellEmpty = isEmpty(row[col]);
    
    if (cellEmpty) {
      if (!seenNonEmpty) {
        emptyPrefix++;
      } else {
        seenEmptyAfterNonEmpty = true;
        if (gapStartCol === -1) {
          gapStartCol = col;
        }
      }
    } else {
      nonEmptyCount++;
      lastNonEmptyCol = col;
      if (seenEmptyAfterNonEmpty) {
        hasGap = true;
      }
      seenNonEmpty = true;
    }
  }
  
  const isCompletelyEmpty = nonEmptyCount === 0;
  const trailingEmpty = lastNonEmptyCol >= 0 ? totalCols - 1 - lastNonEmptyCol : totalCols;
  
  // Group header detection:
  // - Has 1-2 non-empty cells at the start
  // - Rest of the row is empty
  // - Trailing empty cells >= half of total columns
  const isGroupHeader = 
    nonEmptyCount > 0 &&
    nonEmptyCount <= 2 && 
    lastNonEmptyCol < Math.min(2, Math.ceil(totalCols / 2)) &&
    trailingEmpty >= Math.floor(totalCols / 2);
  
  // Valid tree row: no gap pattern and not completely empty
  // But if gap only occurs in right portion (after column 2), still consider valid for tree
  const isValidTreeRow = !isCompletelyEmpty && (!hasGap || gapStartCol >= Math.min(3, Math.ceil(totalCols / 2)));
  
  return {
    rowIndex,
    nonEmptyCount,
    lastNonEmptyCol,
    emptyPrefix,
    isGroupHeader,
    isValidTreeRow,
    isCompletelyEmpty,
    hasGap,
    gapStartCol
  };
}

/**
 * Detect group header rows in the table
 * 
 * Group headers are rows where:
 * 1. Only the first 1-2 columns have content
 * 2. The rest of the columns are empty
 * 3. They serve as section separators/titles
 * 
 * @param rows - 2D array of cell strings
 * @returns Array of row indices that are group headers
 * 
 * @example
 * ```typescript
 * const rows = [
 *   ['电子产品', '',   ''],      // ← Group header (index 0)
 *   ['手机',    '10', '3000'],
 *   ['电脑',    '5',  '5000'],
 *   ['办公用品', '',   ''],      // ← Group header (index 3)
 *   ['打印纸',  '100', '20'],
 * ];
 * const headers = detectGroupHeaders(rows);
 * // headers = [0, 3]
 * ```
 */
export function detectGroupHeaders(rows: string[][]): number[] {
  const totalCols = rows[0]?.length || 0;
  if (totalCols < 2) return [];
  
  const groupHeaders: number[] = [];
  
  for (let i = 0; i < rows.length; i++) {
    const analysis = analyzeRow(rows[i], i, totalCols);
    if (analysis.isGroupHeader) {
      groupHeaders.push(i);
    }
  }
  
  return groupHeaders;
}

/**
 * Check if a specific row is a group header
 * 
 * @param row - Single row of cell strings
 * @param totalCols - Total number of columns in the table
 * @returns true if the row is a group header
 */
export function isGroupHeaderRow(row: string[], totalCols?: number): boolean {
  const cols = totalCols ?? row.length;
  const analysis = analyzeRow(row, 0, cols);
  return analysis.isGroupHeader;
}

// ============================================================================
// Column Analysis
// ============================================================================

/**
 * Extract merge segments from a column
 */
function extractColumnSegments(
  rows: string[][],
  colIndex: number,
  skipRows: Set<number>
): MergeSegment[] {
  const segments: MergeSegment[] = [];
  let currentSegment: MergeSegment | null = null;
  
  for (let row = 0; row < rows.length; row++) {
    if (skipRows.has(row)) {
      if (currentSegment) {
        segments.push(currentSegment);
        currentSegment = null;
      }
      continue;
    }
    
    const value = rows[row]?.[colIndex];
    const cellEmpty = isEmpty(value);
    
    if (!cellEmpty) {
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = { anchorRow: row, length: 1 };
    } else if (currentSegment) {
      currentSegment.length++;
    }
  }
  
  if (currentSegment) {
    segments.push(currentSegment);
  }
  
  return segments;
}

/**
 * Analyze a column for tree structure
 */
function analyzeColumn(
  rows: string[][],
  colIndex: number,
  skipRows: Set<number>
): ColumnAnalysis {
  const segments = extractColumnSegments(rows, colIndex, skipRows);
  const effectiveRows = rows.length - skipRows.size;
  
  if (segments.length === 0 || effectiveRows <= 1) {
    return {
      colIndex,
      segmentCount: 0,
      maxSegmentLength: 0,
      hasMultiRowSegment: false,
      isTreeColumn: false
    };
  }
  
  const segmentCount = segments.length;
  const maxSegmentLength = Math.max(...segments.map(s => s.length));
  const hasMultiRowSegment = segments.some(s => s.length >= 2);
  
  // Tree column criteria (relaxed):
  // 1. Has at least one multi-row segment (most important)
  // 2. Segment count is reasonable (allow up to 90% of effective rows, was 80%)
  // 3. First segment starts early (row 0 or 1)
  // 4. OR: average segment length > 1.2 (shows meaningful grouping)
  const avgSegmentLength = effectiveRows / segmentCount;
  const isTreeColumn = 
    hasMultiRowSegment &&
    (segmentCount <= effectiveRows * 0.9 || avgSegmentLength > 1.2) &&
    segments[0].anchorRow <= 1;
  
  return {
    colIndex,
    segmentCount,
    maxSegmentLength,
    hasMultiRowSegment,
    isTreeColumn
  };
}

// ============================================================================
// Table Type Detection
// ============================================================================

/**
 * Check if table is a comparison/feature table
 */
function isComparisonTable(rows: string[][]): boolean {
  let markerCount = 0;
  let totalCells = 0;
  
  for (const row of rows) {
    for (const cell of row) {
      totalCells++;
      if (isMarkerSymbol(cell)) {
        markerCount++;
      }
    }
  }
  
  return totalCells > 0 && markerCount / totalCells > 0.3;
}

/**
 * Check if table has sparse/random empty pattern
 * A row is considered "sparse" if it has a gap in the left portion (tree columns)
 */
function isSparseTable(rowAnalyses: RowAnalysis[]): boolean {
  // Count rows that are NOT valid tree rows (have gap in left columns)
  const invalidTreeRows = rowAnalyses.filter(r => !r.isValidTreeRow && !r.isGroupHeader && !r.isCompletelyEmpty);
  return invalidTreeRows.length / rowAnalyses.length > 0.3;
}

// ============================================================================
// Main Analysis Functions
// ============================================================================

/**
 * Analyze table structure comprehensively
 * 
 * This is the main entry point for table structure analysis.
 * It determines the table type and whether cells should be merged.
 * 
 * @param rows - 2D array of cell strings (data rows only, excluding header)
 * @returns Complete analysis result
 * 
 * @example
 * ```typescript
 * // Tree structure example
 * const rows = [
 *   ['研发部', '前端组', '张三'],
 *   ['',       '',       '李四'],
 *   ['',       '后端组', '王五'],
 * ];
 * const result = analyzeTableStructure(rows);
 * // result.tableType = 'tree'
 * // result.tree.columnCount = 2
 * // result.shouldMerge = true
 * 
 * // Group header example
 * const rows2 = [
 *   ['水果类', '',     ''],
 *   ['苹果',  '5元',  '红色'],
 *   ['香蕉',  '3元',  '黄色'],
 * ];
 * const result2 = analyzeTableStructure(rows2);
 * // result2.groupHeaders.rows = [0]
 * // result2.groupHeaders.hasGroupHeaders = true
 * ```
 */
export function analyzeTableStructure(rows: string[][]): TableAnalysisResult {
  const totalRows = rows.length;
  const totalCols = rows[0]?.length || 0;
  
  // Calculate empty stats
  let emptyCount = 0;
  for (const row of rows) {
    for (const cell of row) {
      if (isEmpty(cell)) emptyCount++;
    }
  }
  const totalCells = totalRows * totalCols;
  const emptyRatio = totalCells > 0 ? emptyCount / totalCells : 0;
  
  const baseStats = { totalRows, totalCols, emptyCount, emptyRatio };
  
  // Edge cases
  if (totalRows === 0 || totalCols === 0 || totalRows === 1) {
    return createNormalResult(baseStats);
  }
  
  // Check for comparison table first
  if (isComparisonTable(rows)) {
    return createComparisonResult(baseStats);
  }
  
  // Analyze all rows
  const rowAnalyses = rows.map((row, idx) => analyzeRow(row, idx, totalCols));
  
  // Detect group headers
  const groupHeaderRows = rowAnalyses
    .filter(r => r.isGroupHeader)
    .map(r => r.rowIndex);
  const groupHeaderSet = new Set(groupHeaderRows);
  const hasGroupHeaders = groupHeaderRows.length > 0;
  
  // Check for sparse pattern
  if (isSparseTable(rowAnalyses)) {
    return createSparseResult(baseStats, groupHeaderRows);
  }
  
  // Calculate tree score
  const nonHeaderRows = rowAnalyses.filter(r => !groupHeaderSet.has(r.rowIndex));
  const validTreeRows = nonHeaderRows.filter(r => r.isValidTreeRow);
  const treeScore = nonHeaderRows.length > 0
    ? validTreeRows.length / nonHeaderRows.length
    : 0;
  
  // Determine if it's a tree table
  const isTreeTable = treeScore >= 0.8 && nonHeaderRows.length > 0;
  
  // Analyze columns for tree structure
  const treeColumns: number[] = [];
  if (isTreeTable) {
    for (let col = 0; col < totalCols; col++) {
      const colAnalysis = analyzeColumn(rows, col, groupHeaderSet);
      if (colAnalysis.isTreeColumn) {
        treeColumns.push(col);
      }
    }
  }
  
  // Tree columns must be contiguous from the left
  let treeColumnCount = 0;
  for (let i = 0; i < treeColumns.length; i++) {
    if (treeColumns[i] === i) {
      treeColumnCount = i + 1;
    } else {
      break;
    }
  }
  
  const finalTreeColumns = treeColumns.slice(0, treeColumnCount);
  const isValidTree = isTreeTable && treeColumnCount > 0;
  
  // Determine table type
  let tableType: TableType;
  if (isValidTree) {
    tableType = 'tree';
  } else if (hasGroupHeaders) {
    tableType = 'grouped';
  } else {
    tableType = 'normal';
  }
  
  return {
    tableType,
    shouldMerge: isValidTree,
    tree: {
      isTree: isValidTree,
      columnCount: treeColumnCount,
      columns: finalTreeColumns,
      score: treeScore
    },
    groupHeaders: {
      rows: groupHeaderRows,
      hasGroupHeaders
    },
    stats: baseStats
  };
}

/**
 * Quick check if a table might need structure analysis
 * Use this for early filtering before full analysis
 * 
 * @param rows - 2D array of cell strings
 * @returns true if the table might need analysis
 */
export function mightNeedAnalysis(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  
  const totalCols = rows[0]?.length || 0;
  if (totalCols < 2) return false;
  
  // Check if there are any empty cells
  for (const row of rows) {
    for (const cell of row) {
      if (isEmpty(cell)) return true;
    }
  }
  
  return false;
}

// ============================================================================
// Result Constructors
// ============================================================================

function createNormalResult(stats: TableAnalysisResult['stats']): TableAnalysisResult {
  return {
    tableType: 'normal',
    shouldMerge: false,
    tree: { isTree: false, columnCount: 0, columns: [], score: 0 },
    groupHeaders: { rows: [], hasGroupHeaders: false },
    stats
  };
}

function createComparisonResult(stats: TableAnalysisResult['stats']): TableAnalysisResult {
  return {
    tableType: 'comparison',
    shouldMerge: false,
    tree: { isTree: false, columnCount: 0, columns: [], score: 0 },
    groupHeaders: { rows: [], hasGroupHeaders: false },
    stats
  };
}

function createSparseResult(stats: TableAnalysisResult['stats'], groupHeaderRows: number[]): TableAnalysisResult {
  return {
    tableType: 'sparse',
    shouldMerge: false,
    tree: { isTree: false, columnCount: 0, columns: [], score: 0 },
    groupHeaders: { rows: groupHeaderRows, hasGroupHeaders: groupHeaderRows.length > 0 },
    stats
  };
}
