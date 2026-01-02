/**
 * Cache tab management for popup
 */

import { translate, getUiLocale } from './i18n-helpers';
import { BackgroundCacheProxy } from './cache-proxy';
import type { SimpleCacheStats } from '../../types/cache';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Cache item interface
 */
interface CacheItem {
  key: string;
  type?: string;
  size?: number;
  sizeMB?: string;
  created?: number;
  lastAccess?: number;
}

// Popup cache stats are defined in shared types

/**
 * Cache tab manager options
 */
interface CacheTabManagerOptions {
  showMessage: (text: string, type: 'success' | 'error' | 'info') => void;
  showConfirm: (title: string, message: string) => Promise<boolean>;
}

/**
 * Cache tab manager interface
 */
export interface CacheTabManager {
  initCacheManager: () => Promise<void>;
  loadCacheData: () => Promise<void>;
  clearCache: () => Promise<void>;
  resetCacheView: () => void;
  showManualCacheInfo: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a cache tab manager
 * @param options - Configuration options
 * @returns Cache tab manager instance
 */
export function createCacheTabManager({ showMessage, showConfirm }: CacheTabManagerOptions): CacheTabManager {
  let cacheManager: BackgroundCacheProxy | null = null;

  /**
   * Initialize the cache manager (lazy - does not load data)
   */
  async function initCacheManager(): Promise<void> {
    if (!cacheManager) {
      cacheManager = new BackgroundCacheProxy();
    }
  }

  /**
   * Reset cache view to initial state
   */
  function resetCacheView(): void {
    const statsPlaceholders = [
      document.getElementById('cache-stat-item-count'),
      document.getElementById('cache-stat-size'),
      document.getElementById('cache-stat-usage'),
      document.getElementById('cache-stat-capacity')
    ];

    statsPlaceholders.forEach((el) => {
      if (el) {
        el.textContent = '--';
      }
    });

    const itemsEl = document.getElementById('cache-items');
    if (itemsEl) {
      (itemsEl as HTMLElement).dataset.empty = 'false';
      itemsEl.querySelectorAll('[data-cache-item="dynamic"]').forEach((element) => {
        element.remove();
      });
    }

    updateCacheMessage('', '');
  }

  /**
   * Update cache message display
   * @param primaryText - Primary message text
   * @param detailText - Detail message text
   */
  function updateCacheMessage(primaryText: string, detailText: string): void {
    const primaryEl = document.getElementById('cache-message-text');
    const detailEl = document.getElementById('cache-message-details');
    const container = document.getElementById('cache-message');

    if (primaryEl) {
      primaryEl.textContent = primaryText || '';
    }

    if (detailEl) {
      detailEl.textContent = detailText || '';
    }

    if (container) {
      const hasContent = Boolean(primaryText?.trim() || detailText?.trim());
      container.hidden = !hasContent;
    }
  }

  /**
   * Load cache data and render
   */
  async function loadCacheData(): Promise<void> {
    resetCacheView();

    try {
      // Lazy init
      if (!cacheManager) {
        cacheManager = new BackgroundCacheProxy();
      }

      const stats = await cacheManager.getStats();

      renderCacheStats(stats);

      const items: CacheItem[] = (stats.items as CacheItem[]) || [];

      renderCacheItems(items);
    } catch (error) {
      console.error('Failed to load cache data:', error);
      const fallbackMessage = translate('cache_loading_failed', [(error as Error).message || '']);
      updateCacheMessage(fallbackMessage, '');
    }
  }

  /**
   * Render cache statistics
   * @param stats - Cache statistics object
   */
  function renderCacheStats(stats: SimpleCacheStats): void {
    if (!stats) {
      return;
    }

    let itemCount = 0;
    let totalSizeMB = '0.00';
    let maxItems = 1000;

    itemCount = stats.itemCount || 0;
    totalSizeMB = stats.totalSizeMB || '0.00';
    maxItems = stats.maxItems || 1000;

    const itemCountEl = document.getElementById('cache-stat-item-count');
    const sizeEl = document.getElementById('cache-stat-size');
    const usageEl = document.getElementById('cache-stat-usage');
    const capacityEl = document.getElementById('cache-stat-capacity');

    if (itemCount === 0) {
      const hintDetails = translate('cache_hint_details');
      if (itemCountEl) {
        itemCountEl.textContent = '0';
      }
      if (sizeEl) {
        sizeEl.textContent = '0.00MB';
      }
      if (usageEl) {
        usageEl.textContent = '0%';
      }
      if (capacityEl) {
        capacityEl.textContent = `${maxItems}`;
      }
      if (stats.message) {
        updateCacheMessage(`Hint: ${stats.message}`, hintDetails);
      } else {
        updateCacheMessage('', '');
      }
      return;
    }

    const usagePercent = Math.round((itemCount / maxItems) * 100);

    if (itemCountEl) {
      itemCountEl.textContent = `${itemCount}`;
    }
    if (sizeEl) {
      sizeEl.textContent = `${totalSizeMB}MB`;
    }
    if (usageEl) {
      usageEl.textContent = `${usagePercent}%`;

      // Visual feedback for high usage
      if (usagePercent >= 90) {
        usageEl.style.color = 'var(--color-danger)';
      } else if (usagePercent >= 70) {
        usageEl.style.color = 'var(--color-warning)';
      } else {
        usageEl.style.color = 'var(--color-text-primary)';
      }
    }
    if (capacityEl) {
      capacityEl.textContent = `${maxItems}`;
    }

    updateCacheMessage('', '');
  }

  /**
   * Render cache items list
   * @param items - Cache items array
   */
  function renderCacheItems(items: CacheItem[] | SimpleCacheStats): void {
    const itemsEl = document.getElementById('cache-items');
    const template = document.getElementById('cache-item-template') as HTMLTemplateElement | null;

    if (!itemsEl || !template) {
      return;
    }

    let allItems: CacheItem[] = [];

    if (Array.isArray(items)) {
      allItems = items;
    } else if (items && typeof items === 'object') {
      if (Array.isArray(items.items)) {
        allItems = items.items as CacheItem[];
      }
    }

    itemsEl.querySelectorAll('[data-cache-item="dynamic"]').forEach((element) => {
      element.remove();
    });

    if (allItems.length === 0) {
      (itemsEl as HTMLElement).dataset.empty = 'true';
      return;
    }

    (itemsEl as HTMLElement).dataset.empty = 'false';

    const typeLabel = translate('cache_item_type_label');
    const sizeLabel = translate('cache_item_size_label');
    const createdLabel = translate('cache_item_created_label');
    const accessedLabel = translate('cache_item_accessed_label');
    const unknownType = translate('cache_item_type_unknown');
    const locale = getUiLocale();

    const fragment = document.createDocumentFragment();

    allItems.forEach((item) => {
      const cacheItemEl = (template.content.firstElementChild as HTMLElement).cloneNode(true) as HTMLElement;
      cacheItemEl.dataset.cacheItem = 'dynamic';

      const keyEl = cacheItemEl.querySelector('.cache-item-key');
      const typeEl = cacheItemEl.querySelector('.cache-item-type');
      const sizeEl = cacheItemEl.querySelector('.cache-item-size');
      const createdEl = cacheItemEl.querySelector('.cache-item-created');
      const accessedEl = cacheItemEl.querySelector('.cache-item-accessed');

      if (keyEl) {
        keyEl.textContent = item.key;
      }

      if (typeEl) {
        typeEl.textContent = `${typeLabel}: ${item.type || unknownType}`;
      }

      const sizeMB = item.sizeMB || (item.size ? (item.size / (1024 * 1024)).toFixed(3) : '0.000');
      if (sizeEl) {
        sizeEl.textContent = `${sizeLabel}: ${sizeMB}MB`;
      }

      if (createdEl) {
        createdEl.textContent = item.created
          ? `${createdLabel}: ${new Date(item.created).toLocaleString(locale)}`
          : '';
      }

      if (accessedEl) {
        accessedEl.textContent = item.lastAccess
          ? `${accessedLabel}: ${new Date(item.lastAccess).toLocaleString(locale)}`
          : '';
      }

      fragment.appendChild(cacheItemEl);
    });

    itemsEl.appendChild(fragment);
  }

  /**
   * Clear all cache with confirmation
   */
  async function clearCache(): Promise<void> {
    const confirmMessage = translate('cache_clear_confirm');
    const confirmed = await showConfirm(translate('cache_clear'), confirmMessage);

    if (!confirmed) {
      return;
    }

    try {
      if (!cacheManager) {
        await initCacheManager();
      }

      await cacheManager!.clear();
      await loadCacheData();
      showMessage(translate('cache_clear_success'), 'success');
    } catch (error) {
      console.error('Failed to clear cache:', error);
      showMessage(translate('cache_clear_failed'), 'error');
    }
  }

  /**
   * Show manual cache management info
   */
  function showManualCacheInfo(): void {
    resetCacheView();

    const manualLimitTitle = translate('cache_manual_limit_title');
    const manualLimitDesc1 = translate('cache_manual_limit_desc_1');
    const manualLimitDesc2 = translate('cache_manual_limit_desc_2');
    const manualStatusTitle = translate('cache_manual_status_title');
    const manualStatusIntro = translate('cache_manual_status_intro');
    const manualStatusStepOpen = translate('cache_manual_status_step_open');
    const manualStatusStepSpeed = translate('cache_manual_status_step_speed');
    const manualStatusStepConsole = translate('cache_manual_status_step_console');
    const manualClearTitle = translate('cache_manual_clear_title');
    const manualClearIntro = translate('cache_manual_clear_intro');
    const manualClearCode = 'globalThis.platform?.cache?.clear()';
    const manualClearStep1 = translate('cache_manual_clear_step_1');
    const manualClearStep2 = translate('cache_manual_clear_step_2');
    const manualClearStep3Raw = translate('cache_manual_clear_step_3', [manualClearCode]);

    const primaryMessage = `${manualLimitTitle}
${manualLimitDesc1}
${manualLimitDesc2}`;
    const detailMessage = `${manualStatusTitle}
${manualStatusIntro}
- ${manualStatusStepOpen}
- ${manualStatusStepSpeed}
- ${manualStatusStepConsole}

${manualClearTitle}
${manualClearIntro}
1. ${manualClearStep1}
2. ${manualClearStep2}
3. ${manualClearStep3Raw}`;

    updateCacheMessage(primaryMessage, detailMessage);
  }

  return {
    initCacheManager,
    loadCacheData,
    clearCache,
    resetCacheView,
    showManualCacheInfo
  };
}
