// Chrome Extension Renderer Manager using Offscreen API
import ExtensionCacheManager from './cache-manager.js';

class ExtensionRenderer {
  constructor(cacheManager = null) {
    // Use provided cache manager or create a new one
    this.cache = cacheManager || new ExtensionCacheManager();
    this.offscreenCreated = false;
    this.initPromise = null;
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
   * Send message to offscreen document via background script
   */
  async _sendMessage(message) {
    try {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Message timeout after 30 seconds'));
        }, 30000);
        
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timeout);
          
          if (chrome.runtime.lastError) {
            reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
            return;
          }
          
          if (!response) {
            reject(new Error('No response received from background script'));
            return;
          }
          
          if (response.error) {
            reject(new Error(response.error));
            return;
          }
          
          resolve(response);
        });
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Render Mermaid diagram to PNG base64
   */
  async renderMermaidToPng(code) {
    const cacheKey = await this.cache.generateKey(code, 'MERMAID_PNG');
    
    // Check cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this._sendMessage({
      type: 'renderMermaid',
      mermaid: code
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Cache the result (wait for completion to ensure it's saved)
    try {
      await this.cache.set(cacheKey, response.base64, 'MERMAID_PNG');
    } catch (error) {
      // Ignore cache errors
    }
    
    return response.base64;
  }

  /**
   * Render HTML to PNG base64
   */
  async renderHtmlToPng(html, width = 1200) {
    const contentKey = html + width;
    const cacheKey = await this.cache.generateKey(contentKey, 'HTML_PNG');
    
    // Check cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this._sendMessage({
      type: 'renderHtml',
      html: html,
      width: width
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Cache the result (wait for completion to ensure it's saved)
    try {
      await this.cache.set(cacheKey, response.base64, 'HTML_PNG');
    } catch (error) {
      // Ignore cache errors
    }
    
    return response.base64;
  }

  /**
   * Render SVG to PNG base64
   */
  async renderSvgToPng(svg) {
    const cacheKey = await this.cache.generateKey(svg, 'SVG_PNG');
    
    // Check cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this._sendMessage({
      type: 'renderSvg',
      svg: svg
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Cache the result in background (don't await to avoid blocking)
    this.cache.set(cacheKey, response.base64, 'SVG_PNG').then(() => {
    }).catch(error => {
      // Ignore cache errors
    });
    
    return response.base64;
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
        await chrome.offscreen.closeDocument();
        this.offscreenCreated = false;
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

export default ExtensionRenderer;