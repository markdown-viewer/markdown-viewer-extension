/**
 * Chrome Platform API Implementation
 * 
 * Implements the platform interface for Chrome Extension environment.
 */

import {
  BaseCacheService,
  BaseI18nService,
  BaseRendererService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE
} from '../shared/index.js';

// ============================================================================
// Chrome Storage Service
// ============================================================================

class ChromeStorageService {
  async get(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => {
        resolve(result || {});
      });
    });
  }

  async set(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, () => {
        resolve();
      });
    });
  }

  async remove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => {
        resolve();
      });
    });
  }
}

// ============================================================================
// Chrome File Service
// ============================================================================

class ChromeFileService {
  async download(blob, filename, options = {}) {
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: options.saveAs !== false
      });
    } finally {
      // Delay revoke to ensure download starts
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

// ============================================================================
// Chrome Resource Service
// ============================================================================

class ChromeResourceService {
  getURL(path) {
    return chrome.runtime.getURL(path);
  }

  /**
   * Fetch asset content
   * @param {string} path - Asset path relative to extension root
   * @returns {Promise<string>} Asset content as string
   */
  async fetch(path) {
    const url = this.getURL(path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}

// ============================================================================
// Chrome Message Service
// ============================================================================

class ChromeMessageService {
  send(message, timeout = 300000) {
    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        reject(new Error('Message timeout after 5 minutes'));
      }, timeout);

      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timeoutTimer);

        if (chrome.runtime.lastError) {
          reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
          return;
        }

        if (!response) {
          reject(new Error('No response received from background script'));
          return;
        }

        if (response.error) {
          reject(new Error(response.error));
          return;
        }

        resolve(response);
      });
    });
  }

  addListener(handler) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const result = handler(message, sender);
      if (result instanceof Promise) {
        result.then(sendResponse).catch((err) => {
          sendResponse({ error: err.message });
        });
        return true; // Keep channel open for async response
      }
      return false;
    });
  }
}

// ============================================================================
// Chrome Cache Service (Proxy to Background)
// Extends BaseCacheService for common hash/key generation
// ============================================================================

class ChromeCacheService extends BaseCacheService {
  constructor(messageService) {
    super();
    this.messageService = messageService;
  }

  async init() {
    // No initialization needed, background handles it
  }

  async ensureDB() {
    // No initialization needed, background handles it
  }

  async get(key) {
    try {
      const response = await this.messageService.send({
        type: 'cacheOperation',
        operation: 'get',
        key: key
      });
      return response.result || null;
    } catch (error) {
      return null;
    }
  }

  async set(key, value, type = 'unknown') {
    try {
      const response = await this.messageService.send({
        type: 'cacheOperation',
        operation: 'set',
        key: key,
        value: value,
        dataType: type
      });
      return response.success || false;
    } catch (error) {
      return false;
    }
  }

  async clear() {
    try {
      const response = await this.messageService.send({
        type: 'cacheOperation',
        operation: 'clear'
      });
      return response.success || false;
    } catch (error) {
      return false;
    }
  }

  async getStats() {
    try {
      const response = await this.messageService.send({
        type: 'cacheOperation',
        operation: 'getStats'
      });
      return response.result || null;
    } catch (error) {
      return null;
    }
  }
}

// ============================================================================
// Chrome Renderer Service
// Extends BaseRendererService for common theme config handling
// ============================================================================

class ChromeRendererService extends BaseRendererService {
  constructor(messageService, cacheService) {
    super();
    this.messageService = messageService;
    this.cache = cacheService;
  }

  async init() {
    // Renderer initialization handled by background/offscreen
  }

  async setThemeConfig(config) {
    this.themeConfig = config;
    try {
      await this.messageService.send({
        type: 'setThemeConfig',
        config: config
      });
    } catch (error) {
      console.error('Failed to set theme config:', error);
    }
  }

  async render(type, content, options = {}) {
    // Generate cache key
    const inputString = typeof content === 'string' ? content : JSON.stringify(content);
    const contentKey = inputString + JSON.stringify(options);
    const cacheType = `${type.toUpperCase()}_PNG`;
    const cacheKey = await this.cache.generateKey(contentKey, cacheType, this.themeConfig);

    // Check cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Send render request to background
    const message = {
      action: 'RENDER_DIAGRAM',
      renderType: type,
      input: content,
      themeConfig: this.themeConfig,
      extraParams: options
    };

    const response = await this.messageService.send(message);

    if (response.error) {
      throw new Error(response.error);
    }

    // Cache the result asynchronously (don't wait)
    this.cache.set(cacheKey, response, cacheType).catch(() => {});

    return response;
  }
}

// ============================================================================
// Chrome I18n Service
// Extends BaseI18nService for common message lookup logic
// ============================================================================

class ChromeI18nService extends BaseI18nService {
  constructor(storageService, resourceService) {
    super();
    this.storageService = storageService;
    this.resourceService = resourceService;
  }

  async init() {
    try {
      await this.ensureFallbackMessages();
      const result = await this.storageService.get(['markdownViewerSettings']);
      const settings = result.markdownViewerSettings || {};
      const preferredLocale = settings.preferredLocale || DEFAULT_SETTING_LOCALE;
      
      if (preferredLocale !== DEFAULT_SETTING_LOCALE) {
        await this.loadLocale(preferredLocale);
      }
      this.locale = preferredLocale;
    } catch (error) {
      console.warn('[I18n] init failed:', error);
    } finally {
      this.ready = Boolean(this.messages || this.fallbackMessages);
    }
  }

  async loadLocale(locale) {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] Failed to load locale', locale, error);
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async fetchLocaleData(locale) {
    try {
      const url = this.resourceService.getURL(`_locales/${locale}/messages.json`);
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.warn('[I18n] fetchLocaleData failed for', locale, error);
      return null;
    }
  }

  translate(key, substitutions) {
    if (!key) return '';

    // Try user-selected messages first (using base class logic)
    const value = this.lookupMessage(this.messages, key, substitutions);
    if (value !== null) return value;

    // Try fallback messages
    const fallbackValue = this.lookupMessage(this.fallbackMessages, key, substitutions);
    if (fallbackValue !== null) return fallbackValue;

    // Use Chrome's built-in i18n as last resort
    if (chrome?.i18n?.getMessage) {
      return chrome.i18n.getMessage(key, substitutions) || '';
    }

    return '';
  }
}

// ============================================================================
// Chrome Platform API
// ============================================================================

class ChromePlatformAPI {
  constructor() {
    this.platform = 'chrome';
    
    // Initialize services
    this.storage = new ChromeStorageService();
    this.file = new ChromeFileService();
    this.resource = new ChromeResourceService();
    this.message = new ChromeMessageService();
    this.cache = new ChromeCacheService(this.message);
    this.renderer = new ChromeRendererService(this.message, this.cache);
    this.i18n = new ChromeI18nService(this.storage, this.resource);
  }

  async init() {
    await this.cache.init();
    await this.i18n.init();
  }
}

// ============================================================================
// Export
// ============================================================================

export const chromePlatform = new ChromePlatformAPI();

export {
  ChromeStorageService,
  ChromeFileService,
  ChromeResourceService,
  ChromeMessageService,
  ChromeCacheService,
  ChromeRendererService,
  ChromeI18nService,
  ChromePlatformAPI,
  DEFAULT_SETTING_LOCALE
};
