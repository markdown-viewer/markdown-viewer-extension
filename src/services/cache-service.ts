/**
 * Unified Cache Service
 * 
 * Application-layer cache service that uses ServiceChannel for communication.
 * Platform-agnostic - works with any transport (Chrome, Mobile, VSCode).
 */

import type { ServiceChannel } from '../messaging/channels/service-channel';
import type { RendererThemeConfig } from '../types/render';
import type { SimpleCacheStats } from '../types/cache';

// ============================================================================
// Types
// ============================================================================

export interface CacheOperationPayload {
  operation: 'get' | 'set' | 'delete' | 'clear' | 'getStats';
  key?: string;
  value?: unknown;
  dataType?: string;
  size?: number;
  limit?: number;
}

export interface CacheSetResult {
  success: boolean;
}

// ============================================================================
// Cache Service
// ============================================================================

/**
 * Unified cache service using ServiceChannel for backend communication.
 * The actual storage is handled by the platform's backend (Background Script,
 * Flutter host, or VSCode Extension Host).
 */
export class CacheService {
  private channel: ServiceChannel;
  private getQueue: Promise<unknown> = Promise.resolve();

  constructor(channel: ServiceChannel) {
    this.channel = channel;
  }

  /**
   * Initialize cache service
   */
  async init(): Promise<void> {
    // Initialization handled by backend
  }

  /**
   * Calculate hash of text (FNV-1a 64-bit, hex string).
   *
   * Cache keys are internal-only indices, so no cryptographic strength is
   * needed. A non-crypto hash also avoids failures in non-secure contexts
   * where `crypto.subtle` is unavailable (e.g. plain HTTP pages hosting
   * <markdown-viewer> elements).
   */
  async calculateHash(text: string): Promise<string> {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
  }

  /**
   * Generate cache key from content, type, and optional theme config
   */
  async generateKey(
    content: string,
    type: string,
    themeConfig: RendererThemeConfig | null = null
  ): Promise<string> {
    let keyContent = content;
    
    if (themeConfig) {
      const fontFamily = themeConfig.fontFamily || '';
      const fontSize = themeConfig.fontSize || '';
      const diagramStyle = themeConfig.diagramStyle || 'normal';
      const colorSchema = themeConfig.colorSchema || '';
      keyContent = `${content}_font:${fontFamily}_size:${fontSize}_style:${diagramStyle}_schema:${colorSchema}`;
    }
    
    const hash = await this.calculateHash(keyContent);
    return `${hash}_${type}`;
  }

  /**
   * Estimate byte size of data
   */
  estimateSize(data: unknown): number {
    return new Blob([typeof data === 'string' ? data : JSON.stringify(data)]).size;
  }

  /**
   * Send a single cache get request.
   */
  private async sendGet(key: string): Promise<unknown> {
    try {
      const result = await this.channel.send('CACHE_OPERATION', {
        operation: 'get',
        key,
      } as CacheOperationPayload);
      return result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get cached item
   */
  async get(key: string): Promise<unknown> {
    const operation = this.getQueue.then(() => this.sendGet(key));
    this.getQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /**
   * Set cached item
   */
  async set(key: string, value: unknown, type: string = 'unknown'): Promise<boolean> {
    try {
      const result = await this.channel.send('CACHE_OPERATION', {
        operation: 'set',
        key,
        value,
        dataType: type,
        size: this.estimateSize(value),
      } as CacheOperationPayload);

      // Handle various response formats
      if (result && typeof result === 'object') {
        const resultObj = result as CacheSetResult;
        return resultObj.success !== false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete cached item
   */
  async delete(key: string): Promise<boolean> {
    try {
      const result = await this.channel.send('CACHE_OPERATION', {
        operation: 'delete',
        key,
      } as CacheOperationPayload);

      if (result && typeof result === 'object') {
        const resultObj = result as CacheSetResult;
        return resultObj.success !== false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<boolean> {
    try {
      const result = await this.channel.send('CACHE_OPERATION', {
        operation: 'clear',
      } as CacheOperationPayload);

      if (result && typeof result === 'object') {
        const resultObj = result as CacheSetResult;
        return resultObj.success !== false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(limit?: number): Promise<SimpleCacheStats | null> {
    try {
      const result = await this.channel.send('CACHE_OPERATION', {
        operation: 'getStats',
        limit,
      } as CacheOperationPayload);

      return (result as SimpleCacheStats) || null;
    } catch {
      return null;
    }
  }
}
