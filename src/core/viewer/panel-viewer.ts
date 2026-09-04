/**
 * Panel Viewer — the shared document state machine for container-style
 * rendering (editor panels and <markdown-viewer> elements).
 *
 * VS Code, Obsidian, Mobile and the <markdown-viewer> element all render
 * into a container with the same semantics:
 *
 *   openDocument()   — a NEW document (treats content as a file change)
 *   updateContent()  — same document, content changed (keeps viewport)
 *   switchTheme()    — apply a theme and re-render
 *   setScrollLine()  — scroll to a document line
 *   scrollToAnchor() — scroll to a heading anchor
 *
 * Everything else is the shared rendering core (createMountedViewer →
 * renderMarkdownFlow) plus the platform hooks below. Hosts keep their own
 * UI shell (toolbar/TOC panel/export menu) and message bridges; they only
 * delegate the document lifecycle here.
 */

import { wrapFileContent } from '../../utils/file-wrapper';
import { createMountedViewer, setCurrentFileKey } from './viewer-host';
import type { TranslateFn } from './viewer-host';
import type { HeadingInfo } from '../markdown-processor';
import type { ScrollSyncController } from '../line-based-scroll';
import type { PlatformAPI, PluginRenderer } from '../../types';

export interface PanelViewerOptions {
  /** Content container to render into (e.g. #markdown-content). */
  container: HTMLElement;
  /** Scroll container (defaults to the content container). */
  scrollContainer?: HTMLElement;
  platform: PlatformAPI;
  renderer: PluginRenderer;
  translate: TranslateFn;

  /**
   * External scroll sync controller (hosts with editor↔preview sync such as
   * VS Code provide their own createViewerScrollSync instance). When omitted
   * the panel viewer creates an internal one.
   */
  scrollController?: ScrollSyncController | null;

  /** Passed through to renderMarkdownFlow (first-screen responsiveness). */
  deferAsyncRenderUntilFirstPaint?: boolean;

  /**
   * Persist the scroll line to platform.fileState under the document key.
   * Editor panels keep this (true); <markdown-viewer> elements manage their
   * own scroll-line attribute, so they pass false.
   */
  persistScroll?: boolean;

  /** Called with the headings extracted during render (TOC sync). */
  onHeadings?: (headings: HeadingInfo[]) => void;
  /** Called when the user scrolls to a new line. */
  onScrollLineChange?: (line: number) => void;

  /** Passed through to renderMarkdownFlow (async-task progress). */
  onProgress?: (completed: number, total: number) => void;
  /** Passed through to renderMarkdownFlow (processing indicator). */
  beforeProcessAll?: () => void;
  afterProcessAll?: () => void;
  /** Passed through to renderMarkdownFlow (post-render hook). */
  afterRender?: () => void;
  /** Passed through to renderMarkdownFlow (TOC presence prediction). */
  onHeadingPresenceKnown?: (hasHeadings: boolean) => void;

  /** Apply a theme (typically loadAndApplyTheme). */
  applyTheme: (themeId: string) => Promise<void>;
  /** Persist the theme selection (optional). */
  saveTheme?: (themeId: string) => Promise<void>;

  /**
   * Wrap non-markdown file content (mermaid/vega/...) before rendering.
   * Defaults to wrapFileContent.
   */
  wrapContent?: (content: string, filename: string) => string;

  /**
   * Slidev hook: hosts that support .slides.md files detect them here and
   * take over rendering via onSlidevFile. <markdown-viewer> elements pass
   * neither (their content is always plain markdown).
   */
  isSlidevFile?: (filename: string) => boolean;
  onSlidevFile?: (filename: string, content: string) => void;
}

export interface PanelViewerUpdateOptions {
  /** Explicit document key (defaults to the filename). */
  documentKey?: string;
  /** Scroll to this 1-based line after rendering. */
  scrollLine?: number;
  /** Force a full re-render even when the document key is unchanged. */
  forceRender?: boolean;
  /**
   * Document base URI for relative-path resolution. When set, the panel
   * viewer calls platform.document.setDocumentPath(filename, baseUri).
   */
  documentBaseUri?: string;
}

export interface PanelViewerController {
  /** Load a new document (treats the content as a file change). */
  openDocument(content: string, filename: string, options?: PanelViewerUpdateOptions): Promise<void>;
  /** Update the current document's content (keeps the viewport). */
  updateContent(content: string, filename: string, options?: PanelViewerUpdateOptions): Promise<void>;
  switchTheme(themeId: string): Promise<void>;
  setScrollLine(line: number): void;
  scrollToAnchor(anchor: string): void;
  getCurrentLine(): number | null;
  destroy(): void;
}

export function createPanelViewer(options: PanelViewerOptions): PanelViewerController {
  const {
    container,
    scrollContainer,
    platform,
    renderer,
    translate,
    persistScroll = true,
    onHeadings,
    onScrollLineChange,
    onProgress,
    beforeProcessAll,
    afterProcessAll,
    afterRender,
    onHeadingPresenceKnown,
    applyTheme,
    saveTheme,
  } = options;
  const wrapContent = options.wrapContent ?? wrapFileContent;
  const isSlidevFile = options.isSlidevFile ?? (() => false);
  const onSlidevFile = options.onSlidevFile ?? (() => undefined);

  let currentDocumentKey = '';
  let currentFilename = 'document.md';

  const mountedViewer = createMountedViewer({
    container,
    scrollContainer: scrollContainer ?? container,
    platform,
    renderer,
    translate,
    scrollController: options.scrollController ?? null,
    deferAsyncRenderUntilFirstPaint: options.deferAsyncRenderUntilFirstPaint ?? false,
    onHeadings,
    onHeadingPresenceKnown,
    onProgress,
    beforeProcessAll,
    afterProcessAll,
    afterRender,
    onScrollLineChange: persistScroll
      ? (line) => {
          onScrollLineChange?.(line);
          if (currentDocumentKey) {
            platform.fileState.set(currentDocumentKey, { scrollLine: line });
          }
        }
      : onScrollLineChange,
    applyTheme,
    saveTheme,
  });

  async function updateDocument(
    content: string,
    filename: string,
    updateOptions: PanelViewerUpdateOptions | undefined,
    forceOpen: boolean,
  ): Promise<void> {
    const newFilename = filename || 'document.md';
    const newDocumentKey = updateOptions?.documentKey || newFilename;
    const fileChanged = forceOpen
      || currentDocumentKey !== newDocumentKey
      || currentFilename !== newFilename;

    currentFilename = newFilename;
    currentDocumentKey = newDocumentKey;

    // Resolve relative paths against the document base URI. The document KEY
    // is used (not the bare filename): hosts like Obsidian pass the full
    // document path as the key, so relative resolution stays exact.
    if (updateOptions?.documentBaseUri && platform.document) {
      platform.document.setDocumentPath(newDocumentKey, updateOptions.documentBaseUri);
    }

    // Slidev hook: the host takes over rendering for .slides.md files.
    if (isSlidevFile(newFilename)) {
      onSlidevFile(newFilename, content);
      return;
    }

    // Always announce the document key so external scroll controllers
    // (createViewerScrollSync) and file-state consumers see it; persistScroll
    // only controls whether user scrolls are written to fileState here.
    setCurrentFileKey(newDocumentKey);

    const wrapped = wrapContent(content, newFilename);

    await mountedViewer.render(wrapped, {
      fileChanged,
      forceRender: updateOptions?.forceRender ?? false,
      targetLine: updateOptions?.scrollLine,
    });
  }

  return {
    async openDocument(content, filename, updateOptions) {
      await updateDocument(content, filename, updateOptions, true);
    },
    async updateContent(content, filename, updateOptions) {
      await updateDocument(content, filename, updateOptions, false);
    },
    async switchTheme(themeId) {
      // mountedViewer.switchTheme runs handleThemeSwitchFlow (save scroll,
      // apply, saveTheme, re-render) — no extra saveTheme here.
      await mountedViewer.switchTheme(themeId);
    },
    setScrollLine(line) {
      mountedViewer.setScrollLine(line);
    },
    scrollToAnchor(anchor) {
      mountedViewer.scrollToAnchor(anchor);
    },
    getCurrentLine() {
      return mountedViewer.getCurrentLine();
    },
    destroy() {
      mountedViewer.destroy();
    },
  };
}
