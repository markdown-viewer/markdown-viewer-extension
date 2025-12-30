/**
 * Platform Type Definitions
 * Types for platform abstraction layer
 */

import type { RendererThemeConfig, RenderResult } from './render';
import type { CacheStats, SimpleCacheStats } from './cache';

// =============================================================================
// Platform Identification
// =============================================================================

export type PlatformType = 'chrome' | 'mobile' | 'vscode';

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
  setThemeConfig(config: RendererThemeConfig): Promise<void>;
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
  resource: ResourceService;
  i18n: I18nService;
  message: MessageService;
}
