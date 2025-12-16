/**
 * Platform API Interface Definitions
 * 
 * This file defines the platform-agnostic interfaces that must be implemented
 * by each platform (Chrome Extension, Mobile, etc.)
 * 
 * Design Principles:
 * 1. All services use consistent method naming across platforms
 * 2. Platform-specific features should be optional or have no-op defaults
 * 3. Common logic should be in shared base classes (see ./shared/)
 */

// ============================================================================
// Type Definitions
// ============================================================================

export type PlatformType = 'chrome' | 'mobile';

export interface ThemeConfig {
  fontFamily: string;
  fontSize: number;
  backgroundColor?: string;
}

export interface RenderOptions {
  outputFormat?: 'png' | 'svg';
  width?: number;
  height?: number;
  scale?: number;
  [key: string]: any;
}

export interface RenderResult {
  base64?: string;
  svg?: string;
  width: number;
  height: number;
  format?: 'png' | 'svg';
  error?: string;
}

export interface CacheStats {
  totalItems: number;
  totalSize: number;
  totalSizeMB: string;
  byType?: Record<string, number>;
}

export interface DownloadOptions {
  saveAs?: boolean;
  mimeType?: string;
}

export interface MessagePayload {
  type: string;
  [key: string]: any;
}

// ============================================================================
// Service Interfaces
// ============================================================================

/**
 * Cache Service Interface
 * Provides caching for render results and other data
 */
export interface CacheService {
  /** Initialize cache database */
  init(): Promise<void>;

  /** Ensure database is ready */
  ensureDB(): Promise<void>;

  /** Calculate hash of text content */
  calculateHash(text: string): Promise<string>;

  /** Generate cache key from content and type */
  generateKey(content: string, type: string, themeConfig?: ThemeConfig): Promise<string>;

  /** Get cached item by key */
  get(key: string): Promise<RenderResult | null>;

  /** Set cached item */
  set(key: string, value: RenderResult, type?: string): Promise<boolean>;

  /** Clear all cached items */
  clear(): Promise<boolean>;

  /** Get cache statistics (optional, may return null) */
  getStats(): Promise<CacheStats | null>;
}

/**
 * Renderer Service Interface
 * Renders diagrams, charts, and other visual content
 */
export interface RendererService {
  /** Initialize the renderer */
  init(): Promise<void>;

  /** Set theme configuration for rendering */
  setThemeConfig(config: ThemeConfig): Promise<void>;

  /** Get current theme configuration */
  getThemeConfig(): ThemeConfig | null;

  /**
   * Render content to image/svg
   * @param type - Render type: 'mermaid' | 'vega' | 'vega-lite' | 'svg' | 'html'
   * @param content - Content to render
   * @param options - Render options including outputFormat
   */
  render(type: string, content: string | object, options?: RenderOptions): Promise<RenderResult>;
}

/**
 * Storage Service Interface
 * Provides persistent key-value storage
 */
export interface StorageService {
  /** Get storage data by keys */
  get(keys: string[]): Promise<Record<string, any>>;

  /** Set storage data */
  set(data: Record<string, any>): Promise<void>;

  /** Remove storage data by keys */
  remove(keys: string[]): Promise<void>;
}

/**
 * File Service Interface
 * Handles file downloads and exports
 */
export interface FileService {
  /**
   * Download/share file
   * @param blob - File data (Blob on web, base64 on mobile)
   * @param filename - File name
   * @param options - Download options
   */
  download(blob: Blob | string, filename: string, options?: DownloadOptions): Promise<void>;
}

/**
 * Resource Service Interface
 * Provides access to bundled assets
 */
export interface ResourceService {
  /**
   * Get URL for bundled resource
   * @param path - Relative path to resource
   */
  getURL(path: string): string;

  /**
   * Fetch resource content as text (optional)
   * @param path - Relative path to resource
   */
  fetch?(path: string): Promise<string>;
}

/**
 * I18n Service Interface
 * Provides internationalization support
 * 
 * Note: All implementations must use `translate()` method for consistency
 */
export interface I18nService {
  /** Initialize localization */
  init(): Promise<void>;

  /** Get current locale */
  getLocale(): string;

  /** Set preferred locale */
  setLocale(locale: string): Promise<void>;

  /**
   * Translate message key
   * @param key - Message key
   * @param substitutions - Replacement values
   */
  translate(key: string, substitutions?: string | string[]): string;
}

/**
 * Message Service Interface
 * Handles inter-context communication (e.g., content script ↔ background)
 */
export interface MessageService {
  /**
   * Send message and wait for response
   * @param message - Message payload
   * @param timeout - Optional timeout in ms
   */
  send(message: MessagePayload, timeout?: number): Promise<any>;

  /**
   * Add message listener
   * @param handler - Message handler function
   * @returns Cleanup function to remove listener
   */
  addListener(handler: (message: MessagePayload, sender?: any) => Promise<any> | void): (() => void) | void;
}

// ============================================================================
// Platform API Interface
// ============================================================================

/**
 * Main Platform API Interface
 * 
 * Each platform must implement this interface to provide unified access
 * to platform-specific functionality.
 */
export interface PlatformAPI {
  /** Platform identifier */
  readonly platform: PlatformType;

  /** Cache service for render results */
  cache: CacheService;

  /** Renderer service for diagrams/charts */
  renderer: RendererService;

  /** Storage service for settings and state */
  storage: StorageService;

  /** File service for downloads/exports */
  file: FileService;

  /** Resource service for bundled assets */
  resource: ResourceService;

  /** Internationalization service */
  i18n: I18nService;

  /** Message service for background communication */
  message: MessageService;

  /**
   * Initialize all platform services
   * Should be called once at startup
   */
  init(): Promise<void>;
}

// ============================================================================
// Global Platform Instance
// ============================================================================

declare global {
  var platform: PlatformAPI;
}
