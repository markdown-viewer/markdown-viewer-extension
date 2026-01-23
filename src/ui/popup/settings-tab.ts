/**
 * Settings Tab Manager
 * Manages settings panel functionality including themes and cache settings
 */

import Localization, { DEFAULT_SETTING_LOCALE } from '../../utils/localization';
import { translate, applyI18nText, getUiLocale } from './i18n-helpers';
import { storageGet, storageSet } from './storage-helper';
import type { EmojiStyle } from '../../types/docx.js';

// Helper: Send message compatible with both Chrome and Firefox
function safeSendMessage(message: unknown): void {
  try {
    const result = chrome.runtime.sendMessage(message);
    // Chrome returns Promise, Firefox MV2 returns undefined
    if (result && typeof result.catch === 'function') {
      result.catch(() => { /* ignore */ });
    }
  } catch {
    // Ignore errors
  }
}

// Helper: Send message to tab compatible with both Chrome and Firefox
function safeSendTabMessage(tabId: number, message: unknown): void {
  try {
    const result = chrome.tabs.sendMessage(tabId, message);
    if (result && typeof result.catch === 'function') {
      result.catch(() => { /* ignore */ });
    }
  } catch {
    // Ignore errors for non-markdown tabs
  }
}

// Helper: Query tabs compatible with both Chrome and Firefox
async function safeQueryTabs(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    try {
      // Chrome MV3 may return Promise, MV2/Firefox uses callback
      const maybePromise = chrome.tabs.query(query, (tabs) => {
        resolve(tabs || []);
      }) as unknown;
      // Check if result is a Promise (Chrome MV3)
      if (maybePromise && typeof (maybePromise as Promise<chrome.tabs.Tab[]>).then === 'function') {
        (maybePromise as Promise<chrome.tabs.Tab[]>).then(resolve).catch(() => resolve([]));
      }
    } catch {
      resolve([]);
    }
  });
}

/**
 * Notify all tabs that a setting has changed, triggering re-render
 */
async function notifySettingChanged(key: string, value: unknown): Promise<void> {
  try {
    const tabs = await safeQueryTabs({});
    tabs.forEach(tab => {
      if (tab.id) {
        safeSendTabMessage(tab.id, {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: 'SETTING_CHANGED',
          payload: { key, value },
          timestamp: Date.now(),
          source: 'popup-settings',
        });
      }
    });
  } catch {
    // Ignore errors
  }
}

/**
 * Theme info from registry
 */
interface ThemeRegistryInfo {
  id: string;
  file: string;
  category: string;
  featured?: boolean;
}

/**
 * Theme definition loaded from preset file
 */
interface ThemeDefinition {
  id: string;
  name: string;
  name_en: string;
  description: string;
  description_en: string;
  category: string;
  featured: boolean;
}

/**
 * Theme category info
 */
interface ThemeCategoryInfo {
  name: string;
  name_en: string;
  order?: number;
}

/**
 * Theme registry structure
 */
interface ThemeRegistry {
  categories: Record<string, ThemeCategoryInfo>;
  themes: ThemeRegistryInfo[];
}

/**
 * Locale info from registry
 */
interface LocaleInfo {
  code: string;
  name: string;
}

/**
 * Locale registry structure
 */
interface LocaleRegistry {
  version: string;
  locales: LocaleInfo[];
}

/**
 * Supported file extensions
 */
interface SupportedExtensions {
  mermaid: boolean;
  vega: boolean;
  vegaLite: boolean;
  dot: boolean;
  infographic: boolean;
}

/**
 * Frontmatter display mode
 */
export type FrontmatterDisplay = 'hide' | 'table' | 'raw';

/**
 * User settings structure
 */
interface Settings {
  maxCacheItems: number;
  preferredLocale: string;
  docxHrAsPageBreak: boolean;
  docxEmojiStyle?: EmojiStyle;
  supportedExtensions?: SupportedExtensions;
  frontmatterDisplay?: FrontmatterDisplay;
  tableMergeEmpty?: boolean;
}

/**
 * Settings tab manager options
 */
interface SettingsTabManagerOptions {
  showMessage: (message: string, type: 'success' | 'error' | 'info') => void;
  showConfirm: (title: string, message: string) => Promise<boolean>;
  onReloadCacheData?: () => void;
}

/**
 * Settings tab manager interface
 */
export interface SettingsTabManager {
  loadSettings: () => Promise<void>;
  loadSettingsUI: () => void;
  saveSettings: () => Promise<void>;
  resetSettings: () => Promise<void>;
  getSettings: () => Settings;
  loadThemes: () => Promise<void>;
}

/**
 * Create a settings tab manager
 * @param options - Configuration options
 * @returns Settings tab manager instance
 */
export function createSettingsTabManager({
  showMessage,
  showConfirm,
  onReloadCacheData
}: SettingsTabManagerOptions): SettingsTabManager {
  let settings: Settings = {
    maxCacheItems: 1000,
    preferredLocale: DEFAULT_SETTING_LOCALE,
    docxHrAsPageBreak: true,
    docxEmojiStyle: 'system',
    supportedExtensions: {
      mermaid: true,
      vega: true,
      vegaLite: true,
      dot: true,
      infographic: true,
    },
    frontmatterDisplay: 'hide',
    tableMergeEmpty: true,
  };
  let currentTheme = 'default';
  let themes: ThemeDefinition[] = [];
  let registry: ThemeRegistry | null = null;
  let localeRegistry: LocaleRegistry | null = null;

  /**
   * Load settings from storage
   */
  async function loadSettings(): Promise<void> {
    try {
      const result = await storageGet(['markdownViewerSettings']);
      if (result.markdownViewerSettings) {
        settings = { ...settings, ...result.markdownViewerSettings };
      }

      // Load selected theme
      const themeResult = await storageGet(['selectedTheme']);
      currentTheme = (themeResult.selectedTheme as string) || 'default';
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  /**
   * Load settings into UI elements
   */
  function loadSettingsUI(): void {
    // Max cache items
    const maxCacheItemsEl = document.getElementById('max-cache-items') as HTMLSelectElement | null;
    if (maxCacheItemsEl) {
      maxCacheItemsEl.value = String(settings.maxCacheItems);
      
      // Add change listener for immediate save
      if (!maxCacheItemsEl.dataset.listenerAdded) {
        maxCacheItemsEl.dataset.listenerAdded = 'true';
        maxCacheItemsEl.addEventListener('change', async () => {
          const value = parseInt(maxCacheItemsEl.value, 10);
          if (!Number.isNaN(value)) {
            settings.maxCacheItems = value;
            await saveSettingsToStorage();
          }
        });
      }
    }

    // Locale selector
    const localeSelect = document.getElementById('interface-language') as HTMLSelectElement | null;
    if (localeSelect) {
      void loadLocalesIntoSelect(localeSelect);

      // Add change listener for immediate language change (only once)
      if (!localeSelect.dataset.listenerAdded) {
        localeSelect.dataset.listenerAdded = 'true';
        localeSelect.addEventListener('change', async (event) => {
          const target = event.target as HTMLSelectElement;
          const newLocale = target.value;
          try {
            settings.preferredLocale = newLocale;
            await storageSet({
              markdownViewerSettings: settings
            });

            await Localization.setPreferredLocale(newLocale);
            safeSendMessage({
              id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              type: 'LOCALE_CHANGED',
              payload: { locale: newLocale },
              timestamp: Date.now(),
              source: 'popup-settings',
            });
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

    // DOCX: Treat horizontal rule as page break
    const docxHrPageBreakEl = document.getElementById('docx-hr-page-break') as HTMLInputElement | null;
    if (docxHrPageBreakEl) {
      docxHrPageBreakEl.checked = settings.docxHrAsPageBreak !== false;
      
      // Add change listener for immediate save
      if (!docxHrPageBreakEl.dataset.listenerAdded) {
        docxHrPageBreakEl.dataset.listenerAdded = 'true';
        docxHrPageBreakEl.addEventListener('change', async () => {
          settings.docxHrAsPageBreak = docxHrPageBreakEl.checked;
          await saveSettingsToStorage();
        });
      }
    }

    // DOCX: Emoji style
    const docxEmojiStyleEl = document.getElementById('docx-emoji-style') as HTMLSelectElement | null;
    if (docxEmojiStyleEl) {
        docxEmojiStyleEl.value = settings.docxEmojiStyle || 'system';
      if (!docxEmojiStyleEl.dataset.listenerAdded) {
        docxEmojiStyleEl.dataset.listenerAdded = 'true';
        docxEmojiStyleEl.addEventListener('change', async () => {
          settings.docxEmojiStyle = docxEmojiStyleEl.value as EmojiStyle;
          await saveSettingsToStorage();
        });
      }
    }

    // Frontmatter display mode
    const frontmatterDisplayEl = document.getElementById('frontmatter-display') as HTMLSelectElement | null;
    if (frontmatterDisplayEl) {
      frontmatterDisplayEl.value = settings.frontmatterDisplay || 'hide';
      if (!frontmatterDisplayEl.dataset.listenerAdded) {
        frontmatterDisplayEl.dataset.listenerAdded = 'true';
        frontmatterDisplayEl.addEventListener('change', async () => {
          settings.frontmatterDisplay = frontmatterDisplayEl.value as FrontmatterDisplay;
          await saveSettingsToStorage();
          // Notify all tabs to re-render
          notifySettingChanged('frontmatterDisplay', settings.frontmatterDisplay);
        });
      }
    }

    // Table merge empty cells
    const tableMergeEmptyEl = document.getElementById('table-merge-empty') as HTMLInputElement | null;
    if (tableMergeEmptyEl) {
      tableMergeEmptyEl.checked = settings.tableMergeEmpty ?? true;
      if (!tableMergeEmptyEl.dataset.listenerAdded) {
        tableMergeEmptyEl.dataset.listenerAdded = 'true';
        tableMergeEmptyEl.addEventListener('change', async () => {
          settings.tableMergeEmpty = tableMergeEmptyEl.checked;
          await saveSettingsToStorage();
          // Notify all tabs to re-render
          notifySettingChanged('tableMergeEmpty', settings.tableMergeEmpty);
        });
      }
    }

    // Auto Refresh settings (Chrome only)
    loadAutoRefreshSettingsUI();

    // Load supported file extensions checkboxes
    const ext = settings.supportedExtensions || {
      mermaid: true,
      vega: true,
      vegaLite: true,
      dot: true,
      infographic: true,
    };

    const supportMermaidEl = document.getElementById('support-mermaid') as HTMLInputElement | null;
    if (supportMermaidEl) {
      supportMermaidEl.checked = ext.mermaid;
      addExtensionChangeListener(supportMermaidEl, 'mermaid');
    }

    const supportVegaEl = document.getElementById('support-vega') as HTMLInputElement | null;
    if (supportVegaEl) {
      supportVegaEl.checked = ext.vega;
      addExtensionChangeListener(supportVegaEl, 'vega');
    }

    const supportVegaLiteEl = document.getElementById('support-vega-lite') as HTMLInputElement | null;
    if (supportVegaLiteEl) {
      supportVegaLiteEl.checked = ext.vegaLite;
      addExtensionChangeListener(supportVegaLiteEl, 'vegaLite');
    }

    const supportDotEl = document.getElementById('support-dot') as HTMLInputElement | null;
    if (supportDotEl) {
      supportDotEl.checked = ext.dot;
      addExtensionChangeListener(supportDotEl, 'dot');
    }

    const supportInfographicEl = document.getElementById('support-infographic') as HTMLInputElement | null;
    if (supportInfographicEl) {
      supportInfographicEl.checked = ext.infographic;
      addExtensionChangeListener(supportInfographicEl, 'infographic');
    }
  }

  async function loadLocalesIntoSelect(localeSelect: HTMLSelectElement): Promise<void> {
    try {
      if (!localeRegistry) {
        const url = chrome.runtime.getURL('_locales/registry.json');
        const response = await fetch(url);
        localeRegistry = (await response.json()) as LocaleRegistry;
      }

      // Rebuild options each time to ensure registry order is reflected.
      localeSelect.innerHTML = '';

      const autoOption = document.createElement('option');
      autoOption.value = 'auto';
      autoOption.setAttribute('data-i18n', 'settings_language_auto');
      localeSelect.appendChild(autoOption);

      (localeRegistry.locales || []).forEach((locale) => {
        const option = document.createElement('option');
        option.value = locale.code;
        option.textContent = locale.name;
        localeSelect.appendChild(option);
      });

      // Apply i18n to the auto option.
      applyI18nText();

      // Set selected value AFTER options exist.
      localeSelect.value = settings.preferredLocale || DEFAULT_SETTING_LOCALE;
    } catch (error) {
      console.error('Failed to load locale registry:', error);
      // Fallback: keep whatever is currently in the DOM
      localeSelect.value = settings.preferredLocale || DEFAULT_SETTING_LOCALE;
    }
  }

  /**
   * Add change listener for extension checkbox
   */
  function addExtensionChangeListener(el: HTMLInputElement, key: keyof SupportedExtensions): void {
    if (!el.dataset.listenerAdded) {
      el.dataset.listenerAdded = 'true';
      el.addEventListener('change', async () => {
        if (!settings.supportedExtensions) {
          settings.supportedExtensions = {
            mermaid: true,
            vega: true,
            vegaLite: true,
            dot: true,
            infographic: true,
          };
        }
        settings.supportedExtensions[key] = el.checked;
        await saveSettingsToStorage();
      });
    }
  }

  /**
   * Load and setup Auto Refresh settings UI (Chrome only feature)
   */
  function loadAutoRefreshSettingsUI(): void {
    const enabledEl = document.getElementById('auto-refresh-enabled') as HTMLInputElement | null;
    const intervalEl = document.getElementById('auto-refresh-interval') as HTMLSelectElement | null;

    // If elements don't exist (not Chrome), skip
    if (!enabledEl || !intervalEl) {
      return;
    }

    // Load current settings from background
    chrome.runtime.sendMessage(
      {
        id: `get-auto-refresh-${Date.now()}`,
        type: 'GET_AUTO_REFRESH_SETTINGS',
        payload: {},
      },
      (response) => {
        if (response && response.ok && response.data) {
          const settings = response.data as { enabled: boolean; intervalMs: number };
          enabledEl.checked = settings.enabled;
          intervalEl.value = String(settings.intervalMs);
        }
      }
    );

    // Setup change listeners
    if (!enabledEl.dataset.listenerAdded) {
      enabledEl.dataset.listenerAdded = 'true';
      enabledEl.addEventListener('change', () => {
        updateAutoRefreshSettings();
      });
    }

    if (!intervalEl.dataset.listenerAdded) {
      intervalEl.dataset.listenerAdded = 'true';
      intervalEl.addEventListener('change', () => {
        updateAutoRefreshSettings();
      });
    }

    function updateAutoRefreshSettings(): void {
      const enabled = enabledEl!.checked;
      const intervalMs = parseInt(intervalEl!.value, 10);

      // Save to storage and update tracker
      const newSettings = { enabled, intervalMs };
      
      chrome.storage.local.set({ autoRefreshSettings: newSettings });

      chrome.runtime.sendMessage(
        {
          id: `update-auto-refresh-${Date.now()}`,
          type: 'UPDATE_AUTO_REFRESH_SETTINGS',
          payload: newSettings,
        },
        (response) => {
          if (response && response.ok) {
            showMessage(translate('settings_save_success'), 'success');

            // Broadcast to all markdown tabs
            safeQueryTabs({}).then((tabs) => {
              tabs.forEach((tab) => {
                if (tab.id && tab.url && (tab.url.endsWith('.md') || tab.url.endsWith('.markdown'))) {
                  safeSendTabMessage(tab.id, {
                    type: 'AUTO_REFRESH_SETTINGS_CHANGED',
                    payload: newSettings,
                  });
                }
              });
            });
          }
        }
      );
    }
  }

  /**
   * Save settings to storage (internal helper)
   */
  async function saveSettingsToStorage(): Promise<void> {
    try {
      await storageSet({
        markdownViewerSettings: settings
      });
      showMessage(translate('settings_save_success'), 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      showMessage(translate('settings_save_failed'), 'error');
    }
  }

  /**
   * Load available themes from registry
   */
  async function loadThemes(): Promise<void> {
    try {
      // Load theme registry
      const registryResponse = await fetch(chrome.runtime.getURL('themes/registry.json'));
      registry = await registryResponse.json();

      // Load all theme metadata
      const themePromises = registry!.themes.map(async (themeInfo) => {
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
          } as ThemeDefinition;
        } catch (error) {
          console.error(`Failed to load theme ${themeInfo.id}:`, error);
          return null;
        }
      });

      themes = (await Promise.all(themePromises)).filter((t): t is ThemeDefinition => t !== null);

      // Populate theme selector with categories
      const themeSelector = document.getElementById('theme-selector') as HTMLSelectElement | null;
      if (themeSelector) {
        themeSelector.innerHTML = '';

        // Get current locale to determine which name to use
        const locale = getUiLocale();
        const useEnglish = !locale.startsWith('zh');

        // Group themes by category
        const themesByCategory: Record<string, ThemeDefinition[]> = {};
        themes.forEach(theme => {
          if (!themesByCategory[theme.category]) {
            themesByCategory[theme.category] = [];
          }
          themesByCategory[theme.category].push(theme);
        });

        // Sort categories by their order property
        const sortedCategoryIds = Object.keys(registry!.categories)
          .sort((a, b) => (registry!.categories[a].order || 0) - (registry!.categories[b].order || 0));

        // Add themes grouped by category (in sorted order)
        sortedCategoryIds.forEach(categoryId => {
          const categoryInfo = registry!.categories[categoryId];
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
          const target = event.target as HTMLSelectElement;
          switchTheme(target.value);
        });
      }
    } catch (error) {
      console.error('Failed to load themes:', error);
    }
  }

  /**
   * Update theme description display
   * @param themeId - Theme ID
   */
  function updateThemeDescription(themeId: string): void {
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
   * @param themeId - Theme ID to switch to
   */
  async function switchTheme(themeId: string): Promise<void> {
    try {
      // Save theme selection
      await storageSet({ selectedTheme: themeId });
      currentTheme = themeId;

      // Update description
      updateThemeDescription(themeId);

      // Notify all tabs to reload theme
      notifySettingChanged('themeId', themeId);

      showMessage(translate('settings_theme_changed'), 'success');
    } catch (error) {
      console.error('Failed to switch theme:', error);
      showMessage('Failed to switch theme', 'error');
    }
  }

  /**
   * Save settings to storage
   */
  async function saveSettings(): Promise<void> {
    try {
      const maxCacheItemsEl = document.getElementById('max-cache-items') as HTMLInputElement | null;
      const maxCacheItems = parseInt(maxCacheItemsEl?.value || '1000', 10);

      if (Number.isNaN(maxCacheItems) || maxCacheItems < 100 || maxCacheItems > 5000) {
        showMessage(
          translate('settings_invalid_max_cache', ['100', '5000']),
          'error'
        );
        return;
      }

      settings.maxCacheItems = maxCacheItems;

      const docxHrPageBreakEl = document.getElementById('docx-hr-page-break') as HTMLInputElement | null;
      if (docxHrPageBreakEl) {
        settings.docxHrAsPageBreak = Boolean(docxHrPageBreakEl.checked);
      }

      const docxEmojiStyleEl = document.getElementById('docx-emoji-style') as HTMLSelectElement | null;
      if (docxEmojiStyleEl) {
        settings.docxEmojiStyle = docxEmojiStyleEl.value as EmojiStyle;
      }

      // Load supported file extensions from checkboxes
      const supportMermaidEl = document.getElementById('support-mermaid') as HTMLInputElement | null;
      const supportVegaEl = document.getElementById('support-vega') as HTMLInputElement | null;
      const supportVegaLiteEl = document.getElementById('support-vega-lite') as HTMLInputElement | null;
      const supportDotEl = document.getElementById('support-dot') as HTMLInputElement | null;
      const supportInfographicEl = document.getElementById('support-infographic') as HTMLInputElement | null;

      settings.supportedExtensions = {
        mermaid: supportMermaidEl?.checked ?? true,
        vega: supportVegaEl?.checked ?? true,
        vegaLite: supportVegaLiteEl?.checked ?? true,
        dot: supportDotEl?.checked ?? true,
        infographic: supportInfographicEl?.checked ?? true,
      };

      await storageSet({
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
  async function resetSettings(): Promise<void> {
    const confirmMessage = translate('settings_reset_confirm');
    const confirmed = await showConfirm(translate('settings_reset_btn'), confirmMessage);

    if (!confirmed) {
      return;
    }

    try {
      settings = {
        maxCacheItems: 1000,
        preferredLocale: DEFAULT_SETTING_LOCALE,
        docxHrAsPageBreak: true,
        docxEmojiStyle: 'system',
        supportedExtensions: {
          mermaid: true,
          vega: true,
          vegaLite: true,
          dot: true,
          infographic: true,
        },
        tableMergeEmpty: true,
      };

      await storageSet({
        markdownViewerSettings: settings
      });

      await Localization.setPreferredLocale(DEFAULT_SETTING_LOCALE);
      safeSendMessage({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: 'LOCALE_CHANGED',
        payload: { locale: DEFAULT_SETTING_LOCALE },
        timestamp: Date.now(),
        source: 'popup-settings',
      });
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
   * @returns Current settings
   */
  function getSettings(): Settings {
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
