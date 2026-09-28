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
}

// ============================================================================
// Renderer Service
// ============================================================================

/**
 * Transport-level failures seen while the service worker and the offscreen
 * document come up ("Cannot read properties of null (reading 'then')" is thrown
 * by Chrome's binding before the request is dispatched). Renders are idempotent,
 * so retrying them is safe.
 */
function isColdStartTransportFailure(message: string): boolean {
  return message.includes('Cannot read properties of null')
    || message.includes('Runtime error:')
    || message.includes('No response received')
    || message.includes('Offscreen communication failed')
    || message.includes('Offscreen request timed out')
    || message.includes('Failed to create offscreen document')
    // The mobile render surface boots as its own WebView; a render that arrives
    // while it is still coming up is a cold start, not a failure of the render.
    || message.includes('Render view not ready');
}

/**
 * Unified renderer service using RenderHost for backend communication.
 * Supports cache integration. RenderHost is lazily initialized on first use.
 */
export class RendererService {
  private createHost: RenderHostFactory;
  private host: RenderHost | null = null;
  private cache: CacheService | null;
  
  private themeConfig: RendererThemeConfig | null = null;
  private themeDirty = true;

  constructor(options: RendererServiceOptions) {
    this.createHost = options.createHost;
    this.cache = options.cache ?? null;
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
   * Note: Theme is not applied immediately to support lazy iframe initialization.
   * It will be applied on the first render via applyThemeIfNeeded().
   */
  setThemeConfig(config: RendererThemeConfig): void {
    this.themeConfig = config;
    this.themeDirty = true;
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
   * Render content using the render host
   * @param type - Render type (mermaid, vega, dot, etc.)
   * @param input - Content to render (string or object)
   * @returns Render result with base64 image data
   */
  async render(
    type: string,
    input: string | object
  ): Promise<RenderResult> {
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
      
      // Apply theme if needed
      await this.applyThemeForRender();
      
      // Render via host
      const result = await this.sendToHost<RenderResult>('RENDER_DIAGRAM', {
        renderType: type,
        input,
        themeConfig: this.themeConfig
      }, 60000);
      
      // Cache the result asynchronously (don't wait)
      this.cache.set(cacheKey, result, cacheType).catch(() => {});
      
      return result;
    }
    
    // No cache - render directly
    await this.applyThemeForRender();
    
    return this.sendToHost<RenderResult>('RENDER_DIAGRAM', {
      renderType: type,
      input,
      themeConfig: this.themeConfig
    }, 60000);
  }

  /**
   * Send a request to the render host, surviving the cold start of a session: the
   * first call(s) can fail while the service worker starts and the offscreen
   * document is created. Without the retry the first diagram of a session simply
   * never appeared (the intermittent CI fixture failure).
   */
  private async sendToHost<T>(type: string, payload: unknown, timeoutMs: number): Promise<T> {
    const host = this.getHost();
    await host.ensureReady();

    const attempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await host.send<T>(type, payload, timeoutMs);
      } catch (error) {
        const message = (error as Error).message ?? '';
        if (attempt >= attempts || !isColdStartTransportFailure(message)) {
          throw error;
        }
        console.warn(`[RendererService] ${type} attempt ${attempt} failed (${message}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }

  /**
   * Push the current theme without letting a failure abort the render: the theme
   * is a follow-up to the render, not a precondition. themeDirty stays true when
   * this fails, so the next render pushes it again.
   */
  private async applyThemeForRender(): Promise<void> {
    try {
      await this.applyThemeIfNeeded();
    } catch (error) {
      console.warn('[RendererService] theme push failed, rendering with the current theme:', (error as Error).message);
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.host) {
      await this.host.cleanup?.();
      this.host = null;
    }
  }
}
