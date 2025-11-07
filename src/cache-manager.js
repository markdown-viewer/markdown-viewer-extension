// Chrome Extension Cache Manager with Two-Layer Caching: Memory (L1) + IndexedDB (L2)
class ExtensionCacheManager {
  constructor(maxItems = 1000, memoryMaxItems = 100) {
    this.maxItems = maxItems; // IndexedDB max items
    this.memoryMaxItems = memoryMaxItems; // Memory cache max items
    this.dbName = 'MarkdownViewerCache';
    this.dbVersion = 1;
    this.storeName = 'renderCache';
    
    // L1 Memory Cache - Fast access for recently used items
    this.memoryCache = new Map();
    this.memoryAccessOrder = []; // Track access order for LRU
    
    this.db = null;
    this.initPromise = this.initDB();
  }

  /**
   * Initialize IndexedDB
   */
  async initDB() {
    if (this.db) return this.db;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = () => {
        reject(request.error);
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Create object store for render cache
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('accessTime', 'accessTime', { unique: false });
          store.createIndex('size', 'size', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
    });
  }

  /**
   * Ensure database is initialized
   */
  async ensureDB() {
    if (!this.db) {
      await this.initPromise;
    }
    return this.db;
  }

  /**
   * Calculate SHA256 hash of string
   */
  async calculateHash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Memory Cache Management - L1 Cache Operations
   */
  
  /**
   * Add item to memory cache with LRU eviction
   */
  _addToMemoryCache(key, value, metadata = {}) {
    // Remove if already exists to update position
    if (this.memoryCache.has(key)) {
      this._removeFromMemoryCache(key, false);
    }
    
    // Add to cache and access order
    this.memoryCache.set(key, { value, metadata, accessTime: Date.now() });
    this.memoryAccessOrder.push(key);
    
    // Evict oldest items if over limit
    while (this.memoryCache.size > this.memoryMaxItems) {
      const oldestKey = this.memoryAccessOrder.shift();
      this.memoryCache.delete(oldestKey);
    }
  }
  
  /**
   * Get item from memory cache and update LRU order
   */
  _getFromMemoryCache(key) {
    if (!this.memoryCache.has(key)) {
      return null;
    }
    
    // Get item first
    const item = this.memoryCache.get(key);
    if (!item) {
      return null;
    }
    
    // Update access order (remove from current position and add to end)
    this._removeFromMemoryCache(key, false);
    
    // Update access time and re-add to cache
    item.accessTime = Date.now();
    this.memoryCache.set(key, item);
    this.memoryAccessOrder.push(key);
    
    return item.value;
  }
  
  /**
   * Remove item from memory cache
   */
  _removeFromMemoryCache(key, logRemoval = true) {
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
  _clearMemoryCache() {
    this.memoryCache.clear();
    this.memoryAccessOrder = [];
  }
  
  /**
   * Get memory cache statistics
   */
  _getMemoryCacheStats() {
    const totalMemorySize = Array.from(this.memoryCache.values())
      .reduce((sum, item) => sum + this.estimateSize(item.value), 0);
      
    return {
      itemCount: this.memoryCache.size,
      maxItems: this.memoryMaxItems,
      totalSize: totalMemorySize,
      totalSizeMB: (totalMemorySize / (1024 * 1024)).toFixed(2),
      items: Array.from(this.memoryCache.entries()).map(([key, item]) => ({
        key: key.substring(0, 32) + '...',
        size: this.estimateSize(item.value),
        accessTime: new Date(item.accessTime).toISOString(),
        metadata: item.metadata
      }))
    };
  }

  /**
   * Estimate byte size of data
   */
  estimateSize(data) {
    return new Blob([typeof data === 'string' ? data : JSON.stringify(data)]).size;
  }

  /**
   * Get cached item by key - Two-layer cache lookup
   */
  async get(key) {
    // Try L1 Memory Cache first
    const memoryResult = this._getFromMemoryCache(key);
    if (memoryResult !== null) {
      // Even for memory cache hits, update IndexedDB access time for LRU consistency
      setTimeout(async () => {
        try {
          await this.updateAccessTime(key);
        } catch (error) {
          // Silent fail for access time update
        }
      }, 0);
      
      return memoryResult;
    }
    
    // Try L2 IndexedDB Cache
    await this.ensureDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      
      const getRequest = store.get(key);
      
      getRequest.onsuccess = () => {
        const result = getRequest.result;
        if (result) {
          // Add to memory cache for faster future access
          this._addToMemoryCache(key, result.value, {
            type: result.type,
            originalTimestamp: result.timestamp
          });
          
          // Update access time for LRU - use a separate transaction to avoid conflicts
          setTimeout(async () => {
            try {
              await this.updateAccessTime(key);
            } catch (error) {
              // Silent fail for access time update
            }
          }, 0);
          
          resolve(result.value);
        } else {
          resolve(null);
        }
      };
      
      getRequest.onerror = () => {
        reject(getRequest.error);
      };
      
      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  /**
   * Update access time for LRU management (separate transaction)
   */
  async updateAccessTime(key) {
    await this.ensureDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      
      const getRequest = store.get(key);
      
      getRequest.onsuccess = () => {
        const item = getRequest.result;
        if (item) {
          item.accessTime = Date.now();
          const putRequest = store.put(item);
          
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve(); // Item not found, that's ok
        }
      };
      
      getRequest.onerror = () => reject(getRequest.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Set cached item - Store in both memory and IndexedDB
   */
  async set(key, value, type = 'unknown') {
    // Add to memory cache immediately for fast access
    this._addToMemoryCache(key, value, { type });
    
    // Also store in IndexedDB for persistence
    await this.ensureDB();
    
    const size = this.estimateSize(value);
    const now = Date.now();
    
    const item = {
      key,
      value,
      type,
      size,
      timestamp: now,
      accessTime: now
    };

    try {
      // Check if we need to cleanup before adding
      await this.cleanupIfNeeded();
      
      // Create a fresh transaction for the put operation
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      
      return new Promise((resolve, reject) => {
        const request = store.put(item);
        
        request.onsuccess = () => {
          resolve();
        };
        
        request.onerror = () => {
          // Remove from memory cache if IndexedDB failed
          this._removeFromMemoryCache(key);
          reject(request.error);
        };
        
        // Also handle transaction errors
        transaction.onerror = () => {
          this._removeFromMemoryCache(key);
          reject(transaction.error);
        };
        
        transaction.onabort = () => {
          this._removeFromMemoryCache(key);
          reject(new Error('Transaction aborted'));
        };
      });
    } catch (error) {
      this._removeFromMemoryCache(key);
      throw error;
    }
  }

  /**
   * Generate cache key for content and type
   */
  async generateKey(content, type) {
    const hash = await this.calculateHash(content);
    return `${hash}_${type}`;
  }

  /**
   * Delete cached item from both layers
   */
  async delete(key) {
    // Remove from memory cache
    this._removeFromMemoryCache(key);
    
    // Remove from IndexedDB
    await this.ensureDB();
    
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    
    return new Promise((resolve, reject) => {
      const request = store.delete(key);
      
      request.onsuccess = () => {
        resolve();
      };
      
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Clear all cache from both layers
   */
  async clear() {
    // Clear memory cache
    this._clearMemoryCache();
    
    // Clear IndexedDB
    await this.ensureDB();
    
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    
    return new Promise((resolve, reject) => {
      const request = store.clear();
      
      request.onsuccess = () => {
        resolve();
      };
      
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Get comprehensive cache statistics from both layers
   */
  async getStats() {
    await this.ensureDB();
    
    // Get memory cache stats
    const memoryStats = this._getMemoryCacheStats();
    
    // Get IndexedDB stats
    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      
      request.onsuccess = () => {
        const items = request.result;
        const totalSize = items.reduce((sum, item) => sum + (item.size || 0), 0);
        
        const stats = {
          // Memory cache stats
          memoryCache: memoryStats,
          
          // IndexedDB cache stats  
          indexedDBCache: {
            itemCount: items.length,
            maxItems: this.maxItems,
            totalSize: totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            items: items
              .sort((a, b) => b.accessTime - a.accessTime) // Sort by most recently accessed
              .slice(0, 20) // Show top 20 items
              .map(item => ({
                key: item.key?.substring(0, 32) + '...',
                type: item.type,
                size: item.size,
                sizeMB: (item.size / (1024 * 1024)).toFixed(3),
                created: new Date(item.timestamp).toISOString(),
                lastAccess: new Date(item.accessTime).toISOString(),
                inMemory: this.memoryCache.has(item.key)
              }))
          },
          
          // Combined stats - avoid double counting items that exist in both caches
          combined: {
            totalItems: items.length, // Only count IndexedDB items as source of truth
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2), // Only IndexedDB size, memory is just a copy
            memoryHitRatio: items.length > 0 ? (memoryStats.itemCount / items.length * 100).toFixed(1) + '%' : '0%',
            hitRate: {
              memoryHits: 0, // Would need to track these metrics
              indexedDBHits: 0,
              misses: 0
            }
          },
          
          // Database info
          databaseInfo: {
            dbName: this.dbName,
            storeName: this.storeName,
            version: this.dbVersion
          }
        };
        
        resolve(stats);
      };
      
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  /**
   * Check if cleanup is needed and perform it
   */
  async cleanupIfNeeded() {
    await this.ensureDB();
    
    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);
    
    return new Promise((resolve, reject) => {
      const countRequest = store.count();
      
      countRequest.onsuccess = async () => {
        const itemCount = countRequest.result;
        
        if (itemCount >= this.maxItems) {
          await this.cleanup();
        }
        resolve();
      };
      
      countRequest.onerror = () => {
        reject(countRequest.error);
      };
    });
  }

  /**
   * Clean up old items based on LRU (Least Recently Used)
   */
  async cleanup() {
    await this.ensureDB();
    
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    const index = store.index('accessTime');
    
    return new Promise((resolve, reject) => {
      const items = [];
      const request = index.openCursor();
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          items.push({
            key: cursor.value.key,
            accessTime: cursor.value.accessTime
          });
          cursor.continue();
        } else {
          // Sort by access time (oldest first) and delete excess items
          items.sort((a, b) => a.accessTime - b.accessTime);
          
          const itemsToDelete = Math.max(0, items.length - Math.floor(this.maxItems * 0.8)); // Keep 80% of max
          
          if (itemsToDelete > 0) {
            const deletePromises = items
              .slice(0, itemsToDelete)
              .map(item => this.delete(item.key));
            
            Promise.all(deletePromises)
              .then(() => {
                resolve();
              })
              .catch(reject);
          } else {
            resolve();
          }
        }
      };
      
      request.onerror = () => {
        reject(request.error);
      };
    });
  }
}

export default ExtensionCacheManager;