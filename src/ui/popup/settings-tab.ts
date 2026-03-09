/**
 * Settings Tab Manager
 * Manages settings panel functionality including themes and cache settings
 */

import Localization, { DEFAULT_SETTING_LOCALE } from '../../utils/localization';
import type { LocaleInfo, LocaleRegistry } from '../../utils/localization';
import { translate, applyI18nText, getUiLocale } from './i18n-helpers';
import { storageGet, storageSet } from './storage-helper';
import type { EmojiStyle } from '../../types/docx.js';
import {
  SUPPORTED_FORMATS,
  getDefaultSupportedExtensions,
  type SupportedExtensions,
} from '../../types/formats';

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
 * Frontmatter display mode
 */
export type FrontmatterDisplay = 'hide' | 'table' | 'raw';

/**
 * Table layout mode
 */
export type TableLayout = 'left' | 'center';

/**
 * User settings structure
 */
interface Settings {
  maxCacheItems: number;
  preferredLocale: string;
  docxHrDisplay: 'pageBreak' | 'line' | 'hide';
  docxEmojiStyle?: EmojiStyle;
  supportedExtensions?: SupportedExtensions;
  frontmatterDisplay?: FrontmatterDisplay;
  tableMergeEmpty?: boolean;
  tableLayout?: TableLayout;
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
  setupLanguageSelector: () => Promise<void>;
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
    docxHrDisplay: 'hide',
    docxEmojiStyle: 'system',
    supportedExtensions: getDefaultSupportedExtensions(),
    frontmatterDisplay: 'hide',
    tableMergeEmpty: true,
    tableLayout: 'center',
  };
  let currentTheme = 'default';
  let themes: ThemeDefinition[] = [];
  let registry: ThemeRegistry | null = null;
  let localeRegistry: LocaleRegistry | null = null;

  /**
   * Ensure locale registry is available (from Localization cache).
   */
  function ensureLocaleRegistry(): LocaleRegistry | null {
    if (!localeRegistry) {
      localeRegistry = Localization.getLocaleRegistry();
    }
    return localeRegistry;
  }

  /**
   * Load settings from storage
   */
  async function loadSettings(): Promise<void> {
    try {
      const result = await storageGet(['markdownViewerSettings']);
      if (result.markdownViewerSettings) {
        settings = { ...settings, ...result.markdownViewerSettings };
      }

      if (!settings.docxHrDisplay) {
        settings.docxHrDisplay = 'hide';
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

    // Language selector button (new compact design)
    setupLanguageSelector();

    // Load themes
    loadThemes();

    // DOCX: Horizontal rule display
    const docxHrDisplayEl = document.getElementById('docx-hr-display') as HTMLSelectElement | null;
    if (docxHrDisplayEl) {
      docxHrDisplayEl.value = settings.docxHrDisplay || 'hide';

      // Add change listener for immediate save
      if (!docxHrDisplayEl.dataset.listenerAdded) {
        docxHrDisplayEl.dataset.listenerAdded = 'true';
        docxHrDisplayEl.addEventListener('change', async () => {
          settings.docxHrDisplay = docxHrDisplayEl.value as Settings['docxHrDisplay'];
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

    // Table layout
    const tableLayoutEl = document.getElementById('table-layout') as HTMLSelectElement | null;
    if (tableLayoutEl) {
      tableLayoutEl.value = settings.tableLayout || 'center';
      if (!tableLayoutEl.dataset.listenerAdded) {
        tableLayoutEl.dataset.listenerAdded = 'true';
        tableLayoutEl.addEventListener('change', async () => {
          settings.tableLayout = tableLayoutEl.value as TableLayout;
          await saveSettingsToStorage();
          // Notify all tabs to re-render
          notifySettingChanged('tableLayout', settings.tableLayout);
        });
      }
    }

    // Auto Refresh settings (Chrome only)
    loadAutoRefreshSettingsUI();

    // Load supported file extensions checkboxes
    const ext = settings.supportedExtensions || getDefaultSupportedExtensions();

    for (const format of SUPPORTED_FORMATS) {
      const el = document.getElementById(`support-${format.fileType}`) as HTMLInputElement | null;
      if (el) {
        el.checked = ext[format.fileType] ?? true;
        addExtensionChangeListener(el, format.fileType);
      }
    }
  }

  async function loadLocalesIntoSelect(localeSelect: HTMLSelectElement): Promise<void> {
    try {
      const reg = ensureLocaleRegistry();
      if (!reg) {
        console.error('Locale registry not available');
        localeSelect.value = settings.preferredLocale || DEFAULT_SETTING_LOCALE;
        return;
      }

      // Rebuild options each time to ensure registry order is reflected.
      localeSelect.innerHTML = '';

      const autoOption = document.createElement('option');
      autoOption.value = 'auto';
      autoOption.setAttribute('data-i18n', 'settings_language_auto');
      localeSelect.appendChild(autoOption);

      (reg.locales || []).forEach((locale) => {
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
   * Get display code for a locale (e.g., "zh_CN" -> "zh", "pt_BR" -> "pt")
   */
  function getLocaleDisplayCode(localeCode: string): string {
    if (localeCode === 'auto') {
      // Use Chrome's UI language (same as what the extension actually uses)
      const chromeLocale = chrome.i18n.getUILanguage().replace('-', '_');
      // Find matching locale in registry
      const match = localeRegistry?.locales.find(l => 
        l.code === chromeLocale || 
        l.code.startsWith(chromeLocale.split('_')[0])
      );
      return match ? match.code.split('_')[0] : 'en';
    }
    return localeCode.split('_')[0];
  }

  /**
   * Setup the compact language selector button and dropdown
   */
  async function setupLanguageSelector(): Promise<void> {
    const langBtn = document.getElementById('language-selector') as HTMLButtonElement | null;
    const dropdown = document.getElementById('language-dropdown') as HTMLElement | null;
    const dropdownContent = document.getElementById('language-dropdown-content') as HTMLElement | null;

    if (!langBtn || !dropdown || !dropdownContent) {
      return;
    }

    // Load locale registry if not already loaded
    const reg = ensureLocaleRegistry();
    if (!reg) {
      return;
    }

    // Update button text with current locale code
    const currentLocale = settings.preferredLocale || DEFAULT_SETTING_LOCALE;
    langBtn.textContent = getLocaleDisplayCode(currentLocale);

    // Populate dropdown options
    dropdownContent.innerHTML = '';

    // Add "Auto" option
    const autoOption = document.createElement('div');
    autoOption.className = 'language-option' + (currentLocale === 'auto' ? ' active' : '');
    autoOption.dataset.locale = 'auto';
    autoOption.innerHTML = `
      <span class="language-option-code">auto</span>
      <span data-i18n="settings_language_auto">Auto</span>
    `;
    dropdownContent.appendChild(autoOption);

    // Add language options
    (reg.locales || []).forEach((locale) => {
      const option = document.createElement('div');
      option.className = 'language-option' + (currentLocale === locale.code ? ' active' : '');
      option.dataset.locale = locale.code;
      option.innerHTML = `
        <span class="language-option-code">${locale.code.split('_')[0]}</span>
        <span>${locale.name}</span>
      `;
      dropdownContent.appendChild(option);
    });

    // Apply i18n
    applyI18nText();

    // Toggle dropdown on button click
    if (!langBtn.dataset.listenerAdded) {
      langBtn.dataset.listenerAdded = 'true';
      langBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = dropdown.style.display !== 'none';
        if (isVisible) {
          dropdown.style.display = 'none';
        } else {
          // Position dropdown below button
          const rect = langBtn.getBoundingClientRect();
          dropdown.style.top = `${rect.bottom + 4}px`;
          dropdown.style.right = `${window.innerWidth - rect.right}px`;
          dropdown.style.display = 'block';
        }
      });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      dropdown.style.display = 'none';
    });

    // Handle language option clicks
    dropdownContent.addEventListener('click', async (e) => {
      const target = (e.target as HTMLElement).closest('.language-option') as HTMLElement | null;
      if (!target) return;

      const newLocale = target.dataset.locale;
      const currentSettingLocale = settings.preferredLocale || DEFAULT_SETTING_LOCALE;
      if (!newLocale || newLocale === currentSettingLocale) {
        dropdown.style.display = 'none';
        return;
      }

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
        
        // Update button text
        langBtn.textContent = getLocaleDisplayCode(newLocale);

        // Update active state in dropdown
        dropdownContent.querySelectorAll<HTMLElement>('.language-option').forEach(opt => {
          opt.classList.toggle('active', opt.dataset.locale === newLocale);
        });

        applyI18nText();

        // Reload themes to update names
        loadThemes();

        dropdown.style.display = 'none';
        showMessage(translate('settings_language_changed'), 'success');
      } catch (error) {
        console.error('Failed to change language:', error);
        showMessage(translate('settings_save_failed'), 'error');
      }
    });
  }

  /**
   * Add change listener for extension checkbox
   */
  function addExtensionChangeListener(el: HTMLInputElement, key: string): void {
    if (!el.dataset.listenerAdded) {
      el.dataset.listenerAdded = 'true';
      el.addEventListener('change', async () => {
        if (!settings.supportedExtensions) {
          settings.supportedExtensions = getDefaultSupportedExtensions();
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

      const docxHrDisplayEl = document.getElementById('docx-hr-display') as HTMLSelectElement | null;
      if (docxHrDisplayEl) {
        settings.docxHrDisplay = docxHrDisplayEl.value as Settings['docxHrDisplay'];
      }

      const docxEmojiStyleEl = document.getElementById('docx-emoji-style') as HTMLSelectElement | null;
      if (docxEmojiStyleEl) {
        settings.docxEmojiStyle = docxEmojiStyleEl.value as EmojiStyle;
      }

      // Load supported file extensions from checkboxes
      const extResult: SupportedExtensions = {};
      for (const format of SUPPORTED_FORMATS) {
        const el = document.getElementById(`support-${format.fileType}`) as HTMLInputElement | null;
        extResult[format.fileType] = el?.checked ?? true;
      }
      settings.supportedExtensions = extResult;

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
        docxHrDisplay: 'hide',
        docxEmojiStyle: 'system',
        supportedExtensions: getDefaultSupportedExtensions(),
        tableMergeEmpty: true,
        tableLayout: 'center',
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
    loadThemes,
    setupLanguageSelector
  };
}
