/**
 * VSCode Platform API Implementation
 * 
 * Implements the platform interface for VS Code Extension environment.
 * Runs in webview context, communicates with extension host via postMessage.
 */

import {
  BaseI18nService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE,
  CacheService,
  StorageService,
  FileService,
  RendererService,
  SettingsService,
  createSettingsService,
} from '../../../src/services';

import type { FileState } from '../../../src/types/core';

import type { LocaleMessages } from '../../../src/services';

import type { PlatformBridgeAPI } from '../../../src/types/index';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { VSCodeWebviewTransport } from '../transports/vscode-webview-transport';
import { IframeRenderHost } from '../../../src/renderers/host/iframe-render-host';

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
// VSCode Document Service
// ============================================================================

import { BaseDocumentService } from '../../../src/services/document-service';
import type { ReadFileOptions } from '../../../src/types/platform';

/**
 * VS Code Document Service Implementation
 * 
 * Key differences from Chrome/Firefox:
 * - window.location.href is vscode-webview:// URL, NOT the file path
 * - Document path is provided by extension host
 * - Must use READ_LOCAL_FILE message for all file reads (host resolves paths)
 * - Must use FETCH_REMOTE_IMAGE for remote resources (CSP blocks direct fetch)
 * - Image URIs need rewriting to vscode-webview-resource:// URLs
 */
class VSCodeDocumentService extends BaseDocumentService {
  protected override _needsUriRewrite = true;
  private _webviewBaseUri = '';

  constructor() {
    super();
  }

  /**
   * Set document path and webview base URI.
   * Called by main.ts when receiving UPDATE_CONTENT from host.
   */
  override setDocumentPath(path: string, webviewBaseUri?: string): void {
    super.setDocumentPath(path);
    if (webviewBaseUri) {
      this._webviewBaseUri = webviewBaseUri;
      this._baseUrl = webviewBaseUri;
    }
  }

  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    // VS Code: Send path to host, host reads the file
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: absolutePath,
      binary: options?.binary
    });
    
    const result = response as { content: string; contentType?: string };
    return result.content;
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    // VS Code: Send relative path directly, host resolves from document directory
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: relativePath,
      binary: options?.binary
    });
    
    const result = response as { content: string; contentType?: string };
    return result.content;
  }

  async fetchRemote(url: string): Promise<Uint8Array> {
    // VS Code: Must proxy through host due to CSP restrictions
    const response = await serviceChannel.send('FETCH_REMOTE_IMAGE', { url });
    const { content } = response as { content: string; contentType: string };
    
    // Decode base64 to Uint8Array
    const binaryString = atob(content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  override resolvePath(relativePath: string): string {
    // For VS Code, return relative path as-is - host will resolve
    // This differs from Chrome/Firefox where we can resolve locally
    return relativePath;
  }

  override toResourceUrl(absolutePath: string): string {
    // Convert to VS Code webview resource URL
    if (this._webviewBaseUri) {
      return `${this._webviewBaseUri}${encodeURIComponent(absolutePath)}`;
    }
    // Fallback: return as-is (shouldn't happen if properly initialized)
    return absolutePath;
  }
}

// Create singleton instance
const vsCodeDocumentService = new VSCodeDocumentService();

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
// VSCode Message Service
// ============================================================================

class VSCodeMessageService {
  async send(message: Record<string, unknown>): Promise<unknown> {
    // Extract type and requestId from message
    const { type, payload, id, ...rest } = message;
    const requestId = (id ?? rest.requestId) as string | undefined;
    
    if (typeof type !== 'string') {
      throw new Error('Message must have a type field');
    }
    
    try {
      const data = await serviceChannel.send(type, payload ?? rest);
      // Wrap response in ResponseEnvelope format for consistency with Chrome extension
      return {
        type: 'RESPONSE',
        requestId: requestId ?? '',
        ok: true,
        data
      };
    } catch (error) {
      return {
        type: 'RESPONSE',
        requestId: requestId ?? '',
        ok: false,
        error: {
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  addListener(handler: (message: unknown) => void): void {
    serviceChannel.onAny(handler);
  }
}

// ============================================================================
// VSCode File State Service
// ============================================================================

/**
 * VSCode File State Service
 * 
 * Unlike Chrome/Mobile which persist state to storage, VSCode communicates
 * scroll position with the extension host:
 * - set() sends REVEAL_LINE message to host (Preview → Editor sync)
 * - Host sends SCROLL_TO_LINE message which updates the state (Editor → Preview sync)
 */
class VSCodeFileStateService {
  private states: Map<string, FileState> = new Map();
  private bridge: PlatformBridgeAPI | null = null;

  /**
   * Set the bridge for host communication
   * Must be called before using set() with scrollLine
   */
  setBridge(bridge: PlatformBridgeAPI): void {
    this.bridge = bridge;
  }

  /**
   * Update state from host message (SCROLL_TO_LINE)
   */
  setScrollLineFromHost(url: string, scrollLine: number): void {
    const existing = this.states.get(url) || {};
    this.states.set(url, { ...existing, scrollLine });
  }

  async get(url: string): Promise<FileState> {
    return this.states.get(url) || {};
  }

  set(url: string, state: FileState): void {
    const existing = this.states.get(url) || {};
    this.states.set(url, { ...existing, ...state });
    
    // Send scroll position to host for reverse sync (Preview → Editor)
    if (state.scrollLine !== undefined && this.bridge) {
      this.bridge.postMessage('REVEAL_LINE', { line: state.scrollLine });
    }
  }

  async clear(url: string): Promise<void> {
    this.states.delete(url);
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
  public readonly fileState: VSCodeFileStateService;
  public readonly resource: VSCodeResourceService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: VSCodeI18nService;
  public readonly message: VSCodeMessageService;
  public readonly document: VSCodeDocumentService;
  public readonly settings: SettingsService;

  constructor() {
    this.storage = storageService; // Use unified storage service
    this.file = fileService;       // Use unified file service
    this.fileState = new VSCodeFileStateService(); // In-memory file state
    this.resource = new VSCodeResourceService();
    this.cache = cacheService; // Use unified cache service
    this.message = new VSCodeMessageService(); // Message service for plugins
    this.document = vsCodeDocumentService; // Unified document service
    
    // Settings service - refresh callback will be set by main.ts after render function is ready
    this.settings = createSettingsService(this.storage);
    
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
        // Service request handler for proxying render worker requests
        // VSCode srcdoc iframe cannot fetch external resources directly due to CSP
        serviceRequestHandler: async (type, payload) => {
          if (type === 'FETCH_REMOTE_URL') {
            const { url } = payload as { url: string };
            try {
              // Proxy through extension host which can fetch external resources
              const response = await serviceChannel.send('FETCH_REMOTE_IMAGE', { url });
              const { content, contentType } = response as { content: string; contentType: string };
              
              // Convert base64 to data URL
              const dataUrl = `data:${contentType};base64,${content}`;
              return { dataUrl };
            } catch (error) {
              return { dataUrl: null };
            }
          }
          
          // Handle resource fetch requests (e.g., DrawIO stencils)
          if (type === 'FETCH_RESOURCE') {
            const { path } = payload as { path: string };
            return this.resource.fetch(path);
          }
          
          throw new Error(`Unknown service request type: ${type}`);
        },
      }),
      cache: this.cache,
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

  /**
   * Set document path and base URI (called when document changes)
   */
  setDocumentPath(path: string, baseUri?: string): void {
    this.document.setDocumentPath(path, baseUri);
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
