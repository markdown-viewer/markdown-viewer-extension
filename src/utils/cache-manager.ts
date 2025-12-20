// Chrome Extension Cache Manager with Two-Layer Caching: Memory (L1) + IndexedDB (L2)

import type {
  CacheItem,
  MemoryCacheItem,
  CacheStats,
  RendererThemeConfig
} from '../types/index';

// Re-export types for consumers
export type { CacheItem, MemoryCacheItem, CacheStats };

class ExtensionCacheManager {
  maxItems: number;
  memoryMaxItems: number;
  dbName = 'MarkdownViewerCache';
  dbVersion = 1;
  storeName = 'renderCache';

  // L1 Memory Cache - Fast access for recently used items
  memoryCache: Map<string, MemoryCacheItem> = new Map();
  memoryAccessOrder: string[] = []; // Track access order for LRU

  db: IDBDatabase | null = null;
  initPromise: Promise<IDBDatabase>;

  // Async cleanup state management
  cleanupInProgress = false; // Flag to prevent concurrent cleanup
  cleanupScheduled = false; // Flag to prevent multiple scheduled cleanups

  // Batched access time updates to reduce transaction overhead
  pendingAccessTimeUpdates: Set<string> = new Set();
  accessTimeUpdateScheduled = false;

  constructor(maxItems = 1000, memoryMaxItems = 100) {
    this.maxItems = maxItems; // IndexedDB max items
    this.memoryMaxItems = memoryMaxItems; // Memory cache max items
    this.initPromise = this.initDB();
  }

  /**
   * Initialize IndexedDB
   */
  private async initDB(): Promise<IDBDatabase> {
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
        const db = (event.target as IDBOpenDBRequest).result;

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
  async ensureDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.initPromise;
    }
    return this.db!;
  }

  /**
   * Calculate SHA256 hash of string
   */
  private async calculateHash(text: string): Promise<string> {
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
  private _addToMemoryCache(key: string, value: any, metadata: Record<string, any> = {}): void {
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
      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }
  }

  /**
   * Get item from memory cache and update LRU order
   */
  private _getFromMemoryCache(key: string): any {
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
  private _removeFromMemoryCache(key: string, logRemoval = true): void {
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
  private _clearMemoryCache(): void {
    this.memoryCache.clear();
    this.memoryAccessOrder = [];
  }

  /**
   * Estimate byte size of data
   */
  estimateSize(data: any): number {
    return new Blob([typeof data === 'string' ? data : JSON.stringify(data)]).size;
  }

  /**
   * Get cached item by key - Two-layer cache lookup
   */
  async get(key: string): Promise<any> {
    // Try L1 Memory Cache first
    const memoryResult = this._getFromMemoryCache(key);
    if (memoryResult !== null) {
      // Update IndexedDB access time asynchronously (non-blocking)
      this._scheduleAccessTimeUpdate(key);
      return memoryResult;
    }

    // Try L2 IndexedDB Cache
    await this.ensureDB();

    return new Promise((resolve, reject) => {
      // Use readonly transaction for get - faster and doesn't block other operations
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);

      const getRequest = store.get(key);

      getRequest.onsuccess = () => {
        const result = getRequest.result as CacheItem | undefined;
        if (result) {
          // Add to memory cache for faster future access
          this._addToMemoryCache(key, result.value, {
            type: result.type,
            originalTimestamp: result.timestamp
          });

          // Update access time asynchronously (non-blocking)
          this._scheduleAccessTimeUpdate(key);

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
   * Schedule batched access time update (non-blocking)
   * Batches multiple updates into a single transaction
   */
  private _scheduleAccessTimeUpdate(key: string): void {
    // Skip access time updates for now - they cause performance issues
    // The in-memory cache already tracks access order
    // TODO: Consider updating access time only on cleanup or periodically
    return;

    this.pendingAccessTimeUpdates.add(key);

    if (this.accessTimeUpdateScheduled) {
      return;
    }

    this.accessTimeUpdateScheduled = true;

    // Batch updates with a longer delay to reduce transaction frequency
    setTimeout(async () => {
      this.accessTimeUpdateScheduled = false;

      if (this.pendingAccessTimeUpdates.size === 0) {
        return;
      }

      const keysToUpdate = Array.from(this.pendingAccessTimeUpdates);
      this.pendingAccessTimeUpdates.clear();

      try {
        await this._batchUpdateAccessTime(keysToUpdate);
      } catch (error) {
        // Silent fail for access time updates
      }
    }, 500); // 500ms delay to batch multiple accesses
  }

  /**
   * Batch update access times in a single transaction
   */
  private async _batchUpdateAccessTime(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    await this.ensureDB();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const now = Date.now();
      let completed = 0;

      keys.forEach(key => {
        const getRequest = store.get(key);

        getRequest.onsuccess = () => {
          const item = getRequest.result as CacheItem | undefined;
          if (item) {
            item.accessTime = now;
            store.put(item);
          }
          completed++;
          if (completed === keys.length) {
            resolve();
          }
        };

        getRequest.onerror = () => {
          completed++;
          if (completed === keys.length) {
            resolve();
          }
        };
      });

      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * Update access time for LRU management (separate transaction)
   * @deprecated Use _scheduleAccessTimeUpdate instead for better performance
   */
  async updateAccessTime(key: string): Promise<void> {
    await this.ensureDB();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      const getRequest = store.get(key);

      getRequest.onsuccess = () => {
        const item = getRequest.result as CacheItem | undefined;
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
  async set(key: string, value: any, type = 'unknown'): Promise<void> {
    // Add to memory cache immediately for fast access
    this._addToMemoryCache(key, value, { type });

    // Also store in IndexedDB for persistence
    await this.ensureDB();

    const size = this.estimateSize(value);
    const now = Date.now();

    const item: CacheItem = {
      key,
      value,
      type,
      size,
      timestamp: now,
      accessTime: now
    };

    try {
      // Insert immediately without waiting for cleanup
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      const result = await new Promise<void>((resolve, reject) => {
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
   * @param content - Content to cache
   * @param type - Cache type identifier
   * @param themeConfig - Optional theme configuration (fontFamily, fontSize)
   * @returns Cache key
   */
  async generateKey(content: string, type: string, themeConfig: RendererThemeConfig | null = null): Promise<string> {
    let keyContent = content;
    
    // Include theme config in cache key if provided
    if (themeConfig && themeConfig.fontFamily && themeConfig.fontSize) {
      keyContent = `${content}_font:${themeConfig.fontFamily}_size:${themeConfig.fontSize}`;
    }
    
    const hash = await this.calculateHash(keyContent);
    return `${hash}_${type}`;
  }

  /**
   * Delete cached item from both layers
   */
  async delete(key: string): Promise<void> {
    // Remove from memory cache
    this._removeFromMemoryCache(key);

    // Remove from IndexedDB
    await this.ensureDB();

    const transaction = this.db!.transaction([this.storeName], 'readwrite');
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
  async clear(): Promise<void> {
    // Clear memory cache
    this._clearMemoryCache();

    // Clear IndexedDB
    await this.ensureDB();

    const transaction = this.db!.transaction([this.storeName], 'readwrite');
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
  async getStats(limit = 50): Promise<CacheStats> {
    await this.ensureDB();

    // Skip expensive memory cache size calculation (estimateSize creates Blob for each item)
    const memoryStats = {
      itemCount: this.memoryCache.size,
      maxItems: this.memoryMaxItems,
      totalSize: 0,
      totalSizeMB: '0.00',
      items: [] as Array<{ key: string; size: number; accessTime: string; metadata: Record<string, unknown> }>
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      
      let itemCount = 0;
      let totalSize = 0;
      const items: CacheItem[] = [];
      
      // 1. Get total count
      const countRequest = store.count();
      
      countRequest.onsuccess = () => {
        itemCount = countRequest.result;
      };
      
      // 2. Calculate total size using key cursor on size index (avoids loading values)
      const sizeIndex = store.index('size');
      const sizeCursorRequest = sizeIndex.openKeyCursor();
      
      sizeCursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result as IDBCursor | null;
        if (cursor) {
          totalSize += cursor.key as number;
          cursor.continue();
        }
      };
      
      // 3. Get top N items by accessTime
      const accessIndex = store.index('accessTime');
      const itemsCursorRequest = accessIndex.openCursor(null, 'prev');
      
      itemsCursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;
        if (cursor && items.length < limit) {
          items.push(cursor.value as CacheItem);
          cursor.continue();
        }
      };
      
      transaction.oncomplete = () => {
        const stats: CacheStats = {
          memoryCache: memoryStats,
          indexedDBCache: {
            itemCount: itemCount,
            maxItems: this.maxItems,
            totalSize: totalSize,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            items: items.map(item => ({
              key: (item.key?.substring(0, 32) || '') + '...',
              type: item.type,
              size: item.size,
              sizeMB: (item.size / (1024 * 1024)).toFixed(3),
              created: new Date(item.timestamp).toISOString(),
              lastAccess: new Date(item.accessTime).toISOString(),
              inMemory: this.memoryCache.has(item.key)
            }))
          },
          combined: {
            totalItems: itemCount,
            totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
            memoryHitRatio: itemCount > 0 ? (memoryStats.itemCount / itemCount * 100).toFixed(1) + '%' : '0%',
            hitRate: {
              memoryHits: this.memoryHits,
              indexedDBHits: this.indexedDBHits,
              misses: this.misses
            }
          },
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
  private _scheduleAsyncCleanup(): void {
    // Don't schedule if already scheduled or in progress
    if (this.cleanupScheduled || this.cleanupInProgress) {
      return;
    }

    this.cleanupScheduled = true;

    // Run cleanup asynchronously after a delay to avoid blocking
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
    }, 100);
  }

  /**
   * Async cleanup that runs in background
   * Only cleans up if cache exceeds maxItems, brings it down to exactly maxItems
   */
  private async _asyncCleanup(): Promise<void> {
    // Prevent concurrent cleanup
    if (this.cleanupInProgress) {
      return;
    }

    this.cleanupInProgress = true;

    try {
      await this.ensureDB();

      // Get current item count from database
      const currentCount = await this._getItemCount();
      if (currentCount <= this.maxItems) {
        return;
      }

      // Calculate how many items to delete
      const itemsToDelete = currentCount - this.maxItems;

      // Perform cleanup in a separate transaction
      await new Promise<void>((resolve, reject) => {
        const cleanupTransaction = this.db!.transaction([this.storeName], 'readwrite');
        const cleanupStore = cleanupTransaction.objectStore(this.storeName);
        const index = cleanupStore.index('accessTime');

        const itemsToSort: Array<{ key: string; accessTime: number; size: number }> = [];
        const cursorRequest = index.openCursor();

        cursorRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;
          if (cursor) {
            const item = cursor.value as CacheItem;
            itemsToSort.push({
              key: item.key,
              accessTime: item.accessTime,
              size: item.size || 0
            });
            cursor.continue();
          } else {
            // Sort by access time (oldest first)
            itemsToSort.sort((a, b) => a.accessTime - b.accessTime);

            // Delete oldest items to bring count down to maxItems
            const keysToDelete = itemsToSort.slice(0, itemsToDelete);
            let deletedCount = 0;
            let deletedSize = 0;

            if (keysToDelete.length === 0) {
              resolve();
              return;
            }

            keysToDelete.forEach(item => {
              // Remove from memory cache
              this._removeFromMemoryCache(item.key, false);

              // Delete from IndexedDB
              const deleteRequest = cleanupStore.delete(item.key);

              deleteRequest.onsuccess = () => {
                deletedCount++;
                deletedSize += item.size;
                if (deletedCount === keysToDelete.length) {
                  resolve();
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
   * Get current item count from database
   */
  private async _getItemCount(): Promise<number> {
    await this.ensureDB();

    const transaction = this.db!.transaction([this.storeName], 'readonly');
    const store = transaction.objectStore(this.storeName);

    return new Promise((resolve, reject) => {
      const countRequest = store.count();

      countRequest.onsuccess = () => {
        resolve(countRequest.result);
      };

      countRequest.onerror = () => {
        reject(countRequest.error);
      };
    });
  }

  /**
   * Manual cleanup (for external calls)
   */
  async cleanupIfNeeded(): Promise<void> {
    const count = await this._getItemCount();
    if (count > this.maxItems) {
      await this.cleanup();
    }
  }

  /**
   * Manual cleanup (synchronous version for external use)
   * Brings cache down to maxItems by removing oldest items
   */
  async cleanup(): Promise<void> {
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
