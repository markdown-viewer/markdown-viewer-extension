/**
 * Mobile Platform API Implementation
 * 
 * Runs in WebView context, communicates with the host app (Flutter) via JavaScript channel.
 */

import {
  BaseI18nService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE,
  SettingsService,
  createSettingsService,
} from '../../../src/services';

import type { LocaleMessages } from '../../../src/services';

import type { PlatformBridgeAPI } from '../../../src/types/index';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { FlutterJsChannelTransport } from '../transports/flutter-jschannel-transport';
import { WindowPostMessageTransport } from '../../../src/messaging/transports/window-postmessage-transport';

import { IframeRenderHost } from '../../../src/renderers/host/iframe-render-host';

import { CacheService, StorageService, FileService, FileStateService, RendererService } from '../../../src/services';

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

/**
 * Window extensions for mobile platform
 */
declare global {
  interface Window {
    MarkdownViewer?: {
      postMessage: (message: string) => void;
    };
    __receiveMessageFromHost?: (payload: unknown) => void;
    __mobilePlatformCache?: CacheService;
  }
}

// ============================================================================
// Service Channel (Host ↔ WebView)
// ============================================================================

const hostServiceChannel = new ServiceChannel(new FlutterJsChannelTransport(), {
  source: 'mobile-webview',
  timeoutMs: 30000,
});

// Unified cache service (same as Chrome/VSCode)
const cacheService = new CacheService(hostServiceChannel);

// Unified storage service (same as Chrome/VSCode)
const storageService = new StorageService(hostServiceChannel);

// Unified file service (same as Chrome/VSCode, but without forced chunked upload)
const fileService = new FileService(hostServiceChannel);

// Unified file state service (same as Chrome/VSCode)
const fileStateService = new FileStateService(hostServiceChannel);

// Bridge compatibility layer (used by mobile/main.ts and some plugins).
// NOTE: sendRequest/postMessage now use unified envelopes under the hood.
export const bridge: PlatformBridgeAPI = {
  sendRequest: async <T = unknown>(type: string, payload: unknown): Promise<T> => {
    return (await hostServiceChannel.send(type, payload)) as T;
  },
  postMessage: (type: string, payload: unknown): void => {
    hostServiceChannel.post(type, payload);
  },
  addListener: (handler: (message: unknown) => void): (() => void) => {
    return hostServiceChannel.onAny((message) => {
      handler(message);
    });
  },
};

// ============================================================================
// Mobile Document Service
// ============================================================================

import { BaseDocumentService } from '../../../src/services/document-service';
import type { ReadFileOptions } from '../../../src/types/platform';

/**
 * Mobile Document Service Implementation
 * 
 * Key differences from Chrome/Firefox:
 * - Document path is provided by Flutter host
 * - Uses READ_RELATIVE_FILE message for file reads (Flutter resolves paths)
 * - Direct fetch for remote resources (no CSP restrictions)
 * - Enables URI rewrite for network documents (relative images need absolute URLs)
 */
class MobileDocumentService extends BaseDocumentService {
  constructor() {
    super();
  }

  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    // For absolute paths, use READ_RELATIVE_FILE with full path
    // Flutter's handler supports absolute paths starting with /
    const result = await hostServiceChannel.send('READ_RELATIVE_FILE', {
      path: absolutePath,
      binary: options?.binary
    });
    
    return (result as { content: string }).content;
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    // Send relative path to Flutter, it will resolve from document directory
    const result = await hostServiceChannel.send('READ_RELATIVE_FILE', {
      path: relativePath,
      binary: options?.binary
    });
    
    return (result as { content: string }).content;
  }

  async fetchRemote(url: string): Promise<Uint8Array> {
    // Mobile has no CSP restrictions, direct fetch
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  override resolvePath(relativePath: string): string {
    // For Mobile, return relative path as-is - Flutter will resolve
    // This is similar to VS Code behavior
    return relativePath;
  }

  override toResourceUrl(absolutePath: string): string {
    // Mobile uses file:// URLs
    if (absolutePath.startsWith('file://')) {
      return absolutePath;
    }
    return `file://${absolutePath}`;
  }

  override setDocumentPath(path: string, baseUrl?: string): void {
    super.setDocumentPath(path, baseUrl);
    
    // Always enable URI rewrite - relative paths need to be resolved
    this._needsUriRewrite = true;
    if (baseUrl) {
      this._baseUrl = baseUrl;
    }
  }
}

// Create singleton instance
const mobileDocumentService = new MobileDocumentService();

// ============================================================================
// Mobile Resource Service
// ============================================================================

/**
 * Mobile Resource Service
 * Resources are bundled with the app
 */
class MobileResourceService {
  getURL(path: string): string {
    // In mobile WebView loaded via loadFlutterAsset, we need absolute asset URLs
    // Using relative paths from the loaded HTML should work
    return `./${path}`;
  }

  /**
   * Fetch asset content via Flutter bridge
   * WebView's native fetch doesn't work reliably with Flutter assets
   * @param path - Asset path relative to webview folder
   * @returns Asset content as string
   */
  async fetch(path: string): Promise<string> {
    return bridge.sendRequest('FETCH_ASSET', { path });
  }
}

// ============================================================================
// Mobile Message Service
// ============================================================================

/**
 * Mobile Message Service
 * Handles Host ↔ WebView communication
 */
class MobileMessageService {
  send<T = unknown>(message: unknown): Promise<T> {
    return bridge.sendRequest('MESSAGE', message);
  }

  addListener(callback: (message: unknown) => void): () => void {
    return bridge.addListener(callback);
  }
}

// ============================================================================
// Mobile I18n Service
// ============================================================================

/**
 * Mobile I18n Service
 * Loads locale data from bundled JSON files
 * Extends BaseI18nService for common message lookup logic
 */
class MobileI18nService extends BaseI18nService {
  constructor() {
    super();
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      // For mobile, we use system locale by default
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

  getUILanguage(): string {
    return navigator.language || 'en';
  }
}

// ============================================================================
// Mobile Platform API
// ============================================================================

/**
 * Mobile Platform API
 * Implements PlatformAPI interface for mobile WebView environment
 */
class MobilePlatformAPI {
  public readonly platform = 'mobile' as const;
  
  // Services
  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly fileState: FileStateService;
  public readonly resource: MobileResourceService;
  public readonly message: MobileMessageService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: MobileI18nService;
  public readonly document: MobileDocumentService;
  public readonly settings: SettingsService;
  
  // Internal bridge reference (for advanced usage)
  public readonly _bridge: PlatformBridgeAPI;

  constructor() {
    // Initialize services
    this.storage = storageService; // Use unified storage service
    this.file = fileService;       // Use unified file service
    this.fileState = fileStateService; // Use unified file state service
    this.resource = new MobileResourceService();
    this.message = new MobileMessageService();
    this.cache = cacheService; // Use unified cache service
    this.document = mobileDocumentService; // Unified document service
    
    // Settings service - refresh callback will be set by main.ts after render function is ready
    this.settings = createSettingsService(this.storage);
    
    // Unified renderer service with IframeRenderHost
    const resourceService = this.resource;
    this.renderer = new RendererService({
      createHost: () => new IframeRenderHost({
        iframeUrl: './iframe-render.html',
        source: 'mobile-parent',
        // Service request handler for proxying render worker requests
        serviceRequestHandler: async (type, payload) => {
          // Handle resource fetch requests (e.g., DrawIO stencils)
          if (type === 'FETCH_RESOURCE') {
            const { path } = payload as { path: string };
            return resourceService.fetch(path);
          }
          
          throw new Error(`Unknown service request type: ${type}`);
        },
      }),
      cache: this.cache,
    });
    
    this.i18n = new MobileI18nService();
    
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
   * Notify host app that WebView is ready
   */
  notifyReady(): void {
    bridge.postMessage('WEBVIEW_READY', {});
  }
}

// ============================================================================
// Export
// ============================================================================

export const platform = new MobilePlatformAPI();

export {
  MobileResourceService,
  MobileMessageService,
  MobileI18nService,
  MobilePlatformAPI,
  DEFAULT_SETTING_LOCALE
};
