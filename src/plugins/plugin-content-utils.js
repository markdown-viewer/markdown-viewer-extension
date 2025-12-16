/**
 * Plugin Content Script Utilities
 * Handles content script specific logic for plugins (HTML generation, remark integration)
 */

/**
 * Create async placeholder element HTML (before rendering)
 * @param {string} id - Placeholder element ID
 * @param {string} pluginType - Plugin type identifier
 * @param {boolean} isInline - Whether to render inline or block
 * @param {Function} translate - Translation function
 * @returns {string} Placeholder HTML
 */
export function createPlaceholderElement(id, pluginType, isInline, translate) {
  // Generate translation key dynamically based on type
  const typeLabelKey = `async_placeholder_type_${pluginType.replace(/-/g, '')}`;
  const typeLabel = translate(typeLabelKey) || '';
  
  // If no translation found, use type as fallback
  const resolvedTypeLabel = typeLabel || pluginType;
  const processingText = translate('async_processing_message', [resolvedTypeLabel, ''])
    || `Processing ${resolvedTypeLabel}...`;

  if (isInline) {
    return `<span id="${id}" class="async-placeholder ${pluginType}-placeholder inline-placeholder">
      <span class="async-loading">
        <span class="async-spinner"></span>
        <span class="async-text">${processingText}</span>
      </span>
    </span>`;
  }

  return `<div id="${id}" class="async-placeholder ${pluginType}-placeholder">
    <div class="async-loading">
      <div class="async-spinner"></div>
      <div class="async-text">${processingText}</div>
    </div>
  </div>`;
}

/**
 * Create error HTML
 * @param {string} errorMessage - Localized error message
 * @returns {string} Error HTML
 */
export function createErrorHTML(errorMessage) {
  return `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${errorMessage}</pre>`;
}

/**
 * Create remark plugin function for a plugin
 * @param {object} plugin - Plugin instance
 * @param {object} renderer - Renderer instance
 * @param {Function} asyncTask - Async task creator
 * @param {Function} translate - Translation function
 * @param {Function} escapeHtml - HTML escape function
 * @param {Function} visit - unist-util-visit function
 * @returns {Function} Remark plugin function
 */
export function createRemarkPlugin(plugin, renderer, asyncTask, translate, escapeHtml, visit) {
  return function() {
    return (tree) => {
      // Visit all node types
      for (const nodeType of plugin.nodeSelector) {
        visit(tree, nodeType, (node, index, parent) => {
          const content = plugin.extractContent(node);
          if (!content) return;

          // Determine initial status: URLs need fetching
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
                // If renderer returns null (e.g., empty content), skip rendering
                if (renderResult) {
                  // Dynamically import HTML utils to replace placeholder
                  const { replacePlaceholderWithImage } = await import('./plugin-html-utils.js');
                  replacePlaceholderWithImage(id, renderResult, plugin.type, plugin.isInline());
                } else {
                  // Remove placeholder element if content is empty
                  const placeholder = document.getElementById(id);
                  if (placeholder) {
                    placeholder.remove();
                  }
                }
              } catch (error) {
                // Show error
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
        });
      }
    };
  };
}
