/**
 * Markdown Document - In-memory document structure for incremental updates
 * 
 * This module provides a pure data structure for managing markdown documents
 * without any DOM dependencies. It handles:
 * - Block-level parsing and tracking with stable IDs
 * - Content hashing for change detection
 * - Incremental diff computation
 * - Virtual DOM with precise DOM operation commands
 * - Line number mapping for scroll sync
 */

import {
  splitMarkdownIntoBlocksWithLines,
  type BlockWithLine,
} from './markdown-block-splitter';
import { hashCode } from '../utils/hash';

/**
 * Block metadata stored in memory
 */
export interface BlockMeta {
  /** Unique block ID (stable across updates for same content position) */
  id: string;
  /** Block hash (content-based) */
  hash: string;
  /** Source line number (0-based) */
  startLine: number;
  /** Number of source lines */
  lineCount: number;
  /** Raw markdown content */
  content: string;
  /** Rendered HTML (if available) */
  html?: string;
  /** Whether this block contains async placeholder */
  hasPlaceholder?: boolean;
}

/**
 * Block attributes for DOM elements
 */
export interface BlockAttrs {
  'data-block-id': string;
  'data-block-hash': string;
  'data-line': number;
  'data-line-count': number;
}

/**
 * DOM operation command - platform-agnostic instructions for updating the DOM
 */
export type DOMCommand =
  | { type: 'clear' }
  | { type: 'append'; blockId: string; html: string; attrs: BlockAttrs }
  | { type: 'insertBefore'; blockId: string; html: string; refId: string; attrs: BlockAttrs }
  | { type: 'remove'; blockId: string }
  | { type: 'replace'; blockId: string; html: string; attrs: BlockAttrs }
  | { type: 'updateAttrs'; blockId: string; attrs: Partial<BlockAttrs> };

/**
 * Result of computing DOM commands
 */
export interface DOMCommandResult {
  commands: DOMCommand[];
  stats: {
    kept: number;
    inserted: number;
    removed: number;
    replaced: number;
  };
}

/**
 * Diff operation type (internal)
 */
type DiffOp = 
  | { type: 'keep'; newIndex: number; oldIndex: number }
  | { type: 'insert'; newIndex: number }
  | { type: 'delete'; oldIndex: number };

/**
 * Normalize math blocks in markdown text
 * Converts single-line $$...$$ to multi-line format for proper display math rendering
 */
export function normalizeMathBlocks(markdown: string): string {
  const singleLineMathRegex = /^(\s*)(?<!\$\$)\$\$(.+?)\$\$(?!\$\$)\s*$/gm;
  return markdown.replace(singleLineMathRegex, (_match, _indent, formula) => {
    return `\n$$\n${formula.trim()}\n$$\n`;
  });
}

/**
 * In-memory markdown document with virtual DOM support
 */
export class MarkdownDocument {
  private blocks: BlockMeta[] = [];
  private blockIdMap: Map<string, number> = new Map(); // blockId -> index for O(1) lookup
  private rawContent: string = '';
  private idCounter: number = 0;
  
  /**
   * Create a new document (optionally with initial content)
   */
  constructor(markdown?: string) {
    if (markdown) {
      this.update(markdown);
    }
  }

  /**
   * Rebuild the blockId -> index map
   */
  private rebuildBlockIdMap(): void {
    this.blockIdMap.clear();
    for (let i = 0; i < this.blocks.length; i++) {
      this.blockIdMap.set(this.blocks[i].id, i);
    }
  }

  /**
   * Get all blocks
   */
  getBlocks(): readonly BlockMeta[] {
    return this.blocks;
  }

  /**
   * Get block by index
   */
  getBlock(index: number): BlockMeta | undefined {
    return this.blocks[index];
  }

  /**
   * Get block by ID (O(1) lookup)
   */
  getBlockById(id: string): BlockMeta | undefined {
    const index = this.blockIdMap.get(id);
    return index !== undefined ? this.blocks[index] : undefined;
  }

  /**
   * Get block index by ID (O(1) lookup)
   */
  getBlockIndexById(id: string): number {
    return this.blockIdMap.get(id) ?? -1;
  }

  /**
   * Get block count
   */
  get blockCount(): number {
    return this.blocks.length;
  }

  /**
   * Get raw markdown content
   */
  getRawContent(): string {
    return this.rawContent;
  }







  /**
   * Find block by line number
   */
  findBlockByLine(line: number): { block: BlockMeta; index: number } | null {
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (line >= block.startLine && line < block.startLine + block.lineCount) {
        return { block, index: i };
      }
    }
    return null;
  }

  /**
   * Get total line count of the document
   */
  getTotalLineCount(): number {
    if (this.blocks.length === 0) return 0;
    const lastBlock = this.blocks[this.blocks.length - 1];
    return lastBlock.startLine + lastBlock.lineCount;
  }

  /**
   * Get line position info for scroll sync.
   * Returns the block containing the line and progress within that block.
   * 
   * @param line - Source line number (can be fractional for sub-line precision)
   * @returns Object with block info and progress (0-1) within block, or null if out of range
   */
  getLinePosition(line: number): { 
    block: BlockMeta; 
    index: number; 
    progress: number;
  } | null {
    if (this.blocks.length === 0 || line < 0) {
      return null;
    }

    // Find the block containing this line
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      const blockEnd = block.startLine + block.lineCount;
      
      if (line < blockEnd) {
        // Calculate progress within block
        const lineOffset = line - block.startLine;
        const progress = block.lineCount > 0 
          ? Math.max(0, Math.min(1, lineOffset / block.lineCount))
          : 0;

        return { block, index: i, progress };
      }
    }

    // Line is beyond last block - not yet rendered, return null
    return null;
  }

  /**
   * Calculate line number from block index and progress within block.
   * Inverse of getLinePosition.
   * 
   * @param index - Block index
   * @param progress - Progress within block (0-1)
   * @returns Line number (with fractional part)
   */
  getLineFromPosition(index: number, progress: number): number {
    if (index < 0 || index >= this.blocks.length) return 0;
    
    const block = this.blocks[index];
    const clampedProgress = Math.max(0, Math.min(1, progress));
    return block.startLine + clampedProgress * block.lineCount;
  }

  /**
   * Find surrounding blocks for a given line (for interpolation).
   * Returns previous and next blocks relative to the line.
   */
  getSurroundingBlocks(line: number): {
    previous?: { block: BlockMeta; index: number };
    next?: { block: BlockMeta; index: number };
  } {
    if (this.blocks.length === 0) return {};

    let previous: { block: BlockMeta; index: number } | undefined;
    
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      
      if (block.startLine > line) {
        return { previous, next: { block, index: i } };
      }
      
      previous = { block, index: i };
    }

    return { previous };
  }

  /**
   * Calculate source line number from block ID and progress within block.
   * Used by scroll sync: DOM provides blockId + pixel progress, we compute line.
   * 
   * @param blockId - Block ID from DOM element's data-block-id
   * @param progress - Progress within block (0-1) based on pixel position
   * @returns Line number (with fractional part), or null if block not found
   */
  getLineFromBlockId(blockId: string, progress: number = 0): number | null {
    const block = this.getBlockById(blockId);
    if (!block) {
      return null;
    }
    
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const resultLine = block.startLine + clampedProgress * block.lineCount;
    
    return resultLine;
  }

  /**
   * Get block position for a source line number.
   * Used by scroll sync: editor provides line, we compute blockId + progress for DOM scroll.
   * 
   * @param line - Source line number (can be fractional)
   * @returns Object with blockId and progress (0-1) within block, or null if out of range
   */
  getBlockPositionFromLine(line: number): { blockId: string; progress: number } | null {
    const pos = this.getLinePosition(line);
    if (!pos) {
      return null;
    }

    return {
      blockId: pos.block.id,
      progress: pos.progress,
    };
  }

  /**
   * Update document content and return DOM commands for incremental update
   * @param markdown - New raw markdown
   * @param options - Optional diff hints
   * @param options.blockHashInput - Text a block is hashed by instead of its
   *   own content. Callers whose block rendering depends on document-level
   *   context pass the block plus that context here, so a change to the context
   *   alone still rebuilds the blocks that were affected (e.g. link reference
   *   definitions resolved across blocks, issue #136). Must be a pure function
   *   of the block content and the incoming context.
   */
  update(
    markdown: string,
    options?: { blockHashInput?: (content: string) => string }
  ): DOMCommandResult {
    const blockHashInput = options?.blockHashInput;
    const oldBlocks = this.blocks;
    const isFirstRender = oldBlocks.length === 0;
    
    // Parse blocks from raw content
    this.rawContent = markdown;
    // Keep line mapping anchored to raw markdown to avoid normalization-induced drift.
    const parsedBlocks = splitMarkdownIntoBlocksWithLines(this.rawContent);
    
    // Build new block metadata
    const newBlocks: BlockMeta[] = parsedBlocks.map((block, index) => {
      // Use actual content line count, not distance to next block
      // This avoids counting trailing empty lines that aren't rendered
      const lineCount = block.content.split('\n').length;
      const blockHash = hashCode(blockHashInput ? blockHashInput(block.content) : block.content);
      
      return {
        id: '', // Will be assigned after diffing
        hash: blockHash,
        startLine: block.startLine,
        lineCount,
        content: block.content,
        html: undefined,
      };
    });

    // First render: simple append all
    if (isFirstRender) {
      for (let i = 0; i < newBlocks.length; i++) {
        newBlocks[i].id = this.generateNewId();
      }
      this.blocks = newBlocks;
      this.rebuildBlockIdMap();
      
      return {
        commands: [{ type: 'clear' }],
        stats: { kept: 0, inserted: newBlocks.length, removed: 0, replaced: 0 },
      };
    }

    // Compute diff operations
    const diffOps = this.computeDiff(oldBlocks, newBlocks);
    
    // Generate DOM commands and assign IDs
    const result = this.generateDOMCommands(oldBlocks, newBlocks, diffOps);
    
    this.blocks = newBlocks;
    this.rebuildBlockIdMap();
    return result;
  }

  /**
   * Generate a new unique block ID
   */
  private generateNewId(): string {
    return `block-${++this.idCounter}`;
  }

  /**
   * Compute diff between old and new block arrays using LCS-based algorithm
   */
  private computeDiff(oldBlocks: BlockMeta[], newBlocks: BlockMeta[]): DiffOp[] {
    // Build hash-to-indices map for old blocks
    const oldHashMap = new Map<string, number[]>();
    oldBlocks.forEach((block, index) => {
      const list = oldHashMap.get(block.hash) || [];
      list.push(index);
      oldHashMap.set(block.hash, list);
    });

    // Track which old blocks are matched
    const usedOldIndices = new Set<number>();
    const matches: { newIndex: number; oldIndex: number }[] = [];

    // Find matching blocks (same hash), prefer position proximity
    for (let newIndex = 0; newIndex < newBlocks.length; newIndex++) {
      const hash = newBlocks[newIndex].hash;
      const candidates = oldHashMap.get(hash);
      
      if (candidates) {
        let bestOldIndex = -1;
        let bestDistance = Infinity;
        
        for (const oldIndex of candidates) {
          if (!usedOldIndices.has(oldIndex)) {
            const distance = Math.abs(oldIndex - newIndex);
            if (distance < bestDistance) {
              bestDistance = distance;
              bestOldIndex = oldIndex;
            }
          }
        }
        
        if (bestOldIndex >= 0) {
          matches.push({ newIndex, oldIndex: bestOldIndex });
          usedOldIndices.add(bestOldIndex);
        }
      }
    }

    // Sort matches by new index for sequential processing
    matches.sort((a, b) => a.newIndex - b.newIndex);

    // Generate diff ops
    const ops: DiffOp[] = [];
    const matchedNewIndices = new Set(matches.map(m => m.newIndex));
    let matchIdx = 0;

    for (let newIndex = 0; newIndex < newBlocks.length; newIndex++) {
      if (matchedNewIndices.has(newIndex)) {
        const match = matches[matchIdx++];
        ops.push({ type: 'keep', newIndex, oldIndex: match.oldIndex });
      } else {
        ops.push({ type: 'insert', newIndex });
      }
    }

    // Add deletions
    for (let oldIndex = 0; oldIndex < oldBlocks.length; oldIndex++) {
      if (!usedOldIndices.has(oldIndex)) {
        ops.push({ type: 'delete', oldIndex });
      }
    }

    return ops;
  }

  /**
   * Generate DOM commands from diff operations
   */
  private generateDOMCommands(
    oldBlocks: BlockMeta[],
    newBlocks: BlockMeta[],
    diffOps: DiffOp[]
  ): DOMCommandResult {
    const commands: DOMCommand[] = [];
    const stats = { kept: 0, inserted: 0, removed: 0, replaced: 0 };

    // Build old ID map
    const oldIdMap = new Map<number, string>();
    oldBlocks.forEach((block, index) => {
      oldIdMap.set(index, block.id);
    });

    // Separate ops by type
    const keepOps = diffOps.filter(op => op.type === 'keep') as { type: 'keep'; newIndex: number; oldIndex: number }[];
    const insertOps = diffOps.filter(op => op.type === 'insert') as { type: 'insert'; newIndex: number }[];
    const deleteOps = diffOps.filter(op => op.type === 'delete') as { type: 'delete'; oldIndex: number }[];

    // Assign IDs to new blocks
    // - Keep blocks: inherit ID from old block
    // - Insert blocks: generate new ID
    for (const op of keepOps) {
      const oldBlock = oldBlocks[op.oldIndex];
      newBlocks[op.newIndex].id = oldBlock.id;
      // Preserve cached HTML and placeholder state
      if (oldBlock.html) {
        newBlocks[op.newIndex].html = oldBlock.html;
        newBlocks[op.newIndex].hasPlaceholder = oldBlock.hasPlaceholder;
      }
      stats.kept++;
    }

    for (const op of insertOps) {
      newBlocks[op.newIndex].id = this.generateNewId();
      stats.inserted++;
    }

    // Generate remove commands (do removes first)
    for (const op of deleteOps) {
      const oldId = oldIdMap.get(op.oldIndex)!;
      commands.push({ type: 'remove', blockId: oldId });
      stats.removed++;
    }

    // Check if kept blocks maintain their relative order
    // If not, we need to treat out-of-order blocks as needing repositioning
    const keepOpsSortedByNew = [...keepOps].sort((a, b) => a.newIndex - b.newIndex);
    const keptOldIndicesInNewOrder = keepOpsSortedByNew.map(op => op.oldIndex);
    
    // Find which kept blocks are out of order (need to be moved)
    // A block needs moving if its oldIndex breaks the increasing sequence
    const needsMove = new Set<number>(); // newIndex of blocks that need moving
    let maxOldIndexSeen = -1;
    for (const op of keepOpsSortedByNew) {
      if (op.oldIndex < maxOldIndexSeen) {
        // This block was originally after a block that now comes before it
        // It needs to be moved
        needsMove.add(op.newIndex);
      } else {
        maxOldIndexSeen = op.oldIndex;
      }
    }

    // Build the final ordered list and generate insert commands
    // Process new blocks in order to generate correct insertBefore references
    for (let i = 0; i < newBlocks.length; i++) {
      const block = newBlocks[i];
      const attrs = this.getBlockAttrs(block);
      
      // Check if this is a kept block
      const keepOp = keepOps.find(op => op.newIndex === i);
      
      if (keepOp && !needsMove.has(i)) {
        // Block is kept and in correct relative order - just update attrs if needed
        const oldBlock = oldBlocks[keepOp.oldIndex];
        if (oldBlock.startLine !== block.startLine || oldBlock.lineCount !== block.lineCount) {
          commands.push({
            type: 'updateAttrs',
            blockId: block.id,
            attrs: {
              'data-line': block.startLine,
              'data-line-count': block.lineCount,
            },
          });
        }
      } else {
        // New block OR kept block that needs repositioning
        // Find the next sibling that exists in DOM and doesn't need moving
        let refId: string | null = null;
        for (let j = i + 1; j < newBlocks.length; j++) {
          const futureKeepOp = keepOps.find(op => op.newIndex === j);
          if (futureKeepOp && !needsMove.has(j)) {
            refId = newBlocks[j].id;
            break;
          }
        }
        
        if (keepOp && needsMove.has(i)) {
          // This is a kept block that needs to be moved
          // Remove it first, then insert at correct position
          commands.push({ type: 'remove', blockId: block.id });
          stats.removed++;
          stats.kept--; // Adjust stats since we're re-inserting
          stats.inserted++;
        }
        
        if (refId) {
          commands.push({
            type: 'insertBefore',
            blockId: block.id,
            html: keepOp ? (oldBlocks[keepOp.oldIndex].html || '') : '', // Preserve HTML for moved blocks
            refId,
            attrs,
          });
        } else {
          commands.push({
            type: 'append',
            blockId: block.id,
            html: keepOp ? (oldBlocks[keepOp.oldIndex].html || '') : '', // Preserve HTML for moved blocks
            attrs,
          });
        }
      }
    }

    return { commands, stats };
  }

  /**
   * Get block attributes for DOM element
   */
  private getBlockAttrs(block: BlockMeta): BlockAttrs {
    return {
      'data-block-id': block.id,
      'data-block-hash': block.hash,
      'data-line': block.startLine,
      'data-line-count': block.lineCount,
    };
  }

  /**
   * Set rendered HTML for a block by index
   */
  setBlockHtml(index: number, html: string): void {
    if (index >= 0 && index < this.blocks.length) {
      this.blocks[index].html = html;
      this.blocks[index].hasPlaceholder = html.includes('async-placeholder');
    }
  }

  /**
   * Set rendered HTML for a block by ID
   */
  setBlockHtmlById(id: string, html: string): void {
    const block = this.blocks.find(b => b.id === id);
    if (block) {
      block.html = html;
      block.hasPlaceholder = html.includes('async-placeholder');
    }
  }

  /**
   * Get blocks that need rendering (no cached HTML or has placeholder)
   */
  getBlocksNeedingRender(): { block: BlockMeta; index: number }[] {
    return this.blocks
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => !block.html || block.hasPlaceholder);
  }

  /**
   * Get all block IDs in order
   */
  getBlockIds(): string[] {
    return this.blocks.map(b => b.id);
  }

  /**
   * Clear all cached HTML
   */
  clearHtmlCache(): void {
    for (const block of this.blocks) {
      block.html = undefined;
      block.hasPlaceholder = undefined;
    }
  }

  /**
   * Get full HTML content (all blocks concatenated)
   */
  getFullHtml(): string {
    return this.blocks
      .map(block => {
        if (!block.html) return '';
        return this.wrapBlockHtml(block);
      })
      .join('\n');
  }

  /**
   * Wrap block HTML with container div and attributes
   */
  wrapBlockHtml(block: BlockMeta): string {
    const attrs = this.getBlockAttrs(block);
    const attrStr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    return `<div class="md-block" ${attrStr}>${block.html}</div>`;
  }

  /**
   * Export document state for serialization
   */
  toJSON(): { blocks: Omit<BlockMeta, 'html' | 'hasPlaceholder'>[]; rawContent: string; idCounter: number } {
    return {
      blocks: this.blocks.map(b => ({
        id: b.id,
        hash: b.hash,
        startLine: b.startLine,
        lineCount: b.lineCount,
        content: b.content,
      })),
      rawContent: this.rawContent,
      idCounter: this.idCounter,
    };
  }

  /**
   * Create document from serialized state
   */
  static fromJSON(data: { blocks: Omit<BlockMeta, 'html' | 'hasPlaceholder'>[]; rawContent: string; idCounter: number }): MarkdownDocument {
    const doc = new MarkdownDocument();
    doc.rawContent = data.rawContent;
    doc.blocks = data.blocks.map(b => ({ ...b, html: undefined }));
    doc.idCounter = data.idCounter;
    return doc;
  }
}

/**
 * Extract title from markdown content
 */
export function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Heading info for TOC
 */
export interface HeadingInfo {
  level: number;
  text: string;
  id: string;
  line: number;
}

/**
 * Extract headings from parsed blocks (without DOM)
 */
export function extractHeadingsFromBlocks(blocks: readonly BlockMeta[]): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const seenIds = new Set<string>();
  
  for (const block of blocks) {
    const match = block.content.match(/^(#{1,6})\s+(.+)$/m);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      
      // Generate slug ID
      let baseId = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
      
      // Handle duplicates
      let id = baseId || 'heading';
      let counter = 1;
      while (seenIds.has(id)) {
        id = `${baseId}-${counter++}`;
      }
      seenIds.add(id);
      
      headings.push({ level, text, id, line: block.startLine });
    }
  }
  
  return headings;
}

/**
 * Execute DOM commands on a container element
 * This is the only function that touches the real DOM
 */
export function executeDOMCommands(
  container: HTMLElement,
  commands: DOMCommand[],
  document: Document
): void {
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'clear':
        container.innerHTML = '';
        break;
        
      case 'append': {
        const div = document.createElement('div');
        div.className = 'md-block';
        div.innerHTML = cmd.html;
        setBlockAttrs(div, cmd.attrs);
        container.appendChild(div);
        break;
      }
      
      case 'insertBefore': {
        const refEl = container.querySelector(`[data-block-id="${cmd.refId}"]`);
        if (refEl) {
          const div = document.createElement('div');
          div.className = 'md-block';
          div.innerHTML = cmd.html;
          setBlockAttrs(div, cmd.attrs);
          refEl.parentNode?.insertBefore(div, refEl);
        }
        break;
      }
      
      case 'remove': {
        const el = container.querySelector(`[data-block-id="${cmd.blockId}"]`);
        el?.remove();
        break;
      }
      
      case 'replace': {
        const el = container.querySelector(`[data-block-id="${cmd.blockId}"]`);
        if (el) {
          el.innerHTML = cmd.html;
          setBlockAttrs(el as HTMLElement, cmd.attrs);
        }
        break;
      }
      
      case 'updateAttrs': {
        const el = container.querySelector(`[data-block-id="${cmd.blockId}"]`);
        if (el) {
          setBlockAttrs(el as HTMLElement, cmd.attrs as BlockAttrs);
        }
        break;
      }
    }
  }
}

/**
 * Set block attributes on an element
 */
function setBlockAttrs(el: HTMLElement, attrs: Partial<BlockAttrs>): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) {
      el.setAttribute(key, String(value));
    }
  }
}
