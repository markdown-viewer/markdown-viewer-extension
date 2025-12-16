/**
 * Base Plugin Class
 * 
 * Abstract base class for diagram plugins.
 * Defines the plugin interface and core rendering logic.
 */

export class BasePlugin {
  /**
   * @param {string} type - Plugin type identifier (e.g., 'mermaid', 'vega')
   */
  constructor(type) {
    if (this.constructor === BasePlugin) {
      throw new Error('BasePlugin is abstract and cannot be instantiated directly');
    }
    this.type = type;
  }

  /**
   * Get AST node selectors for remark visit
   * @returns {string[]} Array of node types to visit (e.g., ['code'], ['code', 'image'])
   */
  get nodeSelector() {
    return ['code']; // Default: only code blocks
  }

  /**
   * Get language identifier for code blocks
   * @returns {string|null} Language identifier or null for non-code nodes
   */
  get language() {
    return this.type; // Default: type matches language
  }

  /**
   * Extract content from AST node
   * Plugins override this to implement their own node matching logic
   * @param {object} node - AST node
   * @returns {string|null} Extracted content or null if not applicable
   */
  extractContent(node) {
    // Check node type matches selector
    if (!this.nodeSelector.includes(node.type)) {
      return null;
    }

    // Check language for code blocks
    if (this.language && node.lang !== this.language) {
      return null;
    }
    
    return node.value || null;
  }

  /**
   * Create async task data for rendering
   * @param {string} content - Extracted content
   * @returns {object} Task data with code and any extra parameters
   */
  createTaskData(content) {
    return { code: content };
  }

  /**
   * Get extra rendering parameters
   * @returns {object} Extra parameters for renderer
   */
  getRenderParams() {
    return {};
  }

  /**
   * Check if this plugin uses inline rendering
   * @returns {boolean} True for inline (span), false for block (div)
   */
  isInline() {
    return false; // Default: block-level
  }

  /**
   * Check if extracted content is a URL that needs fetching
   * @param {string} content - Extracted content
   * @returns {boolean} True if content is a URL
   */
  isUrl(content) {
    return false; // Default: content is not a URL
  }

  /**
   * Fetch content from URL
   * @param {string} url - URL to fetch
   * @returns {Promise<string>} Fetched content
   */
  async fetchContent(url) {
    throw new Error('fetchContent not implemented');
  }

  /**
   * Render content to unified intermediate format
   * This is the core rendering method that returns a format-agnostic result
   * @param {object} renderer - Renderer instance
   * @param {string} content - Content to render
   * @returns {Promise<object>} Unified render result
   * Format:
   * {
   *   type: 'image' | 'text' | 'error' | 'empty',
   *   content: {
   *     data: Uint8Array,  // for type='image': PNG bytes
   *     text: string,      // for type='text' or 'error': text content
   *     width: number,     // for type='image': original width
   *     height: number,    // for type='image': original height
   *     format: string     // for type='image': 'png'
   *   },
   *   display: {
   *     inline: boolean,      // inline vs block display
   *     alignment: string     // 'left' | 'center' | 'right'
   *   }
   * }
   */
  async renderToCommon(renderer, content) {
    const inline = this.isInline();
    
    // No renderer available
    if (!renderer) {
      return {
        type: 'error',
        content: {
          text: `[${this.type} - Renderer not available]`
        },
        display: {
          inline: inline,
          alignment: 'left'
        }
      };
    }

    try {
      const extraParams = this.getRenderParams();
      // Use PNG format for DOCX export (binary format required)
      extraParams.outputFormat = 'png';
      const pngResult = await renderer.render(this.type, content, extraParams);

      // Empty content
      if (!pngResult) {
        return {
          type: 'empty',
          content: {},
          display: {
            inline: inline,
            alignment: 'left'
          }
        };
      }

      // Convert base64 to Uint8Array
      const binaryString = atob(pngResult.base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Return image result
      return {
        type: 'image',
        content: {
          data: bytes,
          base64: pngResult.base64,  // Keep base64 for HTML rendering
          width: pngResult.width,
          height: pngResult.height,
          format: 'png'
        },
        display: {
          inline: inline,
          alignment: inline ? 'left' : 'center'
        }
      };
    } catch (error) {
      console.warn(`Failed to render ${this.type}:`, error);
      
      return {
        type: 'error',
        content: {
          text: `[${this.type} Error: ${error.message}]`
        },
        display: {
          inline: inline,
          alignment: 'left'
        }
      };
    }
  }
}

