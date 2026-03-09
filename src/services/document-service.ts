/**
 * Document Service Base Implementation
 * 
 * Provides a base class for platform-specific DocumentService implementations.
 * Handles common path resolution logic.
 */

import type { DocumentService, ReadFileOptions } from '../types/platform';

/**
 * Abstract base class for DocumentService implementations.
 * Subclasses must implement platform-specific file reading and remote fetching.
 */
export abstract class BaseDocumentService implements DocumentService {
  protected _documentPath = '';
  protected _documentDir = '';
  protected _baseUrl = '';
  protected _needsUriRewrite = false;

  // === Context Information (readonly getters) ===

  get documentPath(): string {
    return this._documentPath;
  }

  get documentDir(): string {
    return this._documentDir;
  }

  get baseUrl(): string {
    return this._baseUrl;
  }

  get needsUriRewrite(): boolean {
    return this._needsUriRewrite;
  }

  // === Context Management ===

  setDocumentPath(path: string, baseUrl?: string): void {
    this._documentPath = path;
    // Extract directory from path
    const lastSlash = path.lastIndexOf('/');
    this._documentDir = lastSlash >= 0 ? path.substring(0, lastSlash + 1) : '';
    
    if (baseUrl !== undefined) {
      this._baseUrl = baseUrl;
    } else {
      // Default: use file:// URL for the directory
      this._baseUrl = `file://${this._documentDir}`;
    }
  }

  // === Path Resolution ===

  resolvePath(relativePath: string): string {
    if (!relativePath) return this._documentDir;
    
    // Handle different relative path formats
    if (relativePath.startsWith('/')) {
      // Absolute path - return as-is
      return relativePath;
    }
    
    if (relativePath.startsWith('./')) {
      // Explicit current directory
      return `${this._documentDir}${relativePath.substring(2)}`;
    }
    
    if (relativePath.startsWith('../')) {
      // Parent directory - use URL resolution for proper handling
      try {
        const resolved = new URL(relativePath, `file://${this._documentDir}`);
        return resolved.pathname;
      } catch {
        // Fallback: simple concatenation
        return `${this._documentDir}${relativePath}`;
      }
    }
    
    // Implicit current directory
    return `${this._documentDir}${relativePath}`;
  }

  toResourceUrl(absolutePath: string): string {
    // Default implementation: file:// URL
    if (absolutePath.startsWith('file://')) {
      return absolutePath;
    }
    return `file://${absolutePath}`;
  }

  // === Abstract Methods (platform-specific) ===

  abstract readFile(absolutePath: string, options?: ReadFileOptions): Promise<string>;
  abstract readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string>;
}
