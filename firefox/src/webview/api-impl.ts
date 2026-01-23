/**
 * Firefox Platform API Implementation
 * 
 * Runs in content script context, uses browser.* API.
 * Uses background page rendering (Firefox MV2 background page has DOM access).
 * This is similar to Chrome's Offscreen API approach.
 */

import {
  BaseI18nService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE
} from '../../../src/services';

import type { LocaleMessages } from '../../../src/services';
import type { PlatformBridgeAPI } from '../../../src/types/index';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { BrowserRuntimeTransport } from '../../../chrome/src/transports/chrome-runtime-transport';

import { BackgroundRenderHost } from './hosts/background-render-host';

import { CacheService, StorageService, FileService, FileStateService, RendererService, SettingsService, createSettingsService } from '../../../src/services';

// Firefox WebExtension API types
declare const browser: typeof chrome;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Download options
 */
interface DownloadOptions {
  mimeType?: string;
  [key: string]: unknown;
}

// ============================================================================
// Service Channel (Background ↔ Content Script)
// ============================================================================

const backgroundServiceChannel = new ServiceChannel(new BrowserRuntimeTransport(), {
  source: 'firefox-content',
  timeoutMs: 30000,
});

// Unified cache service (same as Chrome/Mobile)
const cacheService = new CacheService(backgroundServiceChannel);

// Unified storage service (same as Chrome/Mobile)
const storageService = new StorageService(backgroundServiceChannel);

// Unified file service (same as Chrome/Mobile)
const fileService = new FileService(backgroundServiceChannel);

// Unified file state service (same as Chrome/Mobile)
const fileStateService = new FileStateService(backgroundServiceChannel);

// Bridge compatibility layer (for plugins that need direct message access)
export const bridge: PlatformBridgeAPI = {
  sendRequest: async <T = unknown>(type: string, payload: unknown): Promise<T> => {
    return (await backgroundServiceChannel.send(type, payload)) as T;
  },
  postMessage: (type: string, payload: unknown): void => {
    backgroundServiceChannel.post(type, payload);
  },
  addListener: (handler: (message: unknown) => void): (() => void) => {
    return backgroundServiceChannel.onAny((message) => {
      handler(message);
    });
  },
};

// ============================================================================
// Firefox Document Service
// ============================================================================

import { BaseDocumentService } from '../../../src/services/document-service';
import type { ReadFileOptions } from '../../../src/types/platform';

/**
 * Firefox Document Service Implementation
 * 
 * Firefox has strict CORS restrictions that prevent extensions from reading file:// URLs.
 * This is a browser-level security policy that cannot be bypassed via manifest.json.
 * 
 * Supported:
 * - fetchRemote(): Works for http/https URLs
 * - readRelativeFile(): Works for http/https documents (resolves relative to document URL)
 * 
 * Not supported:
 * - readFile(): Cannot read file:// URLs due to Firefox CORS restrictions
 * - readRelativeFile() on file:// pages: Cannot read local files
 */
class FirefoxDocumentService extends BaseDocumentService {
  async readFile(_absolutePath: string, _options?: ReadFileOptions): Promise<string> {
    // Firefox cannot read file:// URLs from extension context due to CORS
    throw new Error('Firefox does not support reading local files from extensions');
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    // Resolve relative path based on current document location and fetch
    const absoluteUrl = new URL(relativePath, window.location.href).href;
    const data = await this.fetchRemote(absoluteUrl);
    
    // Convert to string (base64 for binary, text otherwise)
    if (options?.binary) {
      let binaryString = '';
      for (let i = 0; i < data.byteLength; i++) {
        binaryString += String.fromCharCode(data[i]);
      }
      return btoa(binaryString);
    }
    return new TextDecoder().decode(data);
  }

  async fetchRemote(url: string): Promise<Uint8Array> {
    // Network URLs can be fetched directly from content script
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

// Create singleton instance
const firefoxDocumentService = new FirefoxDocumentService();

// ============================================================================
// Firefox Resource Service
// ============================================================================

/**
 * Firefox Resource Service
 * Resources are accessed via browser.runtime.getURL
 */
class FirefoxResourceService {
  getURL(path: string): string {
    return browser.runtime.getURL(path);
  }

  /**
   * Fetch asset content
   * @param path - Asset path relative to extension root
   * @returns Asset content as string
   */
  async fetch(path: string): Promise<string> {
    const url = this.getURL(path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${path}: ${response.status}`);
    }
    return response.text();
  }
}

// ============================================================================
// Firefox Message Service
// ============================================================================

/**
 * Firefox Message Service
 * Handles Background ↔ Content Script communication
 * Directly sends message to background (message itself contains type)
 */
class FirefoxMessageService {
  /**
   * Send message directly to background script.
   * The message should already contain { id, type, payload, ... } structure.
   */
  async send<T = unknown>(message: unknown): Promise<T> {
    try {
      // Send message directly - Firefox browser.runtime.sendMessage returns Promise
      const response = await browser.runtime.sendMessage(message);
      return response as T;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Message send failed: ${errorMessage}`);
    }
  }

  addListener(callback: (message: unknown) => void): () => void {
    return bridge.addListener(callback);
  }
}

// ============================================================================
// Firefox I18n Service
// ============================================================================

/**
 * Firefox I18n Service
 * Uses browser.i18n API for localization
 * Extends BaseI18nService for common message lookup logic
 */
class FirefoxI18nService extends BaseI18nService {
  constructor() {
    super();
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] init failed:', error);
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async loadLocale(locale: string): Promise<void> {
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

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      const url = browser.runtime.getURL(`_locales/${locale}/messages.json`);
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch (error) {
      console.warn('[I18n] fetchLocaleData failed for', locale, error);
      return null;
    }
  }

  getUILanguage(): string {
    return browser.i18n.getUILanguage();
  }

  /**
   * Get message using browser.i18n API (native Firefox i18n)
   */
  getNativeMessage(key: string, substitutions?: string | string[]): string {
    return browser.i18n.getMessage(key, substitutions) || key;
  }
}

// ============================================================================
// Firefox Platform API
// ============================================================================

/**
 * Firefox Platform API
 * Implements PlatformAPI interface for Firefox WebExtension environment
 * Uses background page rendering (Firefox MV2 has DOM access in background)
 */
class FirefoxPlatformAPI {
  public readonly platform = 'firefox' as const;
  
  // Services
  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly fileState: FileStateService;
  public readonly resource: FirefoxResourceService;
  public readonly message: FirefoxMessageService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: FirefoxI18nService;
  public readonly document: FirefoxDocumentService;
  public readonly settings: SettingsService;
  
  // Internal bridge reference (for advanced usage)
  public readonly _bridge: PlatformBridgeAPI;

  constructor() {
    // Initialize services
    this.storage = storageService;
    this.file = fileService;
    this.fileState = fileStateService;
    this.resource = new FirefoxResourceService();
    this.message = new FirefoxMessageService();
    this.cache = cacheService;
    this.document = firefoxDocumentService; // Unified document service
    
    // Unified renderer service with BackgroundRenderHost
    // Firefox MV2 background page has DOM access (like Chrome's Offscreen API)
    // So we can render diagrams directly in the background page
    this.renderer = new RendererService({
      createHost: () => new BackgroundRenderHost('firefox-renderer'),
      cache: this.cache,
    });
    
    this.i18n = new FirefoxI18nService();
    // Settings service
    this.settings = createSettingsService(this.storage);
    
    // Internal bridge reference
    this._bridge = bridge;
  }

  /**
   * Initialize all platform services
   */
  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }

  /**
   * Download file using browser.downloads API
   */
  async downloadFile(filename: string, data: string, mimeType: string): Promise<void> {
    try {
      // Create blob URL from base64 data
      const byteCharacters = atob(data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mimeType });
      const url = URL.createObjectURL(blob);

      // Use browser.downloads API
      await browser.downloads.download({
        url,
        filename,
        saveAs: true,
      });

      // Clean up blob URL after a delay
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      // Don't log or throw error if user canceled the download
      const errorMsg = String((error as Error)?.message || error);
      if (errorMsg.includes('canceled') || errorMsg.includes('cancelled')) {
        // User canceled, just clean up silently
        return;
      }
      console.error('Download failed:', error);
      throw error;
    }
  }

  /**
   * Check if extension has file access permission
   */
  async hasFileAccess(): Promise<boolean> {
    // Firefox doesn't have a direct equivalent to chrome.extension.isAllowedFileSchemeAccess
    // File access is controlled by the user through about:config
    return true; // Assume true, user will see errors if not allowed
  }
}

// ============================================================================
// Export
// ============================================================================

export const platform = new FirefoxPlatformAPI();

export {
  FirefoxResourceService,
  FirefoxMessageService,
  FirefoxI18nService,
  FirefoxPlatformAPI,
  DEFAULT_SETTING_LOCALE
};
