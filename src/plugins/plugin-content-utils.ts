/**
 * Plugin Content Script Utilities
 * Handles content script specific logic for plugins (HTML generation, remark integration)
 */

import type { BasePlugin } from './base-plugin';
import { replacePlaceholderWithImage } from './plugin-html-utils';
import type { 
  TranslateFunction,
  EscapeHtmlFunction,
  TaskData,
  AsyncTaskQueueManager,
  ASTNode,
  PluginRenderer
} from '../types/index';

/**
 * Create async placeholder element HTML (before rendering)
 * @param id - Placeholder element ID
 * @param pluginType - Plugin type identifier
 * @param isInline - Whether to render inline or block
 * @param translate - Translation function
 * @param sourceHash - Content hash for DOM diff matching
 * @param imgAttrs - Authored <img> attributes (width/height/alt) to carry into the placeholder so the rendered replacement can apply them
 * @param sourceLine - 1-based markdown line of the block, carried into the DOM so
 *   an error block (and a host inspecting the rendered document) can name the
 *   real source location instead of only the placeholder id
 * @returns Placeholder HTML
 */
export function createPlaceholderElement(
  id: string,
  pluginType: string,
  isInline: boolean,
  translate: TranslateFunction,
  sourceHash?: string,
  imgAttrs?: { width?: string | null; height?: string | null; alt?: string | null } | null,
  sourceLine?: number | null
): string {
  // Generate translation key dynamically based on type
  const typeLabelKey = `async_placeholder_type_${pluginType.replace(/-/g, '')}`;
  const typeLabel = translate(typeLabelKey) || '';
  
  // If no translation found, use type as fallback
  const resolvedTypeLabel = typeLabel || pluginType;
  const processingText = translate('async_processing_message', [resolvedTypeLabel, ''])
    || `Processing ${resolvedTypeLabel}...`;

  // Data attributes for DOM diff matching
  const dataAttrs = sourceHash 
    ? `data-source-hash="${sourceHash}" data-plugin-type="${pluginType}"` 
    : '';

  // Source line for diagnostics: an export can report "line 42" for a block
  // without parsing the console output.
  const lineAttr = typeof sourceLine === 'number' && sourceLine > 0
    ? ` data-source-line="${sourceLine}"`
    : '';

  // Authored <img> attributes survive the takeover via data-* attributes on
  // the placeholder; replacePlaceholderWithImage reads them back and applies
  // them to the rendered <img> element.
  const imgDataAttrs = imgAttrs
    ? (['width', 'height', 'alt'] as const)
        .filter((key) => imgAttrs[key] != null && imgAttrs[key] !== '')
        .map((key) => ` data-${key}="${escapeHtmlAttr(String(imgAttrs[key]))}"`)
        .join('')
    : '';

  if (isInline) {
    return `<span id="${id}" class="async-placeholder ${pluginType}-placeholder inline-placeholder" ${dataAttrs}${lineAttr}${imgDataAttrs}>
      <span class="async-loading">
        <span class="async-spinner"></span>
        <span class="async-text">${processingText}</span>
      </span>
    </span>`;
  }

  return `<div id="${id}" class="async-placeholder ${pluginType}-placeholder" ${dataAttrs}${lineAttr}${imgDataAttrs}>
    <div class="async-loading">
      <div class="async-spinner"></div>
      <div class="async-text">${processingText}</div>
    </div>
  </div>`;
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Context a failed block can carry into its error element. */
export interface PluginErrorInfo {
  /** Plugin / diagram type that failed. */
  pluginType?: string | null;
  /** 1-based markdown line of the block. */
  sourceLine?: number | null;
  /** Placeholder id the error block replaced. */
  blockId?: string | null;
  /** What failed: the render itself or fetching the block's source. */
  stage?: 'render' | 'fetch' | null;
}

/**
 * Build the data attributes of an error block. The class and the data-* pair
 * are the contract a host reads to find the blocks a document lost (e.g. the
 * CLI's diagram-error report walks `.mv-plugin-error[data-source-line]`),
 * rather than matching the localized message text.
 */
export function pluginErrorAttributes(info?: PluginErrorInfo | null): string {
  if (!info) return '';
  const attrs: string[] = [];
  if (info.pluginType) attrs.push(`data-plugin-type="${escapeHtmlAttr(info.pluginType)}"`);
  if (typeof info.sourceLine === 'number' && info.sourceLine > 0) {
    attrs.push(`data-source-line="${info.sourceLine}"`);
  }
  if (info.blockId) attrs.push(`data-block-id="${escapeHtmlAttr(info.blockId)}"`);
  attrs.push(`data-plugin-stage="${info.stage || 'render'}"`);
  return attrs.join(' ');
}

/**
 * Carry authored <img> attributes (width/height/alt) and the source line from
 * the AST node into the async task data, so the placeholder element can expose
 * them to the replacement step and error reports can name the location. The
 * attributes come from node.data.hProperties (set by remark-inline-html); the
 * alt text is the standard mdast image field; the line comes from the remark
 * AST position.
 * @param data - Task data created by plugin.createTaskData()
 * @param node - The AST node being processed
 * @returns Task data enriched with sourceWidth/sourceHeight/sourceAlt/sourceLine
 */
export function withNodeSourceInfo(
  data: Record<string, unknown>,
  node: ASTNode
): Record<string, unknown> {
  const enriched = { ...data };
  if (node.type === 'image') {
    const hProperties = (node.data as { hProperties?: Record<string, string> } | undefined)?.hProperties;
    enriched.sourceWidth = hProperties?.width ?? null;
    enriched.sourceHeight = hProperties?.height ?? null;
    enriched.sourceAlt = node.alt ?? null;
  }
  enriched.sourceLine = node.position?.start?.line ?? null;
  return enriched;
}

/**
 * Severity of a block a plugin could not render the way it wanted to. The
 * element is one element for every level (see createPluginMessageHTML) — the
 * level only decides its colours.
 */
export type PluginMessageLevel = 'info' | 'warning' | 'error';

/** Inline colours per level. */
const PLUGIN_LEVEL_STYLE: Record<PluginMessageLevel, string> = {
  // Explicit colour + background so the block stays readable under both light
  // and dark themes (inherited text colour would otherwise be light in dark
  // themes and become illegible on a light background).
  error: 'background: #fee; color: #8b0000; border-left: 4px solid #f00;',
  warning: 'background: #fff8e1; color: #7a4f01; border-left: 4px solid #f0a000;',
  info: 'background: #eef4fb; color: #1f4b73; border-left: 4px solid #4a90d9;',
};

/**
 * Create the plugin message element.
 *
 * One element serves every level: it always carries `data-plugin-level`, and a
 * `error` message *also* carries the historical `mv-plugin-error` class, which
 * hosts and the CLI report on. A message is never a silent placeholder — it is
 * what the plugin reported instead of the block it could not produce.
 *
 * @param message - Localized message text
 * @param info - Block context (type, source line, stage, level)
 */
export function createPluginMessageHTML(
  message: string,
  info?: (PluginErrorInfo & { level?: PluginMessageLevel }) | null,
): string {
  const level = info?.level ?? 'error';
  const attrs = pluginErrorAttributes(info);
  const contextAttrs = attrs ? ` ${attrs}` : '';
  const classes = level === 'error' ? 'mv-plugin-error mv-plugin-message' : 'mv-plugin-message';
  return `<pre class="${classes}" data-plugin-level="${level}"${contextAttrs} `
    + `style="${PLUGIN_LEVEL_STYLE[level]} padding: 10px; font-size: 12px; `
    + `white-space: pre-wrap; word-break: break-word;">${message}</pre>`;
}

/**
 * Create error HTML
 * @param errorMessage - Localized error message
 * @param info - Block context (type, source line, stage), exposed as data-
 *   attributes so a host can locate and report the blocks a document lost
 * @returns Error HTML
 */
export function createErrorHTML(errorMessage: string, info?: PluginErrorInfo | null): string {
  return createPluginMessageHTML(errorMessage, { ...info, level: 'error' });
}

// PluginRenderer is defined in src/types/plugin.ts

/**
 * Visit function type from unist-util-visit
 */
type VisitFn = (
  tree: unknown,
  nodeType: string,
  visitor: (node: ASTNode, index: number | undefined, parent: { children?: unknown[] } | undefined) => void
) => void;

/**
 * Create remark plugin function for a plugin
 * @param plugin - Plugin instance
 * @param renderer - Renderer instance
 * @param asyncTask - Async task creator
 * @param translate - Translation function
 * @param escapeHtml - HTML escape function
 * @param visit - unist-util-visit function
 * @returns Remark plugin function
 */
export function createRemarkPlugin(
  plugin: BasePlugin,
  renderer: PluginRenderer,
  asyncTask: AsyncTaskQueueManager['asyncTask'],
  translate: TranslateFunction,
  escapeHtml: EscapeHtmlFunction,
  visit: VisitFn
): () => (tree: unknown) => void {  
  return function() {
    return (tree: unknown) => {
      // Visit all node types
      for (const nodeType of plugin.nodeSelector) {
        visit(tree, nodeType, (node, index, parent) => {
          const content = plugin.extractContent(node);
          if (!content) return;

          const isInline = plugin.isInline();
          const placeholderPlugin = { ...plugin, isInline: () => isInline } as typeof plugin;

          // Determine initial status: URLs need fetching
          const initialStatus = plugin.isUrl(content) ? 'fetching' : 'ready';

          const result = asyncTask(
            async (data: TaskData) => {
              const { id, code, sourceHash } = data;
              try {
                const renderResult = await renderer.render(plugin.type, code || '');
                
                // If renderer returns null (e.g., empty content), skip rendering
                if (renderResult) {
                  replacePlaceholderWithImage(id, renderResult, plugin.type, isInline, sourceHash as string);
                } else {
                  // Remove placeholder element if content is empty
                  const placeholder = document.getElementById(id);
                  if (placeholder) {
                    placeholder.remove();
                  }
                }
              } catch (error) {
                // Skip error display if context was cancelled or render was cancelled
                if ((error as Error).message === 'Render cancelled' || (error as Error).message === 'Request cancelled') {
                  return;
                }
                
                // Show error
                const placeholder = document.getElementById(id);
                if (placeholder) {
                  const errorDetail = escapeHtml((error as Error).message || '');
                  const localizedError = translate('async_processing_error', [plugin.type, errorDetail]) 
                    || `${plugin.type} error: ${errorDetail}`;
                  placeholder.outerHTML = createErrorHTML(localizedError);
                }
              }
            },
            withNodeSourceInfo(plugin.createTaskData(content), node),
            placeholderPlugin,
            translate,
            initialStatus
          );

          // For URLs, start fetching immediately
          if (plugin.isUrl(content)) {
            plugin.fetchContent(content)
              .then(fetchedContent => {
                result.task.data.code = fetchedContent;
                result.task.setReady();
              })
              .catch(error => {
                result.task.setError(error);
              });
          }

          const parentWithChildren = parent as { children?: unknown[] } | undefined;
          if (index === undefined || !parentWithChildren || !Array.isArray(parentWithChildren.children)) return;
          parentWithChildren.children[index] = result.placeholder as unknown;
        });
      }
    };
  };
}
