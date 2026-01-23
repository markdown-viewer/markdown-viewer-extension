/**
 * Markdown Preview Panel
 * 
 * WebviewPanel implementation for rendering Markdown with advanced features.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { CacheStorage } from './cache-storage';
import type { EmojiStyle } from '../../../src/types/docx.js';

export class MarkdownPreviewPanel {
  public static currentPanel: MarkdownPreviewPanel | undefined;
  public static readonly viewType = 'markdownViewerAdvanced';

  // Static global state for settings storage
  private static _globalState: vscode.Memento | undefined;

  /**
   * Initialize the panel with extension context
   * Must be called once before using createOrShow
   */
  public static initialize(context: vscode.ExtensionContext): void {
    MarkdownPreviewPanel._globalState = context.globalState;
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _cacheStorage: CacheStorage;
  private _document: vscode.TextDocument | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _uploadSessions: Map<string, UploadSession> = new Map();

  // Message ID counter for envelope format
  private _messageIdCounter = 0;

  // Progress callbacks
  private _exportProgressCallback: ((progress: number) => void) | null = null;
  private _renderProgressCallback: ((completed: number, total: number) => void) | null = null;

  // Webview ready state
  private _isWebviewReady = false;
  private _pendingOperations: Array<() => void> = [];

  // Flag to open settings after webview is ready
  private _openSettingsOnReady = false;

  // Flag to prevent scroll feedback loop (Preview → Editor → Preview)
  private _isScrolling = false;

  public static createOrShow(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    cacheStorage: CacheStorage,
    column?: vscode.ViewColumn
  ): MarkdownPreviewPanel {
    const targetColumn = column || vscode.ViewColumn.Beside;

    // If panel already exists, show it
    if (MarkdownPreviewPanel.currentPanel) {
      MarkdownPreviewPanel.currentPanel._panel.reveal(targetColumn);
      MarkdownPreviewPanel.currentPanel.setDocument(document);
      return MarkdownPreviewPanel.currentPanel;
    }

    // Create new panel
    // Include workspace folders and document directory in localResourceRoots
    // so that relative images can be loaded
    const resourceRoots: vscode.Uri[] = [
      vscode.Uri.joinPath(extensionUri, 'webview')
    ];
    
    // Add all workspace folders
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        resourceRoots.push(folder.uri);
      }
    }
    
    // Add document directory (in case it's outside workspace)
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    if (!resourceRoots.some(root => docDir.fsPath.startsWith(root.fsPath))) {
      resourceRoots.push(docDir);
    }

    const panel = vscode.window.createWebviewPanel(
      MarkdownPreviewPanel.viewType,
      'Markdown Preview',
      targetColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots
      }
    );

    MarkdownPreviewPanel.currentPanel = new MarkdownPreviewPanel(panel, extensionUri, document, cacheStorage);
    return MarkdownPreviewPanel.currentPanel;
  }

  /**
   * Create or show panel and open settings popup
   * If panel exists and webview is ready, open settings immediately
   * If panel is new or webview not ready, open settings when ready
   */
  public static createOrShowWithSettings(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    cacheStorage: CacheStorage,
    column?: vscode.ViewColumn
  ): void {
    // If panel exists and webview is ready, just open settings
    if (MarkdownPreviewPanel.currentPanel) {
      MarkdownPreviewPanel.currentPanel._panel.reveal(column || vscode.ViewColumn.Beside);
      MarkdownPreviewPanel.currentPanel.setDocument(document);
      
      if (MarkdownPreviewPanel.currentPanel._isWebviewReady) {
        // Webview is ready, open settings immediately
        MarkdownPreviewPanel.currentPanel.openSettings();
      } else {
        // Webview not ready yet, set flag to open when ready
        MarkdownPreviewPanel.currentPanel._openSettingsOnReady = true;
      }
      return;
    }

    // Create new panel with flag set
    const panel = MarkdownPreviewPanel.createOrShow(extensionUri, document, cacheStorage, column);
    panel._openSettingsOnReady = true;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    cacheStorage: CacheStorage
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._document = document;
    this._cacheStorage = cacheStorage;

    // Set initial content
    this._update();

    // Handle panel disposal
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle view state changes
    this._panel.onDidChangeViewState(
      (e) => {
        // NOTE: Do NOT call _update() here. The webview context is retained when hidden 
        // (retainContextWhenHidden: true), so we only need to update the content when 
        // it actually changes (via updateContent()), not when visibility changes.
        // Calling _update() here would cause unnecessary full page reloads.
      },
      null,
      this._disposables
    );

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    );
  }

  public setDocument(document: vscode.TextDocument, initialLine?: number): void {
    const isSameDocument = this._document?.uri.toString() === document.uri.toString();
    
    // If same document, skip update to avoid unnecessary refresh
    if (isSameDocument) {
      return;
    }
    
    this._document = document;
    this._panel.title = `Preview: ${path.basename(document.fileName)}`;
    this.updateContent(document.getText());
    
    // Send scroll position immediately - ScrollSyncController will handle
    // waiting for content to render and repositioning automatically
    const line = typeof initialLine === 'number' ? initialLine : 0;
    this.scrollToLine(line);
  }

  public isDocumentMatch(document: vscode.TextDocument): boolean {
    return this._document?.uri.toString() === document.uri.toString();
  }

  /**
   * Generate unique message ID for envelope format
   */
  private _nextMessageId(): string {
    this._messageIdCounter += 1;
    return `host-${Date.now()}-${this._messageIdCounter}`;
  }

  /**
   * Send message to webview using unified envelope format
   */
  private _postToWebview(type: string, payload?: unknown): void {
    this._panel.webview.postMessage({
      id: this._nextMessageId(),
      type,
      payload,
      timestamp: Date.now(),
      source: 'vscode-host',
    });
  }

  public updateContent(content: string): void {
    // Calculate document directory webview URI for resolving relative paths
    let documentBaseUri: string | undefined;
    if (this._document) {
      const docDir = vscode.Uri.file(path.dirname(this._document.uri.fsPath));
      documentBaseUri = this._panel.webview.asWebviewUri(docDir).toString();
    }

    this._postToWebview('UPDATE_CONTENT', {
      content,
      filename: this._document ? path.basename(this._document.fileName) : 'untitled.md',
      documentBaseUri
    });
  }

  public refresh(): void {
    if (this._document) {
      this.updateContent(this._document.getText());
    }
  }

  public openSettings(): void {
    // If webview is ready, send message immediately
    if (this._isWebviewReady) {
      this._postToWebview('OPEN_SETTINGS');
    } else {
      // Queue the operation for when webview is ready
      this._pendingOperations.push(() => {
        this._postToWebview('OPEN_SETTINGS');
      });
    }
  }

  // Export result resolver (for async export completion)
  private _exportResultResolver: ((success: boolean) => void) | null = null;

  public async exportToDocx(onProgress?: (progress: number) => void): Promise<boolean> {
    return new Promise((resolve) => {
      // Store callbacks
      this._exportProgressCallback = onProgress || null;
      this._exportResultResolver = (success: boolean) => {
        this._exportProgressCallback = null;
        this._exportResultResolver = null;
        resolve(success);
      };
      
      this._postToWebview('EXPORT_DOCX');
    });
  }

  /**
   * Set callback for render progress updates
   */
  public setRenderProgressCallback(callback: ((completed: number, total: number) => void) | null): void {
    this._renderProgressCallback = callback;
  }

  /**
   * Scroll preview to specified source line (Editor → Preview)
   * @param line - The line number to scroll to
   */
  public scrollToLine(line: number): void {
    // Skip if this scroll was triggered by preview scrolling editor
    if (this._isScrolling) {
      this._isScrolling = false;
      return;
    }
    this._postToWebview('SCROLL_TO_LINE', { line });
  }

  /**
   * Handle scroll from preview (Preview → Editor)
   * Called when webview reports its scroll position
   */
  private _onPreviewScroll(line: number): void {
    if (!this._document) {
      return;
    }

    // Find matching editor
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === this._document.uri.toString()) {
        this._scrollEditorToLine(line, editor);
        break;
      }
    }
  }

  /**
   * Scroll editor to specified line
   */
  private _scrollEditorToLine(line: number, editor: vscode.TextEditor): void {
    // Set flag to prevent feedback loop
    this._isScrolling = true;
    
    const sourceLine = Math.max(0, Math.floor(line));
    const lineCount = editor.document.lineCount;
    
    if (sourceLine >= lineCount) {
      const lastLine = lineCount - 1;
      editor.revealRange(
        new vscode.Range(lastLine, 0, lastLine, 0),
        vscode.TextEditorRevealType.AtTop
      );
      return;
    }

    const range = new vscode.Range(sourceLine, 0, sourceLine + 1, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
  }

  private async _handleMessage(message: { id?: string; type: string; payload?: unknown }): Promise<void> {
    const { type, payload, id: requestId } = message;

    try {
      let response: unknown;

      switch (type) {
        case 'STORAGE_GET':
          response = await this._handleStorageGet(payload as { keys: string | string[] });
          break;

        case 'STORAGE_SET':
          response = await this._handleStorageSet(payload as { items: Record<string, unknown> });
          break;

        case 'STORAGE_REMOVE':
          response = await this._handleStorageRemove(payload as { keys: string | string[] });
          break;

        case 'CACHE_OPERATION':
          response = await this._handleCacheOperation(payload as {
            operation: 'get' | 'set' | 'delete' | 'clear' | 'getStats';
            key?: string;
            value?: unknown;
            dataType?: string;
          });
          break;

        case 'DOWNLOAD_FILE':
          response = await this._handleDownload(payload as { filename: string; data: string; mimeType: string });
          break;

        case 'UPLOAD_OPERATION':
          response = await this._handleUploadOperation(payload as {
            operation: string;
            token?: string;
            chunk?: string;
            purpose?: string;
            encoding?: string;
            expectedSize?: number;
            chunkSize?: number;
            metadata?: Record<string, unknown>;
          });
          break;

        case 'DOCX_DOWNLOAD_FINALIZE':
          response = await this._handleDocxDownloadFinalize(payload as { token: string });
          break;

        case 'FETCH_ASSET':
          response = await this._handleFetchAsset(payload as { path: string });
          break;

        case 'RENDER_DIAGRAM':
          response = await this._handleRenderDiagram(payload as { renderType: string; input: unknown; themeConfig?: unknown });
          break;

        case 'GET_CONFIG':
          response = this._getConfiguration();
          break;

        case 'READY':
          // Webview is ready, mark it and process any pending operations
          this._isWebviewReady = true;
          
          // Process pending operations
          const operations = this._pendingOperations;
          this._pendingOperations = [];
          for (const op of operations) {
            op();
          }
          
          // Send initial content
          if (this._document) {
            this.updateContent(this._document.getText());
          }
          
          // Check if we should open settings
          if (this._openSettingsOnReady) {
            this._openSettingsOnReady = false;
            // Delay slightly to ensure content is rendered
            setTimeout(() => {
              this._postToWebview('OPEN_SETTINGS');
            }, 100);
          }
          
          response = { success: true };
          break;

        case 'HEADINGS_UPDATED':
          // Headings extracted during rendering - no action needed
          break;

        case 'RENDER_PROGRESS':
          // Rendering progress update
          if (this._renderProgressCallback && payload) {
            const { completed, total } = payload as { completed: number; total: number };
            this._renderProgressCallback(completed, total);
          }
          break;

        case 'EXPORT_PROGRESS':
          // DOCX export progress update
          if (this._exportProgressCallback && payload) {
            const { completed, total } = payload as { completed: number; total: number };
            const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
            this._exportProgressCallback(progress);
          }
          break;

        case 'EXPORT_DOCX_RESULT':
          // Export completed - resolve the promise
          if (this._exportResultResolver) {
            const result = payload as { success: boolean } | undefined;
            this._exportResultResolver(result?.success ?? false);
          }
          break;

        case 'REVEAL_LINE':
          // Preview scrolled, sync editor (Preview → Editor)
          if (payload && typeof (payload as { line: number }).line === 'number') {
            this._onPreviewScroll((payload as { line: number }).line);
          }
          break;

        case 'OPEN_URL':
          // Open external URL in default browser
          if (payload && (payload as { url: string }).url) {
            const url = (payload as { url: string }).url;
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
          response = { success: true };
          break;

        case 'READ_LOCAL_FILE':
          // Read local file content (for SVG plugin, etc.)
          response = await this._handleReadLocalFile(payload as { filePath: string });
          break;
        case 'FETCH_REMOTE_IMAGE':
          // Fetch remote image (for DOCX export, bypasses webview CSP)
          response = await this._handleFetchRemoteImage(payload as { url: string });
          break;
        case 'OPEN_RELATIVE_FILE':
          // Open relative file in VS Code
          if (payload && (payload as { path: string }).path && this._document) {
            const relativePath = (payload as { path: string }).path;
            const documentDir = path.dirname(this._document.uri.fsPath);
            const targetPath = path.resolve(documentDir, relativePath);
            const targetUri = vscode.Uri.file(targetPath);
            
            // Check if it's a markdown file
            if (relativePath.endsWith('.md') || relativePath.endsWith('.markdown')) {
              // Open markdown file and show preview
              const doc = await vscode.workspace.openTextDocument(targetUri);
              await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
              this.setDocument(doc);
            } else {
              // Open other files normally
              await vscode.commands.executeCommand('vscode.open', targetUri);
            }
          }
          response = { success: true };
          break;

        case 'SAVE_SETTING':
          // Save setting to extension global state
          if (payload) {
            const { key, value } = payload as { key: string; value: unknown };

            const globalState = MarkdownPreviewPanel._globalState;
            if (globalState) {
              // Theme is stored separately (used by theme-manager.ts and settings-tab.ts)
              if (key === 'theme' || key === 'selectedTheme') {
                await globalState.update('storage.selectedTheme', value);
              } else {
                // Other settings go into markdownViewerSettings container
                const existing = (globalState.get<Record<string, unknown>>('storage.markdownViewerSettings') ?? {});
                const next = { ...existing };

                if (key === 'locale' || key === 'preferredLocale') {
                  next.preferredLocale = value;
                } else if (key === 'docxHrAsPageBreak') {
                  next.docxHrAsPageBreak = value;
                } else if (key === 'tableMergeEmpty') {
                  next.tableMergeEmpty = value;
                } else if (key === 'docxEmojiStyle') {
                  next.docxEmojiStyle = value;
                } else if (key === 'frontmatterDisplay') {
                  next.frontmatterDisplay = value;
                } else {
                  (next as Record<string, unknown>)[key] = value;
                }

                await globalState.update('storage.markdownViewerSettings', next);
              }
            } else {
              // Fallback for unexpected initialization issues
              await this._handleStorageSet({ items: { [key]: value } });
            }
          }
          response = { success: true };
          break;

        default:
          console.warn(`Unknown message type: ${type}`);
          response = null;
      }

      // Send response using unified ResponseEnvelope format
      if (requestId) {
        this._panel.webview.postMessage({
          type: 'RESPONSE',
          requestId,
          ok: true,
          data: response
        });
      }
    } catch (error) {
      if (requestId) {
        this._panel.webview.postMessage({
          type: 'RESPONSE',
          requestId,
          ok: false,
          error: {
            message: error instanceof Error ? error.message : 'Unknown error'
          }
        });
      }
    }
  }

  private async _handleStorageGet(payload: { keys: string | string[] }): Promise<Record<string, unknown>> {
    const globalState = MarkdownPreviewPanel._globalState;
    const result: Record<string, unknown> = {};
    const keys = Array.isArray(payload.keys) ? payload.keys : [payload.keys];
    
    for (const key of keys) {
      if (key === 'markdownViewerSettings') {
        // Unified settings container used across platforms
        const stored = globalState?.get<Record<string, unknown>>('storage.markdownViewerSettings');
        result[key] = (stored && typeof stored === 'object') ? stored : {};
      } else {
        result[key] = globalState?.get(`storage.${key}`);
      }
    }
    
    return result;
  }

  private async _handleStorageSet(payload: { items: Record<string, unknown> }): Promise<void> {
    const globalState = MarkdownPreviewPanel._globalState;
    if (!globalState) return;
    
    for (const [key, value] of Object.entries(payload.items)) {
      await globalState.update(`storage.${key}`, value);
    }
  }

  private async _handleStorageRemove(payload: { keys: string | string[] }): Promise<void> {
    const globalState = MarkdownPreviewPanel._globalState;
    if (!globalState) return;
    
    const keys = Array.isArray(payload.keys) ? payload.keys : [payload.keys];
    
    for (const key of keys) {
      await globalState.update(`storage.${key}`, undefined);
    }
  }

  // Unified cache operation handler (same interface as Chrome/Mobile)
  private async _handleCacheOperation(payload: {
    operation: 'get' | 'set' | 'delete' | 'clear' | 'getStats';
    key?: string;
    value?: unknown;
    dataType?: string;
  }): Promise<unknown> {
    const { operation, key, value, dataType } = payload;

    switch (operation) {
      case 'get':
        return key ? this._cacheStorage.get(key) : null;

      case 'set':
        if (!key) return { success: false };
        const setResult = await this._cacheStorage.set(key, value, dataType);
        return { success: setResult };

      case 'delete':
        if (!key) return { success: false };
        const deleteResult = await this._cacheStorage.delete(key);
        return { success: deleteResult };

      case 'clear':
        const clearResult = await this._cacheStorage.clear();
        return { success: clearResult };

      case 'getStats':
        return this._cacheStorage.getStats();

      default:
        return null;
    }
  }

  private async _handleDownload(payload: { filename: string; data: string; mimeType: string }): Promise<void> {
    const { filename, data, mimeType } = payload;
    
    // Build default save path based on current document directory
    let defaultUri: vscode.Uri;
    if (this._document) {
      const docDir = path.dirname(this._document.uri.fsPath);
      defaultUri = vscode.Uri.file(path.join(docDir, filename));
    } else {
      defaultUri = vscode.Uri.file(filename);
    }
    
    // Ask user for save location
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'All Files': ['*']
      }
    });

    if (uri) {
      // Decode base64 and write file
      const buffer = Buffer.from(data, 'base64');
      await vscode.workspace.fs.writeFile(uri, buffer);
      vscode.window.showInformationMessage(`File saved: ${uri.fsPath}`);
    }
  }

  private async _handleUploadOperation(payload: {
    operation: string;
    token?: string;
    chunk?: string;
    purpose?: string;
    encoding?: string;
    expectedSize?: number;
    chunkSize?: number;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    const { operation } = payload;

    switch (operation) {
      case 'init': {
        const token = `${Date.now()}-${this._uploadSessions.size}`;
        const chunkSize = payload.chunkSize || 255 * 1024;
        
        this._uploadSessions.set(token, {
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
        const { token, chunk } = payload;
        if (!token || !chunk) {
          throw new Error('Invalid chunk payload');
        }

        const session = this._uploadSessions.get(token);
        if (!session) {
          throw new Error('Upload session not found');
        }

        session.chunks.push(chunk);
        return {};
      }

      case 'finalize': {
        const { token } = payload;
        if (!token) {
          throw new Error('Missing token');
        }

        const session = this._uploadSessions.get(token);
        if (!session) {
          throw new Error('Upload session not found');
        }

        session.data = session.chunks.join('');
        session.completed = true;

        return {
          token,
          purpose: session.purpose,
          bytes: session.data.length,
          encoding: session.encoding,
        };
      }

      case 'abort': {
        const { token } = payload;
        if (token) {
          this._uploadSessions.delete(token);
        }
        return {};
      }

      default:
        throw new Error(`Unknown upload operation: ${operation}`);
    }
  }

  private async _handleDocxDownloadFinalize(payload: { token: string }): Promise<unknown> {
    const { token } = payload;
    
    if (!token) {
      throw new Error('Missing token');
    }

    const session = this._uploadSessions.get(token);
    if (!session) {
      throw new Error('Upload session not found');
    }

    if (!session.completed) {
      throw new Error('Upload not finalized');
    }

    const filename = (session.metadata.filename as string) || 'document.docx';
    
    // Build default save path based on current document directory
    let defaultUri: vscode.Uri;
    if (this._document) {
      const docDir = path.dirname(this._document.uri.fsPath);
      defaultUri = vscode.Uri.file(path.join(docDir, filename));
    } else {
      defaultUri = vscode.Uri.file(filename);
    }
    
    // Ask user for save location
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'Word Documents': ['docx'],
        'All Files': ['*']
      }
    });

    if (uri) {
      // Decode base64 and write file
      const buffer = Buffer.from(session.data, 'base64');
      await vscode.workspace.fs.writeFile(uri, buffer);
      vscode.window.showInformationMessage(`File saved: ${uri.fsPath}`);
    }

    // Clean up session
    this._uploadSessions.delete(token);

    return { success: true };
  }

  private async _handleFetchAsset(payload: { path: string }): Promise<string> {
    // Extract relative path from full URL if needed
    let relativePath = payload.path;
    
    // Handle VSCode resource URLs (https://file+.vscode-resource.vscode-cdn.net/...)
    if (relativePath.includes('vscode-resource') || relativePath.includes('vscode-webview')) {
      const webviewIndex = relativePath.indexOf('/webview/');
      if (webviewIndex !== -1) {
        relativePath = relativePath.slice(webviewIndex + '/webview/'.length);
      }
    }
    
    // Handle URL-encoded characters
    try {
      relativePath = decodeURIComponent(relativePath);
    } catch {
      // Ignore decode errors
    }
    
    // When packaged, _extensionUri points to dist/vscode, so webview assets are at webview/
    const assetPath = vscode.Uri.joinPath(this._extensionUri, 'webview', relativePath);
    try {
      const data = await vscode.workspace.fs.readFile(assetPath);
      return Buffer.from(data).toString('utf8');
    } catch (error) {
      console.error(`[PreviewPanel] Failed to fetch asset: ${relativePath} (original: ${payload.path})`, error);
      throw error;
    }
  }

  private async _handleRenderDiagram(payload: { renderType: string; input: unknown; themeConfig?: unknown }): Promise<unknown> {
    // For now, pass through to webview's internal renderer
    // In a full implementation, this could use a worker or separate process
    return {
      error: 'Server-side rendering not implemented. Please use client-side rendering.'
    };
  }

  /**
   * Handle READ_LOCAL_FILE request - read file relative to current document
   */
  private async _handleReadLocalFile(payload: { filePath: string; binary?: boolean }): Promise<{ content: string; contentType?: string }> {
    const { filePath, binary } = payload;
    
    if (!this._document) {
      throw new Error('No document open');
    }

    let targetUri: vscode.Uri;
    
    // Handle different path formats
    if (filePath.startsWith('file://')) {
      // file:// URL - convert to URI
      targetUri = vscode.Uri.parse(filePath);
    } else if (path.isAbsolute(filePath)) {
      // Absolute path
      targetUri = vscode.Uri.file(filePath);
    } else {
      // Relative path - resolve from document directory
      const documentDir = vscode.Uri.joinPath(this._document.uri, '..');
      targetUri = vscode.Uri.joinPath(documentDir, filePath);
    }

    // Read file content
    const data = await vscode.workspace.fs.readFile(targetUri);
    
    // Determine content type from extension
    const ext = path.extname(targetUri.fsPath).toLowerCase().slice(1);
    const contentTypeMap: Record<string, string> = {
      'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
      'gif': 'image/gif', 'bmp': 'image/bmp', 'webp': 'image/webp',
      'svg': 'image/svg+xml', 'ico': 'image/x-icon'
    };
    const contentType = contentTypeMap[ext];
    
    if (binary) {
      // Return base64 encoded content for binary files (images, etc.)
      const content = Buffer.from(data).toString('base64');
      return { content, contentType };
    } else {
      // Return UTF-8 text content
      const content = Buffer.from(data).toString('utf-8');
      return { content, contentType };
    }
  }

  /**
   * Handle FETCH_REMOTE_IMAGE request - fetch image from URL (bypasses webview CSP)
   */
  private async _handleFetchRemoteImage(payload: { url: string }): Promise<{ content: string; contentType: string }> {
    const { url } = payload;
    
    // Use Node.js https/http modules to fetch the image
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const content = Buffer.from(arrayBuffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/png';
    
    return { content, contentType };
  }

  private _getConfiguration(): Record<string, unknown> {
    const globalState = MarkdownPreviewPanel._globalState;
    const config = vscode.workspace.getConfiguration('markdownViewer');
    
    // Get settings from persistent storage
    const settings = globalState?.get<Record<string, unknown>>('storage.markdownViewerSettings') ?? {};
    // Theme is stored separately at storage.selectedTheme (used by theme-manager.ts and settings-tab.ts)
    const theme = globalState?.get<string>('storage.selectedTheme') || 'default';
    const locale = (typeof settings.preferredLocale === 'string' && settings.preferredLocale) ? settings.preferredLocale : 'auto';
    const docxHrAsPageBreak = (typeof settings.docxHrAsPageBreak === 'boolean') ? settings.docxHrAsPageBreak : true;
    const tableMergeEmpty = (typeof settings.tableMergeEmpty === 'boolean') ? settings.tableMergeEmpty : true;
    const storedEmojiStyle = settings.docxEmojiStyle;
    const docxEmojiStyle: EmojiStyle = (storedEmojiStyle === 'apple' || storedEmojiStyle === 'windows' || storedEmojiStyle === 'system') ? storedEmojiStyle : 'system';
    const storedFrontmatterDisplay = settings.frontmatterDisplay;
    const frontmatterDisplay = (storedFrontmatterDisplay === 'hide' || storedFrontmatterDisplay === 'table' || storedFrontmatterDisplay === 'raw') ? storedFrontmatterDisplay : 'hide';
    
    return {
      theme,
      locale,
      docxHrAsPageBreak,
      tableMergeEmpty,
      docxEmojiStyle,
      frontmatterDisplay,
      fontSize: config.get('fontSize', 16),
      fontFamily: config.get('fontFamily', ''),
      lineNumbers: config.get('lineNumbers', true),
      scrollSync: config.get('scrollSync', true)
    };
  }

  private _update(): void {
    const webview = this._panel.webview;
    
    if (this._document) {
      this._panel.title = `Preview: ${path.basename(this._document.fileName)}`;
    }

    webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Get URIs for webview resources
    // Note: When packaged, the extension root IS dist/vscode, so paths are relative to that
    const webviewUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview')
    );
    
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'bundle.js')
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'styles.css')
    );

    // Settings panel styles
    const settingsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'settings-panel.css')
    );

    // Search panel styles
    const searchStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'search-panel.css')
    );

    const nonce = getNonce();
    const config = this._getConfiguration();

    // CSP needs to allow iframe for diagram rendering
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; img-src ${webview.cspSource} data: https: blob:; font-src ${webview.cspSource} data:; frame-src ${webview.cspSource} blob:; connect-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <link rel="stylesheet" href="${settingsStyleUri}">
  <link rel="stylesheet" href="${searchStyleUri}">
  <title>Markdown Preview</title>
  <style>
    /* Hide Chrome extension specific UI elements */
    #toolbar,
    #table-of-contents,
    #toc-overlay {
      display: none !important;
    }
    
    /* VS Code webview layout - use body scroll */
    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
    }
    
    #vscode-root {
      min-height: 100%;
    }
    
    #vscode-content {
      /* No overflow: auto - let body scroll */
    }
    
    /* Reset wrapper for VS Code (no sidebar offset) */
    #markdown-wrapper {
      margin-left: 0 !important;
      margin-top: 0 !important;
    }
    
    /* Full width content for VS Code */
    #markdown-page {
      max-width: none !important;
    }
  </style>
</head>
<body>
  <div id="vscode-root">
    <div id="vscode-content">
      <div id="markdown-wrapper">
        <div id="markdown-page">
          <div id="markdown-content"></div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    // Remove VSCode default styles to prevent style conflicts
    document.getElementById('_defaultStyles')?.remove();
    window.VSCODE_WEBVIEW_BASE_URI = '${webviewUri}';
    window.VSCODE_CONFIG = ${JSON.stringify(config)};
    window.VSCODE_NONCE = '${nonce}';
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    MarkdownPreviewPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Upload session for chunked file uploads */
interface UploadSession {
  purpose: string;
  encoding: string;
  expectedSize?: number;
  chunkSize: number;
  metadata: Record<string, unknown>;
  chunks: string[];
  data: string;
  completed: boolean;
}
