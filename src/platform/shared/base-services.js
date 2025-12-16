/**
 * Platform Shared Base Services
 * 
 * Common base implementations that can be extended by platform-specific code.
 * These classes provide default implementations for cross-platform functionality.
 */

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
   * @param {string} text - Text to hash
   * @returns {Promise<string>} Hex hash string
   */
  async calculateHash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate cache key from content, type, and optional theme config
   * @param {string} content - Content to cache
   * @param {string} type - Cache type (e.g., 'MERMAID_PNG')
   * @param {object|null} themeConfig - Optional theme configuration
   * @returns {Promise<string>} Cache key
   */
  async generateKey(content, type, themeConfig = null) {
    let keyContent = content;
    
    // Include theme config in cache key if provided
    if (themeConfig && themeConfig.fontFamily && themeConfig.fontSize) {
      keyContent = `${content}_font:${themeConfig.fontFamily}_size:${themeConfig.fontSize}`;
    }
    
    const hash = await this.calculateHash(keyContent);
    return `${hash}_${type}`;
  }

  // Abstract methods - must be implemented by subclasses
  async init() {
    throw new Error('Not implemented');
  }

  async ensureDB() {
    throw new Error('Not implemented');
  }

  async get(key) {
    throw new Error('Not implemented');
  }

  async set(key, value, type) {
    throw new Error('Not implemented');
  }

  async clear() {
    throw new Error('Not implemented');
  }

  async getStats() {
    return null;
  }
}

// ============================================================================
// Base I18n Service
// ============================================================================

const DEFAULT_SETTING_LOCALE = 'auto';
const FALLBACK_LOCALE = 'en';

/**
 * Base i18n service with common message lookup logic.
 * Platform-specific implementations should extend this.
 */
export class BaseI18nService {
  constructor() {
    this.messages = null;
    this.fallbackMessages = null;
    this.locale = DEFAULT_SETTING_LOCALE;
    this.ready = false;
  }

  /**
   * Initialize the i18n service
   */
  async init() {
    throw new Error('Not implemented');
  }

  /**
   * Get current locale
   * @returns {string} Current locale code
   */
  getLocale() {
    return this.locale;
  }

  /**
   * Set preferred locale
   * @param {string} locale - Locale code or 'auto'
   */
  async setLocale(locale) {
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
   * @param {string} locale - Locale code
   */
  async loadLocale(locale) {
    throw new Error('Not implemented');
  }

  /**
   * Ensure fallback messages are loaded
   */
  async ensureFallbackMessages() {
    if (this.fallbackMessages) return;
    this.fallbackMessages = await this.fetchLocaleData(FALLBACK_LOCALE);
  }

  /**
   * Fetch locale data (must be implemented by subclass)
   * @param {string} locale - Locale code
   * @returns {Promise<object|null>} Locale messages object
   */
  async fetchLocaleData(locale) {
    throw new Error('Not implemented');
  }

  /**
   * Translate a message key
   * @param {string} key - Message key
   * @param {string|string[]} substitutions - Replacement values
   * @returns {string} Translated message
   */
  translate(key, substitutions) {
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
   * @param {object} source - Messages object
   * @param {string} key - Message key
   * @param {string|string[]} substitutions - Replacement values
   * @returns {string|null} Message or null if not found
   */
  lookupMessage(source, key, substitutions) {
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
  constructor() {
    this.themeConfig = null;
  }

  /**
   * Initialize the renderer
   */
  async init() {
    // Override in subclass if needed
  }

  /**
   * Set theme configuration
   * @param {object} config - Theme configuration
   */
  async setThemeConfig(config) {
    this.themeConfig = config;
  }

  /**
   * Get current theme configuration
   * @returns {object|null} Current theme config
   */
  getThemeConfig() {
    return this.themeConfig;
  }

  /**
   * Render content (must be implemented by subclass)
   * @param {string} type - Render type
   * @param {string|object} content - Content to render
   * @param {object} options - Render options
   * @returns {Promise<object>} Render result
   */
  async render(type, content, options = {}) {
    throw new Error('Not implemented');
  }
}

// ============================================================================
// Export Constants
// ============================================================================

export { DEFAULT_SETTING_LOCALE, FALLBACK_LOCALE };
