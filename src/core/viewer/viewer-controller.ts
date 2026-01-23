/**
 * ViewerController - Shared, platform-agnostic markdown rendering orchestration.
 * 
 * This version uses MarkdownDocument for block-ID based virtual DOM,
 * providing precise incremental updates without morphdom.
 */

import {
  AsyncTaskManager,
  extractHeadings,
  extractTitle,
  createMarkdownProcessor,
  processTablesForWordCompatibility,
  sanitizeRenderedHtml,
  isFrontmatterBlock,
  parseFrontmatter,
  renderFrontmatterAsTable,
  renderFrontmatterAsRaw,
  type HeadingInfo,
} from '../markdown-processor';

import {
  MarkdownDocument,
  executeDOMCommands,
  type DOMCommand,
  type BlockMeta,
} from '../markdown-document';

import type { PluginRenderer, TranslateFunction } from '../../types/index';
import type { Processor } from 'unified';

// Re-export HeadingInfo for backward compatibility
export type { HeadingInfo };

export type ViewerRenderResult = {
  title: string | null;
  headings: HeadingInfo[];
  taskManager: AsyncTaskManager;
};

/**
 * Frontmatter display mode
 */
export type FrontmatterDisplay = 'hide' | 'table' | 'raw';

export type RenderMarkdownOptions = {
  markdown: string;
  container: HTMLElement;
  renderer: PluginRenderer;
  translate: TranslateFunction;

  /**
   * Optional external task manager, useful for cancellation.
   * If not provided, a new AsyncTaskManager will be created.
   */
  taskManager?: AsyncTaskManager;

  /**
   * When true, container.innerHTML will be cleared before rendering.
   * Keep false if the caller wants to clear before applying theme to avoid flicker.
   */
  clearContainer?: boolean;

  /**
   * When true, use incremental DOM diffing instead of full re-render.
   * This preserves already-rendered plugin content when possible.
   * @deprecated Now always uses block-ID based incremental update
   */
  incrementalUpdate?: boolean;

  /** Called when headings are extracted (may be called multiple times during streaming) */
  onHeadings?: (headings: HeadingInfo[]) => void;
  
  /** Called when initial DOM streaming is complete (before async tasks) */
  onStreamingComplete?: () => void;

  /** Frontmatter display mode: 'hide', 'table', or 'raw' */
  frontmatterDisplay?: FrontmatterDisplay;
  
  /** Enable auto-merge of empty table cells */
  tableMergeEmpty?: boolean;
};

// Global document instance for incremental updates
let documentInstance: MarkdownDocument | null = null;

/**
 * Get or create the markdown document instance
 */
export function getDocument(): MarkdownDocument {
  if (!documentInstance) {
    documentInstance = new MarkdownDocument();
  }
  return documentInstance;
}

/**
 * Reset the document instance (call when switching files)
 */
export function resetDocument(): void {
  documentInstance = null;
}

/**
 * Clear HTML cache (for backward compatibility)
 * @deprecated Use resetDocument() instead
 */
export function clearHtmlCache(): void {
  resetDocument();
}

/**
 * Sync block HTML from DOM after async rendering completes.
 * Called when a placeholder is replaced with rendered content.
 * This ensures the in-memory cache matches the actual DOM state.
 * 
 * @param placeholderId - The ID of the placeholder element that was replaced
 */
export function syncBlockHtmlFromDOM(placeholderId: string): void {
  if (!documentInstance) return;
  
  // Find the rendered element (placeholder has been replaced, so we search by traversing)
  // The element might be inside a block container with data-block-id
  const allBlocks = document.querySelectorAll<HTMLElement>('[data-block-id]');
  
  for (const blockEl of Array.from(allBlocks)) {
    const blockId = blockEl.getAttribute('data-block-id');
    if (!blockId) continue;
    
    // Check if this block contains any element that was the placeholder
    // After replacement, we can check for data-plugin-rendered="true" 
    // or simply update based on the block having async content
    const hasRenderedContent = blockEl.querySelector('[data-plugin-rendered="true"]');
    
    if (hasRenderedContent) {
      // Update the in-memory HTML cache with current DOM state
      documentInstance.setBlockHtmlById(blockId, blockEl.innerHTML);
    }
  }
}

/**
 * Main render function using MarkdownDocument architecture
 */
export async function renderMarkdownDocument(options: RenderMarkdownOptions): Promise<ViewerRenderResult> {
  const {
    markdown,
    container,
    renderer,
    translate,
    taskManager: providedTaskManager,
    clearContainer = true,
    onHeadings,
    onStreamingComplete,
    frontmatterDisplay = 'hide',
    tableMergeEmpty = false,
  } = options;

  const taskManager = providedTaskManager ?? new AsyncTaskManager(translate);

  // Check if this is a fresh render
  const isFirstRender = container.childNodes.length === 0 || clearContainer;
  
  if (isFirstRender && clearContainer) {
    // Reset document for fresh render
    resetDocument();
    container.innerHTML = '';
  }
  
  // Get or create document
  const doc = getDocument();
  
  // Update document and get DOM commands
  const updateResult = doc.update(markdown);
  
  // Create processor for rendering
  const processor = createMarkdownProcessor(renderer, taskManager, translate, { tableMergeEmpty });
  
  if (isFirstRender) {
    // First render: render all blocks with streaming
    await renderAllBlocksStreaming(doc, processor, container, taskManager, frontmatterDisplay, onHeadings);
  } else {
    // Incremental update: apply DOM commands
    await applyIncrementalUpdate(doc, processor, container, updateResult.commands, taskManager, frontmatterDisplay);
  }

  // Notify streaming complete
  onStreamingComplete?.();

  // Update headings (final)
  const headings = extractHeadings(container);
  onHeadings?.(headings);

  if (taskManager.isAborted()) {
    return {
      title: extractTitle(markdown),
      headings,
      taskManager,
    };
  }

  // Async tasks (diagrams, etc.) are NOT processed here.
  // Caller should call taskManager.processAll() after this function returns.
  // This allows the caller to set scroll position before async tasks modify DOM.

  return {
    title: extractTitle(markdown),
    headings,
    taskManager,
  };
}

/**
 * Configuration for chunked streaming
 */
const INITIAL_CHUNK_SIZE = 50; // Lines for first chunk
const CHUNK_GROWTH_FACTOR = 2; // Double chunk size each time

/**
 * Render all blocks for initial render with streaming (chunked)
 */
async function renderAllBlocksStreaming(
  doc: MarkdownDocument,
  processor: Processor,
  container: HTMLElement,
  taskManager: AsyncTaskManager,
  frontmatterDisplay: FrontmatterDisplay,
  onHeadings?: (headings: HeadingInfo[]) => void
): Promise<void> {
  const blocks = doc.getBlocks();
  
  let currentLineCount = 0;
  let targetChunkSize = INITIAL_CHUNK_SIZE;
  let chunkStartIndex = 0;
  
  for (let i = 0; i < blocks.length; i++) {
    if (taskManager.isAborted()) return;
    
    const block = blocks[i];
    
    // Handle frontmatter block specially
    if (isFrontmatterBlock(block.content, block.startLine)) {
      let html = '';
      if (frontmatterDisplay === 'table') {
        const data = parseFrontmatter(block.content);
        html = renderFrontmatterAsTable(data);
      } else if (frontmatterDisplay === 'raw') {
        html = renderFrontmatterAsRaw(block.content);
      }
      // For 'hide' mode, skip this block entirely
      if (!html) {
        continue;
      }
      doc.setBlockHtml(i, html);
      
      // Create and append DOM element
      const div = document.createElement('div');
      div.className = 'md-block';
      div.innerHTML = html;
      setBlockAttributes(div, block);
      container.appendChild(div);
      
      currentLineCount += block.lineCount;
      continue;
    }
    
    // Render block content
    const html = await renderBlockContent(block.content, processor);
    doc.setBlockHtml(i, html);
    
    // Create and append DOM element
    const div = document.createElement('div');
    div.className = 'md-block';
    div.innerHTML = html;
    setBlockAttributes(div, block);
    container.appendChild(div);
    
    currentLineCount += block.lineCount;
    
    // Check if chunk complete
    if (currentLineCount >= targetChunkSize || i === blocks.length - 1) {
      // Yield to allow UI update
      await yieldToMain();
      
      // Update headings progressively
      if (onHeadings) {
        const headings = extractHeadings(container);
        onHeadings(headings);
      }
      
      // Prepare next chunk
      currentLineCount = 0;
      targetChunkSize *= CHUNK_GROWTH_FACTOR;
      chunkStartIndex = i + 1;
    }
  }
}

/**
 * Apply incremental update using DOM commands
 */
async function applyIncrementalUpdate(
  doc: MarkdownDocument,
  processor: Processor,
  container: HTMLElement,
  commands: DOMCommand[],
  taskManager: AsyncTaskManager,
  frontmatterDisplay: FrontmatterDisplay
): Promise<void> {
  // First, render HTML for all blocks that need it
  for (const cmd of commands) {
    if (taskManager.isAborted()) return;
    
    if (cmd.type === 'append' || cmd.type === 'insertBefore') {
      const block = doc.getBlockById(cmd.blockId);
      if (block && !block.html) {
        // Handle frontmatter block specially
        if (isFrontmatterBlock(block.content, block.startLine)) {
          let html = '';
          if (frontmatterDisplay === 'table') {
            const data = parseFrontmatter(block.content);
            html = renderFrontmatterAsTable(data);
          } else if (frontmatterDisplay === 'raw') {
            html = renderFrontmatterAsRaw(block.content);
          }
          // For 'hide' mode, skip this block
          if (!html) {
            cmd.type = 'remove' as any; // Convert to remove command to skip
            continue;
          }
          doc.setBlockHtmlById(cmd.blockId, html);
          cmd.html = html;
        } else {
          const html = await renderBlockContent(block.content, processor);
          doc.setBlockHtmlById(cmd.blockId, html);
          cmd.html = html;
        }
      } else if (block?.html) {
        cmd.html = block.html;
      }
    } else if (cmd.type === 'replace') {
      const block = doc.getBlockById(cmd.blockId);
      if (block) {
        // Handle frontmatter block specially
        if (isFrontmatterBlock(block.content, block.startLine)) {
          let html = '';
          if (frontmatterDisplay === 'table') {
            const data = parseFrontmatter(block.content);
            html = renderFrontmatterAsTable(data);
          } else if (frontmatterDisplay === 'raw') {
            html = renderFrontmatterAsRaw(block.content);
          }
          doc.setBlockHtmlById(cmd.blockId, html);
          cmd.html = html;
        } else {
          const html = await renderBlockContent(block.content, processor);
          doc.setBlockHtmlById(cmd.blockId, html);
          cmd.html = html;
        }
      }
    }
  }
  
  // Execute DOM commands
  executeDOMCommands(container, commands, document);
}

/**
 * Render a single block's content to HTML
 */
async function renderBlockContent(content: string, processor: Processor): Promise<string> {
  const file = await processor.process(content);
  let html = String(file);
  html = processTablesForWordCompatibility(html);
  html = sanitizeRenderedHtml(html);
  return html;
}

/**
 * Set block attributes on a DOM element
 */
function setBlockAttributes(el: HTMLElement, block: BlockMeta): void {
  el.setAttribute('data-block-id', block.id);
  el.setAttribute('data-block-hash', block.hash);
  el.setAttribute('data-line', String(block.startLine));
  if (block.lineCount > 0) {
    el.setAttribute('data-line-count', String(block.lineCount));
  }
  // Add code-line class for scroll sync compatibility
  el.classList.add('code-line');
}

/**
 * Yield to main thread to keep UI responsive
 */
function yieldToMain(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Find block element by ID
 */
export function findBlockElement(container: HTMLElement, blockId: string): HTMLElement | null {
  return container.querySelector(`[data-block-id="${blockId}"]`);
}

/**
 * Get all block elements in order
 */
export function getBlockElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.md-block'));
}

/**
 * Check if incremental update is possible (for backward compatibility)
 * @deprecated Always returns true now since we use block-ID based updates
 */
export function canIncrementalUpdate(container: HTMLElement): boolean {
  return container.childNodes.length > 0;
}
