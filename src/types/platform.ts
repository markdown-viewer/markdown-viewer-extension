/**
 * Platform Type Definitions
 * Types for platform abstraction layer
 */

import type { RendererThemeConfig, RenderResult } from './render';
import type { CacheStats, SimpleCacheStats } from './cache';
import type { FileState } from './core';

// =============================================================================
// Platform Identification
// =============================================================================

export type PlatformType = 'chrome' | 'firefox' | 'mobile' | 'vscode';

// =============================================================================
// Platform Service Interfaces
// =============================================================================

/**
 * Platform message API
 */
export interface PlatformMessageAPI {
  send(message: Record<string, unknown>): Promise<unknown>;
  addListener(handler: (message: unknown) => void): void;
}

/**
 * Platform storage API
 */
export interface PlatformStorageAPI {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Platform resource API
 */
export interface PlatformResourceAPI {
  fetch(path: string): Promise<string>;
  getURL(path: string): string;
}

/**
 * Platform i18n API
 */
export interface PlatformI18nAPI {
  translate(key: string, substitutions?: string | string[]): string;
  getUILanguage(): string;
}

/**
 * Platform bridge API (mobile WebView ↔ host)
 */
export interface PlatformBridgeAPI {
  sendRequest<T = unknown>(type: string, payload: unknown): Promise<T>;
  postMessage(type: string, payload: unknown): void;
  addListener(handler: (message: unknown) => void): () => void;
}

/**
 * Download options
 */
export interface DownloadOptions {
  saveAs?: boolean;
  mimeType?: string;
  onProgress?: (progress: { uploaded: number; total: number }) => void;
}

// =============================================================================
// Service Interfaces
// =============================================================================

/**
 * Cache service interface
 */
export interface CacheService {
  init(): Promise<void>;
  calculateHash(text: string): Promise<string>;
  generateKey(content: string, type: string, themeConfig?: RendererThemeConfig | null): Promise<string>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, type?: string): Promise<boolean>;
  clear(): Promise<boolean>;
  getStats(): Promise<CacheStats | SimpleCacheStats | null>;
}

/**
 * Renderer service interface
 */
export interface RendererService {
  init(): Promise<void>;
  setThemeConfig(config: RendererThemeConfig): void;
  getThemeConfig(): RendererThemeConfig | null;
  render(type: string, content: string | object): Promise<RenderResult>;
}

/**
 * Storage service interface
 */
export interface StorageService {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(data: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/**
 * File service interface
 */
export interface FileService {
  download(blob: Blob | string, filename: string, options?: DownloadOptions): Promise<void>;
}

/**
 * File state service interface
 */
export interface FileStateService {
  get(url: string): Promise<FileState>;
  set(url: string, state: FileState): void;
  clear(url: string): Promise<void>;
}

/**
 * Resource service interface
 */
export interface ResourceService {
  fetch(path: string): Promise<string>;
  getURL(path: string): string;
}

/**
 * I18n service interface
 */
export interface I18nService {
  translate(key: string, substitutions?: string | string[]): string;
  getUILanguage(): string;
  setLocale?(locale: string): Promise<void>;
}

/**
 * Message service interface
 */
export interface MessageService {
  send(message: Record<string, unknown>): Promise<unknown>;
  addListener(handler: (message: unknown) => void): void;
}

// =============================================================================
// Document Service Interface (Phase 1)
// =============================================================================

/**
 * Read file options
 */
export interface ReadFileOptions {
  /** If true, returns base64-encoded content for binary files */
  binary?: boolean;
}

/**
 * Unified document service for file operations and document context.
 * Replaces scattered platform detection and file reading logic.
 * 
 * Platform implementations:
 * - Chrome/Firefox: Uses window.location.href as base, READ_LOCAL_FILE message
 * - VS Code: Uses host-provided paths, READ_LOCAL_FILE/FETCH_REMOTE_IMAGE messages
 * - Mobile: Uses Flutter bridge, READ_RELATIVE_FILE message
 */
export interface DocumentService {
  // === Context Information ===
  
  /** Absolute path to the current document (e.g., /Users/x/doc.md) */
  readonly documentPath: string;
  
  /** Directory containing the document (e.g., /Users/x/) */
  readonly documentDir: string;
  
  /** Base URL for resolving relative paths (platform-specific) */
  readonly baseUrl: string;
  
  /** Whether relative image paths need URI rewriting (VS Code only) */
  readonly needsUriRewrite: boolean;
  
  // === File Operations ===
  
  /**
   * Read a local file by absolute path.
   * @param absolutePath - Full path to the file
   * @param options - Read options (binary mode, etc.)
   * @returns File content (string or base64 if binary)
   */
  readFile(absolutePath: string, options?: ReadFileOptions): Promise<string>;
  
  /**
   * Read a file relative to the current document.
   * @param relativePath - Path relative to documentDir
   * @param options - Read options (binary mode, etc.)
   * @returns File content (string or base64 if binary)
   */
  readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string>;
  
  /**
   * Fetch a remote resource (HTTP/HTTPS).
   * On VS Code, this bypasses CSP by proxying through the host.
   * @param url - Remote URL
   * @returns Binary content as Uint8Array
   */
  fetchRemote(url: string): Promise<Uint8Array>;
  
  // === Path Resolution ===
  
  /**
   * Resolve a relative path to an absolute path.
   * @param relativePath - Path relative to documentDir
   * @returns Absolute file path
   */
  resolvePath(relativePath: string): string;
  
  /**
   * Convert a local file path to a URL suitable for the current platform.
   * - Chrome/Firefox: file:// URL
   * - VS Code: vscode-webview-resource:// URL
   * - Mobile: file:// URL
   */
  toResourceUrl(absolutePath: string): string;
  
  // === Context Management ===
  
  /**
   * Set the current document path.
   * Called by the platform when a new document is opened.
   * @param path - Absolute path to the document
   * @param baseUrl - Optional base URL for resource loading (VS Code)
   */
  setDocumentPath(path: string, baseUrl?: string): void;
}

// =============================================================================
// Platform API Interface
// =============================================================================

/**
 * Complete platform API interface
 */
export interface PlatformAPI {
  platform: PlatformType;
  cache: CacheService;
  renderer: RendererService;
  storage: StorageService;
  file: FileService;
  fileState: FileStateService;
  resource: ResourceService;
  i18n: I18nService;
  message: MessageService;
  
  /** Unified document service for file operations (Phase 1) */
  document?: DocumentService;
  
  /** Unified settings service (required for all setting operations) */
  settings: import('./settings').ISettingsService;
}
