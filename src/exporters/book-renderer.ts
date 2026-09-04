/**
 * Book print renderer — renders every book page into hidden DOM containers
 * for browser-print PDF export (webview only).
 *
 * Uses the same markdown processor pipeline as the viewer (KaTeX, syntax
 * highlighting, diagram plugins via AsyncTaskManager), so the printed book
 * matches on-screen fidelity. Each source file becomes a `.book-chapter`
 * div; the caller prints the container with per-chapter page breaks.
 */

import { AsyncTaskManager, createMarkdownProcessor } from '../core/markdown-processor';
import { parseFootnotes } from '../core/footnote-model.ts';
import { applyFootnotes } from '../core/footnote-postprocessor.ts';
import { rewriteObsidianLinks } from '../utils/obsidian-link-rewrite';
import { preprocessPage } from './book-exporter';
import type { BookExportProgressHandler, BookPage } from '../types/book-export';
import type { PluginRenderer } from '../types/plugin';
import type { TranslateFunction } from '../types/core';
import { DEFAULT_SETTINGS } from '../config/settings.generated';

export interface RenderBookForPrintOptions {
  pages: BookPage[];
  fetchPage: (href: string) => Promise<string>;
  renderer: PluginRenderer;
  translate: TranslateFunction;
  /** Auto-merge empty table cells (mirrors the viewer setting) */
  tableMergeEmpty?: boolean;
  /** Table layout setting (mirrors the viewer setting) */
  tableLayout?: 'left' | 'center' | 'center-full-width';
  /** Standalone image layout setting (mirrors the viewer setting) */
  imageLayout?: 'left' | 'center';
  /** Diagram/chart layout setting (mirrors the viewer setting) */
  diagramLayout?: 'left' | 'center';
  onProgress?: BookExportProgressHandler;
  signal?: AbortSignal;
}

export interface RenderedBook {
  container: HTMLElement;
  cleanup: () => void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render all book pages into an off-screen container. The container is
 * attached to the document so async diagram placeholders can be resolved.
 * Callers should print it (with `.book-chapter { break-before: page }`
 * print CSS) and then call `cleanup()`.
 */
export async function renderBookForPrint(options: RenderBookForPrintOptions): Promise<RenderedBook> {
  const {
    pages,
    fetchPage,
    renderer,
    translate,
    tableMergeEmpty = DEFAULT_SETTINGS.tableMergeEmpty,
    tableLayout = DEFAULT_SETTINGS.tableLayout,
    imageLayout = DEFAULT_SETTINGS.imageLayout,
    diagramLayout = DEFAULT_SETTINGS.diagramLayout,
    onProgress,
    signal,
  } = options;

  const root = document.createElement('div');
  root.id = 'book-print-root';
  root.style.position = 'absolute';
  root.style.left = '-9999px';
  root.style.top = '0';
  root.style.width = '100%';
  document.body.appendChild(root);

  try {
    const total = pages.length;
    for (let i = 0; i < total; i++) {
      signal?.throwIfAborted();
      const page = pages[i];
      const chapter = document.createElement('div');
      chapter.className = 'book-chapter';
      const chapterContent = document.createElement('div');
      chapterContent.id = 'markdown-content';
      chapterContent.className = [
        'markdown-viewer-content',
        `table-layout-${tableLayout}`,
        `image-layout-${imageLayout}`,
        `diagram-layout-${diagramLayout}`,
      ].join(' ');
      chapter.appendChild(chapterContent);
      root.appendChild(chapter);

      try {
        const raw = await fetchPage(page.href);
        const processed = preprocessPage(raw, page.href, { depth: page.depth, chapterTitle: page.title });

        const taskManager = new AsyncTaskManager(translate);
        const processor = createMarkdownProcessor(renderer, taskManager, translate, { tableMergeEmpty });
        const footnotes = parseFootnotes(rewriteObsidianLinks(processed));
        const file = await processor.process(footnotes.bodyMarkdown);
        chapterContent.innerHTML = String(file);
        await applyFootnotes(chapterContent, footnotes, processor);
        await taskManager.processAll();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        chapterContent.innerHTML = `<p class="book-chapter-error" style="color:#c0392b">`
          + `${escapeHtml(page.title)} — ${escapeHtml(message)}</p>`;
      }

      onProgress?.('render', i + 1, total);
    }

    await waitForImages(root);
  } catch (error) {
    root.remove();
    throw error;
  }

  return {
    container: root,
    cleanup: () => {
      root.remove();
    },
  };
}

function waitForImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  return Promise.all(
    images.map((img) => {
      if (img.complete) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });
    })
  ).then(() => undefined);
}
