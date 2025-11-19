// Markdown Viewer Extension - Popup Script

// Note: Popup cannot access IndexedDB directly due to security restrictions
// We use BackgroundCacheProxy to communicate with content scripts through background script

import Localization, { DEFAULT_SETTING_LOCALE } from '../../utils/localization.js';

const translate = (key, substitutions) => Localization.translate(key, substitutions);

const getUiLocale = () => {
  const selectedLocale = Localization.getLocale();
  if (selectedLocale && selectedLocale !== DEFAULT_SETTING_LOCALE) {
    return selectedLocale.replace('_', '-');
  }

  if (chrome?.i18n?.getUILanguage) {
    return chrome.i18n.getUILanguage();
  }
  return 'en';
};

const applyI18nText = () => {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach((element) => {
    const { i18n: key, version, i18nArgs } = element.dataset;
    let substitutions;

    if (i18nArgs) {
      substitutions = i18nArgs.split('|');
    } else if (version) {
      substitutions = [version];
    }

    let message = translate(key, substitutions);
    if (message && substitutions) {
      const list = Array.isArray(substitutions) ? substitutions : [substitutions];
      message = message.replace(/\{(\d+)\}/g, (match, index) => {
        const idx = Number.parseInt(index, 10);
        if (Number.isNaN(idx) || idx < 0 || idx >= list.length) {
          return match;
        }
        return list[idx];
      });
    }

    if (message) {
      element.textContent = message;
    }
  });

  const attributeElements = document.querySelectorAll('[data-i18n-attr]');
  attributeElements.forEach((element) => {
    const mapping = element.dataset.i18nAttr;
    if (!mapping) {
      return;
    }

    mapping.split(',').forEach((pair) => {
      const [attrRaw, key] = pair.split(':');
      if (!attrRaw || !key) {
        return;
      }

      const attrName = attrRaw.trim();
      const message = translate(key.trim());
      if (attrName && message) {
        element.setAttribute(attrName, message);
      }
    });
  });
};

// Backup proxy for cache operations via background script
class BackgroundCacheProxy {
  constructor() {
    // Don't hardcode maxItems, get it from actual stats
    this.maxItems = null;
  }

  async getStats() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getCacheStats'
      });

      if (response && response.error) {
        throw new Error(response.error);
      }

      if (!response) {
        return {
          itemCount: 0,
          maxItems: 1000,
          totalSize: 0,
          totalSizeMB: '0.00',
          items: []
        };
      }

      // Update maxItems from actual cache manager stats
      if (response.indexedDBCache && response.indexedDBCache.maxItems) {
        this.maxItems = response.indexedDBCache.maxItems;
      } else if (response.maxItems) {
        this.maxItems = response.maxItems;
      }

      return response;
    } catch (error) {
      console.error('Failed to get cache stats via background:', error);
      return {
        itemCount: 0,
        maxItems: this.maxItems || 1000,
        totalSize: 0,
        totalSizeMB: '0.00',
        items: [],
        message: translate('cache_error_message')
      };
    }
  }

  async clear() {
    try {
      return await chrome.runtime.sendMessage({
        action: 'clearCache'
      });
    } catch (error) {
      console.error('Failed to clear cache via background:', error);
      throw error;
    }
  }
}

class PopupManager {
  constructor() {
    this.cacheManager = null;
    this.currentTab = 'history';
    this.themes = [];
    this.currentTheme = 'default';
    this.settings = {
      maxCacheItems: 1000,
      preferredLocale: DEFAULT_SETTING_LOCALE
    };

    this.init();
  }

  async init() {
    await this.loadSettings();
    this.setupEventListeners();
    this.initCacheManager();
    this.checkFileAccess();

    if (this.currentTab === 'cache') {
      this.loadCacheData();
    } else if (this.currentTab === 'history') {
      this.loadHistoryData();
    }
  }

  async initCacheManager() {
    this.cacheManager = new BackgroundCacheProxy();

    try {
      await this.loadCacheData();
    } catch (error) {
      console.error('Failed to load cache data:', error);
      this.showError(translate('cache_system_unavailable'));
      this.showManualCacheInfo();
    }
  }

  resetCacheView() {
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
      itemsEl.dataset.empty = 'false';
      itemsEl.querySelectorAll('[data-cache-item="dynamic"]').forEach((element) => {
        element.remove();
      });
    }

    this.updateCacheMessage('', '');
  }

  updateCacheMessage(primaryText, detailText) {
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

  setupEventListeners() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', (event) => {
        const tabName = event.currentTarget.dataset.tab;
        this.switchTab(tabName);
      });
    });

    const refreshBtn = document.getElementById('refresh-cache');
    const clearBtn = document.getElementById('clear-cache');
    const saveBtn = document.getElementById('save-settings');
    const resetBtn = document.getElementById('reset-settings');
    const refreshHistoryBtn = document.getElementById('refresh-history');
    const clearHistoryBtn = document.getElementById('clear-history');

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.loadCacheData();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearCache();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        this.saveSettings();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.resetSettings();
      });
    }

    if (refreshHistoryBtn) {
      refreshHistoryBtn.addEventListener('click', () => {
        this.loadHistoryData();
      });
    }

    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => {
        this.clearHistory();
      });
    }
  }

  switchTab(tabName) {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.remove('active');
    });

    const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
    if (activeTab) {
      activeTab.classList.add('active');
    }

    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.remove('active');
    });

    const activePanel = document.getElementById(tabName);
    if (activePanel) {
      activePanel.classList.add('active');
    }

    this.currentTab = tabName;

    if (tabName === 'cache') {
      this.loadCacheData();
    } else if (tabName === 'settings') {
      this.loadSettingsUI();
    } else if (tabName === 'history') {
      this.loadHistoryData();
    }
  }

  async loadCacheData() {
    this.resetCacheView();

    try {
      if (!this.cacheManager) {
        await this.initCacheManager();
      }

      if (!this.cacheManager) {
        throw new Error(translate('cache_manager_init_failed'));
      }

      const stats = await this.cacheManager.getStats();

      this.renderCacheStats(stats);

      let items = [];
      if (stats.indexedDBCache?.items) {
        items = stats.indexedDBCache.items;
      } else if (stats.items) {
        items = stats.items;
      }

      this.renderCacheItems(items);
    } catch (error) {
      console.error('Failed to load cache data:', error);
      const fallbackMessage = translate('cache_loading_failed', [error.message || '']);
      this.updateCacheMessage(fallbackMessage, '');
    }
  }

  renderCacheStats(stats) {
    if (!stats) {
      return;
    }

    let itemCount = 0;
    let totalSizeMB = '0.00';
    let maxItems = 1000;

    if (stats.indexedDBCache) {
      itemCount = stats.indexedDBCache.itemCount || 0;
      totalSizeMB = stats.indexedDBCache.totalSizeMB || '0.00';
      maxItems = stats.indexedDBCache.maxItems || 1000;
    } else {
      itemCount = stats.itemCount || 0;
      totalSizeMB = stats.totalSizeMB || '0.00';
      maxItems = stats.maxItems || 1000;
    }

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
        this.updateCacheMessage(`Hint: ${stats.message}`, hintDetails);
      } else {
        this.updateCacheMessage('', '');
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

    this.updateCacheMessage('', '');
  }

  renderCacheItems(items) {
    const itemsEl = document.getElementById('cache-items');
    const template = document.getElementById('cache-item-template');

    if (!itemsEl || !template) {
      return;
    }

    let allItems = [];

    if (Array.isArray(items)) {
      allItems = items;
    } else if (items && typeof items === 'object') {
      if (Array.isArray(items.indexedDBCache?.items)) {
        allItems = items.indexedDBCache.items;
      }
    }

    itemsEl.querySelectorAll('[data-cache-item="dynamic"]').forEach((element) => {
      element.remove();
    });

    if (allItems.length === 0) {
      itemsEl.dataset.empty = 'true';
      return;
    }

    itemsEl.dataset.empty = 'false';

    const typeLabel = translate('cache_item_type_label');
    const sizeLabel = translate('cache_item_size_label');
    const createdLabel = translate('cache_item_created_label');
    const accessedLabel = translate('cache_item_accessed_label');
    const unknownType = translate('cache_item_type_unknown');
    const locale = getUiLocale();

    const fragment = document.createDocumentFragment();

    allItems.forEach((item) => {
      const cacheItemEl = template.content.firstElementChild.cloneNode(true);
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

  showConfirm(title, message) {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const titleEl = document.getElementById('modal-title');
      const messageEl = document.getElementById('modal-message');
      const confirmBtn = document.getElementById('modal-confirm');
      const cancelBtn = document.getElementById('modal-cancel');

      if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn) {
        // Fallback to native confirm if modal elements are missing
        resolve(confirm(message));
        return;
      }

      titleEl.textContent = title;
      messageEl.textContent = message;
      modal.style.display = 'flex';

      const cleanup = () => {
        modal.style.display = 'none';
        confirmBtn.replaceWith(confirmBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      };

      confirmBtn.onclick = () => {
        cleanup();
        resolve(true);
      };

      cancelBtn.onclick = () => {
        cleanup();
        resolve(false);
      };
      
      // Close on click outside
      modal.onclick = (e) => {
        if (e.target === modal) {
          cleanup();
          resolve(false);
        }
      };
    });
  }

  async clearCache() {
    const confirmMessage = translate('cache_clear_confirm');
    const confirmed = await this.showConfirm(translate('cache_clear'), confirmMessage);
    
    if (!confirmed) {
      return;
    }

    try {
      if (!this.cacheManager) {
        await this.initCacheManager();
      }

      await this.cacheManager.clear();
      this.loadCacheData();
      this.showMessage(translate('cache_clear_success'), 'success');
    } catch (error) {
      console.error('Failed to clear cache:', error);
      this.showMessage(translate('cache_clear_failed'), 'error');
    }
  }

  async loadHistoryData() {
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
      
      this.renderHistoryItems(history);

    } catch (error) {
      console.error('Failed to load history data:', error);
      this.showMessage(translate('history_loading_failed'), 'error');
    }
  }

  extractFileName(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const fileName = pathname.split('/').pop();
      return decodeURIComponent(fileName);
    } catch (error) {
      return url;
    }
  }

  renderHistoryItems(items) {
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
          this.showMessage(translate('history_open_failed'), 'error');
        }
      });

      fragment.appendChild(historyItemEl);
    });

    itemsEl.appendChild(fragment);
  }

  async clearHistory() {
    const confirmMessage = translate('history_clear_confirm');
    const confirmed = await this.showConfirm(translate('history_clear'), confirmMessage);
    
    if (!confirmed) {
      return;
    }

    try {
      await chrome.storage.local.set({ markdownHistory: [] });
      this.loadHistoryData();
      this.showMessage(translate('history_clear_success'), 'success');
    } catch (error) {
      console.error('Failed to clear history:', error);
      this.showMessage(translate('history_clear_failed'), 'error');
    }
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.local.get(['markdownViewerSettings']);
      if (result.markdownViewerSettings) {
        this.settings = { ...this.settings, ...result.markdownViewerSettings };
      }
      
      // Load selected theme
      const themeResult = await chrome.storage.sync.get(['selectedTheme']);
      this.currentTheme = themeResult.selectedTheme || 'default';
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  loadSettingsUI() {
    const maxCacheItemsEl = document.getElementById('max-cache-items');
    if (maxCacheItemsEl) {
      maxCacheItemsEl.value = this.settings.maxCacheItems;
    }

    const localeSelect = document.getElementById('interface-language');
    if (localeSelect) {
      localeSelect.value = this.settings.preferredLocale || DEFAULT_SETTING_LOCALE;
      
      // Add change listener for immediate language change (only once)
      if (!localeSelect.dataset.listenerAdded) {
        localeSelect.dataset.listenerAdded = 'true';
        localeSelect.addEventListener('change', async (event) => {
          const newLocale = event.target.value;
          try {
            this.settings.preferredLocale = newLocale;
            await chrome.storage.local.set({
              markdownViewerSettings: this.settings
            });
            
            await Localization.setPreferredLocale(newLocale);
            chrome.runtime.sendMessage({ type: 'localeChanged', locale: newLocale }).catch(() => { });
            applyI18nText();
            
            // Reload themes to update names
            this.loadThemes();
            
            this.showMessage(translate('settings_language_changed'), 'success');
          } catch (error) {
            console.error('Failed to change language:', error);
            this.showMessage(translate('settings_save_failed'), 'error');
          }
        });
      }
    }
    
    // Load themes
    this.loadThemes();
  }
  
  async loadThemes() {
    try {
      // Load theme registry
      const registryResponse = await fetch(chrome.runtime.getURL('themes/registry.json'));
      const registry = await registryResponse.json();
      
      // Load all theme metadata
      const themePromises = registry.themes.map(async (themeInfo) => {
        try {
          const response = await fetch(chrome.runtime.getURL(`themes/presets/${themeInfo.file}`));
          const theme = await response.json();
          
          return {
            id: theme.id,
            name: theme.name,
            name_en: theme.name_en,
            description: theme.description,
            description_en: theme.description_en,
            category: themeInfo.category,
            featured: themeInfo.featured || false
          };
        } catch (error) {
          console.error(`Failed to load theme ${themeInfo.id}:`, error);
          return null;
        }
      });
      
      this.themes = (await Promise.all(themePromises)).filter(t => t !== null);
      this.registry = registry;
      
      // Populate theme selector with categories
      const themeSelector = document.getElementById('theme-selector');
      if (themeSelector) {
        themeSelector.innerHTML = '';
        
        // Get current locale to determine which name to use
        const locale = getUiLocale();
        const useEnglish = !locale.startsWith('zh');
        
        // Group themes by category
        const themesByCategory = {};
        this.themes.forEach(theme => {
          if (!themesByCategory[theme.category]) {
            themesByCategory[theme.category] = [];
          }
          themesByCategory[theme.category].push(theme);
        });
        
        // Add themes grouped by category
        Object.keys(themesByCategory).forEach(categoryId => {
          const categoryInfo = registry.categories[categoryId];
          if (!categoryInfo) return;
          
          const categoryThemes = themesByCategory[categoryId];
          if (categoryThemes.length === 0) return;
          
          const categoryGroup = document.createElement('optgroup');
          categoryGroup.label = useEnglish ? categoryInfo.name_en : categoryInfo.name;
          
          categoryThemes.forEach(theme => {
            const option = document.createElement('option');
            option.value = theme.id;
            option.textContent = useEnglish ? theme.name_en : theme.name;
            
            if (theme.id === this.currentTheme) {
              option.selected = true;
            }
            
            categoryGroup.appendChild(option);
          });
          
          themeSelector.appendChild(categoryGroup);
        });
        
        // Update description
        this.updateThemeDescription(this.currentTheme);
        
        // Add change listener
        themeSelector.addEventListener('change', (event) => {
          this.switchTheme(event.target.value);
        });
      }
    } catch (error) {
      console.error('Failed to load themes:', error);
    }
  }
  
  updateThemeDescription(themeId) {
    const theme = this.themes.find(t => t.id === themeId);
    const descEl = document.getElementById('theme-description');
    
    if (descEl && theme) {
      const locale = getUiLocale();
      const useEnglish = !locale.startsWith('zh');
      descEl.textContent = useEnglish ? theme.description_en : theme.description;
    }
  }
  
  async switchTheme(themeId) {
    try {
      // Save theme selection
      await chrome.storage.sync.set({ selectedTheme: themeId });
      this.currentTheme = themeId;
      
      // Update description
      this.updateThemeDescription(themeId);
      
      // Notify all tabs to reload theme
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'themeChanged',
          themeId: themeId
        }).catch(() => {
          // Ignore errors for non-markdown tabs
        });
      });
      
      this.showMessage(translate('settings_theme_changed'), 'success');
    } catch (error) {
      console.error('Failed to switch theme:', error);
      this.showMessage('Failed to switch theme', 'error');
    }
  }

  async saveSettings() {
    try {
      const maxCacheItemsEl = document.getElementById('max-cache-items');
      const maxCacheItems = parseInt(maxCacheItemsEl.value, 10);

      if (Number.isNaN(maxCacheItems) || maxCacheItems < 100 || maxCacheItems > 5000) {
        this.showMessage(
          translate('settings_invalid_max_cache', ['100', '5000']),
          'error'
        );
        return;
      }

      this.settings.maxCacheItems = maxCacheItems;

      await chrome.storage.local.set({
        markdownViewerSettings: this.settings
      });

      if (this.currentTab === 'cache') {
        this.loadCacheData();
      }

      // No need to update cacheManager.maxItems here
      // Background script will update it via storage.onChanged listener

      this.showMessage(translate('settings_save_success'), 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showMessage(translate('settings_save_failed'), 'error');
    }
  }

  async resetSettings() {
    const confirmMessage = translate('settings_reset_confirm');
    const confirmed = await this.showConfirm(translate('settings_reset_btn'), confirmMessage);
    
    if (!confirmed) {
      return;
    }

    try {
      this.settings = {
        maxCacheItems: 1000,
        preferredLocale: DEFAULT_SETTING_LOCALE
      };

      await chrome.storage.local.set({
        markdownViewerSettings: this.settings
      });

      await Localization.setPreferredLocale(DEFAULT_SETTING_LOCALE);
      chrome.runtime.sendMessage({ type: 'localeChanged', locale: DEFAULT_SETTING_LOCALE }).catch(() => { });
      applyI18nText();

      if (this.currentTab === 'cache') {
        this.loadCacheData();
      }

      this.loadSettingsUI();
      this.showMessage(translate('settings_reset_success'), 'success');
    } catch (error) {
      console.error('Failed to reset settings:', error);
      this.showMessage(translate('settings_reset_failed'), 'error');
    }
  }

  showMessage(text, type = 'info') {
    const message = document.createElement('div');
    message.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: ${type === 'success' ? '#27ae60' : type === 'error' ? '#e74c3c' : '#3498db'};
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 12px;
      z-index: 1000;
      opacity: 0;
      transition: opacity 0.3s;
    `;
    message.textContent = text;

    document.body.appendChild(message);

    setTimeout(() => {
      message.style.opacity = '1';
    }, 100);

    setTimeout(() => {
      message.style.opacity = '0';
      setTimeout(() => {
        if (message.parentElement) {
          message.parentElement.removeChild(message);
        }
      }, 300);
    }, 2000);
  }

  showError(text) {
    console.error('Popup Error:', text);
    this.showMessage(`Error: ${text}`);
  }

  async checkFileAccess() {
    try {
      // Check if file:// access is allowed
      const isAllowed = await chrome.extension.isAllowedFileSchemeAccess();
      
      const warningSection = document.getElementById('file-access-warning');
      
      if (!warningSection) {
        return;
      }
      
      // Only show warning when permission is disabled
      if (!isAllowed) {
        // Get extension ID and create clickable link
        const extensionId = chrome.runtime.id;
        const extensionUrl = `chrome://extensions/?id=${extensionId}`;
        
        const descEl = document.getElementById('file-access-warning-desc');
        if (descEl) {
          const baseText = translate('file_access_disabled_desc_short') || 
                          '要查看本地文件，请访问';
          const linkText = translate('file_access_settings_link') || '扩展设置页面';
          const suffixText = translate('file_access_disabled_suffix') || 
                            '并启用「允许访问文件网址」选项';
          
          descEl.innerHTML = `${baseText} <a href="${extensionUrl}" style="color: #d97706; text-decoration: underline; cursor: pointer;">${linkText}</a> ${suffixText}`;
          
          // Add click handler
          const link = descEl.querySelector('a');
          if (link) {
            link.addEventListener('click', (e) => {
              e.preventDefault();
              chrome.tabs.create({ url: extensionUrl });
            });
          }
        }
        
        warningSection.style.display = 'block';
      } else {
        warningSection.style.display = 'none';
      }
    } catch (error) {
      console.error('Failed to check file access:', error);
    }
  }

  showManualCacheInfo() {
    this.resetCacheView();

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
    const manualClearCode = 'window.extensionRenderer?.cacheManager?.clear()';
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

    this.updateCacheMessage(primaryMessage, detailMessage);
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await Localization.init();
    applyI18nText();
    const popupManager = new PopupManager();

    window.popupManager = popupManager;
  } catch (error) {
    console.error('Failed to create PopupManager:', error);
  }
});
