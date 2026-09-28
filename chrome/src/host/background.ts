/**
 * Background script for handling messages between content script and offscreen document
 */

/// <reference types="chrome"/>

import CacheStorage from '../../../src/utils/cache-storage';
import { toSimpleCacheStats } from '../../../src/utils/cache-stats';
import { RenderTarget } from '../../../src/messaging/routing';
import {
  getFileChangeTracker,
  getFileCheckAlarmName,
  DEFAULT_AUTO_REFRESH_SETTINGS,
  type AutoRefreshSettings,
} from './file-change-tracker';
import type {
  FileState,
  AllFileStates,
  UploadSession,
  BackgroundMessage,
  SimpleCacheStats
} from '../../../src/types/index';


// SimpleCacheStats is used for fallback error responses

let offscreenCreated = false;
let offscreenReady = false;
let offscreenReadyPromise: Promise<void> | null = null;
let offscreenReadyResolve: (() => void) | null = null;
let globalCacheStorage: CacheStorage | null = null;

/**
 * Offscreen state is shared by every concurrent render request, so it is reset in
 * exactly one place. A ready promise that never settles is not a harmless leak:
 * `ensureOffscreenDocument()` awaits it for every later request, so a single
 * missed handshake used to hang renders until the caller gave up (observed as the
 * intermittent `diagram-center` fixture stall in CI, where the next diagram then
 * rendered in under 2s).
 */
function resetOffscreenState(): void {
  offscreenCreated = false;
  offscreenReady = false;
  offscreenReadyPromise = null;
  offscreenReadyResolve = null;
}

/** Mark the offscreen document usable and release everything waiting on it. */
function markOffscreenReady(): void {
  offscreenCreated = true;
  offscreenReady = true;
  releaseOffscreenWaiters();
}

/** Release waiters without marking the document ready (creation failed). */
function releaseOffscreenWaiters(): void {
  const resolve = offscreenReadyResolve;
  offscreenReadyResolve = null;
  offscreenReadyPromise = null;
  if (resolve) resolve();
}

// Envelope helpers (kept local to avoid a hard dependency from background on src/messaging runtime).
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

function isResponseEnvelope(message: unknown): message is { type: 'RESPONSE'; requestId: string; ok: boolean; data?: unknown; error?: { message: string } } {
  if (!message || typeof message !== 'object') return false;
  const obj = message as Record<string, unknown>;
  return obj.type === 'RESPONSE' && typeof obj.requestId === 'string' && typeof obj.ok === 'boolean';
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

async function handleScrollOperationEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const payload = (message.payload || {}) as Record<string, unknown>;
    const operation = payload.operation as string | undefined;
    const url = typeof payload.url === 'string' ? payload.url : '';

    if (!url) {
      sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Missing url' });
      return;
    }

    switch (operation) {
      case 'get': {
        const state = await getFileState(url);
        const line = typeof (state as { scrollLine?: unknown }).scrollLine === 'number' ? (state as { scrollLine?: number }).scrollLine || 0 : 0;
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: line });
        return;
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
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
        return;
      }
      default:
        sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Unknown scroll operation' });
    }
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// Storage Operations (unified across all platforms)
// ============================================================================

async function handleStorageGetEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const payload = (message.payload || {}) as { keys?: string | string[] };
    const keys = payload.keys || [];

    const result = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get(keys, (data) => {
        resolve(data || {});
      });
    });

    sendResponseEnvelope(message.id, sendResponse, { ok: true, data: result });
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

    await new Promise<void>((resolve) => {
      chrome.storage.local.set(items, () => {
        resolve();
      });
    });

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

    await new Promise<void>((resolve) => {
      chrome.storage.local.remove(keys, () => {
        resolve();
      });
    });

    sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
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

function handleDocxDownloadFinalizeEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): boolean {
  const payload = (message.payload || {}) as Record<string, unknown>;
  const token = typeof payload.token === 'string' ? payload.token : '';
  if (!token) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Missing download job token' });
    return false;
  }

  try {
    let session = uploadSessions.get(token);
    if (!session) {
      sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Download job not found' });
      return false;
    }

    if (!session.completed) {
      session = finalizeUploadSession(token);
    }

    const { metadata = {}, data = '' } = session;
    // Chrome downloads API doesn't allow certain characters in filename (e.g., quotes)
    // even with saveAs:true, so we need to sanitize it
    const rawFilename = (metadata.filename as string) || 'document.docx';
    const filename = rawFilename.replace(/["']/g, '_') || 'document.docx';
    const mimeType = (metadata.mimeType as string) || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const dataUrl = `data:${mimeType};base64,${data}`;

    // Check if downloads permission is available (it's optional)
    chrome.permissions.contains({ permissions: ['downloads'] }, (hasPermission) => {
      if (!hasPermission) {
        // No downloads permission - send data back to content script for fallback download
        uploadSessions.delete(token);
        sendResponseEnvelope(message.id, sendResponse, {
          ok: true,
          data: { fallback: true, dataUrl, filename, mimeType },
        });
        return;
      }

      chrome.downloads.download(
        {
          url: dataUrl,
          filename,
          saveAs: true,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            sendResponseEnvelope(message.id, sendResponse, {
              ok: false,
              errorMessage: chrome.runtime.lastError.message ?? 'Download failed',
            });
            return;
          }
          sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { downloadId } });
        }
      );

      uploadSessions.delete(token);
    });

    return true;
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
    return false;
  }
}

async function handleReadLocalFileEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  const payload = (message.payload || {}) as Record<string, unknown>;
  const filePath = typeof payload.filePath === 'string' ? payload.filePath : '';
  const binary = payload.binary === true;

  if (!filePath) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: 'Missing filePath' });
    return;
  }

  try {
    const result = await readLocalFile(filePath, binary);
    sendResponseEnvelope(message.id, sendResponse, { ok: true, data: result });
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
  }
}

// ============================================================================
// File Change Tracking
// ============================================================================

/**
 * Helper function to read file content (used by tracker)
 */
async function readFileContent(url: string): Promise<string> {
  const { content } = await readLocalFile(url, false);
  return content;
}

/**
 * Handle START_FILE_TRACKING request
 */
async function handleStartFileTrackingEnvelope(
  message: { id: string; type: string; payload: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): Promise<void> {
  const payload = (message.payload || {}) as Record<string, unknown>;
  const url = typeof payload.url === 'string' ? payload.url : '';
  const tabId = sender.tab?.id;

  if (!url || !tabId) {
    sendResponseEnvelope(message.id, sendResponse, {
      ok: false,
      errorMessage: 'Missing url or invalid sender tab',
    });
    return;
  }

  if (!url.startsWith('file://')) {
    sendResponseEnvelope(message.id, sendResponse, {
      ok: false,
      errorMessage: 'Only file:// URLs can be tracked',
    });
    return;
  }

  try {
    const tracker = getFileChangeTracker();
    await tracker.startTracking(url, tabId, readFileContent);
    sendResponseEnvelope(message.id, sendResponse, { ok: true });
  } catch (error) {
    sendResponseEnvelope(message.id, sendResponse, {
      ok: false,
      errorMessage: (error as Error).message,
    });
  }
}

/**
 * Handle STOP_FILE_TRACKING request
 */
async function handleStopFileTrackingEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  const payload = (message.payload || {}) as Record<string, unknown>;
  const url = typeof payload.url === 'string' ? payload.url : '';

  if (url) {
    const tracker = getFileChangeTracker();
    await tracker.stopTracking(url);
  }

  sendResponseEnvelope(message.id, sendResponse, { ok: true });
}

/**
 * Handle UPDATE_AUTO_REFRESH_SETTINGS request
 */
async function handleUpdateAutoRefreshSettingsEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  const payload = (message.payload || {}) as Partial<AutoRefreshSettings>;
  const tracker = getFileChangeTracker();
  
  const currentSettings = tracker.getSettings();
  const newSettings: AutoRefreshSettings = {
    enabled: typeof payload.enabled === 'boolean' ? payload.enabled : currentSettings.enabled,
    intervalMs: typeof payload.intervalMs === 'number' ? payload.intervalMs : currentSettings.intervalMs,
  };

  await tracker.updateSettings(newSettings);
  sendResponseEnvelope(message.id, sendResponse, { ok: true, data: newSettings });
}

/**
 * Handle GET_AUTO_REFRESH_SETTINGS request
 */
function handleGetAutoRefreshSettingsEnvelope(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): void {
  const tracker = getFileChangeTracker();
  const settings = tracker.getSettings();
  sendResponseEnvelope(message.id, sendResponse, { ok: true, data: settings });
}

// Clean up tracking when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const tracker = getFileChangeTracker();
  void tracker.stopTrackingByTab(tabId);
});

// Handle alarm events for file change checking
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === getFileCheckAlarmName()) {
    const tracker = getFileChangeTracker();
    void tracker.handleAlarm();
  }
});

// Initialize file change tracker on startup (restores persisted state)
void (async () => {
  const tracker = getFileChangeTracker();
  await tracker.initialize();
})();

// Upload sessions in memory
const uploadSessions = new Map<string, UploadSession>();
const DEFAULT_UPLOAD_CHUNK_SIZE = 255 * 1024;

// File states storage key
const FILE_STATES_STORAGE_KEY = 'markdownFileStates';
const FILE_STATE_MAX_AGE_DAYS = 7; // Keep file states for 7 days

// Helper functions for persistent file state management
async function getFileState(url: string): Promise<FileState> {
  try {
    const result = await chrome.storage.local.get([FILE_STATES_STORAGE_KEY]);
    let allStates: AllFileStates = (result[FILE_STATES_STORAGE_KEY] || {}) as AllFileStates;
    
    // Clean up old states while we're here
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
    
    // Update storage if we cleaned anything
    if (needsCleanup) {
      await chrome.storage.local.set({ [FILE_STATES_STORAGE_KEY]: cleanedStates });
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
    const result = await chrome.storage.local.get([FILE_STATES_STORAGE_KEY]);
    const allStates: AllFileStates = (result[FILE_STATES_STORAGE_KEY] || {}) as AllFileStates;
    
    // Merge with existing state
    allStates[url] = {
      ...(allStates[url] || {}),
      ...state,
      lastModified: Date.now()
    };
    
    await chrome.storage.local.set({ [FILE_STATES_STORAGE_KEY]: allStates });
    return true;
  } catch (error) {
    console.error('[Background] Failed to save file state:', error);
    return false;
  }
}

async function clearFileState(url: string): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([FILE_STATES_STORAGE_KEY]);
    const allStates: AllFileStates = (result[FILE_STATES_STORAGE_KEY] || {}) as AllFileStates;
    
    delete allStates[url];
    
    await chrome.storage.local.set({ [FILE_STATES_STORAGE_KEY]: allStates });
    return true;
  } catch (error) {
    console.error('Failed to clear file state:', error);
    return false;
  }
}

// Initialize the global cache manager with user settings
async function initGlobalCacheStorage(): Promise<CacheStorage | null> {
  try {
    // Load user settings to get maxCacheItems
    const result = await chrome.storage.local.get(['markdownViewerSettings']);
    const settings = (result.markdownViewerSettings || {}) as { maxCacheItems?: number };
    const maxCacheItems = settings.maxCacheItems || 1000;
    
    globalCacheStorage = new CacheStorage(maxCacheItems);
    // Wait for DB initialization (constructor already calls initDB internally)
    await globalCacheStorage.initPromise;
    return globalCacheStorage;
  } catch (error) {
    return null;
  }
}

// Initialize cache manager when background script loads
initGlobalCacheStorage();

// Monitor offscreen document lifecycle
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'offscreen') {
    port.onDisconnect.addListener(() => {
      // Reset state when offscreen document disconnects
      resetOffscreenState();
    });
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  if (isRequestEnvelope(message) && message.type === 'OFFSCREEN_READY') {
    markOffscreenReady();
    return;
  }

  if (isRequestEnvelope(message) && message.type === 'OFFSCREEN_DOM_READY') {
    return;
  }

  if (isRequestEnvelope(message) && message.type === 'OFFSCREEN_ERROR') {
    const payload = (message as { payload?: unknown }).payload;
    const errorMessage =
      payload && typeof payload === 'object'
        ? (payload as { error?: unknown }).error
        : undefined;
    console.error('Offscreen error:', typeof errorMessage === 'string' ? errorMessage : 'Unknown error');
    return;
  }

  // Inject element runtime for HTML pages with <markdown-viewer> element
  if (isRequestEnvelope(message) && message.type === 'INJECT_ELEMENT_RUNTIME') {
    handleElementRuntimeInjection(sender.tab?.id || 0)
      .then(() => {
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
      })
      .catch((error) => {
        sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
      });
    return true;
  }

  // New service envelope: dynamic content script injection (preferred)
  if (isRequestEnvelope(message) && message.type === 'INJECT_CONTENT_SCRIPT') {
    const injectionUrl = (message.payload as { url?: string })?.url;
    handleContentScriptInjection(sender.tab?.id || 0, !!injectionUrl)
      .then(() => {
        const tabId = sender.tab?.id;
        if (tabId) {
          injectedTabs.add(tabId);
          if (sender.tab?.active) {
            updateContextMenu(tabId);
          }
        }
        sendResponseEnvelope(message.id, sendResponse, { ok: true, data: { success: true } });
      })
      .catch((error) => {
        sendResponseEnvelope(message.id, sendResponse, { ok: false, errorMessage: (error as Error).message });
      });
    return true;
  }

  // New render envelope (preferred)
  if (isRequestEnvelope(message) && (message.type === 'RENDER_DIAGRAM' || message.type === 'SET_THEME_CONFIG' || message.type === 'PING')) {
    handleRenderEnvelopeRequest(message, sendResponse);
    return true;
  }

  // New service envelopes (preferred)
  if (isRequestEnvelope(message) && message.type === 'CACHE_OPERATION') {
    handleCacheOperationEnvelope(message, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'FILE_STATE_OPERATION') {
    handleFileStateOperationEnvelope(message, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'SCROLL_OPERATION') {
    handleScrollOperationEnvelope(message, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'UPLOAD_OPERATION') {
    handleUploadOperationEnvelope(message, sendResponse);
    return true;
  }

  // Storage operations (unified across all platforms)
  if (isRequestEnvelope(message) && message.type === 'STORAGE_GET') {
    handleStorageGetEnvelope(message, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'STORAGE_SET') {
    handleStorageSetEnvelope(message, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'STORAGE_REMOVE') {
    handleStorageRemoveEnvelope(message, sendResponse);
    return true;
  }

  // Handle downloads permission request (from content script user gesture)
  if (message && (message as Record<string, unknown>).type === 'REQUEST_DOWNLOADS_PERMISSION') {
    chrome.permissions.request({ permissions: ['downloads'] }, (granted) => {
      sendResponse({ granted: !!granted });
    });
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'DOCX_DOWNLOAD_FINALIZE') {
    return handleDocxDownloadFinalizeEnvelope(message, sendResponse);
  }

  if (isRequestEnvelope(message) && message.type === 'READ_LOCAL_FILE') {
    handleReadLocalFileEnvelope(message, sendResponse);
    return true;
  }

  // File change tracking
  if (isRequestEnvelope(message) && message.type === 'START_FILE_TRACKING') {
    handleStartFileTrackingEnvelope(message, sender, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'STOP_FILE_TRACKING') {
    void handleStopFileTrackingEnvelope(message, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'UPDATE_AUTO_REFRESH_SETTINGS') {
    void handleUpdateAutoRefreshSettingsEnvelope(message, sendResponse);
    return true;
  }

  if (isRequestEnvelope(message) && message.type === 'GET_AUTO_REFRESH_SETTINGS') {
    handleGetAutoRefreshSettingsEnvelope(message, sendResponse);
    return true;
  }

  // Return false for unhandled message types (synchronous response)
  return false;
});

/**
 * A silent offscreen document (dead renderer, missed handshake) would otherwise
 * hold a render request until the caller's own 60s budget expires.
 */
const OFFSCREEN_REQUEST_TIMEOUT_MS = 20000;

function sendOffscreenMessage(request: { id: string; type: string; payload: unknown }): Promise<unknown> {
  const offscreenRequest = {
    ...request,
    __target: RenderTarget.Offscreen
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Offscreen request timed out after ${OFFSCREEN_REQUEST_TIMEOUT_MS}ms`));
    }, OFFSCREEN_REQUEST_TIMEOUT_MS);

    chrome.runtime.sendMessage(offscreenRequest, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(`Offscreen communication failed: ${chrome.runtime.lastError.message}`));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Forward a request to the offscreen document, retrying once against a freshly
 * created document when the first attempt fails. The retry is what turns "the
 * offscreen document stopped answering" back into a normal render; both attempts
 * together still fit inside the renderer's own timeout.
 */
async function sendToOffscreen(request: { id: string; type: string; payload: unknown }): Promise<unknown> {
  // Ensure offscreen document exists and is ready
  await ensureOffscreenDocument();

  try {
    return await sendOffscreenMessage(request);
  } catch (error) {
    // The document is in an unknown state — drop it so the retry recreates it.
    resetOffscreenState();
    await ensureOffscreenDocument();
    return await sendOffscreenMessage(request);
  }
}

async function handleRenderEnvelopeRequest(
  message: { id: string; type: string; payload: unknown },
  sendResponse: (response: unknown) => void
): Promise<void> {
  try {
    const response = await sendToOffscreen(message);

    // Ensure we always respond with a ResponseEnvelope for new callers.
    if (isResponseEnvelope(response)) {
      sendResponse(response);
      return;
    }

    // Fallback: wrap unknown response.
    sendResponse({
      type: 'RESPONSE',
      requestId: message.id,
      ok: true,
      data: response,
    });
  } catch (error) {
    sendResponse({
      type: 'RESPONSE',
      requestId: message.id,
      ok: false,
      error: { message: (error as Error).message },
    });
  }
}


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

async function readLocalFile(
  filePath: string,
  binary: boolean
): Promise<{ content: string; contentType?: string }>{
  // Use fetch to read the file - this should work from background script
  const response = await fetch(filePath);

  if (!response.ok) {
    throw new Error(`Failed to read file: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';

  if (binary) {
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binaryString = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binaryString);
    return { content: base64, contentType };
  }

  const content = await response.text();
  return { content };
}

async function ensureOffscreenDocument(): Promise<void> {
  // If already ready, return immediately
  if (offscreenReady) {
    return;
  }

  // If there's already a pending ready promise, wait for it
  if (offscreenReadyPromise) {
    await offscreenReadyPromise;
    return;
  }

  // Create a promise that will resolve when offscreen is ready
  offscreenReadyPromise = new Promise((resolve) => {
    offscreenReadyResolve = resolve;
  });

  // Try to create offscreen document
  try {
    const offscreenUrl = chrome.runtime.getURL('ui/offscreen-render.html');

    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
      justification: 'Render diagrams and charts to PNG images'
    });

    offscreenCreated = true;

  } catch (error) {
    const errorMessage = (error as Error).message;
    // If error is about document already existing, that's fine
    if (errorMessage.includes('already exists') || errorMessage.includes('Only a single offscreen')) {
      offscreenCreated = true;
      // Document exists but we're not sure if it's ready, wait a bit
      if (!offscreenReady) {
        await new Promise(resolve => setTimeout(resolve, 100));
        // If still not ready after waiting, assume it's ready
        if (!offscreenReady) {
          markOffscreenReady();
        }
      }
      return;
    }

    // For other errors, clean up and throw. Waiters are released first: they then
    // fail with a real communication error instead of hanging on this promise.
    releaseOffscreenWaiters();
    throw new Error(`Failed to create offscreen document: ${errorMessage}`);
  }

  // Wait for the offscreen document to signal it's ready (max 5 seconds). The
  // document normally posts OFFSCREEN_READY almost immediately; when that message
  // is missed (e.g. the worker was restarted while it loaded) the promise must
  // still settle, otherwise every later render waits forever.
  const readyWaiter = offscreenReadyPromise;
  const timedOut = await Promise.race([
    readyWaiter.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
  ]);
  if (timedOut && !offscreenReady) {
    markOffscreenReady();
  }
}

// Handle dynamic content script injection.
// `fromContextMenu` is true when triggered by the right-click menu so we
// always run the HTML→Markdown converter first (the script self-detects
// whether the page is HTML via document.contentType and bails out early
// if it's a raw text file).
async function handleElementRuntimeInjection(tabId: number): Promise<void> {
  // Inline element mode renders into the host page DOM, so it needs the
  // shared content styles — injected as a FILTERED copy (content selectors
  // only, no global html/body rules) so the host page itself is unaffected.
  // iframe mode does not need this: viewer-embed.html loads ui/styles.css.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['core/inject-element-styles.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['core/element-runtime.js'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['core/element-runtime-main.js'],
  });
}

async function handleContentScriptInjection(tabId: number, fromContextMenu = false): Promise<void> {
  try {
    if (fromContextMenu) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['core/html-to-markdown.js'],
      });
    }
    // Inject the content stylesheet as a real <style> element. insertCSS is
    // deliberately NOT used: its injected stylesheets never appear in
    // document.styleSheets, so the export CSS collectors would miss every
    // structural content rule (diagram-block centering etc.) and exported
    // HTML/EPUB would lose the shared stylesheet.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['core/inject-styles.js'],
    });
    // Inject the viewer (handles markdown, .slides.md, and converted HTML)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['core/main.js'],
    });
  } catch (error) {
    throw error;
  }
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

  if (typeof chunk !== 'string') {
    throw new Error('Invalid chunk payload');
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

// Track tabs that have the viewer injected
const injectedTabs = new Set<number>();

// Listen for settings changes to update cache manager
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.markdownViewerSettings) {
    const newSettings = changes.markdownViewerSettings.newValue as { maxCacheItems?: number; preferredLocale?: string } | undefined;
    if (newSettings && newSettings.maxCacheItems) {
      const newMaxItems = newSettings.maxCacheItems;
      
      // Update global cache manager's maxItems
      if (globalCacheStorage) {
        if ('maxItems' in globalCacheStorage) {
          (globalCacheStorage as { maxItems: number }).maxItems = newMaxItems;
        }
      }
    }
    
    // Update context menu when locale changes
    if (newSettings && 'preferredLocale' in newSettings) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTabId = tabs[0]?.id;
        updateContextMenu(activeTabId);
      });
    }
  }
});

// Get localized menu title based on user settings
async function getMenuTitle(isRaw = false): Promise<string> {
  const key = isRaw ? 'contextMenu_viewAsRaw' : 'contextMenu_viewAsMarkdown';
  const defaultText = isRaw ? 'View as Raw' : 'View as Markdown';

  try {
    const result = await chrome.storage.local.get(['markdownViewerSettings']);
    const settings = result?.markdownViewerSettings as { preferredLocale?: string } | undefined;
    const preferredLocale = settings?.preferredLocale;
    
    // If user has set a preferred locale (not 'auto'), load from that locale
    if (preferredLocale && preferredLocale !== 'auto') {
      try {
        const localeUrl = chrome.runtime.getURL(`_locales/${preferredLocale}/messages.json`);
        const response = await fetch(localeUrl);
        const messages = await response.json();
        const message = messages[key]?.message;
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
  return chrome.i18n.getMessage(key) || defaultText;
}

const CONTEXT_MENU_ID = 'view-as-markdown';

// The contextMenus API only gained Promise support in Chrome 123 (the bundle
// targets Chrome 120 syntax, so Chrome 120-122 is supported as well). On those
// versions a promise-style `remove`/`update` never rejects: the failure stays in
// runtime.lastError unread, so Chrome logs
// "Unchecked runtime.lastError: Cannot find menu item with id ..." even for calls
// that are expected to fail (removing an item that does not exist yet, updating
// before creation finished). The callback form plus an explicit runtime.lastError
// read behaves identically on every supported version and keeps the service
// worker console clean.
function removeAllContextMenus(): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      // An already empty menu list is not an error worth reporting.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function createContextMenuItem(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title,
        contexts: ['link', 'page'],
        documentUrlPatterns: ['file://*/*', 'http://*/*', 'https://*/*']
      },
      () => {
        // create() reports failures (e.g. duplicate id) through lastError only.
        const error = chrome.runtime.lastError;
        if (error) {
          console.warn('Failed to create context menu:', error.message);
          resolve(false);
        } else {
          resolve(true);
        }
      }
    );
  });
}

function updateContextMenuItem(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.contextMenus.update(CONTEXT_MENU_ID, { title }, () => {
      // A missing menu item (not created yet, or dropped on a service worker
      // restart) is reported through lastError instead of throwing.
      resolve(!chrome.runtime.lastError);
    });
  });
}

// Initialize context menu for viewing any file as markdown
async function initializeContextMenu(titleOverride?: string): Promise<boolean> {
  try {
    // Menu items do not survive a browser restart, but they do survive a service
    // worker restart, and the id changed in earlier versions (preview-as-markdown):
    // clear every leftover before creating, otherwise create() fails on a duplicate id.
    await removeAllContextMenus();

    const title = titleOverride ?? await getMenuTitle();
    return await createContextMenuItem(title);
  } catch (error) {
    console.error('Failed to create context menu:', error);
    return false;
  }
}

let contextMenuReady = false;
let contextMenuInit: Promise<void> | null = null;

// Create the menu once per service worker life cycle. Concurrent callers share the
// in-flight initialization so they cannot race into a duplicate id.
function ensureContextMenu(title?: string): Promise<void> {
  if (contextMenuReady) {
    return Promise.resolve();
  }
  if (!contextMenuInit) {
    contextMenuInit = initializeContextMenu(title)
      .then((created) => {
        contextMenuReady = created;
      })
      .finally(() => {
        contextMenuInit = null;
      });
  }
  return contextMenuInit;
}

// Update context menu when settings change
async function updateContextMenu(tabId?: number): Promise<void> {
  try {
    // Wait for the initial creation instead of racing it, so the very first update
    // of a fresh service worker does not hit a missing menu item.
    await ensureContextMenu();

    const isRaw = tabId !== undefined ? injectedTabs.has(tabId) : false;
    const title = await getMenuTitle(isRaw);
    const updated = await updateContextMenuItem(title);
    if (!updated) {
      // The item is gone (service worker restart, manual removal): rebuild it so the
      // title matches the current tab instead of staying stale.
      contextMenuReady = false;
      await ensureContextMenu(title);
    }
  } catch (error) {
    console.error('Failed to update context menu:', error);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateContextMenu(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    // If the tab is reloading/navigating, clear the injection state
    injectedTabs.delete(tabId);
    if (tab.active) {
      updateContextMenu(tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID && tab?.id) {
    const tabId = tab.id;
    let targetUrl = '';
    
    // Get the URL to preview
    if (info.linkUrl) {
      targetUrl = info.linkUrl;
    } else if (tab.url) {
      targetUrl = tab.url;
    }
    
    if (targetUrl) {
      const isCurrentPage = targetUrl === tab.url;
      
      if (isCurrentPage) {
        if (injectedTabs.has(tabId)) {
          // Restore original view using message passing to content script first,
          // then reload if it fails (as fallback).
          chrome.tabs.sendMessage(tabId, { type: 'RESTORE_ORIGINAL_VIEW' }).then(() => {
            injectedTabs.delete(tabId);
            updateContextMenu(tabId);
          }).catch((error) => {
            console.error('Failed to restore original view:', error);
            // Fallback: reload page
            injectedTabs.delete(tabId);
            chrome.tabs.reload(tabId);
          });
        } else {
          // Current page - always run html-to-markdown converter first
          chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              try { sessionStorage.removeItem('markdownViewerRawOverride'); } catch (e) {}
            }
          }).finally(() => {
            handleContentScriptInjection(tabId, true).then(() => {
              injectedTabs.add(tabId);
              updateContextMenu(tabId);
            }).catch((error) => {
              console.error('Failed to inject content script:', error);
            });
          });
        }
      } else {
        // Navigate current tab to the target URL
        chrome.tabs.update(tabId, { url: targetUrl });
      }
    }
  }
});

// Initialize context menu when extension loads
void ensureContextMenu();
