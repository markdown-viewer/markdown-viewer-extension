// Mobile Platform API Implementation
// Runs in WebView context, communicates with the host app (Flutter) via JavaScript channel.

import {
  BaseCacheService,
  BaseI18nService,
  BaseRendererService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE
} from '../shared/index.js';

/**
 * Message bridge for Host ↔ WebView communication.
 *
 * Flutter integration notes:
 * - JS -> Flutter: use JavascriptChannel name `MarkdownViewer`, call `MarkdownViewer.postMessage(JSON.stringify(...))`.
 * - Flutter -> JS: execute JS `window.__receiveMessageFromHost(<json or object>)`.
 */
class MessageBridge {
  constructor() {
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.listeners = [];
    this._setupMessageHandler();
  }

  _setupMessageHandler() {
    const handleIncoming = (data) => {
      if (!data) return;

      // Allow string payloads (JSON)
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }

      if (!data || typeof data !== 'object') return;

      // Handle response to pending request
      if (data._responseId !== undefined) {
        const pending = this.pendingRequests.get(data._responseId);
        if (pending) {
          this.pendingRequests.delete(data._responseId);
          if (data.error) {
            pending.reject(new Error(data.error));
          } else {
            pending.resolve(data.result);
          }
        }
        return;
      }

      // Handle incoming message from host
      for (const listener of this.listeners) {
        try {
          listener(data);
        } catch (e) {
          console.error('Message listener error:', e);
        }
      }
    };

    // Optional: support window.postMessage-based delivery (e.g. debugging)
    window.addEventListener('message', (event) => handleIncoming(event.data));

    // Primary: Flutter calls this via `runJavaScript`
    window.__receiveMessageFromHost = (payload) => {
      handleIncoming(payload);
    };
  }

  /**
   * Send message to React Native and wait for response
   */
  sendRequest(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, 30000);

      this._postToHost({
        _requestId: id,
        type,
        payload
      });
    });
  }

  /**
   * Send message to React Native without waiting for response
   */
  postMessage(type, payload = {}) {
    this._postToHost({ type, payload });
  }

  _postToHost(message) {
    const json = JSON.stringify(message);

    // Flutter WebView: JavascriptChannel
    if (window.MarkdownViewer && typeof window.MarkdownViewer.postMessage === 'function') {
      window.MarkdownViewer.postMessage(json);
      return;
    }

    // No-op fallback (host channel not available)
    console.warn('[Mobile] Host message channel not available');
  }

  /**
   * Add listener for messages from React Native
   */
  addListener(callback) {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) this.listeners.splice(index, 1);
    };
  }
}

const bridge = new MessageBridge();

/**
 * Mobile Storage Service
 * Storage operations handled by host app (Flutter).
 */
class MobileStorageService {
  async get(keys) {
    return bridge.sendRequest('STORAGE_GET', { keys });
  }

  async set(items) {
    return bridge.sendRequest('STORAGE_SET', { items });
  }

  async remove(keys) {
    return bridge.sendRequest('STORAGE_REMOVE', { keys });
  }
}

/**
 * Mobile File Service
 * File operations handled by host app (Flutter).
 */
class MobileFileService {
  /**
   * Download/share file - unified interface with Chrome
   * @param {Blob|string} data - Blob or base64 string
   * @param {string} filename - File name
   * @param {object} options - Download options
   */
  async download(data, filename, options = {}) {
    let base64Data;
    let mimeType = options.mimeType || 'application/octet-stream';
    
    if (data instanceof Blob) {
      // Convert Blob to base64 for Flutter
      base64Data = await this._blobToBase64(data);
      mimeType = data.type || mimeType;
    } else {
      // Assume already base64
      base64Data = data;
    }
    
    bridge.postMessage('DOWNLOAD_FILE', {
      filename,
      data: base64Data,
      mimeType
    });
  }

  async _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

/**
 * Mobile Resource Service
 * Resources are bundled with the app
 */
class MobileResourceService {
  getURL(path) {
    // In mobile WebView loaded via loadFlutterAsset, we need absolute asset URLs
    // The base URL for Flutter assets is typically:
    // - iOS: app bundle path
    // - Android: file:///android_asset/flutter_assets/assets/webview/
    // Using relative paths from the loaded HTML should work
    return `./${path}`;
  }

  /**
   * Fetch asset content via Flutter bridge
   * WebView's native fetch doesn't work reliably with Flutter assets
   * @param {string} path - Asset path relative to webview folder
   * @returns {Promise<string>} Asset content as string
   */
  async fetch(path) {
    return bridge.sendRequest('FETCH_ASSET', { path });
  }
}

/**
 * Mobile Message Service
 * Handles Host ↔ WebView communication
 */
class MobileMessageService {
  send(message) {
    return bridge.sendRequest('MESSAGE', message);
  }

  addListener(callback) {
    return bridge.addListener(callback);
  }
}

/**
 * Mobile Cache Service
 * Uses IndexedDB directly in WebView
 * Extends BaseCacheService for common hash/key generation
 */
class MobileCacheService extends BaseCacheService {
  constructor() {
    super();
    this.dbName = 'MarkdownViewerCache';
    this.storeName = 'cache';
    this.db = null;
  }

  async init() {
    await this.ensureDB();
  }

  async ensureDB() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
    });
  }

  async get(key) {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.value || null);
    });
  }

  async set(key, value, type = 'unknown') {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.put({ key, value, type, timestamp: Date.now() });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  }

  async delete(key) {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  }

  async clear() {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  }

  async getStats() {
    // Minimal stats implementation for mobile WebView
    return null;
  }
}

/**
 * Mobile Renderer Service
 * Renders diagrams in a separate iframe to avoid blocking main thread
 * Similar to Chrome extension's offscreen document approach
 * Extends BaseRendererService for common theme config handling
 * 
 * Uses global state set up by inline script in index.html:
 * - window.__renderFrameReady
 * - window.__renderFrameReadyCallbacks
 * - window.__renderFramePendingRequests
 */
class MobileRendererService extends BaseRendererService {
  constructor() {
    super();
    this.iframe = null;
    this.requestId = 0;
    this.readyPromise = null;
    this.requestQueue = Promise.resolve(); // Serial request queue
  }

  /**
   * Check if render frame is ready
   */
  get isReady() {
    return window.__renderFrameReady || false;
  }

  /**
   * Get pending requests map (shared with inline script)
   */
  get pendingRequests() {
    return window.__renderFramePendingRequests;
  }

  /**
   * Wait for render iframe to be ready
   */
  async ensureIframe() {
    // Get iframe reference
    if (!this.iframe) {
      this.iframe = document.getElementById('render-frame');
    }

    // Already ready (detected by inline script)
    if (this.isReady) {
      return;
    }

    // Already waiting
    if (this.readyPromise) {
      return this.readyPromise;
    }

    // Wait for ready callback
    this.readyPromise = new Promise((resolve, reject) => {
      // Register callback
      window.__renderFrameReadyCallbacks.push(resolve);

      // Timeout
      setTimeout(() => {
        if (!this.isReady) {
          console.error('[MobileRenderer] Render frame load timeout');
          reject(new Error('Render frame load timeout'));
        }
      }, 15000);
    });

    return this.readyPromise;
  }

  /**
   * Send message to iframe and wait for response
   * Requests are serialized: wait for previous request to complete before sending next
   * Each request has its own timeout
   */
  sendRequest(type, payload = {}, timeout = 60000) {
    // Chain this request after previous one completes
    const request = this.requestQueue.then(() => this._doSendRequest(type, payload, timeout));
    
    // Update queue (don't let errors break the chain)
    this.requestQueue = request.catch(() => {});
    
    return request;
  }
  
  /**
   * Actually send the request and wait for response
   */
  _doSendRequest(type, payload, timeout) {
    return new Promise((resolve, reject) => {
      if (!this.iframe || !this.isReady) {
        reject(new Error('Render frame not ready'));
        return;
      }

      const id = ++this.requestId;
      
      // Timeout timer
      const timeoutTimer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Render request timeout (${timeout/1000}s): ${type}`));
        }
      }, timeout);
      
      this.pendingRequests.set(id, { 
        resolve: (result) => {
          clearTimeout(timeoutTimer);
          resolve(result);
        }, 
        reject: (error) => {
          clearTimeout(timeoutTimer);
          reject(error);
        }
      });

      this.iframe.contentWindow.postMessage({
        ...payload,
        type,
        requestId: id
      }, '*');
    });
  }

  // Keep for compatibility, but not used with iframe approach
  registerRenderer(type, renderer) {
    // No-op: renderers are loaded inside iframe
  }

  /**
   * Set theme configuration for rendering
   * @param {object} config - Theme configuration (fontFamily, fontSize, etc.)
   */
  async setThemeConfig(config) {
    this.themeConfig = config;
    await this.ensureIframe();
    return this.sendRequest('SET_THEME_CONFIG', { config });
  }

  /**
   * Render content using the iframe renderer
   * @param {string} type - Renderer type (mermaid, vega, vega-lite, svg, html)
   * @param {string|object} input - Content to render
   * @param {object} extraParams - Extra parameters for the renderer (including outputFormat)
   * @returns {Promise<{base64?: string, svg?: string, width: number, height: number, format: string}>}
   */
  async render(type, input, extraParams = {}) {
    // Generate cache key - access cache via platform singleton (set up later)
    const cache = window.__mobilePlatformCache;
    if (cache) {
      const inputString = typeof input === 'string' ? input : JSON.stringify(input);
      const contentKey = inputString + JSON.stringify(extraParams);
      // Generate cache type based on output format
      const outputFormat = extraParams.outputFormat || 'png';
      const formatSuffix = outputFormat.toUpperCase();
      const cacheType = `${type.toUpperCase()}_${formatSuffix}`;
      const cacheKey = await cache.generateKey(contentKey, cacheType, this.themeConfig, outputFormat);

      // Check cache first
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Render via iframe
      await this.ensureIframe();
      const result = await this.sendRequest('RENDER_DIAGRAM', {
        renderType: type,
        input,
        themeConfig: this.themeConfig,
        extraParams
      });

      // Cache the result asynchronously (don't wait)
      cache.set(cacheKey, result, cacheType).catch(() => {});

      return result;
    }

    // Fallback: no cache available
    await this.ensureIframe();
    return this.sendRequest('RENDER_DIAGRAM', {
      renderType: type,
      input,
      themeConfig: this.themeConfig,
      extraParams
    });
  }

  async cleanup() {
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
      this.iframe = null;
      this.readyPromise = null;
    }
  }
}

/**
 * Mobile I18n Service
 * Loads locale data from bundled JSON files
 * Extends BaseI18nService for common message lookup logic
 */
class MobileI18nService extends BaseI18nService {
  constructor() {
    super();
  }

  async init() {
    try {
      await this.ensureFallbackMessages();
      // For mobile, we use system locale by default
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] init failed:', error);
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async loadLocale(locale) {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.locale = locale;
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (e) {
      console.warn('Failed to load locale:', locale, e);
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async fetchLocaleData(locale) {
    try {
      const response = await fetch(`./_locales/${locale}/messages.json`);
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      console.warn('[I18n] fetchLocaleData failed for', locale, error);
      return null;
    }
  }
}

/**
 * Mobile Platform API
 * Implements PlatformAPI interface for mobile WebView environment
 */
class MobilePlatformAPI {
  constructor() {
    // Platform identifier (readonly property)
    this.platform = 'mobile';
    
    // Initialize services
    this.storage = new MobileStorageService();
    this.file = new MobileFileService();
    this.resource = new MobileResourceService();
    this.message = new MobileMessageService();
    this.cache = new MobileCacheService();
    this.renderer = new MobileRendererService();
    this.i18n = new MobileI18nService();
    
    // Internal bridge reference (for advanced usage)
    this._bridge = bridge;

    // Expose cache globally for renderer to use
    window.__mobilePlatformCache = this.cache;
  }

  /**
   * Initialize all platform services
   */
  async init() {
    await this.cache.init();
    await this.i18n.init();
  }

  /**
   * Notify host app that WebView is ready
   */
  notifyReady() {
    bridge.postMessage('WEBVIEW_READY');
  }

  /**
   * Request file download (triggers system share sheet)
   * @deprecated Use platform.file.download() instead
   */
  downloadFile(filename, data, mimeType) {
    bridge.postMessage('DOWNLOAD_FILE', {
      filename,
      data, // base64 encoded
      mimeType
    });
  }
}

// Export singleton instance
export const platform = new MobilePlatformAPI();
export { bridge, DEFAULT_SETTING_LOCALE };
