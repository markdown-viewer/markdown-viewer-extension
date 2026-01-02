/**
 * Unified Renderer Service
 * 
 * Application-layer renderer service that uses RenderHost for diagram rendering.
 * Platform-agnostic - works with any RenderHost implementation (Offscreen, Iframe).
 * 
 * Architecture:
 * - Chrome: Uses OffscreenRenderHost (offscreen document)
 * - Mobile/VSCode: Uses IframeRenderHost (iframe)
 * 
 * The RenderHost interface abstracts the communication mechanism,
 * allowing this service to work identically across all platforms.
 * 
 * RenderHost is lazily initialized - only created when first needed.
 */

import type { RenderHost } from '../renderers/host/render-host';
import type { CacheService } from './cache-service';
import type { RendererThemeConfig, RenderResult } from '../types/index';

// ============================================================================
// Types
// ============================================================================

/**
 * Render request context for cancellation
 */
export interface QueueContext {
  cancelled: boolean;
  id: number;
}

/**
 * Factory function to create RenderHost (for lazy initialization)
 */
export type RenderHostFactory = () => RenderHost;

/**
 * Options for initializing the RendererService
 */
export interface RendererServiceOptions {
  /**
   * Factory function to create RenderHost (lazy initialization)
   */
  createHost: RenderHostFactory;
  
  /**
   * Optional CacheService for caching render results
   */
  cache?: CacheService;
  
  /**
   * Whether to use request queue serialization (Mobile/VSCode)
   * Chrome offscreen document handles serialization internally
   * @default true
   */
  useRequestQueue?: boolean;
}

// ============================================================================
// Renderer Service
// ============================================================================

/**
 * Unified renderer service using RenderHost for backend communication.
 * Supports request queue serialization and cache integration.
 * RenderHost is lazily initialized on first use.
 */
export class RendererService {
  private createHost: RenderHostFactory;
  private host: RenderHost | null = null;
  private cache: CacheService | null;
  private useRequestQueue: boolean;
  
  private themeConfig: RendererThemeConfig | null = null;
  private themeDirty = true;
  private requestQueue: Promise<void>;
  private queueContext: QueueContext;

  constructor(options: RendererServiceOptions) {
    this.createHost = options.createHost;
    this.cache = options.cache ?? null;
    this.useRequestQueue = options.useRequestQueue ?? true;
    
    this.requestQueue = Promise.resolve();
    this.queueContext = { cancelled: false, id: 0 };
  }

  /**
   * Get or create the RenderHost (lazy initialization)
   */
  private getHost(): RenderHost {
    if (!this.host) {
      this.host = this.createHost();
    }
    return this.host;
  }

  /**
   * Initialize the renderer service
   */
  async init(): Promise<void> {
    // Renderer initialization handled by RenderHost on first use
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
   * Wait for render host to be ready
   */
  async ensureReady(): Promise<void> {
    await this.getHost().ensureReady();
  }

  /**
   * Get current theme configuration
   */
  getThemeConfig(): RendererThemeConfig | null {
    return this.themeConfig;
  }

  /**
   * Set theme configuration for rendering
   */
  async setThemeConfig(config: RendererThemeConfig): Promise<void> {
    this.themeConfig = config;
    this.themeDirty = true;
    await this.applyThemeIfNeeded();
  }

  /**
   * Apply theme configuration to render host if dirty
   */
  private async applyThemeIfNeeded(): Promise<void> {
    if (!this.themeConfig || !this.themeDirty) {
      return;
    }
    const host = this.getHost();
    await host.ensureReady();
    await host.send('SET_THEME_CONFIG', { config: this.themeConfig }, 300000);
    this.themeDirty = false;
  }

  /**
   * Send request to render host
   * If useRequestQueue is true, requests are serialized
   */
  private sendRequest<T = unknown>(
    type: string,
    payload: unknown = {},
    timeout: number = 60000,
    context: QueueContext | null = null
  ): Promise<T> {
    const requestContext = context || this.queueContext;
    
    if (requestContext.cancelled) {
      return Promise.reject(new Error('Request cancelled'));
    }
    
    if (!this.useRequestQueue) {
      // Direct send without queue (Chrome offscreen handles serialization)
      return this.getHost().send<T>(type, payload, timeout);
    }
    
    // Queue-based send for Mobile/VSCode
    const request = this.requestQueue.then(() => {
      if (requestContext.cancelled) {
        return Promise.reject(new Error('Request cancelled'));
      }
      return this.doSendRequest<T>(type, payload, timeout, requestContext);
    });
    
    this.requestQueue = request.catch(() => {}) as Promise<void>;
    
    return request;
  }
  
  /**
   * Actually send the request and wait for response
   */
  private doSendRequest<T>(
    type: string,
    payload: unknown,
    timeout: number,
    context: QueueContext
  ): Promise<T> {
    if (context.cancelled) {
      return Promise.reject(new Error('Request cancelled'));
    }

    return this.getHost().send<T>(type, payload, timeout).then((data) => {
      if (context.cancelled) {
        throw new Error('Request cancelled');
      }
      return data as T;
    });
  }

  /**
   * Render content using the render host
   * @param type - Render type (mermaid, vega, dot, etc.)
   * @param input - Content to render (string or object)
   * @param context - Optional queue context for cancellation
   * @returns Render result with base64 image data
   */
  async render(
    type: string,
    input: string | object,
    context: QueueContext | null = null
  ): Promise<RenderResult> {
    const renderContext = context || this.queueContext;
    
    if (renderContext.cancelled) {
      throw new Error('Render cancelled');
    }
    
    // Generate cache key
    const inputString = typeof input === 'string' ? input : JSON.stringify(input);
    const cacheType = `${type.toUpperCase()}_PNG`;
    
    // Check cache first
    if (this.cache) {
      const cacheKey = await this.cache.generateKey(inputString, cacheType, this.themeConfig);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached as RenderResult;
      }
      
      if (renderContext.cancelled) {
        throw new Error('Render cancelled');
      }
      
      // Apply theme if needed
      await this.applyThemeIfNeeded();
      
      // Render via host
      const result = await this.sendRequest<RenderResult>('RENDER_DIAGRAM', {
        renderType: type,
        input,
        themeConfig: this.themeConfig
      }, 60000, renderContext);
      
      // Cache the result asynchronously (don't wait)
      this.cache.set(cacheKey, result, cacheType).catch(() => {});
      
      return result;
    }
    
    // No cache - render directly
    if (renderContext.cancelled) {
      throw new Error('Render cancelled');
    }
    
    await this.applyThemeIfNeeded();
    
    return this.sendRequest<RenderResult>('RENDER_DIAGRAM', {
      renderType: type,
      input,
      themeConfig: this.themeConfig
    }, 60000, renderContext);
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Cancel pending requests first (clear the print queue before shutting down)
    this.cancelPending();
    
    if (this.host) {
      await this.host.cleanup?.();
      this.host = null;
    }
  }
}
