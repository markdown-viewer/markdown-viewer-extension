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
import { registerRemarkPlugins } from '../plugins/index';
import { createPlaceholderElement } from '../plugins/plugin-content-utils';
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

/**
 * Split markdown into logical chunks for incremental rendering.
 * Preserves block boundaries (code blocks, math blocks, tables, lists).
 * Uses adaptive chunk sizing: smaller chunks at the start for faster initial display.
 * @param markdown - Raw markdown content
 * @returns Array of markdown chunks
 */
export function splitMarkdownIntoChunks(markdown: string): string[] {
  // Adaptive chunk size strategy with exponential growth:
  // - Chunk 0: 50 lines
  // - Chunk 1: 100 lines
  // - Chunk 2: 200 lines
  // - Chunk 3: 400 lines, and so on (each chunk doubles in size)
  const INITIAL_CHUNK_SIZE = 50;

  const getTargetChunkSize = (chunkIndex: number): number => {
    return INITIAL_CHUNK_SIZE * Math.pow(2, chunkIndex);
  };

  const lines = markdown.split('\n');
  const chunks: string[] = [];

  let currentChunk: string[] = [];
  let codeBlockFence = '';  // Store the opening fence (e.g., '```' or '~~~~~~')
  let inMathBlock = false;
  let inTable = false;
  let inBlockquote = false;
  let inIndentedCode = false;
  let inFrontMatter = false;
  let listIndent = -1;

  const flushChunk = () => {
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Track front matter (--- at start of file)
    if (i === 0 && trimmedLine === '---') {
      inFrontMatter = true;
    } else if (inFrontMatter && trimmedLine === '---') {
      inFrontMatter = false;
      currentChunk.push(line);
      continue;
    }

    // Track code blocks (fenced) - handle nested fences like `````` containing ```
    const backtickMatch = trimmedLine.match(/^(`{3,})/);
    const tildeMatch = trimmedLine.match(/^(~{3,})/);
    const fenceMatch = backtickMatch || tildeMatch;
    
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const fenceChar = fence[0];
      
      if (!codeBlockFence) {
        // Opening a new code block
        codeBlockFence = fence;
      } else if (fenceChar === codeBlockFence[0] && fence.length >= codeBlockFence.length) {
        // Closing fence must use same char and be at least as long
        codeBlockFence = '';
      }
      // Otherwise it's content inside the code block, ignore
    }

    const inCodeBlock = codeBlockFence !== '';

    // Track math blocks
    if (trimmedLine === '$$') {
      inMathBlock = !inMathBlock;
    }

    // Track tables (lines starting with |)
    if (trimmedLine.startsWith('|')) {
      inTable = true;
    } else if (inTable && trimmedLine === '') {
      inTable = false;
    }

    // Track blockquotes (lines starting with >)
    if (trimmedLine.startsWith('>')) {
      inBlockquote = true;
    } else if (inBlockquote && trimmedLine === '') {
      // Empty line might end blockquote
      const nextLine = lines[i + 1];
      if (!nextLine || !nextLine.trim().startsWith('>')) {
        inBlockquote = false;
      }
    } else if (inBlockquote && !trimmedLine.startsWith('>')) {
      // Non-quote line ends blockquote (unless it's a lazy continuation - rare)
      inBlockquote = false;
    }

    // Track indented code blocks (4 spaces or 1 tab, not inside list)
    if (!inCodeBlock && !inMathBlock && listIndent < 0) {
      const isIndentedCode = line.startsWith('    ') || line.startsWith('\t');
      if (isIndentedCode && trimmedLine !== '') {
        inIndentedCode = true;
      } else if (inIndentedCode && trimmedLine === '') {
        // Empty line might continue or end indented code
        const nextLine = lines[i + 1];
        if (!nextLine || (!nextLine.startsWith('    ') && !nextLine.startsWith('\t'))) {
          inIndentedCode = false;
        }
      } else if (inIndentedCode && !isIndentedCode) {
        inIndentedCode = false;
      }
    }

    // Track lists (detect list item start with proper regex)
    // Match unordered (-, *, +) or ordered (1., 2., etc.) list items with proper anchoring
    const listMatch = line.match(/^(\s*)(?:[-*+]|\d+\.)\s/);
    if (listMatch) {
      const indent = listMatch[1]?.length ?? 0;
      if (listIndent < 0) {
        // Starting a new list
        listIndent = indent;
      } else if (indent <= listIndent) {
        // Back to base or parent list level - update minimum indent
        listIndent = indent;
      } else {
        // Nested deeper - keep existing listIndent to protect all nesting levels
      }
    } else if (listIndent >= 0 && trimmedLine === '') {
      // Empty line might end the list
      const nextLine = lines[i + 1];
      if (!nextLine || !nextLine.match(/^(\s*)(?:[-*+]|\d+\.)\s/)) {
        listIndent = -1;
      }
    } else if (listIndent >= 0 && !trimmedLine.startsWith(' '.repeat(listIndent))) {
      // Non-indented content after list - list has ended
      listIndent = -1;
    }

    currentChunk.push(line);

    // Check if we can split here
    const canSplit = !inCodeBlock && !inMathBlock && !inTable && !inBlockquote && !inIndentedCode && !inFrontMatter && listIndent < 0;
    const isBlockBoundary = trimmedLine === '' || trimmedLine.startsWith('#');
    const targetSize = getTargetChunkSize(chunks.length);
    const reachedTarget = currentChunk.length >= targetSize;

    if (canSplit && isBlockBoundary && reachedTarget) {
      flushChunk();
    }
  }

  // Flush remaining content
  flushChunk();

  return chunks;
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

  try {
    const parsed = new URL(trimmed, document.baseURI);
    return ['http:', 'https:', 'mailto:', 'tel:', 'file:'].includes(parsed.protocol);
  } catch (error) {
    return false;
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
export class AsyncTaskManager {
  private queue: AsyncTask[] = [];
  private idCounter = 0;
  private translate: TranslateFunction;
  private aborted = false;
  private context: TaskContext;

  constructor(translate: TranslateFunction = (key) => key) {
    this.translate = translate;
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

    const task: AsyncTask = {
      id: placeholderId,
      callback: async (taskData: TaskData) => callback(taskData, taskContext),
      data: { ...data, id: placeholderId },
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
      this.translate
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
    if (this.queue.length === 0) return true;

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

        if (task.status === 'error') {
          // Check context before DOM update
          if (task.context.cancelled) return;
          const placeholder = document.getElementById(task.id);
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
        console.error('Async task processing error:', error);
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
 * Process markdown to HTML
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

  // Create processor
  const processor = createMarkdownProcessor(renderer, taskManager, translate);

  // Process markdown
  const file = await processor.process(normalizedMarkdown);
  let htmlContent = String(file);

  // Post-process HTML
  htmlContent = processTablesForWordCompatibility(htmlContent);
  htmlContent = sanitizeRenderedHtml(htmlContent);

  return htmlContent;
}

/**
 * Options for streaming markdown processing
 */
export interface StreamMarkdownOptions extends ProcessMarkdownOptions {
  /**
   * Callback invoked after each chunk is processed
   * @param html - HTML content of the processed chunk
   * @param chunkIndex - Index of the current chunk (0-based)
   * @param totalChunks - Total number of chunks
   */
  onChunk?: (html: string, chunkIndex: number, totalChunks: number) => Promise<void> | void;
}

/**
 * Process markdown to HTML in streaming fashion.
 * Splits markdown into chunks and processes/renders each incrementally.
 * This allows the UI to show content progressively for large documents.
 *
 * @param markdown - Raw markdown content
 * @param options - Processing options including streaming callbacks
 */
export async function processMarkdownStreaming(
  markdown: string,
  options: StreamMarkdownOptions
): Promise<void> {
  const { renderer, taskManager, translate = (key) => key, onChunk } = options;

  // Pre-process markdown
  const normalizedMarkdown = normalizeMathBlocks(markdown);

  // Split into chunks (uses adaptive sizing internally)
  const chunks = splitMarkdownIntoChunks(normalizedMarkdown);
  const totalChunks = chunks.length;

  // If only one chunk, process normally (avoid overhead)
  if (totalChunks === 1) {
    const html = await processMarkdownToHtml(markdown, { renderer, taskManager, translate });
    await onChunk?.(html, 0, 1);
    return;
  }

  // Process each chunk and render incrementally
  for (let i = 0; i < totalChunks; i++) {
    // Check if aborted
    if (taskManager.isAborted()) {
      return;
    }

    const chunk = chunks[i];

    // Create a fresh processor for each chunk
    const processor = createMarkdownProcessor(renderer, taskManager, translate);

    // Process chunk
    const file = await processor.process(chunk);
    let htmlContent = String(file);

    // Post-process HTML
    htmlContent = processTablesForWordCompatibility(htmlContent);
    htmlContent = sanitizeRenderedHtml(htmlContent);

    // Invoke callback to render this chunk
    await onChunk?.(htmlContent, i, totalChunks);

    // Yield to main thread between chunks to keep UI responsive
    if (i < totalChunks - 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
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
