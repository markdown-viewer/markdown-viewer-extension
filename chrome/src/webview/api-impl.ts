/**
 * Chrome Platform API Implementation
 * 
 * Implements the platform interface for Chrome Extension environment.
 */

import {
  BaseI18nService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE,
  CacheService,
  StorageService,
  FileService,
  RendererService
} from '../../../src/services';

import type { LocaleMessages } from '../../../src/services';

import { OffscreenRenderHost } from './hosts/offscreen-render-host';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { ChromeRuntimeTransport } from '../transports/chrome-runtime-transport';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Message handler function type
 */
type MessageHandler = (
  message: unknown,
  sender: chrome.runtime.MessageSender
) => void | Promise<unknown>;

type ResponseEnvelopeLike = {
  type: 'RESPONSE';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { message?: string };
};

function isResponseEnvelopeLike(message: unknown): message is ResponseEnvelopeLike {
  if (!message || typeof message !== 'object') return false;
  const obj = message as Record<string, unknown>;
  return obj.type === 'RESPONSE' && typeof obj.requestId === 'string' && typeof obj.ok === 'boolean';
}

// ============================================================================
// Service Channel (Content Script ↔ Background)
// ============================================================================

const serviceChannel = new ServiceChannel(new ChromeRuntimeTransport(), {
  source: 'chrome-content',
  timeoutMs: 300000,
});

// Unified services (same as Mobile/VSCode)
const cacheService = new CacheService(serviceChannel);
const storageService = new StorageService(serviceChannel);
const fileService = new FileService(serviceChannel);

// ============================================================================
// Chrome Document Service
// ============================================================================

import { BaseDocumentService } from '../../../src/services/document-service';
import type { ReadFileOptions } from '../../../src/types/platform';

/**
 * Chrome Document Service Implementation
 * 
 * Chrome content script must send file read requests to background script,
 * because content script cannot directly fetch file:// URLs due to same-origin policy.
 * Background script has permission to read local files.
 */
export class ChromeDocumentService extends BaseDocumentService {
  constructor() {
    super();
    // Initialize from current page URL for file:// pages
    this._initFromLocation();
  }

  private _initFromLocation(): void {
    const href = window.location.href;
    if (href.startsWith('file://')) {
      // Extract file path from file:// URL
      const filePath = decodeURIComponent(href.replace('file://', ''));
      this.setDocumentPath(filePath);
    }
  }

  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    // Send to background script for file reading
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: absolutePath.startsWith('file://') ? absolutePath : `file://${absolutePath}`,
      binary: options?.binary ?? false,
    }) as { content: string };
    
    return response.content;
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    // Resolve relative path to absolute file:// URL
    const absoluteUrl = new URL(relativePath, this._baseUrl).href;
    
    // Send to background script for file reading
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: absoluteUrl,
      binary: options?.binary ?? false,
    }) as { content: string };
    
    return response.content;
  }

  async fetchRemote(url: string): Promise<Uint8Array> {
    // Chrome content script can directly fetch network URLs
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  override setDocumentPath(path: string, baseUrl?: string): void {
    super.setDocumentPath(path, baseUrl);
    // Chrome uses file:// URLs directly
    if (!baseUrl) {
      this._baseUrl = `file://${this._documentDir}`;
    }
  }
}

// Create singleton instance
const documentService = new ChromeDocumentService();

// ============================================================================
// Chrome Resource Service
// ============================================================================

export class ChromeResourceService {
  getURL(path: string): string {
    return chrome.runtime.getURL(path);
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
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}

// ============================================================================
// Chrome Message Service
// ============================================================================

export class ChromeMessageService {
  private requestCounter = 0;

  private createRequestId(): string {
    this.requestCounter += 1;
    return `${Date.now()}-${this.requestCounter}`;
  }

  send(message: unknown, timeout: number = 300000): Promise<ResponseEnvelopeLike> {
    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        reject(new Error('Message timeout after 5 minutes'));
      }, timeout);

      chrome.runtime.sendMessage(message, (response: unknown) => {
        clearTimeout(timeoutTimer);

        if (chrome.runtime.lastError) {
          reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
          return;
        }

        if (response === undefined) {
          reject(new Error('No response received from background script'));
          return;
        }

        // Envelope-only: background must respond with ResponseEnvelope.
        if (isResponseEnvelopeLike(response)) {
          resolve(response);
          return;
        }

        reject(new Error('Unexpected response type (expected ResponseEnvelope)'));
      });
    });
  }

  /**
   * Preferred: send a unified RequestEnvelope.
   */
  sendEnvelope(type: string, payload: unknown, timeout: number = 300000, source = 'chrome-platform'): Promise<ResponseEnvelopeLike> {
    return this.send(
      {
        id: this.createRequestId(),
        type,
        payload,
        timestamp: Date.now(),
        source,
      },
      timeout
    );
  }

  addListener(handler: (message: unknown) => void): void {
    chrome.runtime.onMessage.addListener((message) => {
      // Event-only listener: envelope RPC is handled via send/sendEnvelope.
      handler(message);
      return false;
    });
  }
}

// ============================================================================
// Chrome I18n Service
// Extends BaseI18nService for common message lookup logic
// ============================================================================

export class ChromeI18nService extends BaseI18nService {
  private storageService: StorageService;
  private resourceService: ChromeResourceService;

  constructor(storageService: StorageService, resourceService: ChromeResourceService) {
    super();
    this.storageService = storageService;
    this.resourceService = resourceService;
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      const result = await this.storageService.get(['markdownViewerSettings']);
      const settings = (result.markdownViewerSettings || {}) as Record<string, unknown>;
      const preferredLocale = (settings.preferredLocale as string) || DEFAULT_SETTING_LOCALE;
      
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

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] Failed to load locale', locale, error);
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
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

  translate(key: string, substitutions?: string | string[]): string {
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

  getUILanguage(): string {
    if (chrome?.i18n?.getUILanguage) {
      return chrome.i18n.getUILanguage();
    }
    return navigator.language || 'en';
  }
}

// ============================================================================
// Chrome Platform API
// ============================================================================

export class ChromePlatformAPI {
  public readonly platform = 'chrome' as const;
  
  // Services
  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly resource: ChromeResourceService;
  public readonly message: ChromeMessageService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: ChromeI18nService;
  public readonly document: ChromeDocumentService;

  constructor() {
    // Initialize services
    this.storage = storageService; // Use unified storage service
    this.file = fileService;       // Use unified file service (with chunked upload)
    this.resource = new ChromeResourceService();
    this.message = new ChromeMessageService();
    this.cache = cacheService; // Use unified cache service
    this.document = documentService; // Unified document service
    
    // Unified renderer service with OffscreenRenderHost
    // Chrome offscreen document handles serialization internally, so no request queue needed
    this.renderer = new RendererService({
      createHost: () => new OffscreenRenderHost(this.message, 'chrome-renderer'),
      cache: this.cache,
      useRequestQueue: false,
    });
    
    this.i18n = new ChromeI18nService(this.storage, this.resource);
  }

  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }
}

// ============================================================================
// Export
// ============================================================================

export const chromePlatform = new ChromePlatformAPI();

export { DEFAULT_SETTING_LOCALE };
