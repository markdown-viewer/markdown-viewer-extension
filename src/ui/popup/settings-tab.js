// Settings tab management for popup

import Localization, { DEFAULT_SETTING_LOCALE } from '../../utils/localization.js';
import { translate, getUiLocale, applyI18nText } from './i18n-helpers.js';

/**
 * Create a settings tab manager
 * @param {Object} options - Configuration options
 * @param {Function} options.showMessage - Function to show toast messages
 * @param {Function} options.showConfirm - Function to show confirmation modal
 * @param {Function} options.onReloadCacheData - Callback to reload cache data after settings change
 * @returns {Object} Settings tab manager instance
 */
export function createSettingsTabManager({ showMessage, showConfirm, onReloadCacheData }) {
  let settings = {
    maxCacheItems: 1000,
    preferredLocale: DEFAULT_SETTING_LOCALE
  };
  let currentTheme = 'default';
  let themes = [];
  let registry = null;

  /**
   * Load settings from storage
   */
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(['markdownViewerSettings']);
      if (result.markdownViewerSettings) {
        settings = { ...settings, ...result.markdownViewerSettings };
      }

      // Load selected theme
      const themeResult = await chrome.storage.local.get(['selectedTheme']);
      currentTheme = themeResult.selectedTheme || 'default';
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  /**
   * Load settings UI elements
   */
  function loadSettingsUI() {
    const maxCacheItemsEl = document.getElementById('max-cache-items');
    if (maxCacheItemsEl) {
      maxCacheItemsEl.value = settings.maxCacheItems;
    }

    const localeSelect = document.getElementById('interface-language');
    if (localeSelect) {
      localeSelect.value = settings.preferredLocale || DEFAULT_SETTING_LOCALE;

      // Add change listener for immediate language change (only once)
      if (!localeSelect.dataset.listenerAdded) {
        localeSelect.dataset.listenerAdded = 'true';
        localeSelect.addEventListener('change', async (event) => {
          const newLocale = event.target.value;
          try {
            settings.preferredLocale = newLocale;
            await chrome.storage.local.set({
              markdownViewerSettings: settings
            });

            await Localization.setPreferredLocale(newLocale);
            chrome.runtime.sendMessage({ type: 'localeChanged', locale: newLocale }).catch(() => { });
            applyI18nText();

            // Reload themes to update names
            loadThemes();

            showMessage(translate('settings_language_changed'), 'success');
          } catch (error) {
            console.error('Failed to change language:', error);
            showMessage(translate('settings_save_failed'), 'error');
          }
        });
      }
    }

    // Load themes
    loadThemes();
  }

  /**
   * Load themes from registry
   */
  async function loadThemes() {
    try {
      // Load theme registry
      const registryResponse = await fetch(chrome.runtime.getURL('themes/registry.json'));
      registry = await registryResponse.json();

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

      themes = (await Promise.all(themePromises)).filter(t => t !== null);

      // Populate theme selector with categories
      const themeSelector = document.getElementById('theme-selector');
      if (themeSelector) {
        themeSelector.innerHTML = '';

        // Get current locale to determine which name to use
        const locale = getUiLocale();
        const useEnglish = !locale.startsWith('zh');

        // Group themes by category
        const themesByCategory = {};
        themes.forEach(theme => {
          if (!themesByCategory[theme.category]) {
            themesByCategory[theme.category] = [];
          }
          themesByCategory[theme.category].push(theme);
        });

        // Sort categories by their order property
        const sortedCategoryIds = Object.keys(registry.categories)
          .sort((a, b) => (registry.categories[a].order || 0) - (registry.categories[b].order || 0));

        // Add themes grouped by category (in sorted order)
        sortedCategoryIds.forEach(categoryId => {
          const categoryInfo = registry.categories[categoryId];
          if (!categoryInfo) return;

          const categoryThemes = themesByCategory[categoryId];
          if (!categoryThemes || categoryThemes.length === 0) return;

          const categoryGroup = document.createElement('optgroup');
          categoryGroup.label = useEnglish ? categoryInfo.name_en : categoryInfo.name;

          categoryThemes.forEach(theme => {
            const option = document.createElement('option');
            option.value = theme.id;
            option.textContent = useEnglish ? theme.name_en : theme.name;

            if (theme.id === currentTheme) {
              option.selected = true;
            }

            categoryGroup.appendChild(option);
          });

          themeSelector.appendChild(categoryGroup);
        });

        // Update description
        updateThemeDescription(currentTheme);

        // Add change listener
        themeSelector.addEventListener('change', (event) => {
          switchTheme(event.target.value);
        });
      }
    } catch (error) {
      console.error('Failed to load themes:', error);
    }
  }

  /**
   * Update theme description display
   * @param {string} themeId - Theme ID
   */
  function updateThemeDescription(themeId) {
    const theme = themes.find(t => t.id === themeId);
    const descEl = document.getElementById('theme-description');

    if (descEl && theme) {
      const locale = getUiLocale();
      const useEnglish = !locale.startsWith('zh');
      descEl.textContent = useEnglish ? theme.description_en : theme.description;
    }
  }

  /**
   * Switch to a different theme
   * @param {string} themeId - Theme ID to switch to
   */
  async function switchTheme(themeId) {
    try {
      // Save theme selection (use local storage to match theme-manager)
      await chrome.storage.local.set({ selectedTheme: themeId });
      currentTheme = themeId;

      // Update description
      updateThemeDescription(themeId);

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

      showMessage(translate('settings_theme_changed'), 'success');
    } catch (error) {
      console.error('Failed to switch theme:', error);
      showMessage('Failed to switch theme', 'error');
    }
  }

  /**
   * Save settings to storage
   */
  async function saveSettings() {
    try {
      const maxCacheItemsEl = document.getElementById('max-cache-items');
      const maxCacheItems = parseInt(maxCacheItemsEl.value, 10);

      if (Number.isNaN(maxCacheItems) || maxCacheItems < 100 || maxCacheItems > 5000) {
        showMessage(
          translate('settings_invalid_max_cache', ['100', '5000']),
          'error'
        );
        return;
      }

      settings.maxCacheItems = maxCacheItems;

      await chrome.storage.local.set({
        markdownViewerSettings: settings
      });

      if (onReloadCacheData) {
        onReloadCacheData();
      }

      // No need to update cacheManager.maxItems here
      // Background script will update it via storage.onChanged listener

      showMessage(translate('settings_save_success'), 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      showMessage(translate('settings_save_failed'), 'error');
    }
  }

  /**
   * Reset settings to defaults
   */
  async function resetSettings() {
    const confirmMessage = translate('settings_reset_confirm');
    const confirmed = await showConfirm(translate('settings_reset_btn'), confirmMessage);

    if (!confirmed) {
      return;
    }

    try {
      settings = {
        maxCacheItems: 1000,
        preferredLocale: DEFAULT_SETTING_LOCALE
      };

      await chrome.storage.local.set({
        markdownViewerSettings: settings
      });

      await Localization.setPreferredLocale(DEFAULT_SETTING_LOCALE);
      chrome.runtime.sendMessage({ type: 'localeChanged', locale: DEFAULT_SETTING_LOCALE }).catch(() => { });
      applyI18nText();

      if (onReloadCacheData) {
        onReloadCacheData();
      }

      loadSettingsUI();
      showMessage(translate('settings_reset_success'), 'success');
    } catch (error) {
      console.error('Failed to reset settings:', error);
      showMessage(translate('settings_reset_failed'), 'error');
    }
  }

  /**
   * Get current settings
   * @returns {Object} Current settings
   */
  function getSettings() {
    return { ...settings };
  }

  return {
    loadSettings,
    loadSettingsUI,
    saveSettings,
    resetSettings,
    getSettings,
    loadThemes
  };
}
