/**
 * Plugin Registry
 * 
 * Centralized plugin management system.
 * New plugins can be added here without modifying content.js or docx-exporter.js.
 * 
 * Architecture:
 * - registerRemarkPlugins(): Register all plugins for remark processing (content.js)
 * - getPluginByType(): Get a specific plugin by type (docx-exporter.js)
 * - plugins: Direct access to plugin array (for advanced use)
 */
import { MermaidPlugin } from './mermaid-plugin.js';
import { VegaLitePlugin } from './vegalite-plugin.js';
import { VegaPlugin } from './vega-plugin.js';
import { HtmlPlugin } from './html-plugin.js';
import { SvgPlugin } from './svg-plugin.js';
import { replacePlaceholderWithImage } from './plugin-html-utils.js';
import { createErrorHTML } from './plugin-content-utils.js';

// Plugin instances array
// Order matters: HTML plugin first to process raw HTML before other plugins generate placeholders
export const plugins = [
  new HtmlPlugin(),
  new MermaidPlugin(),
  new VegaLitePlugin(),
  new VegaPlugin(),
  new SvgPlugin()
];

/**
 * Register all plugins to a remark processor
 * This creates a single unified plugin that processes all node types in document order
 * @param {object} processor - Unified/remark processor
 * @param {object} renderer - Renderer instance
 * @param {Function} asyncTask - Async task creator
 * @param {Function} translate - Translation function
 * @param {Function} escapeHtml - HTML escape function
 * @param {Function} visit - unist-util-visit function
 * @returns {object} The processor (for chaining)
 */
export function registerRemarkPlugins(processor, renderer, asyncTask, translate, escapeHtml, visit) {
  // Create a unified plugin that processes all plugins in a single AST traversal
  // This ensures tasks are created in document order, not grouped by plugin type
  processor.use(function unifiedPluginProcessor() {
    return (tree) => {
      // Collect all unique node types that plugins are interested in
      const nodeTypes = new Set();
      for (const plugin of plugins) {
        for (const nodeType of plugin.nodeSelector) {
          nodeTypes.add(nodeType);
        }
      }

      // Single traversal of AST, processing nodes in document order
      for (const nodeType of nodeTypes) {
        visit(tree, nodeType, (node, index, parent) => {
          // Find the first plugin that can handle this node
          for (const plugin of plugins) {
            const content = plugin.extractContent(node);
            if (!content) continue;

            // This plugin can handle this node, create async task
            const initialStatus = plugin.isUrl(content) ? 'fetching' : 'ready';

            const result = asyncTask(
              async (data) => {
                const { id, code } = data;
                try {
                  const extraParams = plugin.getRenderParams();
                  // Use SVG format for browser display (fonts render correctly)
                  // Exception: HTML plugin uses PNG format (doesn't support SVG)
                  extraParams.outputFormat = plugin.type === 'html' ? 'png' : 'svg';
                  const renderResult = await renderer.render(plugin.type, code, extraParams);
                  if (renderResult) {
                    replacePlaceholderWithImage(id, renderResult, plugin.type, plugin.isInline());
                  } else {
                    const placeholder = document.getElementById(id);
                    if (placeholder) {
                      placeholder.remove();
                    }
                  }
                } catch (error) {
                  const placeholder = document.getElementById(id);
                  if (placeholder) {
                    const errorDetail = escapeHtml(error.message || '');
                    const localizedError = translate('async_processing_error', [plugin.type, errorDetail]) 
                      || `${plugin.type} error: ${errorDetail}`;
                    placeholder.outerHTML = createErrorHTML(localizedError);
                  }
                }
              },
              plugin.createTaskData(content),
              plugin,
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

            parent.children[index] = result.placeholder;
            
            // Stop checking other plugins once we found a match
            break;
          }
        });
      }
    };
  });

  return processor;
}

/**
 * Get a plugin by type
 * @param {string} type - Plugin type (e.g., 'mermaid', 'svg', 'html')
 * @returns {object|null} Plugin instance or null if not found
 */
export function getPluginByType(type) {
  return plugins.find(p => p.type === type) || null;
}

/**
 * Get a plugin that can handle a specific AST node
 * @param {object} node - AST node (e.g., code block or html node)
 * @returns {object|null} Plugin instance or null if no plugin can handle
 */
export function getPluginForNode(node) {
  for (const plugin of plugins) {
    // Let each plugin decide if it can handle this node
    if (plugin.extractContent(node) !== null) {
      return plugin;
    }
  }
  
  return null;
}

/**
 * Get all plugin types
 * @returns {string[]} Array of plugin types
 */
export function getPluginTypes() {
  return plugins.map(p => p.type);
}

/**
 * Convert AST node to DOCX element using appropriate plugin
 * High-level wrapper that encapsulates plugin lookup, content extraction, and conversion
 * 
 * @param {object} node - AST node to convert
 * @param {object} renderer - Renderer instance for generating images
 * @param {object} docxHelpers - DOCX helper objects and functions
 * @param {Function} progressCallback - Optional callback to report progress
 * @returns {Promise<object|null>} DOCX element (Paragraph/ImageRun) or null if no plugin handles this node
 */
export async function convertNodeToDOCX(node, renderer, docxHelpers, progressCallback = null) {
  // Import conversion function
  const { convertPluginResultToDOCX } = await import('../exporters/docx-exporter.js');
  
  // Find plugin that can handle this node
  const plugin = getPluginForNode(node);
  if (!plugin) {
    return null;
  }

  // Extract content from node
  let content = plugin.extractContent(node);
  if (!content) {
    return null;
  }

  // Handle URL fetching if needed
  if (plugin.isUrl && plugin.isUrl(content)) {
    content = await plugin.fetchContent(content);
  }

  // Render to unified format
  const renderResult = await plugin.renderToCommon(renderer, content);
  
  // Convert to DOCX
  const result = convertPluginResultToDOCX(renderResult, plugin.type);

  // Report progress if callback provided
  if (progressCallback) {
    progressCallback();
  }

  return result;
}