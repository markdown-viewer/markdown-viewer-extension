/**
 * History tab management for popup
 */

import { translate, getUiLocale } from './i18n-helpers';
import { storageGet, storageSet } from './storage-helper';
import { isFirefoxPopup } from './platform-detect';

/**
 * History item interface
 */
interface HistoryItem {
  url: string;
  title: string;
  lastAccess?: number;
}

/**
 * Simple heuristic to check if text looks like Markdown
 * @param text - Text to check
 * @returns True if text appears to be Markdown
 */
function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 3) return false;
  
  // Common Markdown patterns
  const markdownPatterns = [
    /^#{1,6}\s+/m,           // Headers: # Header
    /\*\*[^*]+\*\*/,         // Bold: **text**
    /\*[^*]+\*/,             // Italic: *text*
    /^[-*+]\s+/m,            // Unordered list: - item
    /^\d+\.\s+/m,           // Ordered list: 1. item
    /\[.+\]\(.+\)/,         // Links: [text](url)
    /!\[.*\]\(.+\)/,        // Images: ![alt](url)
    /^>\s+/m,               // Blockquote: > text
    /`[^`]+`/,              // Inline code: `code`
    /^```/m,                // Code block: ```
    /^\|.+\|/m,             // Tables: | cell |
    /^---+$/m,              // Horizontal rule
    /^\*\*\*+$/m,           // Horizontal rule variant
  ];
  
  // Check if at least one pattern matches
  return markdownPatterns.some(pattern => pattern.test(text));
}

/**
 * History tab manager options
 */
interface HistoryTabManagerOptions {
  showMessage: (text: string, type: 'success' | 'error' | 'info') => void;
  showConfirm: (title: string, message: string) => Promise<boolean>;
}

/**
 * History tab manager interface
 */
export interface HistoryTabManager {
  loadHistoryData: () => Promise<void>;
  clearHistory: () => Promise<void>;
  extractFileName: (url: string) => string;
}

/**
 * Create a history tab manager
 * @param options - Configuration options
 * @returns History tab manager instance
 */
export function createHistoryTabManager({ showMessage, showConfirm }: HistoryTabManagerOptions): HistoryTabManager {
  /**
   * Extract filename from URL
   * @param url - URL to extract filename from
   * @returns Extracted filename
   */
  function extractFileName(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const fileName = pathname.split('/').pop() || '';
      return decodeURIComponent(fileName);
    } catch {
      return url;
    }
  }

  /**
   * Load history data from storage
   */
  async function loadHistoryData(): Promise<void> {
    const itemsEl = document.getElementById('history-items') as HTMLElement | null;
    if (!itemsEl) {
      return;
    }

    // Clear existing items
    itemsEl.querySelectorAll('[data-cache-item="dynamic"]').forEach((element) => {
      element.remove();
    });
    itemsEl.dataset.empty = 'false';

    try {
      // Check clipboard for Markdown content first (Chrome only)
      await checkAndRenderClipboard(itemsEl);

      const result = await storageGet(['markdownHistory']);
      const history = (result.markdownHistory || []) as HistoryItem[];

      renderHistoryItems(history);
    } catch (error) {
      console.error('Failed to load history data:', error);
      showMessage(translate('history_loading_failed'), 'error');
    }
  }

  /**
   * Check clipboard for Markdown content and render clipboard item if found
   * @param itemsEl - The history items container element
   */
  async function checkAndRenderClipboard(itemsEl: HTMLElement): Promise<void> {
    try {
      const clipboardText = await navigator.clipboard.readText();
      
      if (clipboardText && looksLikeMarkdown(clipboardText)) {
        renderClipboardItem(itemsEl, clipboardText);
      }
    } catch (error) {
      // Clipboard read failed (permission denied or empty) - silently ignore
      console.debug('Clipboard read failed:', error);
    }
  }

  /**
   * Render clipboard item at the top of history list
   * @param itemsEl - The history items container element
   * @param clipboardText - The clipboard text content
   */
  function renderClipboardItem(itemsEl: HTMLElement, clipboardText: string): void {
    const template = document.getElementById('clipboard-item-template') as HTMLTemplateElement | null;
    if (!template) {
      return;
    }

    const clipboardItemEl = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
    clipboardItemEl.dataset.cacheItem = 'dynamic';

    const titleEl = clipboardItemEl.querySelector('.clipboard-item-title');
    const previewEl = clipboardItemEl.querySelector('.clipboard-item-preview');

    if (titleEl) {
      titleEl.textContent = translate('clipboard_open') || 'Open from Clipboard';
    }

    if (previewEl) {
      // Show first line or truncated preview
      const firstLine = clipboardText.split('\n')[0].trim();
      const preview = firstLine.length > 60 ? firstLine.substring(0, 60) + '...' : firstLine;
      previewEl.textContent = preview;
    }

    // Add click handler to open clipboard content in preview
    clipboardItemEl.addEventListener('click', async () => {
      try {
        // Re-read clipboard to get latest content
        const currentClipboard = await navigator.clipboard.readText();
        if (!currentClipboard) {
          showMessage(translate('clipboard_empty') || 'Clipboard is empty', 'error');
          return;
        }

        // Open preview page with clipboard content
        openClipboardPreview(currentClipboard);
      } catch (error) {
        console.error('Failed to read clipboard:', error);
        showMessage(translate('clipboard_read_failed') || 'Failed to read clipboard', 'error');
      }
    });

    // Insert at the beginning of the list
    itemsEl.insertBefore(clipboardItemEl, itemsEl.firstChild);
  }

  /**
   * Open a new tab with clipboard content preview
   * @param content - The Markdown content to preview
   */
  function openClipboardPreview(content: string): void {
    // Save content to storage first
    const CLIPBOARD_CONTENT_KEY = 'clipboardPreviewContent';
    // Use browser API for Firefox compatibility (chrome API works in both via polyfill)
    const storage = typeof browser !== 'undefined' ? browser.storage : chrome.storage;
    const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
    const tabs = typeof browser !== 'undefined' ? browser.tabs : chrome.tabs;
    
    storage.local.set({ [CLIPBOARD_CONTENT_KEY]: content }).then(() => {
      // Then open the preview page
      const previewUrl = runtime.getURL('ui/clipboard-preview.html');
      tabs.create({ url: previewUrl });
      window.close();
    });
  }

  /**
   * Render history items list
   * @param items - History items array
   */
  function renderHistoryItems(items: HistoryItem[]): void {
    const itemsEl = document.getElementById('history-items') as HTMLElement | null;
    const template = document.getElementById('history-item-template') as HTMLTemplateElement | null;

    if (!itemsEl || !template) {
      return;
    }

    if (items.length === 0) {
      // Check if there's a clipboard item already rendered
      const hasClipboardItem = itemsEl.querySelector('.clipboard-item') !== null;
      // Only show empty state if there's no clipboard item either
      if (!hasClipboardItem) {
        itemsEl.dataset.empty = 'true';
      }
      return;
    }

    itemsEl.dataset.empty = 'false';

    const accessedLabel = translate('cache_item_accessed_label');
    const locale = getUiLocale();
    const fragment = document.createDocumentFragment();

    items.forEach((item) => {
      const historyItemEl = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
      historyItemEl.dataset.cacheItem = 'dynamic';
      historyItemEl.dataset.url = item.url;

      const urlEl = historyItemEl.querySelector('.history-item-url');
      const titleEl = historyItemEl.querySelector('.history-item-title');
      const accessedEl = historyItemEl.querySelector('.history-item-accessed');

      if (urlEl) {
        urlEl.textContent = item.title;
      }

      if (titleEl) {
        titleEl.textContent = item.url;
      }

      if (accessedEl && item.lastAccess) {
        accessedEl.textContent = `${accessedLabel}: ${new Date(item.lastAccess).toLocaleString(locale)}`;
      }

      // Add click handler to open the document
      historyItemEl.addEventListener('click', async () => {
        try {
          const isFileUrl = item.url.startsWith('file://');
          
          // Firefox cannot open file:// URLs from extension context due to security restrictions
          if (isFirefoxPopup() && isFileUrl) {
            // Copy URL to clipboard and show message
            await navigator.clipboard.writeText(item.url);
            showMessage(translate('file_url_copied') || 'URL copied. Paste in address bar to open.', 'info');
            return;
          }
          
          // For http/https URLs or Chrome, open normally
          window.open(item.url, '_blank');
          window.close();
        } catch (error) {
          console.error('Failed to open document:', error);
          showMessage(translate('history_open_failed'), 'error');
        }
      });

      fragment.appendChild(historyItemEl);
    });

    itemsEl.appendChild(fragment);
  }

  /**
   * Clear all history with confirmation
   */
  async function clearHistory(): Promise<void> {
    const confirmMessage = translate('history_clear_confirm');
    const confirmed = await showConfirm(translate('history_clear'), confirmMessage);

    if (!confirmed) {
      return;
    }

    try {
      await storageSet({ markdownHistory: [] });
      await loadHistoryData();
      showMessage(translate('history_clear_success'), 'success');
    } catch (error) {
      console.error('Failed to clear history:', error);
      showMessage(translate('history_clear_failed'), 'error');
    }
  }

  return {
    loadHistoryData,
    clearHistory,
    extractFileName
  };
}
