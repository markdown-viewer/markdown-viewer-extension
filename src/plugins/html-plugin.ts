/**
 * HTML Plugin
 * 
 * Handles HTML code block processing in content script and DOCX export
 */
import { BasePlugin } from './base-plugin';
import { sanitizeAndCheck } from '../utils/html-sanitizer';
import { loadImageAsDataUrl } from '../utils/image-loader';
import type { DocumentService } from '../types/platform';

/**
 * AST node interface for HTML plugin
 */
interface AstNode {
  type: string;
  value?: string;
}

export class HtmlPlugin extends BasePlugin {
  private pendingStyle = '';

  constructor() {
    super('html');
  }

  resetState(): void {
    this.pendingStyle = '';
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
      if (!src) return;

      // Remote images: convert via <img> + canvas in main webview
      // (render worker srcdoc iframe has sandbox restrictions)
      if (src.startsWith('http://') || src.startsWith('https://')) {
        try {
          const dataUrl = await loadImageAsDataUrl(src);
          if (dataUrl) {
            img.setAttribute('src', dataUrl);
          }
        } catch (error) {
          console.warn(`[HtmlPlugin] Failed to inline remote image: ${src}`, error);
        }
        return;
      }

      if (!isLocalImageSrc(src)) {
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
    // Mark HTML tables for DOM-based handling
    const tables = Array.from(container.querySelectorAll('table'));
    tables.forEach((table, index) => {
      table.setAttribute('data-table-dom', 'true');
      if (!table.getAttribute('data-table-id')) {
        table.setAttribute('data-table-id', `html-table-${index + 1}`);
      }
    });
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

    let htmlContent = node.value?.trim() || '';
    if (!htmlContent) {
      return null;
    }

    // If this block is only a <style>...</style>, cache it and wait for the next HTML block
    if (isStyleOnlyBlock(htmlContent)) {
      this.pendingStyle += htmlContent;
      return null;
    }

    if (this.pendingStyle) {
      htmlContent = this.pendingStyle + htmlContent;
      this.pendingStyle = '';
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

function isStyleOnlyBlock(html: string): boolean {
  const trimmed = html.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith('<style')) return false;
  if (!trimmed.endsWith('</style>')) return false;
  // Ensure only a single top-level style tag
  return /^<style[\s\S]*<\/style>$/.test(trimmed);
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
