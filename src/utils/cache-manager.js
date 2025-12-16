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

    // Async cleanup state management
    this.cleanupInProgress = false; // Flag to prevent concurrent cleanup
    this.cleanupScheduled = false; // Flag to prevent multiple scheduled cleanups
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
   * Cleanup is done asynchronously to avoid blocking insertion
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
      // Insert immediately without waiting for cleanup
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      const result = await new Promise((resolve, reject) => {
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

      // Schedule async cleanup after successful insertion (non-blocking)
      this._scheduleAsyncCleanup();

      return result;
    } catch (error) {
      this._removeFromMemoryCache(key);
      throw error;
    }
  }

  /**
   * Generate cache key for content and type
   * @param {string} content - Content to cache
   * @param {string} type - Cache type identifier
   * @param {Object} themeConfig - Optional theme configuration (fontFamily, fontSize)
   * @param {string} outputFormat - Output format: 'png' or 'svg' (default: 'png')
   * @returns {Promise<string>} Cache key
   */
  async generateKey(content, type, themeConfig = null, outputFormat = 'png') {
    let keyContent = content;
    
    // Include theme config in cache key if provided
    if (themeConfig && themeConfig.fontFamily && themeConfig.fontSize) {
      keyContent = `${content}_font:${themeConfig.fontFamily}_size:${themeConfig.fontSize}`;
    }
    
    // Include output format in cache key
    keyContent = `${keyContent}_format:${outputFormat}`;
    
    const hash = await this.calculateHash(keyContent);
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
   * Optimized to avoid loading all items into memory
   */
  async getStats(limit = 50) {
    await this.ensureDB();

    // Get memory cache stats
    const memoryStats = this._getMemoryCacheStats();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      
      let itemCount = 0;
      let totalSize = 0;
      const items = [];
      
      // 1. Get total count
      const countRequest = store.count();
      
      countRequest.onsuccess = () => {
        itemCount = countRequest.result;
      };
      
      // 2. Calculate total size using key cursor on size index (avoids loading values)
      const sizeIndex = store.index('size');
      const sizeCursorRequest = sizeIndex.openKeyCursor();
      
      sizeCursorRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          totalSize += cursor.key; // cursor.key is the size value
          cursor.continue();
        }
      };
      
      // 3. Get top N items by accessTime
      const accessIndex = store.index('accessTime');
      // 'prev' direction gives descending order (newest first)
      const itemsCursorRequest = accessIndex.openCursor(null, 'prev');
      
      itemsCursorRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && items.length < limit) {
          items.push(cursor.value);
          cursor.continue();
        }
      };
      
      transaction.oncomplete = () => {
        const stats = {
          // Memory cache stats
          memoryCache: memoryStats,

          // IndexedDB cache stats  
          indexedDBCache: {
            itemCount: itemCount,
            maxItems: this.maxItems,
            totalSize: totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            items: items.map(item => ({
                key: item.key?.substring(0, 32) + '...',
                type: item.type,
                size: item.size,
                sizeMB: (item.size / (1024 * 1024)).toFixed(3),
                created: new Date(item.timestamp).toISOString(),
                lastAccess: new Date(item.accessTime).toISOString(),
                inMemory: this.memoryCache.has(item.key)
              }))
          },

          // Combined stats
          combined: {
            totalItems: itemCount,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            memoryHitRatio: itemCount > 0 ? (memoryStats.itemCount / itemCount * 100).toFixed(1) + '%' : '0%',
            hitRate: {
              memoryHits: 0,
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
      
      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  /**
   * Schedule async cleanup without blocking current operation
   * Uses flags to prevent concurrent cleanup operations
   */
  _scheduleAsyncCleanup() {
    // Don't schedule if already scheduled or in progress
    if (this.cleanupScheduled || this.cleanupInProgress) {
      return;
    }

    this.cleanupScheduled = true;

    // Run cleanup asynchronously after a short delay
    // Short delay (10ms) to batch multiple insertions while keeping responsive
    setTimeout(async () => {
      this.cleanupScheduled = false;

      // Double-check if cleanup is already running
      if (this.cleanupInProgress) {
        return;
      }

      try {
        await this._asyncCleanup();
      } catch (error) {
        console.error('Async cleanup failed:', error);
      }
    }, 10);
  }

  /**
   * Async cleanup that runs in background
   * Only cleans up if cache exceeds maxItems, brings it down to exactly maxItems
   */
  async _asyncCleanup() {
    // Prevent concurrent cleanup
    if (this.cleanupInProgress) {
      return;
    }

    this.cleanupInProgress = true;

    try {
      await this.ensureDB();

      // First check item count
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);

      const itemCount = await new Promise((resolve, reject) => {
        const countRequest = store.count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
      });

      // Only cleanup if we exceed maxItems
      if (itemCount <= this.maxItems) {
        return;
      }

      // Calculate how many items to delete to reach exactly maxItems
      const itemsToDelete = itemCount - this.maxItems;

      // Perform cleanup in a separate transaction
      await new Promise((resolve, reject) => {
        const cleanupTransaction = this.db.transaction([this.storeName], 'readwrite');
        const cleanupStore = cleanupTransaction.objectStore(this.storeName);
        const index = cleanupStore.index('accessTime');

        const items = [];
        const cursorRequest = index.openCursor();

        cursorRequest.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            items.push({
              key: cursor.value.key,
              accessTime: cursor.value.accessTime
            });
            cursor.continue();
          } else {
            // Sort by access time (oldest first)
            items.sort((a, b) => a.accessTime - b.accessTime);

            // Delete oldest items to bring count down to maxItems
            const keysToDelete = items.slice(0, itemsToDelete);
            let deletedCount = 0;

            if (keysToDelete.length === 0) {
              resolve({ deletedCount: 0 });
              return;
            }

            keysToDelete.forEach(item => {
              // Remove from memory cache
              this._removeFromMemoryCache(item.key, false);

              // Delete from IndexedDB
              const deleteRequest = cleanupStore.delete(item.key);

              deleteRequest.onsuccess = () => {
                deletedCount++;
                if (deletedCount === keysToDelete.length) {
                  resolve({ deletedCount });
                }
              };

              deleteRequest.onerror = () => {
                reject(deleteRequest.error);
              };
            });
          }
        };

        cursorRequest.onerror = () => {
          reject(cursorRequest.error);
        };

        cleanupTransaction.onerror = () => {
          reject(cleanupTransaction.error);
        };

        cleanupTransaction.onabort = () => {
          reject(new Error('Cleanup transaction aborted'));
        };
      });
    } finally {
      this.cleanupInProgress = false;
    }
  }

  /**
   * Check if cleanup is needed (readonly check only)
   */
  async _checkIfCleanupNeeded() {
    await this.ensureDB();

    const transaction = this.db.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const countRequest = store.count();

      countRequest.onsuccess = () => {
        const itemCount = countRequest.result;
        resolve(itemCount > this.maxItems);
      };

      countRequest.onerror = () => {
        reject(countRequest.error);
      };
    });
  }

  /**
   * Manual cleanup (for external calls)
   * @deprecated For internal use, async cleanup is preferred
   */
  async cleanupIfNeeded() {
    const needsCleanup = await this._checkIfCleanupNeeded();
    if (needsCleanup) {
      await this.cleanup();
    }
  }

  /**
   * Manual cleanup (synchronous version for external use)
   * Brings cache down to maxItems by removing oldest items
   */
  async cleanup() {
    // Use the async cleanup implementation to avoid code duplication
    // But wait for it to complete (synchronous behavior for manual calls)
    if (this.cleanupInProgress) {
      // Wait for current cleanup to finish
      while (this.cleanupInProgress) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return;
    }

    await this._asyncCleanup();
  }
}

export default ExtensionCacheManager;