// Markdown Processor - Core processing logic shared between Chrome and Mobile
// This module contains only the markdown processing pipeline without UI interactions

import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkSuperSub from '../plugins/remark-super-sub';
import remarkTocFilter from '../plugins/remark-toc-filter';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import rehypeImageUri from '../plugins/rehype-image-uri';
import { registerRemarkPlugins } from '../plugins/index';
import { createPlaceholderElement } from '../plugins/plugin-content-utils';
import { generateContentHash, hashCode } from '../utils/hash';
import {
  splitMarkdownIntoBlocksWithLines as splitBlocks,
  splitMarkdownIntoBlocks as splitBlocksSimple,
  type BlockWithLine
} from './markdown-block-splitter';
import type {
  TranslateFunction,
  TaskStatus,
  TaskData,
  PluginRenderer,
  AsyncTaskQueueManager,
  AsyncTaskPlugin
} from '../types/index';

// Re-export for backward compatibility
export type { TranslateFunction };

/**
 * Task context for cancellation
 */
interface TaskContext {
  cancelled: boolean;
}

/**
 * Plugin interface for async tasks
 */
type Plugin = AsyncTaskPlugin;

/**
 * Async task interface
 */
interface AsyncTask {
  id: string;
  callback: (data: TaskData) => Promise<void>;
  data: TaskData;
  type: string;
  status: TaskStatus;
  error: Error | null;
  context: TaskContext;
  setReady: () => void;
  setError: (error: Error) => void;
}

/**
 * Normalize math blocks in markdown text
 * Converts single-line $$...$$ to multi-line format for proper display math rendering
 * @param markdown - Raw markdown content
 * @returns Normalized markdown
 */
export function normalizeMathBlocks(markdown: string): string {
  const singleLineMathRegex = /^(\s*)(?<!\$\$)\$\$(.+?)\$\$(?!\$\$)\s*$/gm;
  return markdown.replace(singleLineMathRegex, (match, indent, formula) => {
    return `\n$$\n${formula.trim()}\n$$\n`;
  });
}

// Re-export BlockWithLine for backward compatibility
export type { BlockWithLine };

/**
 * Split markdown into semantic blocks (paragraphs, code blocks, tables, etc.)
 * Each block is a complete markdown element that can be processed independently.
 * @param markdown - Raw markdown content
 * @returns Array of markdown blocks
 */
export function splitMarkdownIntoBlocks(markdown: string): string[] {
  return splitBlocksSimple(markdown);
}

/**
 * Split markdown into semantic blocks with source line numbers.
 * Each block includes its starting line number for scroll sync.
 * @param markdown - Raw markdown content
 * @returns Array of blocks with line info
 */
export function splitMarkdownIntoBlocksWithLines(markdown: string): BlockWithLine[] {
  return splitBlocks(markdown);
}

/**
 * Escape HTML special characters
 * @param text - Text to escape
 * @returns Escaped text
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate URL values and block javascript-style protocols
 * @param url - URL to validate
 * @returns True when URL is considered safe
 */
export function isSafeUrl(url: string | null | undefined): boolean {
  if (!url) return true;

  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#')) return true;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:text/javascript')) {
    return false;
  }

  if (lower.startsWith('data:')) {
    return lower.startsWith('data:image/') || lower.startsWith('data:application/pdf');
  }

  // Allow relative paths (don't start with a protocol)
  if (!trimmed.includes(':') || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/')) {
    return true;
  }

  try {
    const parsed = new URL(trimmed, document.baseURI);
    return ['http:', 'https:', 'mailto:', 'tel:', 'file:'].includes(parsed.protocol);
  } catch (error) {
    // If URL parsing fails, it's likely a relative path - allow it
    return true;
  }
}

/**
 * Validate that every URL candidate in a srcset attribute is safe
 * @param value - Raw srcset value
 * @returns True when every entry is safe
 */
export function isSafeSrcset(value: string | null | undefined): boolean {
  if (!value) return true;
  return value.split(',').every((candidate) => {
    const urlPart = candidate.trim().split(/\s+/)[0];
    return isSafeUrl(urlPart);
  });
}

/**
 * Strip unsafe attributes from an element
 * @param element - Element to sanitize
 */
function sanitizeElementAttributes(element: Element): void {
  if (!element.hasAttributes()) return;

  const urlAttributes = ['src', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'srcset'];

  Array.from(element.attributes).forEach((attr) => {
    const attrName = attr.name.toLowerCase();

    // Remove event handlers
    if (attrName.startsWith('on')) {
      element.removeAttribute(attr.name);
      return;
    }

    // Validate URL attributes
    if (urlAttributes.includes(attrName)) {
      if (attrName === 'srcset') {
        if (!isSafeSrcset(attr.value)) {
          element.removeAttribute(attr.name);
        }
      } else if (attrName === 'href' || attrName === 'xlink:href') {
        if (!isSafeUrl(attr.value)) {
          element.removeAttribute(attr.name);
        }
      } else if (!isSafeUrl(attr.value)) {
        element.removeAttribute(attr.name);
      }
    }
  });
}

/**
 * Walk the node tree and remove dangerous elements/attributes
 * @param root - Root node to sanitize
 */
function sanitizeNodeTree(root: DocumentFragment): void {
  const blockedTags = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO']);
  const stack: Element[] = [];

  Array.from(root.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      stack.push(child as Element);
    } else if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
    }
  });

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const tagName = node.tagName ? node.tagName.toUpperCase() : '';
    if (blockedTags.has(tagName)) {
      const originalMarkup = node.outerHTML || `<${tagName.toLowerCase()}>`;
      const truncatedMarkup = originalMarkup.length > 500 ? `${originalMarkup.slice(0, 500)}...` : originalMarkup;
      const warning = document.createElement('pre');
      warning.className = 'blocked-html-warning';
      warning.setAttribute('style', 'background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px; white-space: pre-wrap;');
      warning.textContent = `Blocked insecure <${tagName.toLowerCase()}> element removed.\n\n${truncatedMarkup}`;
      node.replaceWith(warning);
      continue;
    }

    sanitizeElementAttributes(node);

    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        stack.push(child as Element);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
      }
    });
  }
}

/**
 * Sanitize rendered HTML to remove active content like scripts before injection
 * @param html - Raw HTML string produced by the markdown pipeline
 * @returns Sanitized HTML safe for innerHTML assignment
 */
export function sanitizeRenderedHtml(html: string): string {
  try {
    const template = document.createElement('template');
    template.innerHTML = html;
    sanitizeNodeTree(template.content);
    return template.innerHTML;
  } catch (error) {
    return html;
  }
}

/**
 * Process tables to add centering attributes for Word compatibility
 * @param html - HTML content
 * @returns HTML with centered tables
 */
export function processTablesForWordCompatibility(html: string): string {
  html = html.replace(/<table>/g, '<div align="center"><table align="center">');
  html = html.replace(/<\/table>/g, '</table></div>');
  return html;
}

/**
 * Async task manager for plugin rendering
 */
export interface AsyncTaskManagerOptions {
  /** Callback triggered when abort() is called, for cleanup of downstream resources */
  onAbort?: () => void;
}

export class AsyncTaskManager {
  private queue: AsyncTask[] = [];
  private idCounter = 0;
  private translate: TranslateFunction;
  private aborted = false;
  private context: TaskContext;
  private onAbort?: () => void;

  constructor(translate: TranslateFunction = (key) => key, options?: AsyncTaskManagerOptions) {
    this.translate = translate;
    this.onAbort = options?.onAbort;
    // Create a unique context object for this manager instance
    // Tasks will reference this context to check cancellation
    this.context = { cancelled: false };
  }

  /**
   * Abort all pending tasks
   * Called when starting a new render to cancel previous tasks
   */
  abort(): void {
    this.aborted = true;
    // Mark current context as cancelled so running callbacks can check
    this.context.cancelled = true;
    this.queue = [];
    // Trigger downstream cleanup (e.g., cancel pending renderer requests)
    this.onAbort?.();
  }

  /**
   * Reset abort flag (call before starting new task collection)
   */
  reset(): void {
    this.aborted = false;
    this.queue = [];
    this.idCounter = 0;
    // Create new context for new render cycle
    this.context = { cancelled: false };
  }

  /**
   * Check if manager has been aborted
   */
  isAborted(): boolean {
    return this.aborted;
  }

  /**
   * Get current context for callbacks to reference
   */
  getContext(): TaskContext {
    return this.context;
  }

  /**
   * Generate unique ID for async tasks
   */
  generateId(): string {
    return `async-placeholder-${++this.idCounter}`;
  }

  /**
   * Register async task for later execution
   * @param callback - The async callback function
   * @param data - Data to pass to callback
   * @param plugin - Plugin instance
   * @param initialStatus - Initial task status
   * @returns Task control and placeholder content
   */
  createTask(
    callback: (data: TaskData, context: TaskContext) => Promise<void>,
    data: Record<string, unknown> = {},
    plugin: Plugin | null = null,
    initialStatus: TaskStatus = 'ready'
  ): { task: AsyncTask; placeholder: { type: 'html'; value: string } } {
    const placeholderId = this.generateId();
    const type = plugin?.type || 'unknown';
    // Capture current context reference for this task
    const taskContext = this.context;
    
    // Generate content hash for DOM diff matching
    const content = (data.code as string) || '';
    const sourceHash = generateContentHash(type, content);

    const task: AsyncTask = {
      id: placeholderId,
      callback: async (taskData: TaskData) => callback(taskData, taskContext),
      data: { ...data, id: placeholderId, sourceHash },
      type,
      status: initialStatus,
      error: null,
      context: taskContext, // Bind task to its creation context
      setReady: () => { task.status = 'ready'; },
      setError: (error: Error) => { task.status = 'error'; task.error = error; }
    };

    this.queue.push(task);

    const placeholderHtml = createPlaceholderElement(
      placeholderId,
      type,
      plugin?.isInline?.() || false,
      this.translate,
      sourceHash
    );

    return {
      task,
      placeholder: { type: 'html', value: placeholderHtml }
    };
  }

  /**
   * Process all async tasks in parallel
   * @param onProgress - Progress callback (completed, total)
   * @param onError - Error handler for individual task
   * @returns Returns true if completed, false if aborted
   */
  async processAll(
    onProgress: ((completed: number, total: number) => void) | null = null,
    onError: ((error: Error, task: AsyncTask) => void) | null = null
  ): Promise<boolean> {
    if (this.queue.length === 0) {
      return true;
    }

    const tasks = this.queue.splice(0, this.queue.length);
    const totalTasks = tasks.length;
    let completedTasks = 0;

    const waitForReady = async (task: AsyncTask): Promise<void> => {
      // Check task's own context instead of global aborted flag
      while (task.status === 'fetching' && !task.context.cancelled) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };

    const processTask = async (task: AsyncTask): Promise<void> => {
      // Check task's own context - if cancelled, skip this task
      if (task.context.cancelled) {
        return;
      }

      try {
        await waitForReady(task);

        // Check again after waiting (using task's context)
        if (task.context.cancelled) {
          return;
        }

        // Check if placeholder exists in DOM
        const placeholder = document.getElementById(task.id);
        
        if (task.status === 'error') {
          // Check context before DOM update
          if (task.context.cancelled) return;
          if (placeholder) {
            const errorDetail = escapeHtml(task.error?.message || this.translate('async_unknown_error'));
            const localizedError = this.translate('async_processing_error', [errorDetail]);
            placeholder.outerHTML = `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${localizedError}</pre>`;
          }
        } else {
          await task.callback(task.data);
        }
      } catch (error) {
        // Ignore errors if task's context was cancelled
        if (task.context.cancelled) {
          return;
        }
        console.error('[TaskManager] Task processing error:', task.id, error);
        const placeholder = document.getElementById(task.id);
        if (placeholder) {
          const errorDetail = escapeHtml((error as Error).message || '');
          const localizedError = this.translate('async_task_processing_error', [errorDetail]);
          placeholder.outerHTML = `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${localizedError}</pre>`;
        }
        if (onError) onError(error as Error, task);
      } finally {
        // Only update progress if task's context is still valid
        if (!task.context.cancelled) {
          completedTasks++;
          if (onProgress) onProgress(completedTasks, totalTasks);
        }
      }
    };

    await Promise.all(tasks.map(processTask));
    return !this.aborted;
  }

  /**
   * Get pending task count
   */
  get pendingCount(): number {
    return this.queue.length;
  }
}

/**
 * Create the unified markdown processor pipeline
 * @param renderer - Renderer instance for diagrams
 * @param taskManager - Async task manager
 * @param translate - Translation function
 * @returns Configured unified processor
 */
export function createMarkdownProcessor(
  renderer: PluginRenderer,
  taskManager: AsyncTaskManager,
  translate: TranslateFunction = (key) => key
): Processor {
  const asyncTask: AsyncTaskQueueManager['asyncTask'] = (callback, data, plugin, _translate, initialStatus) => {
    return taskManager.createTask(
      async (taskData, _context) => callback(taskData),
      (data || {}) as Record<string, unknown>,
      plugin || null,
      initialStatus || 'ready'
    );
  };

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm, { singleTilde: false })
    .use(remarkBreaks)
    .use(remarkMath)
    .use(remarkSuperSub)
    .use(remarkTocFilter);  // Filter out [toc] markers in rendered HTML

  // Register all plugins from plugin registry
  // Cast via unknown due to unified's complex generic constraints
  registerRemarkPlugins(processor as unknown as Processor, renderer, asyncTask, translate, escapeHtml, visit);

  // Continue with rehype processing
  processor
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeImageUri)  // Rewrite relative image paths for VS Code webview
    .use(rehypeHighlight)
    .use(rehypeKatex)
    .use(rehypeStringify, { allowDangerousHtml: true });

  return processor as unknown as Processor;
}

/**
 * Options for processing markdown to HTML
 */
interface ProcessMarkdownOptions {
  renderer: PluginRenderer;
  taskManager: AsyncTaskManager;
  translate?: TranslateFunction;
}

/**
 * Simple LRU cache for processed HTML results.
 * Key: markdown block hash, Value: processed HTML
 */
class HtmlResultCache {
  private cache = new Map<string, string>();
  private maxSize: number;

  constructor(maxSize = 500) {  // Increased for block-level caching
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    // Delete if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
  
  get size(): number {
    return this.cache.size;
  }
}

// Global block-level HTML cache (large capacity for big documents)
const blockHtmlCache = new HtmlResultCache(5000);

/**
 * Clear the HTML result cache (call when settings change)
 */
export function clearHtmlResultCache(): void {
  blockHtmlCache.clear();
}

/**
 * Process a single markdown block to HTML
 */
async function processBlockToHtml(
  block: string,
  processor: Processor
): Promise<string> {
  const cacheKey = hashCode(block);
  const cached = blockHtmlCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const file = await processor.process(block);
  let html = String(file);
  html = processTablesForWordCompatibility(html);
  html = sanitizeRenderedHtml(html);
  
  blockHtmlCache.set(cacheKey, html);
  return html;
}

/**
 * Add block hash and source line attributes to top-level elements in HTML.
 * Elements get 'data-line' attribute and 'code-line' class for scroll sync.
 * @param html - HTML content
 * @param blockHash - Hash for DOM diffing
 * @param startLine - Source line number (0-based)
 * @param lineCount - Number of lines in this block (for fine-grained sync)
 * @returns HTML with attributes added
 */
function addBlockAttributesToHtml(html: string, blockHash: string, startLine: number, lineCount: number = 0): string {
  // Parse HTML and add attributes to each top-level element
  const template = document.createElement('template');
  template.innerHTML = html;
  
  const children = template.content.children;
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement;
    el.setAttribute('data-block-hash', blockHash);
    el.setAttribute('data-line', String(startLine));
    if (lineCount > 0) {
      el.setAttribute('data-line-count', String(lineCount));
    }
    el.classList.add('code-line');
  }
  
  return template.innerHTML;
}

/**
 * Add block hash attribute to top-level elements in HTML (legacy, no line info)
 */
function addBlockHashToHtml(html: string, blockHash: string): string {
  return addBlockAttributesToHtml(html, blockHash, -1, 0);
}

/**
 * Process markdown to HTML with block-level caching
 * Each block's top-level elements are tagged with hash for efficient DOM diffing.
 * @param markdown - Raw markdown content
 * @param options - Processing options
 * @returns Processed HTML
 */
export async function processMarkdownToHtml(
  markdown: string,
  options: ProcessMarkdownOptions
): Promise<string> {
  const { renderer, taskManager, translate = (key) => key } = options;

  // Pre-process markdown
  const normalizedMarkdown = normalizeMathBlocks(markdown);
  
  // Split into blocks with line info
  const blocks = splitMarkdownIntoBlocksWithLines(normalizedMarkdown);
  
  // Create processor (reused for all blocks)
  const processor = createMarkdownProcessor(renderer, taskManager, translate);
  
  // Process each block with caching
  const t0 = performance.now();
  let cacheHits = 0;
  const htmlParts: string[] = [];
  
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockHash = hashCode(block.content);
    const cached = blockHtmlCache.get(blockHash);
    
    let blockHtml: string;
    // Don't use cache for blocks containing placeholders - they need fresh tasks
    // Placeholders contain 'async-placeholder' class which indicates async rendering is needed
    const cacheContainsPlaceholder = cached !== undefined && cached.includes('async-placeholder');
    
    if (cached !== undefined && !cacheContainsPlaceholder) {
      blockHtml = cached;
      cacheHits++;
    } else {
      const file = await processor.process(block.content);
      let html = String(file);
      html = processTablesForWordCompatibility(html);
      html = sanitizeRenderedHtml(html);
      // Only cache blocks without placeholders
      // Blocks with placeholders need to be processed each time to create tasks
      if (!html.includes('async-placeholder')) {
        blockHtmlCache.set(blockHash, html);
      }
      blockHtml = html;
    }
    
    // Calculate line count for this block (for fine-grained scroll sync)
    const blockLineCount = block.content.split('\n').length;
    // Find next block's start line to get end line of current block
    const nextBlockStartLine = i + 1 < blocks.length ? blocks[i + 1].startLine : block.startLine + blockLineCount;
    const actualLineCount = nextBlockStartLine - block.startLine;
    
    // Add hash and line number to top-level elements for DOM diffing and scroll sync
    htmlParts.push(addBlockAttributesToHtml(blockHtml, blockHash, block.startLine, actualLineCount));
  }
  
  const t1 = performance.now();
  // Only log if processing took significant time (> 50ms)
  if ((t1 - t0) > 50) {
    console.log(`[Perf] processMarkdownToHtml: ${(t1 - t0).toFixed(1)}ms, blocks: ${blocks.length}, cache hits: ${cacheHits}/${blocks.length}`);
  }

  return htmlParts.join('\n');
}

/**
 * Extract title from markdown content
 * @param markdown - Markdown content
 * @returns Extracted title or null
 */
export function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Heading information for TOC
 */
export interface HeadingInfo {
  level: number;
  text: string;
  id: string;
}

/**
 * Extract headings for TOC generation (from DOM)
 * @param container - DOM container with rendered content
 * @returns Array of heading objects
 */
export function extractHeadings(container: Element): HeadingInfo[] {
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const result: HeadingInfo[] = [];

  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName[1]);
    const text = heading.textContent || '';
    const id = heading.id || `heading-${index}`;

    if (!heading.id) {
      heading.id = id;
    }

    result.push({ level, text, id });
  });

  return result;
}

/**
 * Options for incremental HTML rendering
 */
interface RenderHtmlOptions {
  batchSize?: number;
  yieldDelay?: number;
}

/**
 * Render HTML content incrementally to avoid blocking the main thread.
 * Parses HTML, then appends top-level nodes in batches with yields between them.
 * @param container - Target container element
 * @param html - Full HTML content to render
 * @param options - Rendering options
 */
export async function renderHtmlIncrementally(
  container: HTMLElement,
  html: string,
  options: RenderHtmlOptions = {}
): Promise<void> {
  const { batchSize = 200, yieldDelay = 0 } = options;

  // Parse HTML to DOM using template element
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;

  // Get all top-level children as array (need copy since we'll move nodes)
  const children = Array.from(fragment.childNodes);

  // Small content: render all at once
  if (children.length <= batchSize) {
    container.appendChild(fragment);
    return;
  }

  // Large content: render in batches with yields
  for (let i = 0; i < children.length; i += batchSize) {
    const batchFragment = document.createDocumentFragment();
    const end = Math.min(i + batchSize, children.length);

    for (let j = i; j < end; j++) {
      batchFragment.appendChild(children[j]);
    }

    container.appendChild(batchFragment);

    // Yield to main thread between batches to keep UI responsive
    if (end < children.length) {
      await new Promise(resolve => setTimeout(resolve, yieldDelay));
    }
  }
}
