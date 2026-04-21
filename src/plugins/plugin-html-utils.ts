/**
 * Plugin HTML Utilities
 * Converts unified plugin render results to HTML
 */

import type { PluginRenderResult, UnifiedRenderResult } from '../types/index';
import { registerDiagramExport } from '../ui/diagram-export-registry';

/**
 * Convert unified plugin render result to HTML string
 * @param id - Placeholder element ID
 * @param renderResult - Unified render result from plugin.renderToCommon()
 * @param pluginType - Plugin type for alt text
 * @param sourceHash - Content hash for DOM diff matching
 * @returns HTML string
 */
export function convertPluginResultToHTML(
  id: string,
  renderResult: UnifiedRenderResult,
  pluginType = 'diagram',
  sourceHash?: string
): string {
  if (renderResult.type === 'empty') {
    return '';
  }
  
  if (renderResult.type === 'error') {
    return `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${renderResult.content.text}</pre>`;
  }
  
  // Handle PNG image format
  if (renderResult.type === 'image') {
    const { base64, width } = renderResult.content;
    const { inline } = renderResult.display;
    const displayWidth = Math.round((width || 0) / 4);
    
    // Data attributes for DOM diff matching - mark as rendered
    const dataAttrs = sourceHash 
      ? `data-source-hash="${sourceHash}" data-plugin-type="${pluginType}" data-plugin-rendered="true"` 
      : '';
    
    if (inline) {
      return `<img class="diagram-inline" src="data:image/png;base64,${base64}" alt="${pluginType} diagram" width="${displayWidth}px" ${dataAttrs} />`;
    }
    
    return `<div class="diagram-block" style="text-align: center; margin: 20px 0;" ${dataAttrs}>
      <img src="data:image/png;base64,${base64}" alt="${pluginType} diagram" width="${displayWidth}px" />
    </div>`;
  }
  
  return '';
}

/**
 * Replace placeholder with rendered content in DOM
 * @param id - Placeholder element ID
 * @param result - Render result with base64, width, height, format
 * @param pluginType - Plugin type
 * @param isInline - Whether to render inline or block
 * @param expectedSourceHash - Source hash to validate against placeholder (prevents race conditions)
 */
export function replacePlaceholderWithImage(id: string, result: PluginRenderResult, pluginType: string, isInline: boolean, expectedSourceHash: string): void {
  const placeholder = document.getElementById(id);
  if (placeholder) {
    // Preserve source hash from placeholder for DOM diff matching
    const sourceHash = (placeholder as HTMLElement).dataset?.sourceHash;
    
    // Validate source hash match to prevent concurrent rendering race conditions
    if (sourceHash && expectedSourceHash !== sourceHash) {
      return;
    }
    
    // Convert result to unified format (always PNG)
    const content: UnifiedRenderResult['content'] = { 
      base64: result.base64, 
      width: result.width, 
      height: result.height 
    };
    
    const renderResult: UnifiedRenderResult = {
      type: 'image',
      content: content,
      display: {
        inline: isInline,
        alignment: isInline ? 'left' : 'center'
      }
    };
    placeholder.outerHTML = convertPluginResultToHTML(id, renderResult, pluginType, sourceHash);

    // Register intermediate formats for diagram export (SVG, DrawIO)
    if (sourceHash && (result.svg || result.drawioXml)) {
      registerDiagramExport(sourceHash, {
        pluginType,
        svg: result.svg,
        drawioXml: result.drawioXml,
      });
    }
  }
}
