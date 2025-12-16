// Background cache proxy for popup
// Communicates with content scripts through background script

import { translate } from './i18n-helpers.js';

/**
 * Proxy class for cache operations via background script
 * Note: Popup cannot access IndexedDB directly due to security restrictions
 */
export class BackgroundCacheProxy {
  constructor() {
    // Don't hardcode maxItems, get it from actual stats
    this.maxItems = null;
  }

  /**
   * Get cache statistics from background script
   * @returns {Promise<Object>} Cache stats object
   */
  async getStats() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getCacheStats'
      });

      if (response && response.error) {
        throw new Error(response.error);
      }

      if (!response) {
        return {
          itemCount: 0,
          maxItems: 1000,
          totalSize: 0,
          totalSizeMB: '0.00',
          items: []
        };
      }

      // Update maxItems from actual cache manager stats
      if (response.indexedDBCache && response.indexedDBCache.maxItems) {
        this.maxItems = response.indexedDBCache.maxItems;
      } else if (response.maxItems) {
        this.maxItems = response.maxItems;
      }

      return response;
    } catch (error) {
      console.error('Failed to get cache stats via background:', error);
      return {
        itemCount: 0,
        maxItems: this.maxItems || 1000,
        totalSize: 0,
        totalSizeMB: '0.00',
        items: [],
        message: translate('cache_error_message')
      };
    }
  }

  /**
   * Clear all cache via background script
   * @returns {Promise<Object>} Clear result
   */
  async clear() {
    try {
      return await chrome.runtime.sendMessage({
        action: 'clearCache'
      });
    } catch (error) {
      console.error('Failed to clear cache via background:', error);
      throw error;
    }
  }
}
