// Localization manager providing user-selectable locales.
// Note: Comments in English per instructions.

import { fetchJSON } from './fetch-utils.js';

/**
 * Get platform instance from global scope
 * Platform is set by each platform's index.js before using shared modules
 */
function getPlatform() {
  return globalThis.platform;
}

const DEFAULT_SETTING_LOCALE = 'auto';
const FALLBACK_LOCALE = 'en';

class LocalizationManager {
  constructor() {
    this.messages = null;
    this.locale = DEFAULT_SETTING_LOCALE;
    this.ready = false;
    this.loadingPromise = null;
    this.fallbackMessages = null;
  }

  async init() {
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      try {
        await this.ensureFallbackMessages();
        const storageKeys = await this.getStorageSettings();
        const preferredLocale = storageKeys?.preferredLocale || DEFAULT_SETTING_LOCALE;
        if (preferredLocale !== DEFAULT_SETTING_LOCALE) {
          await this.loadLocale(preferredLocale);
        }
        this.locale = preferredLocale;
      } catch (error) {
        console.warn('[Localization] init failed:', error);
      } finally {
        // Ensure ready state reflects whether messages are available
        this.ready = Boolean(this.messages || this.fallbackMessages);
      }
    })();

    return this.loadingPromise;
  }

  async getStorageSettings() {
    const platform = getPlatform();
    if (!platform?.storage) {
      return null;
    }

    const result = await platform.storage.get(['markdownViewerSettings']);
    if (result && result.markdownViewerSettings) {
      return result.markdownViewerSettings;
    }
    return null;
  }

  async setPreferredLocale(locale) {
    const normalized = locale || DEFAULT_SETTING_LOCALE;
    if (normalized === DEFAULT_SETTING_LOCALE) {
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
      this.locale = DEFAULT_SETTING_LOCALE;
    } else {
      await this.loadLocale(normalized);
      this.locale = normalized;
      this.ready = Boolean(this.messages || this.fallbackMessages);
    }
  }

  async ensureFallbackMessages() {
    if (this.fallbackMessages) {
      return;
    }

    this.fallbackMessages = await this.fetchLocaleData(FALLBACK_LOCALE);
  }

  async loadLocale(locale) {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[Localization] Failed to load locale', locale, error);
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async fetchLocaleData(locale) {
    try {
      const platform = getPlatform();
      const url = platform.resource.getURL(`_locales/${locale}/messages.json`);
      return await fetchJSON(url);
    } catch (error) {
      console.warn('[Localization] fetchLocaleData failed for', locale, error.message || error);
      return null;
    }
  }

  translate(key, substitutions) {
    if (!key) {
      return '';
    }

    // Attempt to use user-selected messages first
    const value = this.lookupMessage(this.messages, key, substitutions);
    if (value !== null) {
      return value;
    }

    const fallbackValue = this.lookupMessage(this.fallbackMessages, key, substitutions);
    if (fallbackValue !== null) {
      return fallbackValue;
    }

    // Use platform's i18n service as last resort (both Chrome and Mobile now use translate)
    const platform = getPlatform();
    if (platform?.i18n?.translate) {
      return platform.i18n.translate(key, substitutions) || '';
    }

    return '';
  }

  lookupMessage(source, key, substitutions) {
    if (!source || !source[key]) {
      return null;
    }

    const template = source[key].message || '';
    if (!template) {
      return '';
    }

    if (!substitutions) {
      return template;
    }

    const list = Array.isArray(substitutions) ? substitutions : [substitutions];
    return template.replace(/\{(\d+)\}/g, (match, index) => {
      const idx = parseInt(index, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= list.length) {
        return match;
      }
      return list[idx];
    });
  }

  getLocale() {
    return this.locale;
  }
}

const Localization = new LocalizationManager();

export default Localization;
export { DEFAULT_SETTING_LOCALE };
