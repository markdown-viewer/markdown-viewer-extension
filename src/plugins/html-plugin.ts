/**
 * HTML Plugin
 * 
 * Handles HTML code block processing in content script and DOCX export
 */
import { BasePlugin } from './base-plugin';
import { sanitizeAndCheck } from '../utils/html-sanitizer';
import type { DocumentService } from '../types/platform';

/**
 * AST node interface for HTML plugin
 */
interface AstNode {
  type: string;
  value?: string;
}

export class HtmlPlugin extends BasePlugin {
  constructor() {
    super('html');
  }

  /**
   * Inline local images as data URLs before rendering
   * @param content - Raw HTML content
   * @returns HTML with local images inlined
   */
  override async preprocessContent(content: string): Promise<string> {
    if (typeof document === 'undefined') {
      return content;
    }

    const docService = (globalThis.platform as { document?: DocumentService } | undefined)?.document;
    if (!docService) {
      return content;
    }

    const container = document.createElement('div');
    container.innerHTML = content;

    const images = Array.from(container.querySelectorAll('img[src]'));
    if (images.length === 0) {
      return content;
    }

    const tasks = images.map(async (img) => {
      const src = img.getAttribute('src');
      if (!src || !isLocalImageSrc(src)) {
        return;
      }

      try {
        const resolvedPath = resolveLocalPath(src, docService);
        const base64 = await docService.readFile(resolvedPath, { binary: true });
        const mimeType = getImageMimeType(src);
        img.setAttribute('src', `data:${mimeType};base64,${base64}`);
      } catch (error) {
        console.warn(`[HtmlPlugin] Failed to inline local image: ${src}`, error);
      }
    });

    await Promise.all(tasks);
    return container.innerHTML;
  }

  /**
   * Get AST node selectors for remark visit
   * @returns Array with 'html' node type
   */
  get nodeSelector(): string[] {
    return ['html'];
  }

  /**
   * Extract content from HTML node
   * @param node - AST node
   * @returns Extracted content or null
   */
  extractContent(node: AstNode): string | null {
    // Only process 'html' type nodes
    if (node.type !== 'html') {
      return null;
    }

    const htmlContent = node.value?.trim() || '';
    if (!htmlContent) {
      return null;
    }

    // Sanitize HTML and check if it has meaningful content
    // This removes comments, scripts, dangerous elements, and simple line breaks
    const { hasContent } = sanitizeAndCheck(htmlContent);
    if (!hasContent) {
      return null;
    }

    return htmlContent;
  }
}

function isLocalImageSrc(src: string): boolean {
  if (!src) return false;
  const lower = src.toLowerCase();

  if (lower.startsWith('data:') || lower.startsWith('blob:')) {
    return false;
  }

  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')) {
    return false;
  }

  if (lower.startsWith('vscode-webview-resource:') ||
      lower.startsWith('vscode-resource:') ||
      lower.startsWith('chrome-extension:') ||
      lower.startsWith('moz-extension:')) {
    return false;
  }

  if (isWindowsDrivePath(src)) {
    return true;
  }

  if (lower.startsWith('file://')) {
    return true;
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src);
  if (hasScheme) {
    return false;
  }

  return true;
}

function resolveLocalPath(src: string, docService: DocumentService): string {
  if (src.toLowerCase().startsWith('file://')) {
    return src;
  }

  if (isWindowsDrivePath(src)) {
    const normalized = src.replace(/\\/g, '/');
    return `file:///${normalized}`;
  }

  return docService.resolvePath(src);
}

function getImageMimeType(src: string): string {
  const clean = src.split('?')[0]?.split('#')[0] || '';
  const ext = clean.toLowerCase().split('.').pop() || '';
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon'
  };
  return mimeTypes[ext] || 'image/png';
}

function isWindowsDrivePath(src: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(src);
}
