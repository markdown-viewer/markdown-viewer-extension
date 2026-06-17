/**
 * Base Plugin Class
 * 
 * Abstract base class for diagram plugins.
 * Defines the plugin interface and core rendering logic.
 */

import type { ASTNode, PluginRenderer, PluginRenderResult, UnifiedRenderResult } from '../types/index';
import { CODE_BLOCK_LANGUAGE_MAP } from '../types/formats';

export class BasePlugin {
  type: string;

  /**
   * @param type - Plugin type identifier (e.g., 'mermaid', 'vega')
   */
  constructor(type: string) {
    if (this.constructor === BasePlugin) {
      throw new Error('BasePlugin is abstract and cannot be instantiated directly');
    }
    this.type = type;
  }

  /**
   * Get AST node selectors for remark visit
   * @returns Array of node types to visit (e.g., ['code'], ['code', 'image'])
   */
  get nodeSelector(): string[] {
    return ['code']; // Default: only code blocks
  }

  /**
   * Get language identifier for code blocks
   * @returns Language identifier or null for non-code nodes
   */
  get language(): string | null {
    return this.type; // Default: type matches language
  }

  /**
   * Extract content from AST node
   * Plugins override this to implement their own node matching logic
   * @param node - AST node
   * @returns Extracted content or null if not applicable
   */
  extractContent(node: ASTNode): string | null {
    // Check node type matches selector
    if (!this.nodeSelector.includes(node.type)) {
      return null;
    }

    // Check language for code blocks.
    // The central CODE_BLOCK_LANGUAGE_MAP maps all aliases (e.g. 'wsd',
    // 'puml', 'vegalite', 'graphviz') to fileType, so subclasses don't
    // need to override extractContent just to handle language aliases.
    if (this.language && node.lang) {
      const resolvedType = CODE_BLOCK_LANGUAGE_MAP[node.lang.toLowerCase()];
      if (resolvedType !== this.type) {
        return null;
      }
    } else if (this.language && node.lang !== this.language) {
      return null;
    }

    return node.value || null;
  }

  /**
   * Create async task data for rendering
   * @param content - Extracted content
   * @returns Task data with code and any extra parameters
   */
  createTaskData(content: string): Record<string, unknown> {
    return { code: content };
  }

  /**
   * Get extra rendering parameters
   * @returns Extra parameters for renderer
   */
  getRenderParams(): Record<string, unknown> {
    return {};
  }

  /**
   * Check if this plugin uses inline rendering
   * @returns True for inline (span), false for block (div)
   */
  isInline(): boolean {
    return false; // Default: block-level
  }

  /**
   * Check if extracted content is a URL that needs fetching
   * @param content - Extracted content
   * @returns True if content is a URL
   */
  isUrl(content: string): boolean {
    return false; // Default: content is not a URL
  }

  /**
   * Fetch content from URL
   * @param url - URL to fetch
   * @returns Fetched content
   */
  async fetchContent(url: string): Promise<string> {
    throw new Error('fetchContent not implemented');
  }

  /**
   * Render content to unified intermediate format
   * This is the core rendering method that returns a format-agnostic result
   * @param renderer - Renderer instance
   * @param content - Content to render
   * @returns Unified render result
   */
  async renderToCommon(renderer: PluginRenderer | null, content: string): Promise<UnifiedRenderResult> {
    const inline = this.isInline();

    const processedContent = await this.preprocessContent(content);
    
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
      const pngResult = await renderer.render(this.type, processedContent);

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
      const base64 = (pngResult as PluginRenderResult).base64;
      if (typeof base64 !== 'string' || !base64) {
        throw new Error('Missing base64 data');
      }
      const binaryString = atob(base64);
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
          base64: base64,  // Keep base64 for HTML rendering
          width: (pngResult as PluginRenderResult).width,
          height: (pngResult as PluginRenderResult).height,
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
          text: `[${this.type} Error: ${(error as Error).message}]`
        },
        display: {
          inline: inline,
          alignment: 'left'
        }
      };
    }
  }

  /**
   * Optional content preprocessing hook
   * @param content - Raw content extracted from AST
   * @returns Processed content
   */
  async preprocessContent(content: string): Promise<string> {
    return content;
  }
}
