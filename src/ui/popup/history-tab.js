// History tab management for popup

import { translate, getUiLocale } from './i18n-helpers.js';

/**
 * Create a history tab manager
 * @param {Object} options - Configuration options
 * @param {Function} options.showMessage - Function to show toast messages
 * @param {Function} options.showConfirm - Function to show confirmation modal
 * @returns {Object} History tab manager instance
 */
export function createHistoryTabManager({ showMessage, showConfirm }) {
  /**
   * Extract filename from URL
   * @param {string} url - URL to extract filename from
   * @returns {string} Extracted filename
   */
  function extractFileName(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const fileName = pathname.split('/').pop();
      return decodeURIComponent(fileName);
    } catch (error) {
      return url;
    }
  }

  /**
   * Load history data from storage
   */
  async function loadHistoryData() {
    const itemsEl = document.getElementById('history-items');
    if (!itemsEl) {
      return;
    }

    // Clear existing items
    itemsEl.querySelectorAll('[data-cache-item="dynamic"]').forEach((element) => {
      element.remove();
    });
    itemsEl.dataset.empty = 'false';

    try {
      const result = await chrome.storage.local.get(['markdownHistory']);
      const history = result.markdownHistory || [];

      renderHistoryItems(history);
    } catch (error) {
      console.error('Failed to load history data:', error);
      showMessage(translate('history_loading_failed'), 'error');
    }
  }

  /**
   * Render history items list
   * @param {Array} items - History items array
   */
  function renderHistoryItems(items) {
    const itemsEl = document.getElementById('history-items');
    const template = document.getElementById('history-item-template');

    if (!itemsEl || !template) {
      return;
    }

    if (items.length === 0) {
      itemsEl.dataset.empty = 'true';
      return;
    }

    itemsEl.dataset.empty = 'false';

    const accessedLabel = translate('cache_item_accessed_label');
    const locale = getUiLocale();
    const fragment = document.createDocumentFragment();

    items.forEach((item) => {
      const historyItemEl = template.content.firstElementChild.cloneNode(true);
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
  async function clearHistory() {
    const confirmMessage = translate('history_clear_confirm');
    const confirmed = await showConfirm(translate('history_clear'), confirmMessage);

    if (!confirmed) {
      return;
    }

    try {
      await chrome.storage.local.set({ markdownHistory: [] });
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
