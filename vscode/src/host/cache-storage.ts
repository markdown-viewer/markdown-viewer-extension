/**
 * VSCode Extension Host Cache Storage
 * 
 * File system based persistent cache using globalStorageUri.
 * Architecture inspired by Chrome extension's IndexedDB cache (cache-storage.ts).
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Cache statistics
 */
export interface CacheStats {
  itemCount: number;
  maxItems: number;
  totalSize: number;
  totalSizeMB: string;
  items: Array<{
    key: string;
    size: number;
    type: string;
    accessTime: number;
  }>;
}

/**
 * Cache entry stored in file system
 */
interface CacheEntry {
  key: string;
  value: unknown;
  type: string;
  size: number;
  accessTime: number;
  createdTime: number;
}

/**
 * Cache index stored in index.json
 */
interface CacheIndex {
  version: number;
  entries: Record<string, {
    hash: string;
    type: string;
    size: number;
    accessTime: number;
    createdTime: number;
  }>;
}

const CACHE_VERSION = 1;
const MAX_CACHE_ITEMS = 500;
const CLEANUP_THRESHOLD = 400;
const CACHE_DIR_NAME = 'render-cache';
const INDEX_FILE_NAME = 'index.json';

/**
 * File system based cache storage for VSCode extension
 */
export class CacheStorage {
  private storageUri: vscode.Uri | undefined;
  private cacheUri: vscode.Uri | undefined;
  private indexUri: vscode.Uri | undefined;
  private index: CacheIndex | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private cleanupScheduled = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private context: vscode.ExtensionContext) {
    this.storageUri = context.globalStorageUri;
    if (this.storageUri) {
      this.cacheUri = vscode.Uri.joinPath(this.storageUri, CACHE_DIR_NAME);
      this.indexUri = vscode.Uri.joinPath(this.cacheUri, INDEX_FILE_NAME);
    }
  }

  /**
   * Initialize cache service
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    await this.initPromise;
    this.initialized = true;
  }

  private async _init(): Promise<void> {
    if (!this.cacheUri || !this.indexUri) {
      console.warn('[CacheService] No storage URI available');
      return;
    }

    try {
      // Ensure cache directory exists
      await vscode.workspace.fs.createDirectory(this.cacheUri);

      // Load or create index
      try {
        const data = await vscode.workspace.fs.readFile(this.indexUri);
        const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
        if (parsed.version === CACHE_VERSION) {
          this.index = parsed;
        } else {
          // Version mismatch, recreate
          await this._clearAll();
          this.index = this._createEmptyIndex();
        }
      } catch {
        // Index doesn't exist or is corrupted
        this.index = this._createEmptyIndex();
        await this._saveIndex();
      }
    } catch (error) {
      console.error('[CacheService] Init failed:', error);
      this.index = this._createEmptyIndex();
    }
  }

  private _createEmptyIndex(): CacheIndex {
    return {
      version: CACHE_VERSION,
      entries: {}
    };
  }

  /**
   * Generate hash-based key from input
   */
  generateKey(input: string | object): string {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 32);
  }

  /**
   * Get cached value
   */
  async get(key: string): Promise<unknown> {
    await this.init();
    if (!this.index || !this.cacheUri) return null;

    const entry = this.index.entries[key];
    if (!entry) return null;

    try {
      const entryUri = vscode.Uri.joinPath(this.cacheUri, `${entry.hash}.json`);
      const data = await vscode.workspace.fs.readFile(entryUri);
      const cacheEntry = JSON.parse(Buffer.from(data).toString('utf8')) as CacheEntry;

      // Update access time
      entry.accessTime = Date.now();
      this._scheduleIndexSave();

      return cacheEntry.value;
    } catch {
      // Entry corrupted or missing, remove from index
      delete this.index.entries[key];
      this._scheduleIndexSave();
      return null;
    }
  }

  /**
   * Set cached value
   */
  async set(key: string, value: unknown, type: string = 'unknown'): Promise<boolean> {
    await this.init();
    if (!this.index || !this.cacheUri) return false;

    try {
      const hash = this.generateKey(key);
      const now = Date.now();
      const serialized = JSON.stringify(value);
      const size = Buffer.byteLength(serialized, 'utf8');

      const cacheEntry: CacheEntry = {
        key,
        value,
        type,
        size,
        accessTime: now,
        createdTime: now
      };

      // Write cache entry to file
      const entryUri = vscode.Uri.joinPath(this.cacheUri, `${hash}.json`);
      await vscode.workspace.fs.writeFile(
        entryUri,
        Buffer.from(JSON.stringify(cacheEntry), 'utf8')
      );

      // Update index
      this.index.entries[key] = {
        hash,
        type,
        size,
        accessTime: now,
        createdTime: now
      };
      await this._saveIndex();

      // Schedule cleanup if needed
      this._scheduleCleanup();

      return true;
    } catch (error) {
      console.error('[CacheService] Set failed:', error);
      return false;
    }
  }

  /**
   * Delete cached value
   */
  async delete(key: string): Promise<boolean> {
    await this.init();
    if (!this.index || !this.cacheUri) return false;

    const entry = this.index.entries[key];
    if (!entry) return false;

    try {
      const entryUri = vscode.Uri.joinPath(this.cacheUri, `${entry.hash}.json`);
      await vscode.workspace.fs.delete(entryUri);
      delete this.index.entries[key];
      await this._saveIndex();
      return true;
    } catch {
      // File might already be deleted
      delete this.index.entries[key];
      await this._saveIndex();
      return true;
    }
  }

  /**
   * Clear all cached values
   */
  async clear(): Promise<boolean> {
    await this.init();
    return this._clearAll();
  }

  private async _clearAll(): Promise<boolean> {
    if (!this.cacheUri) return false;

    try {
      // Delete entire cache directory
      await vscode.workspace.fs.delete(this.cacheUri, { recursive: true });
      // Recreate directory
      await vscode.workspace.fs.createDirectory(this.cacheUri);
      // Reset index
      this.index = this._createEmptyIndex();
      await this._saveIndex();
      return true;
    } catch (error) {
      console.error('[CacheService] Clear failed:', error);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    await this.init();
    if (!this.index) {
      return {
        itemCount: 0,
        maxItems: MAX_CACHE_ITEMS,
        totalSize: 0,
        totalSizeMB: '0.00 MB',
        items: []
      };
    }

    const entries = Object.entries(this.index.entries);
    const totalSize = entries.reduce((sum, [, entry]) => sum + entry.size, 0);

    return {
      itemCount: entries.length,
      maxItems: MAX_CACHE_ITEMS,
      totalSize,
      totalSizeMB: `${(totalSize / 1024 / 1024).toFixed(2)} MB`,
      items: entries.map(([key, entry]) => ({
        key,
        size: entry.size,
        type: entry.type,
        accessTime: entry.accessTime
      }))
    };
  }

  /**
   * Schedule index save (debounced)
   */
  private _indexSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private _scheduleIndexSave(): void {
    if (this._indexSaveTimeout) return;
    this._indexSaveTimeout = setTimeout(() => {
      this._indexSaveTimeout = null;
      this._saveIndex();
    }, 1000);
  }

  private async _saveIndex(): Promise<void> {
    if (!this.index || !this.indexUri) return;
    
    // Queue write to avoid concurrent writes
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await vscode.workspace.fs.writeFile(
          this.indexUri!,
          Buffer.from(JSON.stringify(this.index, null, 2), 'utf8')
        );
      } catch (error) {
        console.error('[CacheService] Failed to save index:', error);
      }
    });
    await this.writeQueue;
  }

  /**
   * Schedule cleanup if cache is too large
   */
  private _scheduleCleanup(): void {
    if (this.cleanupScheduled || !this.index) return;
    
    const itemCount = Object.keys(this.index.entries).length;
    if (itemCount < CLEANUP_THRESHOLD) return;

    this.cleanupScheduled = true;
    setTimeout(() => {
      this._performCleanup();
      this.cleanupScheduled = false;
    }, 5000);
  }

  /**
   * Perform LRU cleanup
   */
  private async _performCleanup(): Promise<void> {
    if (!this.index || !this.cacheUri) return;

    const entries = Object.entries(this.index.entries);
    if (entries.length <= CLEANUP_THRESHOLD) return;

    // Sort by access time (oldest first)
    entries.sort((a, b) => a[1].accessTime - b[1].accessTime);

    // Remove oldest entries until we're at cleanup threshold
    const toRemove = entries.slice(0, entries.length - CLEANUP_THRESHOLD);
    
    for (const [key, entry] of toRemove) {
      try {
        const entryUri = vscode.Uri.joinPath(this.cacheUri, `${entry.hash}.json`);
        await vscode.workspace.fs.delete(entryUri);
      } catch {
        // Ignore deletion errors
      }
      delete this.index.entries[key];
    }

    await this._saveIndex();
  }
}
