// Background Cache Proxy for Content Scripts
// Communicates with background script via platform message API

/**
 * Cache manager proxy that delegates cache operations to the background script.
 * This is used in content scripts where direct IndexedDB access is not available.
 */
export class BackgroundCacheManagerProxy {
  constructor(platform) {
    this.platform = platform;
    this.dbName = 'MarkdownViewerCache';
    this.storeName = 'cache';
    this.dbVersion = 1;
  }

  async get(key) {
    try {
      const response = await this.platform.message.send({
        type: 'cacheOperation',
        operation: 'get',
        key: key
      });

      if (response.error) {
        throw new Error(response.error);
      }

      return response.result;
    } catch (error) {
      return null;
    }
  }

  async set(key, value, type = 'unknown') {
    try {
      const response = await this.platform.message.send({
        type: 'cacheOperation',
        operation: 'set',
        key: key,
        value: value,
        dataType: type
      });

      if (response.error) {
        throw new Error(response.error);
      }

      return response.success;
    } catch (error) {
      return false;
    }
  }

  async clear() {
    try {
      const response = await this.platform.message.send({
        type: 'cacheOperation',
        operation: 'clear'
      });

      if (response.error) {
        throw new Error(response.error);
      }

      return response.success;
    } catch (error) {
      return false;
    }
  }

  async getStats() {
    try {
      const response = await this.platform.message.send({
        type: 'cacheOperation',
        operation: 'getStats'
      });

      if (response.error) {
        throw new Error(response.error);
      }

      return response.result;
    } catch (error) {
      return null;
    }
  }

  // No need for initDB since background handles it
  async initDB() {
    return Promise.resolve();
  }

  async calculateHash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async generateKey(content, type, themeConfig = null) {
    let keyContent = content;
    
    // Include theme config in cache key if provided
    if (themeConfig && themeConfig.fontFamily && themeConfig.fontSize) {
      keyContent = `${content}_font:${themeConfig.fontFamily}_size:${themeConfig.fontSize}`;
    }
    
    const hash = await this.calculateHash(keyContent);
    return `${hash}_${type}`;
  }
}
