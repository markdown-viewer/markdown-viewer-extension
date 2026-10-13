// Markdown Processor - Core processing logic shared between Chrome and Mobile
// This module contains only the markdown processing pipeline without UI interactions

import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkInlineHtml from '../plugins/remark-inline-html';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkGemoji from 'remark-gemoji';
import remarkGithubAlerts from '../plugins/remark-github-alerts';
import remarkTocFilter from '../plugins/remark-toc-filter';
import remarkRehype from 'remark-rehype';
import GithubSlugger from 'github-slugger';
import rehypeSlugShared from './rehype-slug-shared';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { common as commonGrammars } from 'lowlight';
import { EXTRA_HIGHLIGHT_GRAMMARS } from '../utils/extra-highlight-grammars';
import { codeToHast, createShikiInternalSync, type ShikiTransformer } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import langMarkdown from '@shikijs/langs/markdown';
import themeVitesseDark from '@shikijs/themes/vitesse-dark';
import themeVitesseLight from '@shikijs/themes/vitesse-light';
import { visit } from 'unist-util-visit';
import rehypeImageUri from '../plugins/rehype-image-uri';
import rehypeTableMerge from '../plugins/rehype-table-merge';
import { registerRemarkPlugins } from '../plugins/index';
import { registerOpenapiPlugin } from '../plugins/openapi-plugin';
import { createErrorHTML, createPlaceholderElement } from '../plugins/plugin-content-utils';
import { replacePlaceholderWithImageUrl } from '../plugins/plugin-html-utils';
import { recordRenderDiagnostic } from './render-diagnostics';
import { syncBlockHtmlFromDOM } from './viewer/viewer-controller';
import { generateContentHash, hashCode } from '../utils/hash';
import { sanitizeHtmlFragment } from '../utils/html-sanitizer.ts';
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
  /**
   * Document-level start line of the block currently being rendered (0-based).
   * Block contents are parsed independently, so remark positions restart at
   * line 1; error reports add this offset to name the real document line.
   */
  blockStartLine?: number;
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
 * Check if a block is a frontmatter block
 * Frontmatter must start and end with ---, and typically appears at line 0
 */
export function isFrontmatterBlock(block: string, startLine: number): boolean {
  if (startLine !== 0) return false;
  const lines = block.split('\n');
  if (lines.length < 2) return false;
  return lines[0].trim() === '---' && lines[lines.length - 1].trim() === '---';
}

/**
 * Parse frontmatter YAML content (simple key: value parsing)
 */
export function parseFrontmatter(block: string): Record<string, string> {
  const lines = block.split('\n');
  const result: Record<string, string> = {};
  
  // Skip first and last lines (---)
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      if (key) {
        result[key] = value;
      }
    }
  }
  
  return result;
}

/**
 * Render frontmatter as HTML table
 */
export function renderFrontmatterAsTable(data: Record<string, string>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return '';
  
  const rows = entries
    .map(([key, value]) => `<tr><td><strong>${escapeHtml(key)}</strong></td><td>${escapeHtml(value)}</td></tr>`)
    .join('\n');
  
  return `<table class="frontmatter-table">
<thead><tr><th>Property</th><th>Value</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

/**
 * Render frontmatter as pre block (raw format)
 */
export function renderFrontmatterAsRaw(block: string): string {
  const lines = block.split('\n');
  // Skip first and last --- lines, render content as pre
  const content = lines.slice(1, -1).join('\n');
  return `<pre class="frontmatter-raw">${escapeHtml(content)}</pre>`;
}

/**
 * Validate URL values and block javascript-style protocols.
 *
 * The policy itself lives in src/utils/url-safety.ts, shared with the HTML
 * block sanitizer so the two cannot drift into different ideas of what is
 * dangerous; re-exported here because this module is its historical home.
 */
export { isSafeUrl, isSafeSrcset } from '../utils/url-safety';

/**
 * Sanitize rendered HTML to remove active content like scripts before injection.
 *
 * Delegates to the shared sanitizer in src/utils/html-sanitizer.ts with the
 * rendered-document policy: a visible notice replaces removed elements, and
 * `<style>` is kept where diagrams need it (inside `<svg>`).
 *
 * @param html - Raw HTML string produced by the markdown pipeline
 * @returns Sanitized HTML safe for innerHTML assignment
 */
export function sanitizeRenderedHtml(html: string): string {
  return sanitizeHtmlFragment(html, { reportBlocked: true });
}

/**
 * Process tables to add alignment attributes for Word compatibility
 * @param html - HTML content
 * @param layout - Table layout: 'left' or 'center' (default: 'left')
 * @returns HTML with table alignment applied
 */
export function processTablesForWordCompatibility(html: string, layout: 'left' | 'center' = 'center'): string {
  if (layout === 'center') {
    html = html.replace(/<table>/g, '<div align="center"><table align="center">');
    html = html.replace(/<\/table>/g, '</table></div>');
  }
  // For 'left' layout, no wrapping needed - tables are left-aligned by default
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
   * Set the document-level start line (0-based) of the block currently being
   * processed, so task error reports can name the real source line even when
   * block contents are parsed independently (remark positions restart at 1).
   * @param line - 0-based start line of the current block
   */
  setBlockStartLine(line: number): void {
    this.context.blockStartLine = line;
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

    // Convert the block-relative remark line to a document line. In whole-
    // document parsing the block offset is 0 and the remark line is already
    // absolute; in block-level streaming renders the viewer sets the offset.
    const rawSourceLine = typeof data.sourceLine === 'number' && data.sourceLine > 0
      ? data.sourceLine
      : null;
    const sourceLine = rawSourceLine === null
      ? null
      : rawSourceLine + (this.context.blockStartLine ?? 0);

    const task: AsyncTask = {
      id: placeholderId,
      callback: async (taskData: TaskData) => callback(taskData, taskContext),
      data: { ...data, id: placeholderId, sourceHash, sourceLine },
      type,
      status: initialStatus,
      error: null,
      context: taskContext, // Bind task to its creation context
      setReady: () => { task.status = 'ready'; },
      setError: (error: Error) => { task.status = 'error'; task.error = error; }
    };

    this.queue.push(task);

    // Authored <img> attributes (width/height/alt) flow through the task data
    // (set by withImageNodeAttrs in the remark visitors) onto the placeholder
    // element so the replacement step can re-apply them after rendering.
    const imgAttrs = {
      width: typeof data.sourceWidth === 'string' && data.sourceWidth !== '' ? data.sourceWidth : null,
      height: typeof data.sourceHeight === 'string' && data.sourceHeight !== '' ? data.sourceHeight : null,
      alt: typeof data.sourceAlt === 'string' && data.sourceAlt !== '' ? data.sourceAlt : null,
    };
    const hasImgAttrs = imgAttrs.width !== null || imgAttrs.height !== null || imgAttrs.alt !== null;

    const placeholderHtml = createPlaceholderElement(
      placeholderId,
      type,
      plugin?.isInline?.() || false,
      this.translate,
      sourceHash,
      hasImgAttrs ? imgAttrs : null,
      sourceLine
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

    const waitForNextFrame = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
          return;
        }
        setTimeout(() => resolve(), 0);
      });
    };

    const waitForReady = async (task: AsyncTask): Promise<void> => {
      // Check task's own context instead of global aborted flag
      while (task.status === 'fetching' && !task.context.cancelled) {
        await waitForNextFrame();
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
            // Degrade before reporting: content that could not be fetched but
            // is loadable as a plain image (e.g. a local SVG on a browser that
            // refuses local file reads) is shown as an <img> rather than as an
            // error block.
            const fallbackUrl = typeof task.data.fetchFallbackUrl === 'string'
              ? task.data.fetchFallbackUrl
              : '';
            if (fallbackUrl && replacePlaceholderWithImageUrl(placeholder, fallbackUrl, {
              sourceHash: task.data.sourceHash,
              pluginType: task.type,
            })) {
              // Keep the in-memory block cache in sync (the block no longer
              // holds a placeholder), like the plugin render path does.
              syncBlockHtmlFromDOM(task.id);
            } else {
              const errorDetail = escapeHtml(task.error?.message || this.translate('async_unknown_error'));
              const localizedError = this.translate('async_processing_error', [errorDetail]);
              // Same signal the console carries, in structured form: the block
              // could not be fetched and nothing was rendered in its place.
              recordRenderDiagnostic({
                level: 'error',
                kind: 'resource-failed',
                type: task.type,
                line: typeof task.data.sourceLine === 'number' ? task.data.sourceLine : null,
                blockId: task.id,
                message: task.error?.message || this.translate('async_unknown_error'),
              });
              placeholder.outerHTML = createErrorHTML(localizedError, {
                pluginType: task.type,
                sourceLine: typeof task.data.sourceLine === 'number' ? task.data.sourceLine : null,
                blockId: task.id,
                stage: 'fetch',
              });
            }
          }
        } else {
          await task.callback(task.data);
        }
      } catch (error) {
        // Ignore errors if task's context was cancelled
        if (task.context.cancelled) {
          return;
        }
        // Concise warning: the error is already shown in the document via the
        // placeholder error block — a stack trace here is noise in CLI logs.
        console.warn(`[TaskManager] Task failed for ${task.id}: ${(error as Error).message}`);
        recordRenderDiagnostic({
          level: 'error',
          kind: 'render-failed',
          type: task.type,
          line: typeof task.data.sourceLine === 'number' ? task.data.sourceLine : null,
          blockId: task.id,
          message: (error as Error).message,
        });
        const placeholder = document.getElementById(task.id);
        if (placeholder) {
          const errorDetail = escapeHtml((error as Error).message || '');
          const localizedError = this.translate('async_task_processing_error', [errorDetail]);
          placeholder.outerHTML = createErrorHTML(localizedError, {
            pluginType: task.type,
            sourceLine: typeof task.data.sourceLine === 'number' ? task.data.sourceLine : null,
            blockId: task.id,
          });
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
 * Options for creating markdown processor
 */
export interface CreateMarkdownProcessorOptions {
  renderer: PluginRenderer;
  taskManager: AsyncTaskManager;
  translate?: TranslateFunction;
  /** Enable auto-merge of empty table cells (default: false) */
  tableMergeEmpty?: boolean;
}

const markdownShikiInternal = createShikiInternalSync({
  engine: createJavaScriptRegexEngine(),
  langs: [langMarkdown],
  themes: [themeVitesseLight, themeVitesseDark],
});

function getNodeText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return String(node.value || '');
  if (!Array.isArray(node.children)) return '';
  return node.children.map((child: any) => getNodeText(child)).join('');
}

function isDarkThemeActive(): boolean {
  return Boolean(document?.documentElement?.classList?.contains('dark'));
}

/**
 * Hand the code surface back to the theme.
 *
 * Shiki paints its own `background-color` (vitesse white/black) inline on the
 * `<pre>`, and an inline declaration beats the viewer's
 * `#markdown-content pre { background-color: … }` rule — so a ```markdown
 * fence used to sit on Shiki's colour while every other code block sat on the
 * theme's code background. Only the background is dropped: the token colours
 * (inline on the spans) are what makes the fence syntax highlighted.
 */
const themeOwnedCodeBackground: ShikiTransformer = {
  name: 'documd-theme-owned-code-background',
  pre(node) {
    const style = node.properties?.style;
    if (typeof style !== 'string') {
      return;
    }

    const declarations = style
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration !== '' && !/^background(-color)?\s*:/i.test(declaration));

    if (declarations.length > 0) {
      node.properties.style = declarations.join(';');
    } else {
      delete node.properties.style;
    }
  },
};

function getMarkdownShikiPre(code: string): any | null {
  try {
    const root = codeToHast(markdownShikiInternal, code, {
      lang: 'markdown',
      theme: isDarkThemeActive() ? themeVitesseDark : themeVitesseLight,
      transformers: [themeOwnedCodeBackground],
    });
    return root.children.find((child: any) => child?.type === 'element' && child?.tagName === 'pre') || null;
  } catch {
    return null;
  }
}

export function renderMarkdownCodeBlockHtml(code: string): string | null {
  const shikiPre = getMarkdownShikiPre(code);
  if (!shikiPre) {
    return null;
  }

  try {
    return String(
      unified()
        .use(rehypeStringify)
        .stringify({ type: 'root', children: [shikiPre] } as any)
    );
  } catch {
    return null;
  }
}

function rehypeEnhanceMarkdownCode() {
  return (tree: any): void => {
    visit(tree, 'element', (node: any, _index: number | undefined, parent: any) => {
      if (!parent || node.tagName !== 'pre' || !Array.isArray(node.children)) {
        return;
      }

      const codeNode = node.children.find((child: any) => child?.type === 'element' && child?.tagName === 'code');
      if (!codeNode) {
        return;
      }

      const classList = Array.isArray(codeNode.properties?.className)
        ? codeNode.properties.className
        : typeof codeNode.properties?.className === 'string'
          ? codeNode.properties.className.split(/\s+/)
          : [];

      if (!classList.includes('language-markdown') && !classList.includes('language-md')) {
        return;
      }

      const shikiPre = getMarkdownShikiPre(getNodeText(codeNode));
      if (!shikiPre) {
        return;
      }

      node.properties = shikiPre.properties || {};
      node.children = shikiPre.children || [];
    });
  };
}

/**
 * Create the unified markdown processor pipeline
 * @param renderer - Renderer instance for diagrams
 * @param taskManager - Async task manager
 * @param translate - Translation function
 * @param options - Additional processor options (for backward compatibility, can pass options object)
 * @returns Configured unified processor
 */
export function createMarkdownProcessor(
  renderer: PluginRenderer,
  taskManager: AsyncTaskManager,
  translate: TranslateFunction = (key) => key,
  options?: { tableMergeEmpty?: boolean; slugger?: GithubSlugger }
): Processor {
  const { tableMergeEmpty = false, slugger } = options || {};
  
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
    .use(remarkInlineHtml)  // Convert inline HTML to MDAST nodes (before other remark plugins)
    .use(remarkCjkFriendly)
    .use(remarkGfm, { singleTilde: false })
    .use(remarkMath)
    .use(remarkGemoji)
    .use(remarkGithubAlerts)  // GitHub-style alert syntax (> [!NOTE] / [!TIP] / …)
    .use(remarkTocFilter);  // Filter out [toc] markers in rendered HTML

  // Register all plugins from plugin registry
  // Cast via unknown due to unified's complex generic constraints
  registerRemarkPlugins(processor as unknown as Processor, renderer, asyncTask, translate, escapeHtml, visit);
  registerOpenapiPlugin(processor as unknown as Processor, asyncTask);

  // Continue with rehype processing
  processor
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlugShared, { slugger })
    .use(rehypeImageUri)  // Rewrite relative image paths for VS Code webview
    .use(rehypeTableMerge, { enabled: tableMergeEmpty })  // Auto-merge empty table cells
    // `languages` REPLACES lowlight's default `common` set rather than extending
    // it, so the spread is load-bearing: `{ languages: EXTRA_HIGHLIGHT_GRAMMARS }`
    // alone would drop all 37 common grammars.
    .use(rehypeHighlight, { languages: { ...commonGrammars, ...EXTRA_HIGHLIGHT_GRAMMARS } })
    .use(rehypeEnhanceMarkdownCode)
    .use(rehypeKatex)
    .use(rehypeStringify, { allowDangerousHtml: true });

  return processor as unknown as Processor;
}

/**
 * Frontmatter display mode
 */
export type FrontmatterDisplay = 'hide' | 'table' | 'raw';

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


