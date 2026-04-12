/**
 * VS Code Extension Entry Point
 * 
 * Main entry point for the Markdown Viewer extension.
 */

import * as vscode from 'vscode';
import { MarkdownPreviewPanel } from './preview-panel';
import { CacheStorage } from './cache-storage';
import { registerNumberHeadingsCommand } from './markdown-tools';
import { SUPPORTED_LANGUAGE_IDS } from '../../../src/types/formats';

let outputChannel: vscode.OutputChannel;
let cacheStorage: CacheStorage;
let renderStatusBarItem: vscode.StatusBarItem;
let renderStatusTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Helper to check if a document is supported for preview
 * Also supports .md files that may have different languageId (e.g., prompt files in .github/)
 */
export const isSupportedDocument = (document: vscode.TextDocument): boolean => {
  if (SUPPORTED_LANGUAGE_IDS.includes(document.languageId)) {
    return true;
  }
  // Also support .md files regardless of languageId
  const fileName = document.fileName;
  return fileName.endsWith('.md');
};

/**
 * Tracks the topmost visible line for each document
 * Similar to VSCode's TopmostLineMonitor
 */
class TopmostLineMonitor {
  private readonly _positions = new Map<string, number>();
  private _previousActiveEditor: vscode.TextEditor | undefined;
  
  /**
   * Save scroll position for a document
   */
  setPendingScrollPosition(uri: vscode.Uri, line: number): void {
    this._positions.set(uri.toString(), line);
  }
  
  /**
   * Get saved scroll position for a document
   */
  getPendingScrollPosition(uri: vscode.Uri): number | undefined {
    return this._positions.get(uri.toString());
  }
  
  /**
   * Save position of current editor before switching
   */
  saveCurrentEditorPosition(): void {
    if (this._previousActiveEditor) {
      const visibleRanges = this._previousActiveEditor.visibleRanges;
      if (visibleRanges.length > 0) {
        const line = visibleRanges[0].start.line;
        this._positions.set(this._previousActiveEditor.document.uri.toString(), line);
      }
    }
  }
  
  /**
   * Update the tracked active editor
   */
  setActiveEditor(editor: vscode.TextEditor | undefined): void {
    this._previousActiveEditor = editor;
  }
  
  /**
   * Get position for editor, either from saved positions or current visible range
   */
  getLineForEditor(editor: vscode.TextEditor): number {
    const uri = editor.document.uri.toString();
    const saved = this._positions.get(uri);
    if (saved !== undefined) {
      return saved;
    }
    // Fallback to current visible range
    const visibleRanges = editor.visibleRanges;
    return visibleRanges.length > 0 ? visibleRanges[0].start.line : 0;
  }
}

const topmostLineMonitor = new TopmostLineMonitor();

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Markdown Viewer');
  outputChannel.appendLine('Markdown Viewer is now active');
  
  // Initialize the monitor with current active editor
  topmostLineMonitor.setActiveEditor(vscode.window.activeTextEditor);

  // Initialize preview panel with context for storage
  MarkdownPreviewPanel.initialize(context);

  // Initialize cache storage
  cacheStorage = new CacheStorage(context);
  cacheStorage.init().catch(err => {
    outputChannel.appendLine(`Cache storage init error: ${err}`);
  });

  // Create status bar item for render progress
  renderStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(renderStatusBarItem);

  // Helper to update render progress in status bar
  const updateRenderProgress = (completed: number, total: number) => {
    if (renderStatusTimeout) {
      clearTimeout(renderStatusTimeout);
      renderStatusTimeout = null;
    }
    
    if (total > 0 && completed < total) {
      renderStatusBarItem.text = `$(sync~spin) Rendering ${completed}/${total}`;
      renderStatusBarItem.show();
    } else {
      renderStatusBarItem.text = `$(check) Render complete`;
      renderStatusBarItem.show();
      // Hide after 2 seconds
      renderStatusTimeout = setTimeout(() => {
        renderStatusBarItem.hide();
        renderStatusTimeout = null;
      }, 2000);
    }
  };

  // Register preview command
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownViewer.preview', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && isSupportedDocument(editor.document)) {
        const panel = MarkdownPreviewPanel.createOrShow(context.extensionUri, editor.document, cacheStorage);
        panel.setRenderProgressCallback(updateRenderProgress);
        // Send initial scroll position from editor
        const initialLine = topmostLineMonitor.getLineForEditor(editor);
        outputChannel.appendLine(`[DEBUG] Preview command: sending initial scroll to line ${initialLine}`);
        panel.scrollToLine(initialLine);
      } else {
        vscode.window.showWarningMessage('Please open a supported file (Markdown, Mermaid, Vega, GraphViz, or Infographic)');
      }
    })
  );

  // Register preview to side command
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownViewer.previewToSide', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && isSupportedDocument(editor.document)) {
        const panel = MarkdownPreviewPanel.createOrShow(context.extensionUri, editor.document, cacheStorage, vscode.ViewColumn.Beside);
        panel.setRenderProgressCallback(updateRenderProgress);
        // Send initial scroll position from editor
        const initialLine = topmostLineMonitor.getLineForEditor(editor);
        panel.scrollToLine(initialLine);
      } else {
        vscode.window.showWarningMessage('Please open a supported file (Markdown, Mermaid, Vega, GraphViz, or Infographic)');
      }
    })
  );

  // Register export to DOCX command
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownViewer.exportDocx', async () => {
      const panel = MarkdownPreviewPanel.currentPanel;
      if (panel) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Exporting to DOCX',
            cancellable: false,
          },
          async (progress) => {
            let lastProgress = 0;
            const success = await panel.exportToDocx((percent) => {
              const increment = percent - lastProgress;
              if (increment > 0) {
                progress.report({ increment, message: `${percent}%` });
                lastProgress = percent;
              }
            });
            if (!success) {
              vscode.window.showErrorMessage('DOCX export failed');
            }
          }
        );
      } else {
        vscode.window.showWarningMessage('Please open the Markdown preview first');
      }
    })
  );

  // Register refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownViewer.refresh', () => {
      const panel = MarkdownPreviewPanel.currentPanel;
      if (panel) {
        panel.refresh();
      }
    })
  );

  // Register open settings command
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownViewer.openSettings', () => {
      const panel = MarkdownPreviewPanel.currentPanel;
      if (panel) {
        panel.openSettings();
      }
    })
  );

  // Register Markdown tools
  registerNumberHeadingsCommand(context, cacheStorage);

  // Auto-update preview on document change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isSupportedDocument(e.document)) {
        const panel = MarkdownPreviewPanel.currentPanel;
        if (panel && panel.isDocumentMatch(e.document)) {
          panel.updateContent(e.document.getText());
        }
      }
    })
  );

  // Auto-update preview on active editor change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // First save the position of the previous editor
      topmostLineMonitor.saveCurrentEditorPosition();
      
      if (editor && isSupportedDocument(editor.document)) {
        const panel = MarkdownPreviewPanel.currentPanel;
        if (panel) {
          // Get initial line from saved position or current visible range
          const initialLine = topmostLineMonitor.getLineForEditor(editor);
          panel.setDocumentFromEditor(editor.document, initialLine);
        }
      }
      
      // Update tracked editor
      topmostLineMonitor.setActiveEditor(editor);
    })
  );

  // Scroll sync: Editor → Preview (when editor visible range changes)
  // Disabled for .slides.md files — Slidev handles its own navigation
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (isSupportedDocument(event.textEditor.document)) {
        // Skip scroll sync for Slidev presentation files
        if (event.textEditor.document.fileName.endsWith('.slides.md')) return;

        // Always save the position for this document
        const visibleRanges = event.visibleRanges;
        if (visibleRanges.length > 0) {
          const topLine = visibleRanges[0].start.line;
          topmostLineMonitor.setPendingScrollPosition(event.textEditor.document.uri, topLine);
          
          const panel = MarkdownPreviewPanel.currentPanel;
          if (panel && panel.isDocumentMatch(event.textEditor.document)) {
            panel.scrollToLineFromEditor(topLine);
          }
        }
      }
    })
  );

  outputChannel.appendLine('Commands registered successfully');
}

export function deactivate() {
  if (renderStatusTimeout) {
    clearTimeout(renderStatusTimeout);
  }
  if (outputChannel) {
    outputChannel.dispose();
  }
}
