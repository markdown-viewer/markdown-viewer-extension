/**
 * Cache Type Definitions
 * Types for caching system
 */

import type { RendererThemeConfig } from './render';

// =============================================================================
// Cache Item Types
// =============================================================================

/**
 * Individual cache item stored in IndexedDB
 */
export interface CacheItem<T = unknown> {
  key: string;
  value: T;
  type: string;
  size: number;
  timestamp: number;
  accessTime: number;
}

/**
 * Memory cache item with metadata
 */
export interface MemoryCacheItem<T = unknown> {
  value: T;
  metadata: Record<string, unknown>;
  accessTime: number;
}

// =============================================================================
// Cache Statistics Types
// =============================================================================

/**
 * Memory cache statistics
 */
export interface MemoryCacheStats {
  itemCount: number;
  maxItems: number;
  totalSize: number;
  totalSizeMB: string;
  items: Array<{
    key: string;
    size: number;
    accessTime: string;
    metadata: Record<string, unknown>;
  }>;
}

/**
 * IndexedDB cache statistics
 */
export interface IndexedDBCacheStats {
  itemCount: number;
  maxItems: number;
  totalSize: number;
  totalSizeMB: string;
  items: Array<{
    key: string;
    type: string;
    size: number;
    sizeMB: string;
    created: string;
    lastAccess: string;
    inMemory: boolean;
  }>;
}

/**
 * Full cache statistics (for detailed view)
 */
export interface CacheStats {
  memoryCache: MemoryCacheStats;
  indexedDBCache: IndexedDBCacheStats;
  combined: {
    totalItems: number;
    totalSizeMB: string;
    memoryHitRatio: string;
    hitRate: {
      memoryHits: number;
      indexedDBHits: number;
      misses: number;
    };
  };
  databaseInfo: {
    dbName: string;
    storeName: string;
    version: number;
  };
}

/**
 * Simple cache stats for popup/background communication
 */
export interface SimpleCacheStats {
  itemCount: number;
  maxItems: number;
  totalSize: number;
  totalSizeMB: string;
  items: CacheItem[];
  message?: string;
}

// =============================================================================
// Cache Manager Interface
// =============================================================================

/**
 * Cache manager interface for content scripts
 */
export interface ICacheManager {
  ensureDB?(): Promise<unknown>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, type?: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<boolean>;
  cleanup?(): Promise<void>;
  getStats(): Promise<CacheStats | SimpleCacheStats | null>;
}

// =============================================================================
// Renderer Cache Manager Interface
// =============================================================================

/**
 * Cache manager interface for renderers.
 * Used by both the extension-side cache manager and the background proxy.
 */
export interface RendererCacheManager {
  ensureDB(): Promise<unknown>;
  generateKey(
    content: string,
    type: string,
    themeConfig?: RendererThemeConfig | null,
    outputFormat?: string
  ): Promise<string>;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, type: string): Promise<void>;
  delete?(key: string): Promise<boolean>;
  cleanup?(): Promise<void>;
  getStats(): Promise<CacheStats | SimpleCacheStats | null>;
  clear(): Promise<void>;
}
