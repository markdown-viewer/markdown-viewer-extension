/**
 * Mobile Platform API Implementation
 * 
 * Runs in WebView context, communicates with the host app (Flutter) via JavaScript channel.
 */

import {
  BaseCacheService,
  BaseI18nService,
  BaseRendererService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE
} from '../shared/index';

import type {
  LocaleMessages
} from '../shared/index';

import type {
  RendererThemeConfig,
  RenderResult,
  CacheStats,
  SimpleCacheStats
} from '../../types/index';

import type { PlatformBridgeAPI } from '../../types/index';

import { ServiceChannel } from '../../messaging/channels/service-channel';
import { RenderChannel } from '../../messaging/channels/render-channel';
import { FlutterJsChannelTransport } from '../../messaging/transports/flutter-jschannel-transport';
import { WindowPostMessageTransport } from '../../messaging/transports/window-postmessage-transport';

import type { RenderHost } from '../../renderers/host/render-host';
import { IframeRenderHost } from '../../renderers/host/iframe-render-host';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Pending request entry
 */
interface HostMessage {
  type?: string;
  payload?: unknown;
  [key: string]: unknown;
}

/**
 * Download options
 */
interface DownloadOptions {
  mimeType?: string;
  [key: string]: unknown;
}

/**
 * Render request context for cancellation
 */
interface QueueContext {
  cancelled: boolean;
  id: number;
}

/**
 * Window extensions for mobile platform
 */
declare global {
  interface Window {
    MarkdownViewer?: {
      postMessage: (message: string) => void;
    };
    __receiveMessageFromHost?: (payload: unknown) => void;
    __mobilePlatformCache?: MobileCacheService;
  }
}

// ============================================================================
// Service Channel (Host ↔ WebView)
// ============================================================================

const hostServiceChannel = new ServiceChannel(new FlutterJsChannelTransport(), {
  source: 'mobile-webview',
  timeoutMs: 30000,
});

// Bridge compatibility layer (used by mobile/main.ts and some plugins).
// NOTE: sendRequest/postMessage now use unified envelopes under the hood.
export const bridge: PlatformBridgeAPI = {
  sendRequest: async <T = unknown>(type: string, payload: unknown): Promise<T> => {
    return (await hostServiceChannel.send(type, payload)) as T;
  },
  postMessage: (type: string, payload: unknown): void => {
    hostServiceChannel.post(type, payload);
  },
  addListener: (handler: (message: unknown) => void): (() => void) => {
    return hostServiceChannel.onAny((message) => {
      handler(message);
    });
  },
};

// ============================================================================
// Mobile Storage Service
// ============================================================================

/**
 * Mobile Storage Service
 * Storage operations handled by host app (Flutter).
 */
class MobileStorageService {
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    return bridge.sendRequest('STORAGE_GET', { keys });
  }

  async set(items: Record<string, unknown>): Promise<void> {
    return bridge.sendRequest('STORAGE_SET', { items });
  }

  async remove(keys: string | string[]): Promise<void> {
    return bridge.sendRequest('STORAGE_REMOVE', { keys });
  }
}

// ============================================================================
// Mobile File Service
// ============================================================================

/**
 * Mobile File Service
 * File operations handled by host app (Flutter).
 */
class MobileFileService {
  /**
   * Download/share file - unified interface with Chrome
   * @param data - Blob or base64 string
   * @param filename - File name
   * @param options - Download options
   */
  async download(data: Blob | string, filename: string, options: DownloadOptions = {}): Promise<void> {
    let base64Data: string;
    let mimeType = options.mimeType || 'application/octet-stream';
    
    if (data instanceof Blob) {
      // Convert Blob to base64 for Flutter
      base64Data = await this._blobToBase64(data);
      mimeType = data.type || mimeType;
    } else {
      // Assume already base64
      base64Data = data;
    }
    
    // Use sendRequest to wait for Flutter to finish sharing
    await bridge.sendRequest('DOWNLOAD_FILE', {
      filename,
      data: base64Data,
      mimeType
    });
  }

  private async _blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

// ============================================================================
// Mobile Resource Service
// ============================================================================

/**
 * Mobile Resource Service
 * Resources are bundled with the app
 */
class MobileResourceService {
  getURL(path: string): string {
    // In mobile WebView loaded via loadFlutterAsset, we need absolute asset URLs
    // Using relative paths from the loaded HTML should work
    return `./${path}`;
  }

  /**
   * Fetch asset content via Flutter bridge
   * WebView's native fetch doesn't work reliably with Flutter assets
   * @param path - Asset path relative to webview folder
   * @returns Asset content as string
   */
  async fetch(path: string): Promise<string> {
    return bridge.sendRequest('FETCH_ASSET', { path });
  }
}

// ============================================================================
// Mobile Message Service
// ============================================================================

/**
 * Mobile Message Service
 * Handles Host ↔ WebView communication
 */
class MobileMessageService {
  send<T = unknown>(message: unknown): Promise<T> {
    return bridge.sendRequest('MESSAGE', message);
  }

  addListener(callback: (message: unknown) => void): () => void {
    return bridge.addListener(callback);
  }
}

// ============================================================================
// Mobile Cache Service
// ============================================================================

/**
 * Memory cache item with metadata
 */
interface MemoryCacheItem {
  value: unknown;
  metadata: Record<string, unknown>;
  accessTime: number;
}

/**
 * Mobile Cache Service
 * Two-layer caching: Memory (L1) + Flutter Storage (L2)
 * Extends BaseCacheService for common hash/key generation
 * 
 * Similar to Chrome's BackgroundCacheManagerProxy, this service
 * communicates with Flutter host for persistent storage operations.
 * Memory cache provides fast access for recently used items.
 * Flutter storage provides persistence with larger capacity.
 */
class MobileCacheService extends BaseCacheService {
  // L1 Memory Cache - Fast access for recently used items
  private memoryCache: Map<string, MemoryCacheItem> = new Map();
  private memoryAccessOrder: string[] = []; // Track access order for LRU
  private memoryMaxItems: number;

  constructor(memoryMaxItems = 50) {
    super();
    this.memoryMaxItems = memoryMaxItems;
  }

  async init(): Promise<void> {
    // Memory cache is ready immediately
    // Flutter storage is initialized on first use
  }

  async ensureDB(): Promise<void> {
    // No-op: Flutter handles storage initialization
  }

  // ==========================================================================
  // L1 Memory Cache Operations
  // ==========================================================================

  /**
   * Add item to memory cache with LRU eviction
   */
  private addToMemoryCache(key: string, value: unknown, metadata: Record<string, unknown> = {}): void {
    // Remove if already exists to update position
    if (this.memoryCache.has(key)) {
      this.removeFromMemoryCache(key);
    }

    // Add to cache and access order
    this.memoryCache.set(key, { value, metadata, accessTime: Date.now() });
    this.memoryAccessOrder.push(key);

    // Evict oldest items if over limit
    while (this.memoryCache.size > this.memoryMaxItems) {
      const oldestKey = this.memoryAccessOrder.shift();
      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }
  }

  /**
   * Get item from memory cache and update LRU order
   */
  private getFromMemoryCache(key: string): unknown | null {
    if (!this.memoryCache.has(key)) {
      return null;
    }

    const item = this.memoryCache.get(key);
    if (!item) {
      return null;
    }

    // Update access order (move to end)
    this.removeFromMemoryCache(key);
    item.accessTime = Date.now();
    this.memoryCache.set(key, item);
    this.memoryAccessOrder.push(key);

    return item.value;
  }

  /**
   * Remove item from memory cache
   */
  private removeFromMemoryCache(key: string): void {
    if (this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
      const index = this.memoryAccessOrder.indexOf(key);
      if (index > -1) {
        this.memoryAccessOrder.splice(index, 1);
      }
    }
  }

  /**
   * Clear memory cache
   */
  private clearMemoryCache(): void {
    this.memoryCache.clear();
    this.memoryAccessOrder = [];
  }

  // ==========================================================================
  // Two-Layer Cache Operations (Memory + Flutter Storage)
  // ==========================================================================

  /**
   * Get cached item - Check memory first, then Flutter storage
   */
  async get(key: string): Promise<unknown> {
    // Try L1 Memory Cache first
    const memoryResult = this.getFromMemoryCache(key);
    if (memoryResult !== null) {
      return memoryResult;
    }

    // Try L2 Flutter Storage
    // Note: bridge.sendRequest returns response.data directly (already unwrapped by BaseMessageChannel)
    try {
      const data = await bridge.sendRequest<unknown>('CACHE_OPERATION', {
        operation: 'get',
        key,
      });

      if (data !== null && data !== undefined) {
        // Add to memory cache for faster future access
        this.addToMemoryCache(key, data);
        return data;
      }
      return null;
    } catch (error) {
      console.warn('[MobileCache] Get failed:', error);
      return null;
    }
  }

  /**
   * Set cached item - Store in both memory and Flutter storage
   */
  async set(key: string, value: unknown, type: string = 'unknown'): Promise<boolean> {
    // Add to memory cache immediately
    this.addToMemoryCache(key, value, { type });

    // Store in Flutter storage for persistence
    // Note: bridge.sendRequest returns response.data directly
    try {
      const result = await bridge.sendRequest<{ success: boolean }>('CACHE_OPERATION', {
        operation: 'set',
        key,
        value,
        dataType: type,
        size: this.estimateSize(value),
      });

      return result?.success ?? false;
    } catch (error) {
      console.warn('[MobileCache] Set failed:', error);
      this.removeFromMemoryCache(key);
      return false;
    }
  }

  /**
   * Delete cached item from both layers
   */
  async delete(key: string): Promise<boolean> {
    this.removeFromMemoryCache(key);

    try {
      const result = await bridge.sendRequest<{ success: boolean }>('CACHE_OPERATION', {
        operation: 'delete',
        key,
      });

      return result?.success ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Clear all cache from both layers
   */
  async clear(): Promise<boolean> {
    this.clearMemoryCache();

    try {
      const result = await bridge.sendRequest<{ success: boolean }>('CACHE_OPERATION', {
        operation: 'clear',
      });

      return result?.success ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Get cache statistics from Flutter storage
   */
  async getStats(): Promise<SimpleCacheStats | null> {
    try {
      const stats = await bridge.sendRequest<SimpleCacheStats>('CACHE_OPERATION', {
        operation: 'getStats',
        limit: 50,
      });

      return stats || null;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Mobile Renderer Service
// ============================================================================

/**
 * Render request payload
 */
interface RenderRequestPayload {
  renderType: string;
  input: string | object;
  themeConfig: RendererThemeConfig | null;
}

/**
 * Render response
 */
interface MobileRenderResult {
  base64?: string;
  svg?: string;
  width: number;
  height: number;
  format: string;
}

/**
 * Mobile Renderer Service
 * Renders diagrams in a separate iframe to avoid blocking main thread
 * Similar to Chrome extension's offscreen document approach
 * Extends BaseRendererService for common theme config handling
 * 
 * Uses postMessage READY/ACK handshake with render frame.
 */
class MobileRendererService extends BaseRendererService {
  private host: RenderHost;
  private requestQueue: Promise<void>;
  private queueContext: QueueContext;

  constructor() {
    super();
    this.host = new IframeRenderHost({
      iframeUrl: './iframe-render.html',
      source: 'mobile-parent',
    });
    this.requestQueue = Promise.resolve();
    this.queueContext = { cancelled: false, id: 0 };
  }

  /**
   * Cancel all pending requests and create new queue context
   * Called when starting a new render to cancel previous requests
   */
  cancelPending(): void {
    this.queueContext.cancelled = true;
    this.queueContext = { cancelled: false, id: this.queueContext.id + 1 };
    this.requestQueue = Promise.resolve();
  }

  /**
   * Get current queue context for requests to reference
   */
  getQueueContext(): QueueContext {
    return this.queueContext;
  }

  /**
   * Wait for render iframe to be ready
   */
  async ensureIframe(): Promise<void> {
    await this.host.ensureReady();
  }

  /**
   * Send message to iframe and wait for response
   * Requests are serialized: wait for previous request to complete before sending next
   * Each request has its own timeout
   */
  sendRequest<T = unknown>(
    type: string,
    payload: unknown = {},
    timeout: number = 60000,
    context: QueueContext | null = null
  ): Promise<T> {
    const requestContext = context || this.queueContext;
    
    if (requestContext.cancelled) {
      return Promise.reject(new Error('Request cancelled'));
    }
    
    const request = this.requestQueue.then(() => {
      if (requestContext.cancelled) {
        return Promise.reject(new Error('Request cancelled'));
      }
      return this._doSendRequest<T>(type, payload, timeout, requestContext);
    });
    
    this.requestQueue = request.catch(() => {}) as Promise<void>;
    
    return request;
  }
  
  /**
   * Actually send the request and wait for response
   */
  private _doSendRequest<T>(
    type: string,
    payload: unknown,
    timeout: number,
    context: QueueContext
  ): Promise<T> {
    if (context.cancelled) {
      return Promise.reject(new Error('Request cancelled'));
    }

    return this.host.send<T>(type, payload, timeout).then((data) => {
      if (context.cancelled) {
        throw new Error('Request cancelled');
      }
      return data as T;
    });
  }

  // Keep for compatibility, but not used with iframe approach
  registerRenderer(_type: string, _renderer: unknown): void {
    // No-op: renderers are loaded inside iframe
  }

  /**
   * Set theme configuration for rendering
   */
  async setThemeConfig(config: RendererThemeConfig): Promise<void> {
    this.themeConfig = config;
    await this.ensureIframe();
    await this.sendRequest('SET_THEME_CONFIG', { config });
  }

  /**
   * Render content using the iframe renderer
   */
  async render(
    type: string,
    input: string | object,
    context: QueueContext | null = null
  ): Promise<MobileRenderResult> {
    const renderContext = context || this.queueContext;
    
    if (renderContext.cancelled) {
      throw new Error('Render cancelled');
    }
    
    const cache = window.__mobilePlatformCache;
    if (cache) {
      const inputString = typeof input === 'string' ? input : JSON.stringify(input);
      const contentKey = inputString;
      const cacheType = `${type.toUpperCase()}_PNG`;
      const cacheKey = await cache.generateKey(contentKey, cacheType, this.themeConfig);

      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached as MobileRenderResult;
      }
      
      if (renderContext.cancelled) {
        throw new Error('Render cancelled');
      }

      await this.ensureIframe();
      const result = await this.sendRequest<MobileRenderResult>('RENDER_DIAGRAM', {
        renderType: type,
        input,
        themeConfig: this.themeConfig
      } as RenderRequestPayload, 60000, renderContext);

      cache.set(cacheKey, result, cacheType).catch(() => {});

      return result;
    }

    if (renderContext.cancelled) {
      throw new Error('Render cancelled');
    }
    
    await this.ensureIframe();
    return this.sendRequest<MobileRenderResult>('RENDER_DIAGRAM', {
      renderType: type,
      input,
      themeConfig: this.themeConfig
    } as RenderRequestPayload, 60000, renderContext);
  }

  async cleanup(): Promise<void> {
    await this.host.cleanup?.();
  }
}

// ============================================================================
// Mobile I18n Service
// ============================================================================

/**
 * Mobile I18n Service
 * Loads locale data from bundled JSON files
 * Extends BaseI18nService for common message lookup logic
 */
class MobileI18nService extends BaseI18nService {
  constructor() {
    super();
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      // For mobile, we use system locale by default
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] init failed:', error);
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.locale = locale;
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (e) {
      console.warn('Failed to load locale:', locale, e);
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      const response = await fetch(`./_locales/${locale}/messages.json`);
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      console.warn('[I18n] fetchLocaleData failed for', locale, error);
      return null;
    }
  }

  getUILanguage(): string {
    return navigator.language || 'en';
  }
}

// ============================================================================
// Mobile Platform API
// ============================================================================

/**
 * Mobile Platform API
 * Implements PlatformAPI interface for mobile WebView environment
 */
class MobilePlatformAPI {
  public readonly platform = 'mobile' as const;
  
  // Services
  public readonly storage: MobileStorageService;
  public readonly file: MobileFileService;
  public readonly resource: MobileResourceService;
  public readonly message: MobileMessageService;
  public readonly cache: MobileCacheService;
  public readonly renderer: MobileRendererService;
  public readonly i18n: MobileI18nService;
  
  // Internal bridge reference (for advanced usage)
  public readonly _bridge: PlatformBridgeAPI;

  constructor() {
    // Initialize services
    this.storage = new MobileStorageService();
    this.file = new MobileFileService();
    this.resource = new MobileResourceService();
    this.message = new MobileMessageService();
    this.cache = new MobileCacheService();
    this.renderer = new MobileRendererService();
    this.i18n = new MobileI18nService();
    
    // Internal bridge reference
    this._bridge = bridge;

    // Expose cache globally for renderer to use
    window.__mobilePlatformCache = this.cache;
  }

  /**
   * Initialize all platform services
   */
  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }

  /**
   * Notify host app that WebView is ready
   */
  notifyReady(): void {
    bridge.postMessage('WEBVIEW_READY', {});
  }

  /**
   * Request file download (triggers system share sheet)
   * @deprecated Use platform.file.download() instead
   */
  downloadFile(filename: string, data: string, mimeType: string): void {
    bridge.postMessage('DOWNLOAD_FILE', {
      filename,
      data, // base64 encoded
      mimeType
    });
  }
}

// ============================================================================
// Export
// ============================================================================

export const platform = new MobilePlatformAPI();

export {
  MobileStorageService,
  MobileFileService,
  MobileResourceService,
  MobileMessageService,
  MobileCacheService,
  MobileRendererService,
  MobileI18nService,
  MobilePlatformAPI,
  DEFAULT_SETTING_LOCALE
};
