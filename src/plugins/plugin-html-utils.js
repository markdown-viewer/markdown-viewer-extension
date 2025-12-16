/**
 * Plugin HTML Utilities
 * Converts unified plugin render results to HTML
 */

/**
 * Convert unified plugin render result to HTML string
 * @param {string} id - Placeholder element ID
 * @param {object} renderResult - Unified render result from plugin.renderToCommon()
 * @param {string} pluginType - Plugin type for alt text
 * @returns {string} HTML string
 */
export function convertPluginResultToHTML(id, renderResult, pluginType = 'diagram') {
  if (renderResult.type === 'empty') {
    return '';
  }
  
  if (renderResult.type === 'error') {
    return `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${renderResult.content.text}</pre>`;
  }
  
  // Handle SVG format
  if (renderResult.type === 'svg') {
    const { svg, width } = renderResult.content;
    const { inline } = renderResult.display;
    const displayWidth = Math.round(width / 4);
    
    if (inline) {
      return `<span class="diagram-inline" style="display: inline-block;">
        <span class="diagram-svg" style="display: inline-block; width: ${displayWidth}px; max-width: 100%; vertical-align: middle;">${svg}</span>
      </span>`;
    }
    
    return `<div class="diagram-block" style="text-align: center; margin: 20px 0;">
      <div class="diagram-svg" style="display: inline-block; width: ${displayWidth}px; max-width: 100%;">${svg}</div>
    </div>`;
  }
  
  // Handle PNG image format
  if (renderResult.type === 'image') {
    const { base64, width } = renderResult.content;
    const { inline } = renderResult.display;
    const displayWidth = Math.round(width / 4);
    
    if (inline) {
      return `<span class="diagram-inline" style="display: inline-block;">
        <img src="data:image/png;base64,${base64}" alt="${pluginType} diagram" width="${displayWidth}px" style="vertical-align: middle;" />
      </span>`;
    }
    
    return `<div class="diagram-block" style="text-align: center; margin: 20px 0;">
      <img src="data:image/png;base64,${base64}" alt="${pluginType} diagram" width="${displayWidth}px" />
    </div>`;
  }
  
  return '';
}

/**
 * Replace placeholder with rendered content in DOM
 * @param {string} id - Placeholder element ID
 * @param {object} result - Render result with base64/svg/html, width, height, format
 * @param {string} pluginType - Plugin type
 * @param {boolean} isInline - Whether to render inline or block
 */
export function replacePlaceholderWithImage(id, result, pluginType, isInline) {
  const placeholder = document.getElementById(id);
  if (placeholder) {
    // Determine result type based on format field
    let resultType;
    if (result.format === 'svg') {
      resultType = 'svg';
    } else if (result.format === 'html') {
      resultType = 'html';
    } else {
      resultType = 'image';
    }
    
    // Convert result to unified format
    let content;
    if (resultType === 'svg') {
      content = { svg: result.svg, width: result.width, height: result.height };
    } else if (resultType === 'html') {
      content = { html: result.html, width: result.width, height: result.height };
    } else {
      content = { base64: result.base64, width: result.width, height: result.height };
    }
    
    const renderResult = {
      type: resultType,
      content: content,
      display: {
        inline: isInline
      }
    };
    placeholder.outerHTML = convertPluginResultToHTML(id, renderResult, pluginType);
  }
}
