// Chrome Extension Renderer Manager using Offscreen API
import { CacheManager } from './cache-manager.js';
import { UploadManager } from './upload-manager.js';

/**
 * Get platform instance from global scope
 * Platform is set by each platform's index.js before using shared modules
 */
function getPlatform() {
  return globalThis.platform;
}

class ExtensionRenderer {
  constructor(cacheManager = null) {
    // Use provided cache manager or create a new one
    this.cache = cacheManager || new ExtensionCacheManager();
    this.offscreenCreated = false;
    this.initPromise = null;
    this.themeConfig = null; // Store current theme config for cache key generation
  }

  /**
   * Initialize the renderer
   */
  async init() {
    try {
      // Ensure cache is properly initialized
      if (this.cache) {
        await this.cache.ensureDB();
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Set theme configuration for rendering
   * @param {Object} themeConfig - Theme configuration object
   * @param {string} themeConfig.fontFamily - Font family for text rendering
   * @param {number} themeConfig.fontSize - Font size in pt for scaling calculations
   */
  async setThemeConfig(themeConfig) {
    // Store theme config for cache key generation
    this.themeConfig = themeConfig;
    
    try {
      await this._sendMessage({
        type: 'setThemeConfig',
        config: themeConfig
      });
    } catch (error) {
      console.error('Failed to set theme config:', error);
    }
  }

  /**
   * Send message to offscreen document via background script
   */
  async _sendMessage(message) {
    try {
      const platform = getPlatform();
      return await platform.message.send(message);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Unified diagram rendering method
   * @param {string} renderType - Type of diagram (mermaid, vega, etc.)
   * @param {string|object} input - Input data for rendering
   * @param {object} extraParams - Additional parameters (including outputFormat: 'svg' | 'png')
   * @param {string} cacheType - Cache type identifier
   * @returns {Promise<object>} Render result with base64/svg, width, height, format
   */
  async _renderDiagram(renderType, input, extraParams = {}, cacheType) {
    // Generate cache key (include outputFormat)
    const inputString = typeof input === 'string' ? input : JSON.stringify(input);
    const contentKey = inputString + JSON.stringify(extraParams);
    const outputFormat = extraParams.outputFormat || 'png';
    const cacheKey = await this.cache.generateKey(contentKey, cacheType, this.themeConfig, outputFormat);

    // Check cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Send unified message
    const message = {
      action: 'RENDER_DIAGRAM',
      renderType,
      input,
      themeConfig: this.themeConfig,
      extraParams
    };
    const response = await this._sendMessage(message);

    if (response.error) {
      throw new Error(response.error);
    }

    // Cache the complete response (base64 + dimensions)
    try {
      await this.cache.set(cacheKey, response, cacheType);
    } catch (error) {
      // Ignore cache errors
    }

    return response;
  }

  /**
   * Unified render method
   * @param {string} type - Renderer type (mermaid, vega, vega-lite, html, svg, etc.)
   * @param {string|object} input - Input data for rendering
   * @param {object} extraParams - Additional parameters (including outputFormat: 'svg' | 'png')
   * @returns {Promise<object>} Render result with base64/svg, width, height, format
   */
  async render(type, input, extraParams = {}) {
    // Generate cache type identifier based on output format
    const outputFormat = extraParams.outputFormat || 'png';
    const formatSuffix = outputFormat.toUpperCase();
    const cacheType = `${type.toUpperCase()}_${formatSuffix}`;
    
    return this._renderDiagram(type, input, extraParams, cacheType);
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Clear cache
   */
  async clearCache() {
    await this.cache.clear();
  }

  /**
   * Cleanup offscreen document
   */
  async cleanup() {
    try {
      if (this.offscreenCreated) {
        const platform = getPlatform();
        await platform.renderer.cleanup();
        this.offscreenCreated = false;
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

export default ExtensionRenderer;