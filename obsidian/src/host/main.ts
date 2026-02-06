/**
 * Obsidian Plugin Entry Point
 *
 * Main entry point for the Markdown Viewer plugin.
 * Registers a custom ItemView for Markdown Viewer with DOCX export and settings.
 */

import { Plugin, WorkspaceLeaf, TFile, addIcon } from 'obsidian';
import { MarkdownPreviewView, VIEW_TYPE } from './preview-view';
import { getFileType } from '../../../src/utils/file-wrapper';

// Custom icon derived from icons/icon.svg (M letter, scaled to 100×100)
const MARKDOWN_VIEWER_ICON = '<path fill="currentColor" d="M15.2 77.8v-55.7h13.9L50 43l20.9-20.9h13.9v55.7H70.9V41.9L50 62.7 29 42v36z"/>';

/**
 * Check if a file is supported for preview.
 * Supports all file types defined in file-wrapper.ts.
 */
function isSupportedFile(file: TFile): boolean {
  const fileType = getFileType(file.name);
  // 'markdown' is the default/fallback, only match explicit types + md
  return fileType !== 'markdown' || file.extension === 'md' || file.extension === 'markdown';
}

export default class MarkdownViewerPlugin extends Plugin {

  async onload() {

    // Register non-markdown file extensions so Obsidian recognizes them as files
    try {
      this.registerExtensions(
        ['mermaid', 'mmd', 'vega', 'vl', 'gv', 'dot', 'infographic', 'drawio', 'svg'],
        VIEW_TYPE
      );
    } catch {
      // Extensions may already be registered by another plugin
    }

    // Register custom icon
    addIcon('markdown-viewer', MARKDOWN_VIEWER_ICON);

    // Register custom preview view
    this.registerView(VIEW_TYPE, (leaf) =>
      new MarkdownPreviewView(leaf, this)
    );

    // Ribbon icon in the left sidebar
    this.addRibbonIcon('markdown-viewer', 'Markdown Viewer Preview', async () => {
      await this.showPreview();
    });

    // Command palette: open preview
    this.addCommand({
      id: 'open-preview',
      name: 'Open Markdown Viewer',
      callback: () => this.showPreview(),
    });

    // Update preview when active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updatePreviewContent();
      })
    );

    // Update preview when file is modified
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          this.updatePreviewForFile(file);
        }
      })
    );
  }

  onunload() {
    // Obsidian automatically cleans up registered views
  }

  /**
   * Open the preview panel (or reveal if already open).
   */
  async showPreview(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      this.updatePreviewContent();
      return;
    }

    const leaf = this.app.workspace.getLeaf('split');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Push the current active markdown file content to all preview views.
   */
  updatePreviewContent(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || !isSupportedFile(activeFile)) return;

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MarkdownPreviewView) {
        view.setFile(activeFile);
      }
    }
  }

  /**
   * Update preview only if the modified file matches the currently previewed file.
   */
  updatePreviewForFile(file: TFile): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof MarkdownPreviewView && view.isFileMatch(file)) {
        view.setFile(file);
      }
    }
  }

}
