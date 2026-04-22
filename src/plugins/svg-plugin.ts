/**
 * SVG Plugin
 * 
 * Handles SVG code blocks and SVG image files in content script and DOCX export
 */
import { BasePlugin } from './base-plugin';
import type { DocumentService } from '../types/platform';
import {
  ensureRelativeDotSlash,
  isAbsoluteFilesystemPath,
  isDocumentRelativeUrl,
  isNetworkUrl,
} from '../utils/document-url';

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
    // Remote URLs are passed directly to the renderer for loading via <img>
    if (isNetworkUrl(content)) {
      return false;
    }
    // File paths: absolute, relative with ../, ./, or with / or \ separators
    // Also treat anything with a file extension as a path
    return content.startsWith('file://') ||
           content.startsWith('data:') ||
           content.startsWith('./') ||
           content.startsWith('../') ||
           content.includes('/') || // Relative paths with directories
           content.includes('\\') || // Windows paths
           /\.\w+$/.test(content); // Any filename with extension (e.g., "test.svg")
  }

  /**
   * Fetch SVG content from URL
   * Uses DocumentService for unified file access across all platforms.
   * @param url - URL to fetch (file://, data:, or relative path)
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

    try {
      if (url.startsWith('file://')) {
        return await doc.readFile(url.slice(7));
      }

      if (url.startsWith('data:')) {
        return await doc.readFile(url);
      }

      if (isDocumentRelativeUrl(url)) {
        const normalizedRelativePath = ensureRelativeDotSlash(url);
        const resolvedPath = doc.resolvePath(normalizedRelativePath);
        return isAbsoluteFilesystemPath(resolvedPath)
          ? await doc.readFile(stripFileProtocol(resolvedPath))
          : await doc.readRelativeFile(resolvedPath);
      }

      return await doc.readFile(stripFileProtocol(url));
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

function stripFileProtocol(path: string): string {
  return path.startsWith('file://') ? path.slice(7) : path;
}
