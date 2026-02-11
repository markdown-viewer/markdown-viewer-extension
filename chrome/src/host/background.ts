/**
 * Background script for handling messages between content script and offscreen document
 */

/// <reference types="chrome"/>

import CacheStorage from '../../../src/utils/cache-storage';
import { toSimpleCacheStats } from '../../../src/utils/cache-stats';
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

async function handleDocxDownloadFinalizeEnvelope(
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
    const hasDownloadsPermission = await chrome.permissions.contains({ permissions: ['downloads'] });
    if (!hasDownloadsPermission) {
      // No downloads permission - send data back to content script for fallback download
      uploadSessions.delete(token);
      sendResponseEnvelope(message.id, sendResponse, {
        ok: true,
        data: { fallback: true, dataUrl, filename, mimeType },
      });
      return true;
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
      offscreenCreated = false;
      offscreenReady = false;
      offscreenReadyPromise = null;
      offscreenReadyResolve = null;
    });
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  if (isRequestEnvelope(message) && message.type === 'OFFSCREEN_READY') {
    offscreenCreated = true;
    offscreenReady = true;
    if (offscreenReadyResolve) {
      offscreenReadyResolve();
      offscreenReadyResolve = null;
    }
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

  // New service envelope: dynamic content script injection (preferred)
  if (isRequestEnvelope(message) && message.type === 'INJECT_CONTENT_SCRIPT') {
    handleContentScriptInjection(sender.tab?.id || 0)
      .then(() => {
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

async function sendToOffscreen(request: { id: string; type: string; payload: unknown }): Promise<unknown> {
  // Ensure offscreen document exists and is ready
  await ensureOffscreenDocument();

  const offscreenRequest = {
    ...request,
    __target: 'offscreen'
  };

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(offscreenRequest, (response) => {
      if (chrome.runtime.lastError) {
        // Reset all offscreen state on communication failure
        if (chrome.runtime.lastError.message?.includes('receiving end does not exist')) {
          offscreenCreated = false;
          offscreenReady = false;
          offscreenReadyPromise = null;
          offscreenReadyResolve = null;
        }
        reject(new Error(`Offscreen communication failed: ${chrome.runtime.lastError.message}`));
        return;
      }
      resolve(response);
    });
  });
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
          offscreenReady = true;
          if (offscreenReadyResolve) {
            offscreenReadyResolve();
            offscreenReadyResolve = null;
          }
        }
      }
      return;
    }

    // For other errors, clean up and throw
    offscreenReadyPromise = null;
    offscreenReadyResolve = null;
    throw new Error(`Failed to create offscreen document: ${errorMessage}`);
  }

  // Wait for the offscreen document to signal it's ready (max 5 seconds)
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => {
      if (!offscreenReady) {
        reject(new Error('Offscreen document initialization timeout'));
      }
    }, 5000);
  });

  try {
    await Promise.race([offscreenReadyPromise, timeoutPromise]);
  } catch (error) {
    // On timeout, assume it's ready anyway (the message might have been missed)
    offscreenReady = true;
  }
}

// Handle dynamic content script injection
async function handleContentScriptInjection(tabId: number): Promise<void> {
  try {
    // Inject CSS first
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ['ui/styles.css']
    });

    // Then inject JavaScript
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['core/main.js']
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
      updateContextMenu();
    }
  }
});

// Get localized menu title based on user settings
async function getMenuTitle(): Promise<string> {
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
  return chrome.i18n.getMessage('contextMenu_viewAsMarkdown') || 'View as Markdown';
}

// Initialize context menu for viewing any file as markdown
async function initializeContextMenu(): Promise<void> {
  try {
    // Remove old menu item if exists (migration from preview to view)
    try {
      await chrome.contextMenus.remove('preview-as-markdown');
    } catch {
      // Ignore if old menu doesn't exist
    }
    
    const title = await getMenuTitle();
    chrome.contextMenus.create({
      id: 'view-as-markdown',
      title,
      contexts: ['link', 'page'],
      documentUrlPatterns: ['file://*/*', 'http://*/*', 'https://*/*']
    });
  } catch (error) {
    console.error('Failed to create context menu:', error);
  }
}

// Update context menu when settings change
async function updateContextMenu(): Promise<void> {
  try {
    const title = await getMenuTitle();
    await chrome.contextMenus.update('view-as-markdown', { title });
  } catch (error) {
    // Menu might not exist yet, ignore
    if (!error?.toString().includes('Cannot find menu item')) {
      console.error('Failed to update context menu:', error);
    }
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'view-as-markdown' && tab?.id) {
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
        // Current page - inject directly
        handleContentScriptInjection(tab.id).catch((error) => {
          console.error('Failed to inject content script:', error);
        });
      } else {
        // Navigate current tab to the target URL
        chrome.tabs.update(tab.id, { url: targetUrl });
      }
    }
  }
});

// Initialize context menu when extension loads
initializeContextMenu();
