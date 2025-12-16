// Markdown Processor - Core processing logic shared between Chrome and Mobile
// This module contains only the markdown processing pipeline without UI interactions

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import { registerRemarkPlugins } from '../plugins/index.js';
import { createPlaceholderElement } from '../plugins/plugin-content-utils.js';

/**
 * Normalize math blocks in markdown text
 * Converts single-line $$...$$ to multi-line format for proper display math rendering
 * @param {string} markdown - Raw markdown content
 * @returns {string} Normalized markdown
 */
export function normalizeMathBlocks(markdown) {
  const singleLineMathRegex = /^(\s*)(?<!\$\$)\$\$(.+?)\$\$(?!\$\$)\s*$/gm;
  return markdown.replace(singleLineMathRegex, (match, indent, formula) => {
    return `\n$$\n${formula.trim()}\n$$\n`;
  });
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate URL values and block javascript-style protocols
 * @param {string} url - URL to validate
 * @returns {boolean} True when URL is considered safe
 */
export function isSafeUrl(url) {
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
 * @param {string} value - Raw srcset value
 * @returns {boolean} True when every entry is safe
 */
export function isSafeSrcset(value) {
  if (!value) return true;
  return value.split(',').every((candidate) => {
    const urlPart = candidate.trim().split(/\s+/)[0];
    return isSafeUrl(urlPart);
  });
}

/**
 * Strip unsafe attributes from an element
 * @param {Element} element - Element to sanitize
 */
function sanitizeElementAttributes(element) {
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
 * @param {Node} root - Root node to sanitize
 */
function sanitizeNodeTree(root) {
  const blockedTags = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO']);
  const stack = [];

  Array.from(root.childNodes).forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      stack.push(child);
    } else if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
    }
  });

  while (stack.length > 0) {
    const node = stack.pop();

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
        stack.push(child);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
      }
    });
  }
}

/**
 * Sanitize rendered HTML to remove active content like scripts before injection
 * @param {string} html - Raw HTML string produced by the markdown pipeline
 * @returns {string} Sanitized HTML safe for innerHTML assignment
 */
export function sanitizeRenderedHtml(html) {
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
 * @param {string} html - HTML content
 * @returns {string} HTML with centered tables
 */
export function processTablesForWordCompatibility(html) {
  html = html.replace(/<table>/g, '<div align="center"><table align="center">');
  html = html.replace(/<\/table>/g, '</table></div>');
  return html;
}

/**
 * Async task manager for plugin rendering
 */
export class AsyncTaskManager {
  constructor(translate = (key) => key) {
    this.queue = [];
    this.idCounter = 0;
    this.translate = translate;
    this.aborted = false;
  }

  /**
   * Abort all pending tasks
   * Called when starting a new render to cancel previous tasks
   */
  abort() {
    this.aborted = true;
    this.queue = [];
  }

  /**
   * Reset abort flag (call before starting new task collection)
   */
  reset() {
    this.aborted = false;
    this.queue = [];
    this.idCounter = 0;
  }

  /**
   * Check if manager has been aborted
   */
  isAborted() {
    return this.aborted;
  }

  /**
   * Generate unique ID for async tasks
   */
  generateId() {
    return `async-placeholder-${++this.idCounter}`;
  }

  /**
   * Register async task for later execution
   * @param {Function} callback - The async callback function
   * @param {Object} data - Data to pass to callback
   * @param {Object} plugin - Plugin instance
   * @param {string} initialStatus - Initial task status
   * @returns {Object} Task control and placeholder content
   */
  createTask(callback, data = {}, plugin = null, initialStatus = 'ready') {
    const placeholderId = this.generateId();
    const type = plugin?.type || 'unknown';

    const task = {
      id: placeholderId,
      callback,
      data: { ...data, id: placeholderId },
      type,
      status: initialStatus,
      error: null,
      setReady: () => { task.status = 'ready'; },
      setError: (error) => { task.status = 'error'; task.error = error; }
    };

    this.queue.push(task);

    const placeholderHtml = createPlaceholderElement(
      placeholderId,
      type,
      plugin?.isInline() || false,
      this.translate
    );

    return {
      task,
      placeholder: { type: 'html', value: placeholderHtml }
    };
  }

  /**
   * Process all async tasks in parallel
   * @param {Function} onProgress - Progress callback (completed, total)
   * @param {Function} onError - Error handler for individual task
   * @returns {boolean} - Returns true if completed, false if aborted
   */
  async processAll(onProgress = null, onError = null) {
    if (this.queue.length === 0) return true;

    const tasks = this.queue.splice(0, this.queue.length);
    const totalTasks = tasks.length;
    let completedTasks = 0;

    const waitForReady = async (task) => {
      while (task.status === 'fetching' && !this.aborted) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };

    const processTask = async (task) => {
      // Check if aborted before processing
      if (this.aborted) {
        return;
      }

      try {
        await waitForReady(task);

        // Check again after waiting
        if (this.aborted) {
          return;
        }

        if (task.status === 'error') {
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
        // Ignore errors if aborted
        if (this.aborted) {
          return;
        }
        console.error('Async task processing error:', error);
        const placeholder = document.getElementById(task.id);
        if (placeholder) {
          const errorDetail = escapeHtml(error.message || '');
          const localizedError = this.translate('async_task_processing_error', [errorDetail]);
          placeholder.outerHTML = `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${localizedError}</pre>`;
        }
        if (onError) onError(error, task);
      } finally {
        if (!this.aborted) {
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
  get pendingCount() {
    return this.queue.length;
  }
}

/**
 * Create the unified markdown processor pipeline
 * @param {Object} renderer - Renderer instance for diagrams
 * @param {AsyncTaskManager} taskManager - Async task manager
 * @param {Function} translate - Translation function
 * @returns {Object} Configured unified processor
 */
export function createMarkdownProcessor(renderer, taskManager, translate = (key) => key) {
  // Backwards/forwards compatible wrapper:
  // Some call sites pass (callback, data, plugin, initialStatus)
  // Others pass (callback, data, plugin, translate, initialStatus)
  const asyncTask = (callback, data, plugin, arg4, arg5) => {
    const initialStatus = typeof arg4 === 'string' ? arg4 : arg5;
    return taskManager.createTask(callback, data, plugin, initialStatus || 'ready');
  };

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkMath);

  // Register all plugins from plugin registry
  registerRemarkPlugins(processor, renderer, asyncTask, translate, escapeHtml, visit);

  // Continue with rehype processing
  processor
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeHighlight)
    .use(rehypeKatex)
    .use(rehypeStringify, { allowDangerousHtml: true });

  return processor;
}

/**
 * Process markdown to HTML
 * @param {string} markdown - Raw markdown content
 * @param {Object} options - Processing options
 * @param {Object} options.renderer - Renderer instance
 * @param {AsyncTaskManager} options.taskManager - Task manager
 * @param {Function} options.translate - Translation function
 * @returns {Promise<string>} Processed HTML
 */
export async function processMarkdownToHtml(markdown, options = {}) {
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
 * Extract title from markdown content
 * @param {string} markdown - Markdown content
 * @returns {string|null} Extracted title or null
 */
export function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Extract headings for TOC generation (from DOM)
 * @param {Element} container - DOM container with rendered content
 * @returns {Array} Array of heading objects {level, text, id}
 */
export function extractHeadings(container) {
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const result = [];

  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName[1]);
    const text = heading.textContent;
    const id = heading.id || `heading-${index}`;

    if (!heading.id) {
      heading.id = id;
    }

    result.push({ level, text, id });
  });

  return result;
}

/**
 * Render HTML content incrementally to avoid blocking the main thread.
 * Parses HTML, then appends top-level nodes in batches with yields between them.
 * @param {HTMLElement} container - Target container element
 * @param {string} html - Full HTML content to render
 * @param {Object} options - Rendering options
 * @param {number} options.batchSize - Number of top-level nodes per batch (default: 200)
 * @param {number} options.yieldDelay - Delay in ms between batches (default: 0)
 * @returns {Promise<void>}
 */
export async function renderHtmlIncrementally(container, html, options = {}) {
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
