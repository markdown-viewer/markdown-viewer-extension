/**
 * Firefox Background Script (runs in Background Page with DOM)
 * Handles messages between content script and manages extension state.
 * Unlike Chrome's Service Worker, Firefox Background Page has DOM access,
 * so we can render diagrams directly here (similar to Chrome's Offscreen API).
 */

// Firefox WebExtension API types
declare const browser: typeof chrome & {
  menus: {
    create: (createProperties: {
      id?: string;
      title?: string;
      contexts?: string[];
      documentUrlPatterns?: string[];
    }) => void;
    remove: (menuItemId: string) => Promise<void>;
    update: (id: string, updateProperties: { title?: string }) => Promise<void>;
    onClicked: {
      addListener: (callback: (info: { menuItemId: string; linkUrl?: string; pageUrl?: string }, tab?: { id?: number; url?: string }) => void) => void;
    };
  };
};

import { DirectResourceService } from '../../../src/services';

// ============================================================================
// Platform API for Background Render Worker
// ============================================================================

// Set up minimal platform API for services that need resource.fetch
// (e.g., StencilsService for DrawIO stencils)
globalThis.platform = {
  resource: new DirectResourceService((path) => browser.runtime.getURL(path))
} as unknown as typeof globalThis.platform;

// ============================================================================

import CacheStorage from '../../../src/utils/cache-storage';
import { toSimpleCacheStats } from '../../../src/utils/cache-stats';
import { bootstrapRenderWorker } from '../../../src/renderers/worker/worker-bootstrap';
import { DirectFetchService } from '../../../src/renderers/worker/services';
import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { ManualDispatchTransport } from './manual-dispatch-transport';
import type {
  FileState,
  AllFileStates,
  UploadSession,
  BackgroundMessage,
  SimpleCacheStats
} from '../../../src/types/index';

let globalCacheStorage: CacheStorage | null = null;

// ============================================================================
// CSP Modification for Markdown Files
// ============================================================================

// Track tabs where we've injected content scripts
const injectedTabs = new Set<number>();

// Supported file extensions for CSP modification
const SUPPORTED_EXTENSIONS = ['.md', '.markdown', '.mermaid', '.vega', '.vl', '.vega-lite', '.gv', '.dot', '.infographic'];

function shouldModifyCSP(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    return SUPPORTED_EXTENSIONS.some(ext => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

// Modify CSP headers for markdown files to allow data: URIs and inline styles
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!shouldModifyCSP(details.url)) {
      return {};
    }

    const responseHeaders = details.responseHeaders || [];
    const newHeaders = responseHeaders.filter(header => {
      const name = header.name.toLowerCase();
      // Remove CSP headers that would block our content
      return name !== 'content-security-policy' && 
             name !== 'content-security-policy-report-only' &&
             name !== 'x-content-security-policy';
    });

    // Add a permissive CSP that allows our extension to work
    newHeaders.push({
      name: 'Content-Security-Policy',
      value: "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: moz-extension: https: http:; img-src * data: blob:; style-src 'self' 'unsafe-inline' moz-extension:; font-src 'self' data: moz-extension:; script-src 'self' 'unsafe-inline' 'unsafe-eval' moz-extension:;"
    });

    return { responseHeaders: newHeaders };
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking', 'responseHeaders']
);

// ============================================================================
// Render Worker Setup (Background Page has DOM, like Chrome Offscreen)
// ============================================================================

// Use ManualDispatchTransport instead of BrowserRuntimeTransport to avoid
// conflicts with the main message listener. Messages are manually dispatched
// from the main listener when __target === 'background-render'.
const renderTransport = new ManualDispatchTransport();
const renderChannel = new RenderChannel(renderTransport, {
  source: 'firefox-background',
  timeoutMs: 300000,
  acceptRequest: (msg) => {
    if (!msg || typeof msg !== 'object') return false;
    const target = (msg as { __target?: unknown }).__target;
    return target === 'background-render';
  },
});

// Firefox background page can fetch directly (has full DOM access)
const directFetchService = new DirectFetchService();

// Initialize render worker when DOM is ready
const renderWorker = bootstrapRenderWorker(renderChannel, {
  getCanvas: () => document.getElementById('png-canvas') as HTMLCanvasElement | null,
  getReady: () => true,
  // Inject services for renderers
  services: {
    fetch: directFetchService,
  },
});

// Initialize when background page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    renderWorker.init();
  });
} else {
  renderWorker.init();
}

// Envelope helpers
let requestCounter = 0;
function createRequestId(): string {
  requestCounter += 1;
  return `${Date.now()}-${requestCounter}`;
}

function isRequestEnvelope(message: unknown): message is { id: string; type: string; payload: unknown } {
  if (!message || typeof message !== 'object') return false;
  const obj = message as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.type === 'string' && 'payload' in obj;
}

function sendResponseEnvelope(
  requestId: string,
  sendResponse: (response: unknown) => void,
  result: { ok: true; data?: unknown } | { ok: false; errorMessage: string }
): void {
  if (result.ok) {
    sendResponse({
      type: 'RESPONSE',
      requestId,
      ok: true,
      data: result.data,
    });
    return;
  }
  sendResponse({
    type: 'RESPONSE',
    requestId,
    ok: false,
    error: { message: result.errorMessage },
  });
}

// File states storage key
const FILE_STATES_STORAGE_KEY = 'markdownFileStates';
const FILE_STATE_MAX_AGE_DAYS = 7;

// Upload sessions in memory
const uploadSessions = new Map<string, UploadSession>();
const DEFAULT_UPLOAD_CHUNK_SIZE = 255 * 1024;

// ============================================================================
// File State Operations
// ============================================================================

async function getFileState(url: string): Promise<FileState> {
  try {
    const result = await browser.storage.local.get([FILE_STATES_STORAGE_KEY]);
    let allStates: AllFileStates = (result[FILE_STATES_STORAGE_KEY] || {}) as AllFileStates;
    
    // Clean up old states
    const maxAge = FILE_STATE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let needsCleanup = false;
    
    const cleanedStates: AllFileStates = {};
    for (const [stateUrl, state] of Object.entries(allStates)) {
      const age = now - (state.lastModified || 0);
      if (age < maxAge) {
        cleanedStates[stateUrl] = state;
      } else {
        needsCleanup = true;
      }
    }
    
    if (needsCleanup) {
      await browser.storage.local.set({ [FILE_STATES_STORAGE_KEY]: cleanedStates });
      allStates = cleanedStates;
    }
    
    return allStates[url] || {};
  } catch (error) {
    console.error('[Background] Failed to get file state:', error);
    return {};
  }
}

async function saveFileState(url: string, state: FileState): Promise<boolean> {
  try {
    const result = await browser.storage.local.get([FILE_STATES_STORAGE_KEY]);
    const allStates: AllFileStates = (result[FILE_STATES_STORAGE_KEY] || {}) as AllFileStates;
    
    allStates[url] = {
      ...(allStates[url] || {}),
      ...state,
      lastModified: Date.now()
    };
    
    await browser.storage.local.set({ [FILE_STATES_STORAGE_KEY]: allStates });
    return true;
  } catch (error) {
    console.error('[Background] Failed to save file state:', error);
    return false;
  }
}

async function clearFileState(url: string): Promise<boolean> {
  try {
    const result = await browser.storage.local.get([FILE_STATES_STORAGE_KEY]);
    const allStates: AllFileStates = (result[FILE_STATES_STORAGE_KEY] || {}) as AllFileStates;
    
    delete allStates[url];
    
    await browser.storage.local.set({ [FILE_STATES_STORAGE_KEY]: allStates });
    return true;
  } catch (error) {
    console.error('Failed to clear file state:', error);
    return false;
  }
}

// ============================================================================
// Scroll Operation Handler
// ============================================================================

async function handleScrollOperationAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<{ type: 'RESPONSE'; requestId: string; ok: boolean; data?: unknown; error?: { message: string } }> {
  try {
    const payload = (message.payload || {}) as Record<string, unknown>;
    const operation = payload.operation as string | undefined;
    const url = typeof payload.url === 'string' ? payload.url : '';

    if (!url) {
      return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Missing url' });
    }

    switch (operation) {
      case 'get': {
        const state = await getFileState(url);
        const line = typeof (state as { scrollLine?: unknown }).scrollLine === 'number' 
          ? (state as { scrollLine?: number }).scrollLine || 0 
          : 0;
        return createResponseEnvelope(message.id, { ok: true, data: line });
      }
      case 'clear': {
        const currentState = await getFileState(url);
        if ((currentState as { scrollLine?: unknown }).scrollLine !== undefined) {
          delete (currentState as { scrollLine?: unknown }).scrollLine;
          if (Object.keys(currentState).length === 0) {
            await clearFileState(url);
          } else {
            await saveFileState(url, currentState);
          }
        }
        return createResponseEnvelope(message.id, { ok: true, data: { success: true } });
      }
      default:
        return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Unknown scroll operation' });
    }
  } catch (error) {
    console.error('[Background] SCROLL_OPERATION error:', error);
    return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// Cache Operations Handler
// ============================================================================

async function handleCacheOperationEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    if (!globalCacheStorage) {
      globalCacheStorage = await initGlobalCacheStorage();
    }

    if (!globalCacheStorage) {
      sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Cache system initialization failed' });
      return;
    }

    const payload = (message.payload || {}) as Record<string, unknown>;
    const operation = payload.operation as string | undefined;
    const key = typeof payload.key === 'string' ? payload.key : '';
    const value = payload.value;
    const dataType = typeof payload.dataType === 'string' ? payload.dataType : '';
    const limit = typeof payload.limit === 'number' ? payload.limit : 50;

    switch (operation) {
      case 'get': {
        const item = await globalCacheStorage.get(key);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: item ?? null });
        return;
      }
      case 'set': {
        await globalCacheStorage.set(key, value, dataType);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
        return;
      }
      case 'delete': {
        await globalCacheStorage.delete(key);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
        return;
      }
      case 'clear': {
        await globalCacheStorage.clear();
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
        return;
      }
      case 'getStats': {
        const stats = await globalCacheStorage.getStats(limit);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: stats });
        return;
      }
      default:
        sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Unknown cache operation' });
    }
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// File State Operations Handler
// ============================================================================

async function handleFileStateOperationEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const payload = (message.payload || {}) as Record<string, unknown>;
    const operation = payload.operation as string | undefined;
    const url = typeof payload.url === 'string' ? payload.url : '';
    const state = (payload.state || {}) as FileState;

    if (!url) {
      sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Missing url' });
      return;
    }

    switch (operation) {
      case 'get': {
        const current = await getFileState(url);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: current });
        return;
      }
      case 'set': {
        const success = await saveFileState(url, state);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success } });
        return;
      }
      case 'clear': {
        const success = await clearFileState(url);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success } });
        return;
      }
      default:
        sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Unknown file state operation' });
    }
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// Storage Operations Handler
// ============================================================================

async function handleStorageGetEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const payload = (message.payload || {}) as { keys?: string | string[] };
    const keys = payload.keys || [];
    const result = await browser.storage.local.get(keys);
    sendResponseEnvelope(message.id, sendResponse, { ok: true, data: result || {} });
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

async function handleStorageSetEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const payload = (message.payload || {}) as { items?: Record<string, unknown> };
    const items = payload.items || {};
    await browser.storage.local.set(items);
    sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

async function handleStorageRemoveEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const payload = (message.payload || {}) as { keys?: string | string[] };
    const keys = payload.keys || [];
    await browser.storage.local.remove(keys);
    sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// Upload Operations
// ============================================================================

function createToken(): string {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const buffer = new Uint32Array(4);
  if (globalThis.crypto && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buffer);
  } else {
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = Math.floor(Math.random() * 0xffffffff);
    }
  }
  return Array.from(buffer, (value) => value.toString(16).padStart(8, '0')).join('-');
}

function initUploadSession(purpose: string, options: {
  chunkSize?: number;
  encoding?: 'text' | 'base64';
  metadata?: Record<string, unknown>;
  expectedSize?: number | null;
} = {}): { token: string; chunkSize: number } {
  const {
    chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE,
    encoding = 'text',
    metadata = {},
    expectedSize = null
  } = options;

  const token = createToken();
  uploadSessions.set(token, {
    purpose,
    encoding,
    metadata,
    expectedSize,
    chunkSize,
    chunks: [],
    receivedBytes: 0,
    createdAt: Date.now(),
    completed: false
  });

  return { token, chunkSize };
}

function appendUploadChunk(token: string, chunk: string): void {
  const session = uploadSessions.get(token);
  if (!session || session.completed) {
    throw new Error('Upload session not found');
  }

  if (!Array.isArray(session.chunks)) {
    session.chunks = [];
  }

  session.chunks.push(chunk);

  if (session.encoding === 'base64') {
    session.receivedBytes = (session.receivedBytes || 0) + Math.floor(chunk.length * 3 / 4);
  } else {
    session.receivedBytes = (session.receivedBytes || 0) + chunk.length;
  }

  session.lastChunkTime = Date.now();
}

function finalizeUploadSession(token: string): UploadSession {
  const session = uploadSessions.get(token);
  if (!session || session.completed) {
    throw new Error('Upload session not found');
  }

  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  const combined = chunks.join('');

  session.data = combined;
  session.chunks = [];
  session.completed = true;
  session.completedAt = Date.now();

  return session;
}

function abortUploadSession(token: string | undefined): void {
  if (token && uploadSessions.has(token)) {
    uploadSessions.delete(token);
  }
}

function handleUploadOperationEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): void {
  const payload = (message.payload || {}) as Record<string, unknown>;
  const operation = payload.operation as string | undefined;

  try {
    switch (operation) {
      case 'init': {
        const purposeRaw = typeof payload.purpose === 'string' ? payload.purpose : 'general';
        const purpose = purposeRaw.trim() ? purposeRaw.trim() : 'general';
        const encoding = payload.encoding === 'base64' ? 'base64' : 'text';
        const metadata = payload.metadata && typeof payload.metadata === 'object' ? (payload.metadata as Record<string, unknown>) : {};
        const expectedSize = typeof payload.expectedSize === 'number' ? payload.expectedSize : null;
        const requestedChunkSize = typeof payload.chunkSize === 'number' && payload.chunkSize > 0 ? payload.chunkSize : DEFAULT_UPLOAD_CHUNK_SIZE;

        const { token, chunkSize } = initUploadSession(purpose, {
          chunkSize: requestedChunkSize,
          encoding,
          expectedSize,
          metadata,
        });

        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { token, chunkSize } });
        return;
      }
      case 'chunk': {
        const token = typeof payload.token === 'string' ? payload.token : '';
        const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';

        if (!token || !chunk) {
          sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Invalid upload chunk payload' });
          return;
        }

        appendUploadChunk(token, chunk);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: {} });
        return;
      }
      case 'finalize': {
        const token = typeof payload.token === 'string' ? payload.token : '';
        if (!token) {
          sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Missing upload session token' });
          return;
        }

        const session = finalizeUploadSession(token);
        sendResponseEnvelope(message.id, sendResponse, {
          ok: true,
          data: {
            token,
            purpose: session.purpose,
            bytes: session.receivedBytes,
            encoding: session.encoding,
          },
        });
        return;
      }
      case 'abort': {
        const token = typeof payload.token === 'string' ? payload.token : undefined;
        abortUploadSession(token);
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: {} });
        return;
      }
      default:
        sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Unknown upload operation' });
    }
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// Initialization
// ============================================================================

async function initGlobalCacheStorage(): Promise<CacheStorage | null> {
  try {
    const result = await browser.storage.local.get(['markdownViewerSettings']);
    const settings = (result.markdownViewerSettings || {}) as { maxCacheItems?: number };
    const maxCacheItems = settings.maxCacheItems || 1000;
    
    globalCacheStorage = new CacheStorage(maxCacheItems);
    await globalCacheStorage.initPromise;
    return globalCacheStorage;
  } catch (error) {
    return null;
  }
}

// Initialize cache manager when background script loads
initGlobalCacheStorage();

// ============================================================================
// Content Script Injection (Firefox uses tabs.executeScript in MV2)
// ============================================================================

async function handleContentScriptInjection(tabId: number): Promise<void> {
  try {
    // MV3 uses scripting API instead of tabs.executeScript
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['/core/main.js']
    });
    
    // CSS injection via scripting API
    try {
      await browser.scripting.insertCSS({
        target: { tabId },
        files: ['/ui/styles.css'],
        origin: 'USER'
      });
    } catch (cssError) {
      // CSS injection failed, will rely on JS to inject styles
    }
  } catch (error) {
    console.error('[Firefox Background] Scripting injection failed:', (error as Error).message);
    throw error;
  }
}

// ============================================================================
// Message Handler
// ============================================================================

// Helper to create response envelope
// Must match ResponseEnvelope format expected by ServiceChannel
function createResponseEnvelope(
  requestId: string,
  result: { ok: true; data?: unknown } | { ok: false; errorMessage: string }
): { type: 'RESPONSE'; requestId: string; ok: boolean; data?: unknown; error?: { message: string } } {
  if (result.ok) {
    return {
      type: 'RESPONSE',
      requestId,
      ok: true,
      data: result.data,
    };
  }
  return {
    type: 'RESPONSE',
    requestId,
    ok: false,
    error: { message: result.errorMessage },
  };
}

// Firefox supports returning Promise from message listener
browser.runtime.onMessage.addListener((message: BackgroundMessage, sender): Promise<object> | undefined => {
  if (!isRequestEnvelope(message)) {
    return undefined;
  }

  // Render requests - dispatch to render worker via ManualDispatchTransport
  const target = (message as { __target?: unknown }).__target;
  if (target === 'background-render') {
    return new Promise((resolve) => {
      renderTransport.dispatch(message, (response) => {
        resolve(response as object);
      });
    });
  }

  // Content script injection request
  if (message.type === 'INJECT_CONTENT_SCRIPT') {
    const tabId = sender.tab?.id;
    
    if (!tabId || tabId <= 0) {
      return Promise.resolve(createResponseEnvelope(message.id, { ok: false, errorMessage: 'Invalid tab ID' }));
    }
    
    return handleContentScriptInjection(tabId)
      .then(() => {
        return createResponseEnvelope(message.id, { ok: true, data: { success: true } });
      })
      .catch((error) => {
        return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
      });
  }

  // Cache operations
  if (message.type === 'CACHE_OPERATION') {
    return handleCacheOperationAsync(message);
  }

  // File state operations
  if (message.type === 'FILE_STATE_OPERATION') {
    return handleFileStateOperationAsync(message);
  }

  // Upload operations
  if (message.type === 'UPLOAD_OPERATION') {
    return handleUploadOperationAsync(message);
  }

  // Storage operations
  if (message.type === 'STORAGE_GET') {
    return handleStorageGetAsync(message);
  }

  if (message.type === 'STORAGE_SET') {
    return handleStorageSetAsync(message);
  }

  if (message.type === 'STORAGE_REMOVE') {
    return handleStorageRemoveAsync(message);
  }

  // Download finalize
  if (message.type === 'DOCX_DOWNLOAD_FINALIZE') {
    return handleDocxDownloadFinalizeAsync(message);
  }

  // Scroll operations
  if (message.type === 'SCROLL_OPERATION') {
    return handleScrollOperationAsync(message);
  }

  // Return undefined for unhandled message types
  return undefined;
});

// ============================================================================
// Async Handler Wrappers (for Promise-based Firefox message handling)
// ============================================================================

async function handleCacheOperationAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<object> {
  try {
    if (!globalCacheStorage) {
      globalCacheStorage = await initGlobalCacheStorage();
    }

    if (!globalCacheStorage) {
      return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Cache system initialization failed' });
    }

    const payload = (message.payload || {}) as Record<string, unknown>;
    const operation = payload.operation as string | undefined;
    const key = typeof payload.key === 'string' ? payload.key : '';
    const value = payload.value;
    const dataType = typeof payload.dataType === 'string' ? payload.dataType : '';
    const limit = typeof payload.limit === 'number' ? payload.limit : 50;

    switch (operation) {
      case 'get': {
        const item = await globalCacheStorage.get(key);
        return createResponseEnvelope(message.id, { ok: true, data: item ?? null });
      }
      case 'set': {
        await globalCacheStorage.set(key, value, dataType);
        return createResponseEnvelope(message.id, { ok: true, data: { success: true } });
      }
      case 'delete': {
        await globalCacheStorage.delete(key);
        return createResponseEnvelope(message.id, { ok: true, data: { success: true } });
      }
      case 'clear': {
        await globalCacheStorage.clear();
        return createResponseEnvelope(message.id, { ok: true, data: { success: true } });
      }
      case 'getStats': {
        const stats = await globalCacheStorage.getStats(limit);
        return createResponseEnvelope(message.id, { ok: true, data: stats });
      }
      default:
        return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Unknown cache operation' });
    }
  } catch (error) {
    return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
  }
}

async function handleFileStateOperationAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<object> {
  try {
    const payload = (message.payload || {}) as Record<string, unknown>;
    const operation = payload.operation as string | undefined;
    const url = typeof payload.url === 'string' ? payload.url : '';
    const state = (payload.state || {}) as FileState;

    if (!url) {
      return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Missing url' });
    }

    switch (operation) {
      case 'get': {
        const current = await getFileState(url);
        return createResponseEnvelope(message.id, { ok: true, data: current });
      }
      case 'set': {
        const success = await saveFileState(url, state);
        return createResponseEnvelope(message.id, { ok: true, data: { success } });
      }
      case 'clear': {
        const success = await clearFileState(url);
        return createResponseEnvelope(message.id, { ok: true, data: { success } });
      }
      default:
        return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Unknown file state operation' });
    }
  } catch (error) {
    return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
  }
}

async function handleStorageGetAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<object> {
  try {
    const payload = (message.payload || {}) as { keys?: string | string[] };
    const keys = payload.keys || [];
    const result = await browser.storage.local.get(keys);
    return createResponseEnvelope(message.id, { ok: true, data: result || {} });
  } catch (error) {
    return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
  }
}

async function handleStorageSetAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<object> {
  try {
    const payload = (message.payload || {}) as { items?: Record<string, unknown> };
    const items = payload.items || {};
    await browser.storage.local.set(items);
    return createResponseEnvelope(message.id, { ok: true, data: { success: true } });
  } catch (error) {
    return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
  }
}

async function handleStorageRemoveAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<object> {
  try {
    const payload = (message.payload || {}) as { keys?: string | string[] };
    const keys = payload.keys || [];
    await browser.storage.local.remove(keys);
    return createResponseEnvelope(message.id, { ok: true, data: { success: true } });
  } catch (error) {
    return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
  }
}

function handleUploadOperationAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<object> {
  const payload = (message.payload || {}) as Record<string, unknown>;
  const operation = payload.operation as string | undefined;

  try {
    switch (operation) {
      case 'init': {
        const purposeRaw = typeof payload.purpose === 'string' ? payload.purpose : 'general';
        const purpose = purposeRaw.trim() ? purposeRaw.trim() : 'general';
        const encoding = payload.encoding === 'base64' ? 'base64' : 'text';
        const metadata = payload.metadata && typeof payload.metadata === 'object' ? (payload.metadata as Record<string, unknown>) : {};
        const expectedSize = typeof payload.expectedSize === 'number' ? payload.expectedSize : null;
        const requestedChunkSize = typeof payload.chunkSize === 'number' && payload.chunkSize > 0 ? payload.chunkSize : DEFAULT_UPLOAD_CHUNK_SIZE;

        const { token, chunkSize } = initUploadSession(purpose, {
          chunkSize: requestedChunkSize,
          encoding,
          expectedSize,
          metadata,
        });

        return Promise.resolve(createResponseEnvelope(message.id, { ok: true, data: { token, chunkSize } }));
      }
      case 'chunk': {
        const token = typeof payload.token === 'string' ? payload.token : '';
        const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';

        if (!token || !chunk) {
          return Promise.resolve(createResponseEnvelope(message.id, { ok: false, errorMessage: 'Invalid upload chunk payload' }));
        }

        appendUploadChunk(token, chunk);
        return Promise.resolve(createResponseEnvelope(message.id, { ok: true, data: {} }));
      }
      case 'finalize': {
        const token = typeof payload.token === 'string' ? payload.token : '';
        if (!token) {
          return Promise.resolve(createResponseEnvelope(message.id, { ok: false, errorMessage: 'Missing upload session token' }));
        }

        const session = finalizeUploadSession(token);
        return Promise.resolve(createResponseEnvelope(message.id, {
          ok: true,
          data: {
            token,
            purpose: session.purpose,
            bytes: session.receivedBytes,
            encoding: session.encoding,
          },
        }));
      }
      case 'abort': {
        const token = typeof payload.token === 'string' ? payload.token : undefined;
        abortUploadSession(token);
        return Promise.resolve(createResponseEnvelope(message.id, { ok: true, data: {} }));
      }
      default:
        return Promise.resolve(createResponseEnvelope(message.id, { ok: false, errorMessage: 'Unknown upload operation' }));
    }
  } catch (error) {
    return Promise.resolve(createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message }));
  }
}

async function handleDocxDownloadFinalizeAsync(
  message: { id: string; type: string; payload: unknown }
): Promise<object> {
  const payload = (message.payload || {}) as Record<string, unknown>;
  const token = typeof payload.token === 'string' ? payload.token : '';
  
  if (!token) {
    return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Missing download job token' });
  }

  try {
    let session = uploadSessions.get(token);
    if (!session) {
      return createResponseEnvelope(message.id, { ok: false, errorMessage: 'Download job not found' });
    }

    if (!session.completed) {
      session = finalizeUploadSession(token);
    }

    const { metadata = {}, data = '' } = session;
    // Browser downloads API doesn't allow certain characters in filename (e.g., quotes)
    // even with saveAs:true, so we need to sanitize it
    const rawFilename = (metadata.filename as string) || 'document.docx';
    const filename = rawFilename.replace(/["']/g, '_') || 'document.docx';
    const mimeType = (metadata.mimeType as string) || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    // Convert base64 to Blob URL (Firefox doesn't allow data: URLs for downloads)
    const binaryString = atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    // Start download and return immediately without waiting
    // Firefox's downloads.download with saveAs:true may block until user interaction
    browser.downloads.download({
      url: blobUrl,
      filename,
      saveAs: true,
    }).then(() => {
      URL.revokeObjectURL(blobUrl);
    }).catch((error) => {
      // Don't log error if user canceled the download
      const errorMsg = String(error?.message || error);
      if (!errorMsg.includes('canceled') && !errorMsg.includes('cancelled')) {
        console.error('[Firefox Background] Download failed:', error);
      }
      URL.revokeObjectURL(blobUrl);
    });

    uploadSessions.delete(token);
    // Return success immediately, don't wait for download to complete
    return createResponseEnvelope(message.id, { ok: true, data: { downloadId: -1 } });
  } catch (error) {
    return createResponseEnvelope(message.id, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// Read Local File Handler
// Listen for settings changes to update cache manager
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.markdownViewerSettings) {
    const newSettings = changes.markdownViewerSettings.newValue as { maxCacheItems?: number; preferredLocale?: string } | undefined;
    if (newSettings && newSettings.maxCacheItems && globalCacheStorage) {
      if ('maxItems' in globalCacheStorage) {
        (globalCacheStorage as { maxItems: number }).maxItems = newSettings.maxCacheItems;
      }
    }
    
    // Update context menu when locale changes
    if (newSettings && 'preferredLocale' in newSettings) {
      updateContextMenu();
    }
  }
});

// ============================================================================
// Context Menu for Preview as Markdown
// ============================================================================

// Get localized menu title based on user settings
async function getMenuTitle(): Promise<string> {
  try {
    const result = await browser.storage.local.get(['markdownViewerSettings']);
    const settings = result?.markdownViewerSettings as { preferredLocale?: string } | undefined;
    const preferredLocale = settings?.preferredLocale;
    
    // If user has set a preferred locale (not 'auto'), load from that locale
    if (preferredLocale && preferredLocale !== 'auto') {
      try {
        const localeUrl = browser.runtime.getURL(`_locales/${preferredLocale}/messages.json`);
        const response = await fetch(localeUrl);
        const messages = await response.json();
        const message = messages['contextMenu_viewAsMarkdown']?.message;
        if (message) {
          return message;
        }
      } catch (error) {
        // Fallback to browser locale if custom locale fails
        console.warn(`Failed to load locale ${preferredLocale}, using browser default`);
      }
    }
  } catch (error) {
    console.warn('Failed to get settings:', error);
  }
  
  // Default to browser locale
  return browser.i18n.getMessage('contextMenu_viewAsMarkdown') || 'View as Markdown';
}

// Initialize context menu for viewing any file as markdown
async function initializeContextMenu(): Promise<void> {
  try {
    // Remove old menu item if exists (migration from preview to view)
    try {
      await browser.menus.remove('preview-as-markdown');
    } catch {
      // Ignore if old menu doesn't exist
    }
    
    const title = await getMenuTitle();
    browser.menus.create({
      id: 'view-as-markdown',
      title,
      contexts: ['link', 'page'],
      documentUrlPatterns: ['file:///*', 'http://*/*', 'https://*/*']
    });
  } catch (error) {
    console.error('Failed to create context menu:', error);
  }
}

// Update context menu when settings change
async function updateContextMenu(): Promise<void> {
  try {
    const title = await getMenuTitle();
    await browser.menus.update('view-as-markdown', { title });
  } catch (error) {
    // Menu might not exist yet, ignore
    if (!error?.toString().includes('Could not find any menu items')) {
      console.error('Failed to update context menu:', error);
    }
  }
}

// Handle context menu clicks
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'view-as-markdown' && tab?.id) {
    let targetUrl = '';
    
    // Get the URL to preview
    if (info.linkUrl) {
      targetUrl = info.linkUrl;
    } else if (info.pageUrl) {
      targetUrl = info.pageUrl;
    } else if (tab.url) {
      targetUrl = tab.url;
    }
    
    if (targetUrl) {
      const isCurrentPage = targetUrl === tab.url || targetUrl === info.pageUrl;
      
      if (isCurrentPage) {
        // Current page - inject directly
        handleContentScriptInjection(tab.id).catch((error) => {
          console.error('[Firefox Background] Failed to inject content script:', error);
        });
      } else {
        // Navigate current tab to the target URL
        browser.tabs.update(tab.id, { url: targetUrl }).catch((error) => {
          console.error('[Firefox Background] Failed to navigate to URL:', error);
        });
      }
    }
  }
});

// Initialize context menu when background page loads
initializeContextMenu();
