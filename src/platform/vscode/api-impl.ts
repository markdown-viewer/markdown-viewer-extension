/**
 * VSCode Platform API Implementation
 * 
 * Implements the platform interface for VS Code Extension environment.
 * Runs in webview context, communicates with extension host via postMessage.
 */

import {
  BaseI18nService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE
} from '../shared/index';

import type {
  LocaleMessages
} from '../shared/index';

import type { PlatformBridgeAPI } from '../../types/index';

import { ServiceChannel } from '../../messaging/channels/service-channel';
import { VSCodeWebviewTransport } from '../../messaging/transports/vscode-webview-transport';
import { CacheService, StorageService, FileService, RendererService } from '../../services';
import { IframeRenderHost } from '../../renderers/host/iframe-render-host';

// ============================================================================
// Service Channel (Extension Host ↔ Webview)
// ============================================================================

const transport = new VSCodeWebviewTransport();
const serviceChannel = new ServiceChannel(transport, {
  source: 'vscode-webview',
  timeoutMs: 30000,
});

// Unified cache service (same as Chrome/Mobile)
const cacheService = new CacheService(serviceChannel);

// Unified storage service (same as Chrome/Mobile)
const storageService = new StorageService(serviceChannel);

// Unified file service (same as Chrome/Mobile)
const fileService = new FileService(serviceChannel);

// Bridge compatibility layer (matches Mobile pattern)
const bridge: PlatformBridgeAPI = {
  sendRequest: async <T = unknown>(type: string, payload: unknown): Promise<T> => {
    return (await serviceChannel.send(type, payload)) as T;
  },
  postMessage: (type: string, payload: unknown): void => {
    serviceChannel.post(type, payload);
  },
  addListener: (handler: (message: unknown) => void): (() => void) => {
    return serviceChannel.onAny((message) => {
      handler(message);
    });
  },
};

// ============================================================================
// VSCode Resource Service
// ============================================================================

class VSCodeResourceService {
  private baseUri = '';

  setBaseUri(uri: string): void {
    this.baseUri = uri;
  }

  getURL(path: string): string {
    if (this.baseUri) {
      return `${this.baseUri}/${path}`;
    }
    return path;
  }

  async fetch(path: string): Promise<string> {
    // Request asset from extension host
    return bridge.sendRequest('FETCH_ASSET', { path });
  }
}

// ============================================================================
// VSCode I18n Service
// ============================================================================

class VSCodeI18nService extends BaseI18nService {
  private resourceService: VSCodeResourceService;

  constructor(resourceService: VSCodeResourceService) {
    super();
    this.resourceService = resourceService;
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      this.ready = Boolean(this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] init failed:', error);
      this.ready = false;
    }
  }

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[I18n] Failed to load locale', locale, error);
      this.messages = null;
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      const content = await this.resourceService.fetch(`_locales/${locale}/messages.json`);
      return JSON.parse(content);
    } catch (error) {
      console.warn('[I18n] fetchLocaleData failed for', locale, error);
      return null;
    }
  }

  getUILanguage(): string {
    // Get from VS Code's locale setting
    return navigator.language || 'en';
  }
}

// ============================================================================
// VSCode Platform API
// ============================================================================

export class VSCodePlatformAPI {
  public readonly platform = 'vscode' as const;

  // Services
  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly resource: VSCodeResourceService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: VSCodeI18nService;

  constructor() {
    this.storage = storageService; // Use unified storage service
    this.file = fileService;       // Use unified file service
    this.resource = new VSCodeResourceService();
    this.cache = cacheService; // Use unified cache service
    
    // Get nonce from parent window (set by preview-panel.ts)
    const nonce = (window as unknown as { VSCODE_NONCE?: string }).VSCODE_NONCE;
    
    // Unified renderer service with IframeRenderHost (lazy initialization)
    // VSCode needs special handling: fetchHtmlContent to load HTML into srcdoc
    // This avoids CSP script-src restrictions in VSCode webview
    this.renderer = new RendererService({
      createHost: () => new IframeRenderHost({
        fetchHtmlContent: async () => {
          return this.resource.fetch('iframe-render.html');
        },
        nonce,
        source: 'vscode-parent',
      }),
      cache: this.cache,
      useRequestQueue: true,
    });
    
    this.i18n = new VSCodeI18nService(this.resource);
  }

  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }

  /**
   * Set the base URI for resources (called from extension host)
   */
  setResourceBaseUri(uri: string): void {
    this.resource.setBaseUri(uri);
  }
}

// ============================================================================
// Export
// ============================================================================

export const vscodePlatform = new VSCodePlatformAPI();
export { vscodePlatform as platform };
export { bridge as vscodeBridge };
export { transport as vscodeTransport };
export { serviceChannel as vscodeServiceChannel };
export { DEFAULT_SETTING_LOCALE };
