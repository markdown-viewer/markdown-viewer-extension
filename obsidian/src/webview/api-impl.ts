/**
 * Obsidian Platform API Implementation
 *
 * Implements the PlatformAPI interface for the Obsidian plugin.
 * Runs inside the webview iframe, communicates with the plugin host
 * via postMessage (ServiceChannel over ObsidianWebviewTransport).
 *
 * Modelled closely after the VSCode api-impl.ts for maximum code reuse.
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
import type { ReadFileOptions } from '../../../src/types/platform';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { createDirectTransportPair } from '../transports/direct-transport';
import { BaseDocumentService } from '../../../src/services/document-service';
import { IframeRenderHost } from '../../../src/renderers/host/iframe-render-host';

// ============================================================================
// Service Channel (Plugin Host ↔ Webview, in-memory direct transport)
// ============================================================================

const [hostTransport, webviewTransport] = createDirectTransportPair();
const serviceChannel = new ServiceChannel(webviewTransport, {
  source: 'obsidian-webview',
  timeoutMs: 30000,
});

// Unified services (same as Chrome/VSCode)
const cacheService = new CacheService(serviceChannel);
const storageService = new StorageService(serviceChannel);
const fileService = new FileService(serviceChannel);

// Bridge compatibility layer (same interface as VSCode / Mobile)
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
// Obsidian Document Service
// ============================================================================

class ObsidianDocumentService extends BaseDocumentService {
  // Disable URI rewrite — images will be inlined as data URLs after rendering
  protected override _needsUriRewrite = false;

  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: absolutePath,
      binary: options?.binary,
    });
    return (response as { content: string }).content;
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: relativePath,
      binary: options?.binary,
    });
    return (response as { content: string }).content;
  }

  async fetchRemote(url: string): Promise<Uint8Array> {
    // In Obsidian desktop, we can fetch directly (no strict CSP like VSCode)
    const response = await fetch(url);
    return new Uint8Array(await response.arrayBuffer());
  }

  override resolvePath(relativePath: string): string {
    return relativePath;
  }

  override toResourceUrl(absolutePath: string): string {
    // Return as-is — host will resolve vault paths when needed
    return absolutePath;
  }
}

const obsidianDocumentService = new ObsidianDocumentService();

// ============================================================================
// Obsidian Resource Service
// ============================================================================

class ObsidianResourceService {
  getURL(path: string): string {
    // Resources are fetched via serviceChannel, not by URL
    return path;
  }

  async fetch(path: string): Promise<string> {
    return bridge.sendRequest('FETCH_ASSET', { path });
  }
}

// ============================================================================
// Obsidian I18n Service
// ============================================================================

class ObsidianI18nService extends BaseI18nService {
  private resourceService: ObsidianResourceService;

  constructor(resourceService: ObsidianResourceService) {
    super();
    this.resourceService = resourceService;
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      this.ready = Boolean(this.fallbackMessages);
    } catch (error) {
      console.warn('[Obsidian I18n] init failed:', error);
      this.ready = false;
    }
  }

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[Obsidian I18n] Failed to load locale', locale, error);
      this.messages = null;
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      const content = await this.resourceService.fetch(`_locales/${locale}/messages.json`);
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  getUILanguage(): string {
    return navigator.language || 'en';
  }
}

// ============================================================================
// Obsidian Message Service
// ============================================================================

class ObsidianMessageService {
  async send(message: Record<string, unknown>): Promise<unknown> {
    const { type, payload, id, ...rest } = message;
    const requestId = (id ?? rest.requestId) as string | undefined;

    if (typeof type !== 'string') {
      throw new Error('Message must have a type field');
    }

    try {
      const data = await serviceChannel.send(type, payload ?? rest);
      return { type: 'RESPONSE', requestId: requestId ?? '', ok: true, data };
    } catch (error) {
      return {
        type: 'RESPONSE',
        requestId: requestId ?? '',
        ok: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  addListener(handler: (message: unknown) => void): void {
    serviceChannel.onAny(handler);
  }
}

// ============================================================================
// Obsidian File State Service
// ============================================================================

class ObsidianFileStateService {
  private states: Map<string, FileState> = new Map();

  async get(url: string): Promise<FileState> {
    return this.states.get(url) || {};
  }

  set(url: string, state: FileState): void {
    const existing = this.states.get(url) || {};
    this.states.set(url, { ...existing, ...state });
  }

  async clear(url: string): Promise<void> {
    this.states.delete(url);
  }
}

// ============================================================================
// Obsidian Platform API
// ============================================================================

export class ObsidianPlatformAPI {
  public readonly platform = 'obsidian' as const;

  public readonly storage: StorageService;
  public readonly file: FileService;
  public readonly fileState: ObsidianFileStateService;
  public readonly resource: ObsidianResourceService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: ObsidianI18nService;
  public readonly message: ObsidianMessageService;
  public readonly document: ObsidianDocumentService;
  public readonly settings: SettingsService;

  constructor() {
    this.storage = storageService;
    this.file = fileService;
    this.fileState = new ObsidianFileStateService();
    this.resource = new ObsidianResourceService();
    this.cache = cacheService;
    this.message = new ObsidianMessageService();
    this.document = obsidianDocumentService;
    this.settings = createSettingsService(this.storage);

    // Renderer with IframeRenderHost (lazy-initialized on first render)
    this.renderer = new RendererService({
      createHost: () => new IframeRenderHost({
        fetchHtmlContent: async () => {
          return this.resource.fetch('iframe-render.html');
        },
        source: 'obsidian-parent',
        // Obsidian has relaxed CSP compared to VSCode — direct fetch is usually fine
        // But provide handler for consistency and for DrawIO stencils
        serviceRequestHandler: async (type, payload) => {
          if (type === 'FETCH_RESOURCE') {
            const { path } = payload as { path: string };
            return this.resource.fetch(path);
          }
          throw new Error(`Unknown service request type: ${type}`);
        },
      }),
      cache: this.cache,
    });

    this.i18n = new ObsidianI18nService(this.resource);
  }

  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }

  /**
   * Update document path when file changes
   */
  setDocumentPath(path: string, baseUri?: string): void {
    this.document.setDocumentPath(path, baseUri);
  }
}

// ============================================================================
// Exports
// ============================================================================

export const obsidianPlatform = new ObsidianPlatformAPI();
export { obsidianPlatform as platform };
export { bridge as obsidianBridge };
export { hostTransport as obsidianHostTransport };
export { DEFAULT_SETTING_LOCALE };
