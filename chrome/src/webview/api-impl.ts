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
  FileStateService,
  RendererService,
  SettingsService,
  createSettingsService,
} from '../../../src/services';

import type { LocaleMessages } from '../../../src/services';

import { OffscreenRenderHost } from './hosts/offscreen-render-host';

import { ServiceChannel } from '../../../src/messaging/channels/service-channel';
import { ChromeRuntimeTransport } from '../transports/chrome-runtime-transport';
import { isNetworkUrl, isRootRelativeUrl } from '../../../src/utils/document-url';

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

/**
 * Chrome's file service, which can also ask for the optional "downloads"
 * permission. The background writes the file with chrome.downloads when it
 * holds that permission, and that is the only delivery left for a document
 * Chrome refuses to download from (a sandboxed one, e.g. raw.githubusercontent
 * .com). The plain message is the one the export menu already uses.
 */
class ChromeFileService extends FileService {
  requestDownloadPermission(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'REQUEST_DOWNLOADS_PERMISSION' }, (response) => {
          void chrome.runtime.lastError;
          resolve(Boolean((response as { granted?: boolean } | undefined)?.granted));
        });
      } catch {
        resolve(false);
      }
    });
  }
}

const fileService = new ChromeFileService(serviceChannel);
const fileStateService = new FileStateService(serviceChannel);

// Settings service - will be initialized with refresh callback in ChromePlatformAPI
let settingsService: SettingsService;

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
  private _workspaceFileReader: ((relativePath: string, binary: boolean) => Promise<string>) | null = null;

  /**
   * Set once the fallback below reported a missing document context, so a page
   * that resolves many images logs it once.
   */
  private _missingBaseUrlReported = false;

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
      return;
    }

    if (/^https?:/i.test(href)) {
      // Remote documents need the same context: without it the base URL stays
      // empty, `new URL(relativePath, '')` throws "Invalid base URL", and every
      // relative resource fails — inline SVG disappeared and exported DOCX/HTML
      // lost all images on http(s) pages, while local files kept working.
      //
      // The page URL is the base so the URL API resolves any nesting depth. The
      // document path stays empty on purpose: a derived directory (e.g. `/notes/`)
      // would make `resolvePath()` return a root-relative path that later code
      // mistakes for an absolute file path.
      this.setDocumentPath('', href);
    }
  }

  /**
   * Set a workspace file reader for workspace mode.
   * In workspace mode, file:// paths are not available; files must be read
   * via File System Access API through the parent workspace page.
   */
  setWorkspaceFileReader(reader: (relativePath: string, binary: boolean) => Promise<string>): void {
    this._workspaceFileReader = reader;
  }

  async readFile(absolutePath: string, options?: ReadFileOptions): Promise<string> {
    // A root-relative path belongs to the root of the document's own origin: on
    // a remote document that is the site, not the disk, so it has to be resolved
    // and read like a relative path (`new URL()` copes with the leading slash).
    // Exports pass such paths to readFile() (`/assets/logo.png`), and without
    // this they became `file:///assets/logo.png` and were lost.
    if (isRootRelativeUrl(absolutePath) && isNetworkUrl(this._baseUrl)) {
      return this.readRelativeFile(absolutePath, options);
    }

    const filePath = absolutePath.startsWith('file://') ? absolutePath : `file://${absolutePath}`;
    // Send to background script for file reading
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath,
      binary: options?.binary ?? false,
    }) as { content: string };

    return response.content;
  }

  async readRelativeFile(relativePath: string, options?: ReadFileOptions): Promise<string> {
    // In workspace mode, use workspace file reader (File System Access API via parent)
    if (this._workspaceFileReader) {
      return this._workspaceFileReader(relativePath, options?.binary ?? false);
    }

    // Resolve the relative path against the document's base URL, falling back to
    // the page URL: a content script can be asked to read before any document
    // context was announced, and an empty base makes `new URL()` throw
    // "Invalid base URL" — which silently cost every relative image.
    const base = this._baseUrl || window.location.href;
    if (!this._baseUrl && !this._missingBaseUrlReported) {
      this._missingBaseUrlReported = true;
      console.warn(
        `[DocumentService] no document base URL was set; resolving "${relativePath}" against the page URL ${base}`
      );
    }
    const absoluteUrl = new URL(relativePath, base).href;

    // Same-origin http(s) resources are read right here, in the page's own
    // context: that keeps their credentials, and it works regardless of the
    // extension worker's CSP, host permissions or Private Network Access rules.
    // Cross-origin ones still go through the background, which MV3 makes the
    // only context allowed to fetch them — that path needs the `http: https:`
    // entries in the extension's connect-src (see chrome/manifest.json).
    if (isSameOriginHttpUrl(absoluteUrl)) {
      return readSameOriginHttpUrl(absoluteUrl, options?.binary ?? false);
    }

    // Send to background script for file reading
    const response = await serviceChannel.send('READ_LOCAL_FILE', {
      filePath: absoluteUrl,
      binary: options?.binary ?? false,
    }) as { content: string };

    return response.content;
  }

  override setDocumentPath(path: string, baseUrl?: string): void {
    // A remote document resolves against its own URL: a `file://` base is
    // meaningless there (it produced `file://http://host/` and the same
    // "Invalid base URL" failure). The path itself is deliberately not kept, so
    // resolvePath() leaves relative paths relative instead of prefixing them with
    // a root-relative directory.
    if (/^https?:/i.test(path)) {
      super.setDocumentPath('', baseUrl || path);
      return;
    }

    // Normalize full file:// URLs to bare paths: BaseDocumentService derives
    // _documentDir/_baseUrl from the path, and a full URL would yield a
    // double file:// prefix (file://file:///...), which makes every later
    // `new URL(relative, _baseUrl)` throw "Invalid base URL" — breaking
    // panel navigation on the second click.
    const normalizedPath = path.startsWith('file://') ? path.slice('file://'.length) : path;
    super.setDocumentPath(normalizedPath, baseUrl);
    // Chrome uses file:// URLs directly
    if (!baseUrl) {
      this._baseUrl = `file://${this._documentDir}`;
    }
  }
}

/**
 * Whether a URL is http(s) and same-origin with the page.
 * @param url - Absolute URL
 * @returns True for same-origin http(s) URLs
 */
function isSameOriginHttpUrl(url: string): boolean {
  try {
    const target = new URL(url);
    return /^https?:$/.test(target.protocol) && target.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Read a same-origin http(s) URL from the content script.
 *
 * A page may always read its own origin, so this needs no host permission and
 * cannot be blocked by the extension's `connect-src` — unlike the background
 * worker's fetch, which is subject to both and failed with "Failed to fetch" for
 * every http resource until `connect-src` allowed http.
 *
 * @param url - Absolute same-origin URL
 * @param binary - Return base64-encoded content instead of text
 * @returns Response content
 */
function readSameOriginHttpUrl(url: string, binary: boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';

    request.onload = () => {
      const bytes = request.response ? new Uint8Array(request.response as ArrayBuffer) : null;
      if (!bytes || request.status < 200 || request.status >= 300) {
        reject(new Error(`HTTP ${request.status}: ${request.statusText}`));
        return;
      }


      if (binary) {
        // Chunked conversion: the naive char-by-char loop is quadratic-ish and
        // stalls the content script on multi-megabyte images.
        const chunkSize = 0x8000;
        let binaryString = '';
        for (let i = 0; i < bytes.byteLength; i += chunkSize) {
          binaryString += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        resolve(btoa(binaryString));
        return;
      }
      resolve(new TextDecoder().decode(bytes));
    };
    request.onerror = () => reject(new Error('NetworkError when fetching the resource'));
    request.send();
  });
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
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (!chrome.runtime?.id) return false;
        handler(message);
        return false;
      });
    } catch {
      // Context invalidated after extension reload
    }
  }
}

// ============================================================================
// Chrome I18n Service
// Extends BaseI18nService for common message lookup logic
// ============================================================================

export class ChromeI18nService extends BaseI18nService {
  private settingsService: SettingsService;
  private resourceService: ChromeResourceService;

  constructor(settingsService: SettingsService, resourceService: ChromeResourceService) {
    super();
    this.settingsService = settingsService;
    this.resourceService = resourceService;
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      try {
        const preferredLocale = await this.settingsService.get('preferredLocale');
        const locale = preferredLocale || DEFAULT_SETTING_LOCALE;
        if (locale !== DEFAULT_SETTING_LOCALE) {
          await this.loadLocale(locale);
        }
        this.locale = locale;
      } catch (e) {
        this.locale = DEFAULT_SETTING_LOCALE;
      }
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
  public readonly fileState: FileStateService;
  public readonly resource: ChromeResourceService;
  public readonly message: ChromeMessageService;
  public readonly cache: CacheService;
  public readonly renderer: RendererService;
  public readonly i18n: ChromeI18nService;
  public readonly document: ChromeDocumentService;
  public readonly settings: SettingsService;

  constructor() {
    // Initialize services
    this.storage = storageService; // Use unified storage service
    this.file = fileService;       // Use unified file service (with chunked upload)
    this.fileState = fileStateService; // Use unified file state service
    this.resource = new ChromeResourceService();
    this.message = new ChromeMessageService();
    this.cache = cacheService; // Use unified cache service
    this.document = documentService; // Unified document service
    
    // Settings service - refresh callback will be set by viewer-main after render function is ready
    this.settings = createSettingsService(this.storage);
    settingsService = this.settings;
    
    // Unified renderer service with OffscreenRenderHost
    // Chrome offscreen document handles serialization internally, so no request queue needed
    this.renderer = new RendererService({
      createHost: () => new OffscreenRenderHost(this.message, 'chrome-renderer'),
      cache: this.cache,
    });
    
    this.i18n = new ChromeI18nService(this.settings, this.resource);
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
