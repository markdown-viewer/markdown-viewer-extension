/**
 * SVG Plugin
 * 
 * Handles SVG code blocks and SVG image files in content script and DOCX export
 */
import { BasePlugin } from './base-plugin';
import type { DocumentService } from '../types/platform';

/**
 * AST node interface for SVG plugin
 */
interface AstNode {
  type: string;
  lang?: string;
  value?: string;
  url?: string;
}

export class SvgPlugin extends BasePlugin {
  private _currentNodeType: string | null = null;

  constructor() {
    super('svg');
    this._currentNodeType = null; // Track current node type being processed
  }

  /**
   * Extract content from AST node
   * Handles both SVG code blocks and SVG image files
   * @param node - AST node
   * @returns SVG content or URL, or null if not applicable
   */
  extractContent(node: AstNode): string | null {
    // Store node type for isInline() to use
    this._currentNodeType = node.type;

    // Handle SVG code blocks: ```svg ... ```
    if (node.type === 'code' && node.lang === 'svg') {
      return node.value || null;
    }

    // Handle SVG image files: ![](*.svg)
    if (node.type === 'image') {
      const url = node.url || '';
      const isSvg = url.toLowerCase().endsWith('.svg') || 
                    url.toLowerCase().includes('image/svg+xml');
      if (isSvg) {
        return url; // Return URL for later fetching
      }
    }

    return null;
  }

  /**
   * SVG uses inline rendering for images, block for code blocks
   * @returns True for inline rendering (images), false for block (code blocks)
   */
  isInline(): boolean {
    return this._currentNodeType === 'image';
  }

  /**
   * Check if content is a URL (for image nodes)
   * SVG code block content (containing <svg> tags) is never a URL.
   * @param content - Extracted content
   * @returns True if content is a URL
   */
  isUrl(content: string): boolean {
    // SVG markup from code blocks is not a URL
    if (content.includes('<svg')) {
      return false;
    }
    return content.startsWith('http://') || 
           content.startsWith('https://') ||
           content.startsWith('file://') ||
           content.startsWith('data:') ||
           content.includes('/') || // Relative paths
           content.includes('\\'); // Windows paths
  }

  /**
   * Fetch SVG content from URL
   * Uses DocumentService for unified file access across all platforms.
   * @param url - URL to fetch (http://, https://, file://, data:, or relative path)
   * @returns SVG content
   */
  async fetchContent(url: string): Promise<string> {
    // Handle data: URLs (no platform API needed)
    if (url.startsWith('data:image/svg+xml')) {
      const base64Match = url.match(/^data:image\/svg\+xml;base64,(.+)$/);
      if (base64Match) {
        return atob(base64Match[1]);
      }
      const urlMatch = url.match(/^data:image\/svg\+xml[;,](.+)$/);
      if (urlMatch) {
        return decodeURIComponent(urlMatch[1]);
      }
      throw new Error('Unsupported SVG data URL format');
    }

    // Get DocumentService from platform
    const doc = (globalThis.platform as { document?: DocumentService } | undefined)?.document;
    if (!doc) {
      throw new Error('DocumentService not available - platform not initialized');
    }

    // Handle http:// and https:// URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Use DocumentService.fetchRemote for CSP-safe remote fetch
      const data = await doc.fetchRemote(url);
      return new TextDecoder().decode(data);
    }

    // Handle local file:// URLs or relative paths
    // Strip file:// prefix if present
    const filePath = url.startsWith('file://') ? url.slice(7) : url;
    
    try {
      return await doc.readRelativeFile(filePath);
    } catch (error) {
      throw new Error(`Cannot load SVG file: ${url} - ${(error as Error).message}`);
    }
  }

  /**
   * Get AST node selector(s) for remark visit
   * SVG plugin handles both code blocks and image nodes
   * @returns Array of node types ['code', 'image']
   */
  get nodeSelector(): string[] {
    return ['code', 'image'];
  }
}
