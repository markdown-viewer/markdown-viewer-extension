/**
 * Platform Shared Base Services
 * 
 * Common base implementations that can be extended by platform-specific code.
 * These classes provide default implementations for cross-platform functionality.
 */

import type { RendererThemeConfig, RenderResult } from '../../types/render';
import type { CacheStats, SimpleCacheStats } from '../../types/cache';

// ============================================================================
// Type Definitions (local only, not exported)
// ============================================================================

/**
 * Single locale message entry
 */
export interface LocaleMessageEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

/**
 * Locale messages object
 */
export interface LocaleMessages {
  [key: string]: LocaleMessageEntry;
}

// ============================================================================
// Base Cache Service
// ============================================================================

/**
 * Base cache service with common hash/key generation logic.
 * Platform-specific implementations should extend this.
 */
export class BaseCacheService {
  /**
   * Calculate SHA-256 hash of text
   * @param text - Text to hash
   * @returns Hex hash string
   */
  async calculateHash(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate cache key from content, type, and optional theme config
   * @param content - Content to cache
   * @param type - Cache type (e.g., 'MERMAID_PNG')
   * @param themeConfig - Optional theme configuration
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
   * Estimate byte size of data
   */
  estimateSize(data: unknown): number {
    return new Blob([typeof data === 'string' ? data : JSON.stringify(data)]).size;
  }

  // Abstract methods - must be implemented by subclasses
  async init(): Promise<void> {
    throw new Error('Not implemented');
  }

  async ensureDB(): Promise<unknown> {
    throw new Error('Not implemented');
  }

  async get(key: string): Promise<unknown> {
    throw new Error('Not implemented');
  }

  async set(key: string, value: unknown, type?: string): Promise<boolean> {
    throw new Error('Not implemented');
  }

  async delete(key: string): Promise<boolean> {
    throw new Error('Not implemented');
  }

  async clear(): Promise<boolean> {
    throw new Error('Not implemented');
  }

  async cleanup(): Promise<void> {
    // Optional: LRU cleanup implementation
  }

  async getStats(): Promise<CacheStats | SimpleCacheStats | null> {
    return null;
  }
}

// ============================================================================
// Base I18n Service
// ============================================================================

export const DEFAULT_SETTING_LOCALE = 'auto';
export const FALLBACK_LOCALE = 'en';

/**
 * Base i18n service with common message lookup logic.
 * Platform-specific implementations should extend this.
 */
export class BaseI18nService {
  protected messages: LocaleMessages | null = null;
  protected fallbackMessages: LocaleMessages | null = null;
  protected locale: string = DEFAULT_SETTING_LOCALE;
  protected ready: boolean = false;

  constructor() {
    this.messages = null;
    this.fallbackMessages = null;
    this.locale = DEFAULT_SETTING_LOCALE;
    this.ready = false;
  }

  /**
   * Initialize the i18n service
   */
  async init(): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Get current locale
   * @returns Current locale code
   */
  getLocale(): string {
    return this.locale;
  }

  /**
   * Set preferred locale
   * @param locale - Locale code or 'auto'
   */
  async setLocale(locale: string): Promise<void> {
    const normalized = locale || DEFAULT_SETTING_LOCALE;
    if (normalized === DEFAULT_SETTING_LOCALE) {
      this.messages = null;
      this.locale = DEFAULT_SETTING_LOCALE;
    } else {
      await this.loadLocale(normalized);
      this.locale = normalized;
    }
    this.ready = Boolean(this.messages || this.fallbackMessages);
  }

  /**
   * Load locale data (must be implemented by subclass)
   * @param locale - Locale code
   */
  async loadLocale(locale: string): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Ensure fallback messages are loaded
   */
  async ensureFallbackMessages(): Promise<void> {
    if (this.fallbackMessages) return;
    this.fallbackMessages = await this.fetchLocaleData(FALLBACK_LOCALE);
  }

  /**
   * Fetch locale data (must be implemented by subclass)
   * @param locale - Locale code
   * @returns Locale messages object
   */
  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    throw new Error('Not implemented');
  }

  /**
   * Translate a message key
   * @param key - Message key
   * @param substitutions - Replacement values
   * @returns Translated message
   */
  translate(key: string, substitutions?: string | string[]): string {
    if (!key) return '';

    // Try user-selected messages first
    const value = this.lookupMessage(this.messages, key, substitutions);
    if (value !== null) return value;

    // Try fallback messages
    const fallbackValue = this.lookupMessage(this.fallbackMessages, key, substitutions);
    if (fallbackValue !== null) return fallbackValue;

    return '';
  }

  /**
   * Lookup message in source with substitutions
   * @param source - Messages object
   * @param key - Message key
   * @param substitutions - Replacement values
   * @returns Message or null if not found
   */
  lookupMessage(source: LocaleMessages | null, key: string, substitutions?: string | string[]): string | null {
    if (!source || !source[key]) return null;

    const template = source[key].message || '';
    if (!template) return '';
    if (!substitutions) return template;

    const list = Array.isArray(substitutions) ? substitutions : [substitutions];
    return template.replace(/\{(\d+)\}/g, (match, index) => {
      const idx = parseInt(index, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= list.length) {
        return match;
      }
      return list[idx];
    });
  }
}

// ============================================================================
// Base Renderer Service
// ============================================================================

/**
 * Base renderer service with common cache integration logic.
 * Platform-specific implementations should extend this.
 */
export class BaseRendererService {
  protected themeConfig: RendererThemeConfig | null = null;

  constructor() {
    this.themeConfig = null;
  }

  /**
   * Initialize the renderer
   */
  async init(): Promise<void> {
    // Override in subclass if needed
  }

  /**
   * Set theme configuration
   * @param config - Theme configuration
   */
  async setThemeConfig(config: RendererThemeConfig): Promise<void> {
    this.themeConfig = config;
  }

  /**
   * Get current theme configuration
   * @returns Current theme config
   */
  getThemeConfig(): RendererThemeConfig | null {
    return this.themeConfig;
  }

  /**
   * Render content (must be implemented by subclass)
   * @param type - Render type
   * @param content - Content to render
   * @returns Render result
   */
  async render(type: string, content: string | object): Promise<RenderResult> {
    throw new Error('Not implemented');
  }
}
