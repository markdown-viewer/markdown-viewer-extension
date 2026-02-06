/**
 * Markdown Viewer View
 *
 * Custom ItemView implementation that renders markdown directly in a div.
 * No iframe — the viewer module runs in the same process and uses
 * DirectTransport for ServiceChannel communication with the host handlers.
 *
 * Provides title-bar action buttons for DOCX export and settings.
 */

import { ItemView, WorkspaceLeaf, TFile, Menu, Notice } from 'obsidian';
import type MarkdownViewerPlugin from './main';
import { getFileType } from '../../../src/utils/file-wrapper';

// Viewer module — runs in same process, no iframe
import { initializeViewer, obsidianHostTransport } from '../webview/main';

// ServiceChannel on the host side of the DirectTransport pair
import { ServiceChannel } from '../../../src/messaging/channels/service-channel';

export const VIEW_TYPE = 'markdown-viewer-preview';

export class MarkdownPreviewView extends ItemView {
  private plugin: MarkdownViewerPlugin;
  private currentFile: TFile | null = null;
  private hostChannel: ServiceChannel | null = null;
  private isViewerReady = false;
  private pendingMessages: Array<{ type: string; payload?: unknown }> = [];

  // Upload sessions for chunked DOCX transfer
  private uploadSessions: Map<string, {
    purpose: string;
    encoding: string;
    expectedSize?: number;
    chunkSize: number;
    metadata: Record<string, unknown>;
    chunks: string[];
    data: string;
    completed: boolean;
  }> = new Map();

  constructor(leaf: WorkspaceLeaf, plugin: MarkdownViewerPlugin) {
    super(leaf);
    this.plugin = plugin;

    // addAction items render right-to-left, so register in reverse order:
    // Settings (rightmost) first, then Export DOCX (leftmost)
    this.addAction('settings', 'Settings', () => {
      this.openSettings();
    });

    this.addAction('download', 'Export to DOCX', () => {
      this.exportToDocx();
    });
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.currentFile
      ? this.currentFile.basename
      : 'Markdown Viewer';
  }

  getIcon(): string {
    return 'markdown-viewer';
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('markdown-viewer-preview');

    // Create the host-side ServiceChannel over the DirectTransport
    this.hostChannel = new ServiceChannel(obsidianHostTransport, {
      source: 'obsidian-host',
      timeoutMs: 30000,
    });

    // Register all host-side request handlers
    this.registerHostHandlers();

    // Listen for READY from the viewer module
    this.hostChannel.on('READY', () => {
      console.debug('[MV Host] Viewer READY received!');
      this.isViewerReady = true;
      // Flush pending messages
      console.debug('[MV Host] Flushing', this.pendingMessages.length, 'pending messages');
      for (const pending of this.pendingMessages) {
        this.hostChannel!.post(pending.type, pending.payload);
      }
      this.pendingMessages = [];
      // Send initial content
      if (this.currentFile) {
        this.sendFileContent(this.currentFile);
      }
    });

    // Initialize the viewer directly in the container (no iframe)
    console.debug('[MV Host] Initializing viewer in container...');
    await initializeViewer(container);

    // Load current active file
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && isSupportedFile(activeFile)) {
      console.debug('[MV Host] Active file:', activeFile.path);
      await this.setFile(activeFile);
    }
  }

  async onClose(): Promise<void> {
    this.hostChannel?.close();
    this.hostChannel = null;
    this.isViewerReady = false;
    this.pendingMessages = [];
    this.uploadSessions.clear();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Set the file to preview. Reads content and pushes to viewer.
   */
  async setFile(file: TFile): Promise<void> {
    if (!file) return;

    this.currentFile = file;
    // Update the header display text
    (this.leaf as WorkspaceLeaf).updateHeader();

    await this.sendFileContent(file);
  }

  private async sendFileContent(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);

    // Build resource base URI for image path resolution.
    // Use a placeholder filename so getResourcePath returns a proper app:// URL
    // for this directory, then strip the placeholder and query string.
    const folder = file.parent;
    const folderPath = folder && folder.path !== '/' ? folder.path : '';
    let documentBaseUri = '';
    const adapter = this.app.vault.adapter as { getResourcePath?: (path: string) => string };
    if (adapter.getResourcePath) {
      const placeholder = folderPath ? `${folderPath}/__p__` : '__p__';
      const placeholderUrl = adapter.getResourcePath(placeholder);
      // Strip "/__p__" and any "?timestamp" to get a clean directory URL
      documentBaseUri = placeholderUrl.replace(/\/__p__(\?.*)?$/, '');
    }

    this.postToViewer('UPDATE_CONTENT', {
      content,
      filename: file.name,
      documentPath: file.path,
      documentBaseUri,
    });
  }

  /**
   * Check whether the given file matches the currently previewed file.
   */
  isFileMatch(file: TFile): boolean {
    return this.currentFile?.path === file.path;
  }

  // ===========================================================================
  // Title-bar Actions
  // ===========================================================================

  private exportToDocx(): void {
    if (!this.currentFile) return;
    new Notice('Exporting to DOCX...');
    this.postToViewer('EXPORT_DOCX');
  }

  private openSettings(): void {
    this.postToViewer('OPEN_SETTINGS');
  }

  onMoreOptionsMenu(menu: Menu): void {
    menu.addItem((item) => {
      item
        .setIcon('refresh-cw')
        .setTitle('Refresh Preview')
        .onClick(() => this.refreshPreview());
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item
        .setIcon('download')
        .setTitle('Export to DOCX')
        .onClick(() => this.exportToDocx());
    });

    super.onMoreOptionsMenu(menu);
  }

  private async refreshPreview(): Promise<void> {
    if (this.currentFile) {
      await this.setFile(this.currentFile);
    }
  }

  // ===========================================================================
  // Host → Viewer Messaging
  // ===========================================================================

  /**
   * Send a message to the viewer module.
   * If the viewer is not ready yet, queue the message.
   */
  private postToViewer(type: string, payload?: unknown): void {
    if (!this.isViewerReady || !this.hostChannel) {
      console.debug('[MV Host] Queuing message (viewer not ready):', type);
      this.pendingMessages.push({ type, payload });
      return;
    }
    console.debug('[MV Host] ▶ Sending to viewer:', type);
    this.hostChannel.post(type, payload);
  }

  // ===========================================================================
  // Host-side Request Handlers
  // ===========================================================================

  /**
   * Register all request handlers on the host-side ServiceChannel.
   * These handle service requests from the viewer module (storage, cache, etc.).
   */
  private registerHostHandlers(): void {
    if (!this.hostChannel) return;

    this.hostChannel.handle('STORAGE_GET', async (payload) => {
      return this.handleStorageGet(payload as { keys: string | string[] });
    });

    this.hostChannel.handle('STORAGE_SET', async (payload) => {
      return this.handleStorageSet(payload as { items: Record<string, unknown> });
    });

    this.hostChannel.handle('STORAGE_REMOVE', async (payload) => {
      return this.handleStorageRemove(payload as { keys: string | string[] });
    });

    this.hostChannel.handle('CACHE_OPERATION', async (payload) => {
      return this.handleCacheOperation(payload as {
        operation: string; key?: string; value?: unknown; dataType?: string;
      });
    });

    this.hostChannel.handle('FETCH_ASSET', async (payload) => {
      return this.handleFetchAsset(payload as { path: string });
    });

    this.hostChannel.handle('READ_LOCAL_FILE', async (payload) => {
      return this.handleReadLocalFile(payload as { filePath: string; binary?: boolean });
    });

    this.hostChannel.handle('UPLOAD_OPERATION', async (payload) => {
      return this.handleUploadOperation(payload as {
        operation: string; token?: string; chunk?: string;
        purpose?: string; encoding?: string; expectedSize?: number;
        chunkSize?: number; metadata?: Record<string, unknown>;
      });
    });

    this.hostChannel.handle('DOCX_DOWNLOAD_FINALIZE', async (payload) => {
      return this.handleDocxDownloadFinalize(payload as { token: string });
    });

    this.hostChannel.handle('SAVE_SETTING', async (payload) => {
      const { key, value } = (payload ?? {}) as { key: string; value: unknown };
      const data = (await this.plugin.loadData()) ?? {};
      data[key] = value;
      await this.plugin.saveData(data);
      return { success: true };
    });

    this.hostChannel.handle('OPEN_URL', async (payload) => {
      if (payload && (payload as { url: string }).url) {
        window.open((payload as { url: string }).url);
      }
      return { success: true };
    });

    this.hostChannel.handle('OPEN_RELATIVE_FILE', async (payload) => {
      if (payload && (payload as { path: string }).path && this.currentFile) {
        const relPath = (payload as { path: string }).path;
        const folder = this.currentFile.parent;
        const target = this.app.metadataCache.getFirstLinkpathDest(relPath, folder?.path ?? '');
        if (target) {
          await this.app.workspace.openLinkText(target.path, '', false);
        }
      }
      return { success: true };
    });

    this.hostChannel.handle('LOAD_SETTINGS', async () => {
      const data = (await this.plugin.loadData()) ?? {};
      const stored = (data.markdownViewerSettings as Record<string, unknown>) ?? {};
      return {
        locale: stored.locale ?? data.locale ?? 'auto',
        docxHrDisplay: stored.docxHrDisplay ?? data.docxHrDisplay ?? 'hide',
        docxEmojiStyle: stored.docxEmojiStyle ?? data.docxEmojiStyle ?? 'system',
        frontmatterDisplay: stored.frontmatterDisplay ?? data.frontmatterDisplay ?? 'hide',
        tableMergeEmpty: stored.tableMergeEmpty ?? (data.tableMergeEmpty !== false),
        tableLayout: stored.tableLayout ?? data.tableLayout ?? 'center',
      };
    });

    // Handle export result notification
    this.hostChannel.on('EXPORT_DOCX_RESULT', (payload) => {
      const result = payload as { success: boolean; filename?: string; error?: string };
      if (result.success) {
        new Notice(`DOCX exported: ${result.filename || 'document.docx'}`);
      } else {
        new Notice(`DOCX export failed: ${result.error || 'Unknown error'}`, 5000);
      }
    });

    // Informational messages — just listen, no response needed
    for (const infoType of [
      'EXPORT_PROGRESS', 'RENDER_PROGRESS',
      'HEADINGS_UPDATED', 'REVEAL_LINE', 'THEME_CHANGED',
    ]) {
      this.hostChannel.on(infoType, () => { /* no-op */ });
    }
  }

  // ===========================================================================
  // Storage Handlers (backed by Plugin.loadData / saveData)
  // ===========================================================================

  private async handleStorageGet(payload: { keys: string | string[] }): Promise<Record<string, unknown>> {
    const data = (await this.plugin.loadData()) ?? {};
    const keys = Array.isArray(payload.keys) ? payload.keys : [payload.keys];
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = data[key];
    }
    return result;
  }

  private async handleStorageSet(payload: { items: Record<string, unknown> }): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};
    Object.assign(data, payload.items);
    await this.plugin.saveData(data);
  }

  private async handleStorageRemove(payload: { keys: string | string[] }): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};
    const keys = Array.isArray(payload.keys) ? payload.keys : [payload.keys];
    for (const key of keys) {
      delete data[key];
    }
    await this.plugin.saveData(data);
  }

  // ===========================================================================
  // Cache Handlers (simple in-memory for Phase 1)
  // ===========================================================================

  private cacheStore: Map<string, unknown> = new Map();

  private async handleCacheOperation(payload: {
    operation: string; key?: string; value?: unknown; dataType?: string;
  }): Promise<unknown> {
    const { operation, key, value } = payload;
    switch (operation) {
      case 'get': return key ? (this.cacheStore.get(key) ?? null) : null;
      case 'set':
        if (key) { this.cacheStore.set(key, value); return { success: true }; }
        return { success: false };
      case 'delete':
        if (key) { this.cacheStore.delete(key); return { success: true }; }
        return { success: false };
      case 'clear':
        this.cacheStore.clear();
        return { success: true };
      case 'getStats': {
        let totalSize = 0;
        const items: Array<{ key: string; value: unknown; type: string; size: number; timestamp: number; accessTime: number }> = [];
        this.cacheStore.forEach((value, key) => {
          const size = new Blob([typeof value === 'string' ? value : JSON.stringify(value)]).size;
          totalSize += size;
          items.push({ key, value, type: 'unknown', size, timestamp: Date.now(), accessTime: Date.now() });
        });
        return {
          itemCount: this.cacheStore.size,
          maxItems: 500,
          totalSize,
          totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2) + ' MB',
          items,
        };
      }
      default: return null;
    }
  }

  // ===========================================================================
  // File Handlers
  // ===========================================================================

  private async handleFetchAsset(payload: { path: string }): Promise<string> {
    const pluginDir = this.plugin.manifest.dir;
    if (!pluginDir) throw new Error('Plugin directory unknown');

    const fullPath = `${pluginDir}/webview/${payload.path}`;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(fullPath)) {
      return adapter.read(fullPath);
    }
    throw new Error(`Asset not found: ${payload.path}`);
  }

  private async handleReadLocalFile(payload: { filePath: string; binary?: boolean }): Promise<{ content: string; contentType?: string }> {
    const { filePath, binary } = payload;

    // Resolve relative to current file
    let targetPath = filePath;
    if (!filePath.startsWith('/') && this.currentFile) {
      const folder = this.currentFile.parent;
      const folderPath = folder ? folder.path : '';
      // Root folder path is "/" in Obsidian, avoid double slash
      const base = folderPath === '/' ? '' : folderPath;
      targetPath = base ? `${base}/${filePath}` : filePath;
    }

    // Resolve ".." and "." segments, produce clean vault-relative path
    const segments = targetPath.split('/');
    const resolved: string[] = [];
    for (const seg of segments) {
      if (seg === '..') {
        resolved.pop();
      } else if (seg && seg !== '.') {
        resolved.push(seg);
      }
    }
    targetPath = resolved.join('/');

    // Use vault adapter to read directly from filesystem (bypasses vault index)
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(targetPath))) {
      throw new Error(`File not found: ${targetPath}`);
    }

    if (binary) {
      const buf = await adapter.readBinary(targetPath);
      const bytes = new Uint8Array(buf);
      let base64 = '';
      for (let i = 0; i < bytes.length; i++) {
        base64 += String.fromCharCode(bytes[i]);
      }
      return { content: btoa(base64) };
    }

    const content = await adapter.read(targetPath);
    return { content };
  }

  // ===========================================================================
  // Upload Handlers (for chunked DOCX transfer)
  // ===========================================================================

  private handleUploadOperation(payload: {
    operation: string; token?: string; chunk?: string;
    purpose?: string; encoding?: string; expectedSize?: number;
    chunkSize?: number; metadata?: Record<string, unknown>;
  }): unknown {
    const { operation } = payload;
    switch (operation) {
      case 'init': {
        const token = `${Date.now()}-${this.uploadSessions.size}`;
        const chunkSize = payload.chunkSize || 255 * 1024;
        this.uploadSessions.set(token, {
          purpose: payload.purpose || 'general',
          encoding: payload.encoding || 'text',
          expectedSize: payload.expectedSize,
          chunkSize,
          metadata: payload.metadata || {},
          chunks: [],
          data: '',
          completed: false,
        });
        return { token, chunkSize };
      }
      case 'chunk': {
        const session = this.uploadSessions.get(payload.token!);
        if (!session) throw new Error('Upload session not found');
        session.chunks.push(payload.chunk!);
        return {};
      }
      case 'finalize': {
        const session = this.uploadSessions.get(payload.token!);
        if (!session) throw new Error('Upload session not found');
        session.data = session.chunks.join('');
        session.completed = true;
        return { token: payload.token, purpose: session.purpose, bytes: session.data.length, encoding: session.encoding };
      }
      case 'abort': {
        if (payload.token) this.uploadSessions.delete(payload.token);
        return {};
      }
      default: throw new Error(`Unknown upload operation: ${operation}`);
    }
  }

  private async handleDocxDownloadFinalize(payload: { token: string }): Promise<unknown> {
    const session = this.uploadSessions.get(payload.token);
    if (!session || !session.completed) throw new Error('Upload session not found or not finalized');

    const filename = (session.metadata.filename as string) || 'document.docx';

    // Decode base64 → binary
    const binaryStr = atob(session.data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    // Build default save path next to the current file
    let defaultDir = '';
    if (this.currentFile?.parent) {
      defaultDir = this.currentFile.parent.path;
    }

    // Show native save dialog via Electron
    try {
      const electron = require('electron');
      const remote = electron.remote;
      const path = require('path');

      // Get vault base path for absolute path construction
      const vaultBasePath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
      const defaultPath = path.join(vaultBasePath, defaultDir, filename);

      const result = await remote.dialog.showSaveDialog({
        title: 'Export DOCX',
        defaultPath,
        filters: [
          { name: 'Word Documents', extensions: ['docx'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        // User cancelled — clean up session
        this.uploadSessions.delete(payload.token);
        return { success: false, cancelled: true };
      }

      // Write to the selected path using Node.js fs
      const fs = require('fs');
      fs.writeFileSync(result.filePath, Buffer.from(bytes));
      this.uploadSessions.delete(payload.token);
      return { success: true };
    } catch {
      // Fallback: save to vault directly (e.g. on mobile or if Electron API unavailable)
      const savePath = defaultDir ? `${defaultDir}/${filename}` : filename;
      const existing = this.app.vault.getAbstractFileByPath(savePath);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, bytes.buffer as ArrayBuffer);
      } else {
        await this.app.vault.createBinary(savePath, bytes.buffer as ArrayBuffer);
      }
      this.uploadSessions.delete(payload.token);
      return { success: true };
    }
  }
}

/**
 * Check if a file is supported for preview.
 */
function isSupportedFile(file: TFile): boolean {
  const fileType = getFileType(file.name);
  return fileType !== 'markdown' || file.extension === 'md' || file.extension === 'markdown';
}
