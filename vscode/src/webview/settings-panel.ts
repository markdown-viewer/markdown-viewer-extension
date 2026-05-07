/**
 * VSCode Settings Panel Component
 * 
 * A dropdown settings panel that appears when clicking the settings button.
 * Includes: theme selector, language, DOCX options.
 * 
 * Languages and themes are loaded dynamically from registry.json files.
 */

import Localization from '../../../src/utils/localization';
import type { EmojiStyle } from '../../../src/types/docx.js';
import type { FrontmatterDisplay } from '../../../src/core/viewer/viewer-controller';

/** Table layout mode */
export type TableLayout = 'left' | 'center' | 'center-full-width';

export interface SettingsPanelOptions {
  /** Current theme ID */
  currentTheme?: string;
  /** Current locale */
  currentLocale?: string;
  /** DOCX HR display mode setting */
  docxHrDisplay?: 'pageBreak' | 'line' | 'hide';
  /** DOCX emoji style setting */
  docxEmojiStyle?: EmojiStyle;
  /** Frontmatter display mode */
  frontmatterDisplay?: FrontmatterDisplay;
  /** Table merge empty cells setting */
  tableMergeEmpty?: boolean;
  /** Table layout setting */
  tableLayout?: TableLayout;
  /** Theme changed callback */
  onThemeChange?: (themeId: string) => void;
  /** Locale changed callback */
  onLocaleChange?: (locale: string) => void;
  /** DOCX HR display changed callback */
  onDocxHrDisplayChange?: (display: 'pageBreak' | 'line' | 'hide') => void;
  /** DOCX emoji style changed callback */
  onDocxEmojiStyleChange?: (style: EmojiStyle) => void;
  /** Frontmatter display changed callback */
  onFrontmatterDisplayChange?: (display: FrontmatterDisplay) => void;
  /** Table merge empty cells changed callback */
  onTableMergeEmptyChange?: (enabled: boolean) => void;
  /** Table layout changed callback */
  onTableLayoutChange?: (layout: TableLayout) => void;
  /** Cache clear callback */
  onClearCache?: () => Promise<void>;
  /** Called when panel is shown, use to refresh dynamic data */
  onShow?: () => void;
  /** Close panel callback */
  onClose?: () => void;
}

export interface SettingsPanel {
  /** Show the panel */
  show: (anchorEl: HTMLElement) => void;
  /** Show the panel at a specific position */
  showAtPosition: (x: number, y: number) => void;
  /** Hide the panel */
  hide: () => void;
  /** Check if panel is visible */
  isVisible: () => boolean;
  /** Update theme list */
  setThemes: (themes: ThemeOption[]) => void;
  /** Update locale list */
  setLocales: (locales: LocaleOption[]) => void;
  /** Update UI labels after locale change */
  updateLabels: () => void;
  /** Update cache stats display */
  setCacheStats: (stats: CacheStats) => void;
  /** Get the panel element */
  getElement: () => HTMLElement;
  /** Cleanup */
  dispose: () => void;
}

export interface ThemeOption {
  id: string;
  name: string;
  category?: string;
}

export interface LocaleOption {
  code: string;
  name: string;
}

export interface CacheStats {
  itemCount: number;
  totalSizeMB: string;
  maxItems: number;
}

/**
 * Create settings panel
 */
export function createSettingsPanel(options: SettingsPanelOptions): SettingsPanel {
  const {
    currentTheme = 'default',
    currentLocale = 'auto',
    docxHrDisplay = 'hide',
    docxEmojiStyle = 'windows',
    frontmatterDisplay = 'hide',
    tableMergeEmpty = true,
    tableLayout = 'center',
    onThemeChange,
    onLocaleChange,
    onDocxHrDisplayChange,
    onDocxEmojiStyleChange,
    onClose
  } = options;

  let visible = false;

  // Create panel container
  const panel = document.createElement('div');
  panel.className = 'vscode-settings-panel';
  panel.style.display = 'none';

  // Helper to get display code from locale
  const getLocaleDisplayCode = (localeCode: string): string => {
    if (localeCode === 'auto') {
      // Use VSCode's UI language
      const uiLang = document.documentElement.lang || navigator.language || 'en';
      const baseLang = uiLang.split('-')[0].split('_')[0];
      return baseLang.toLowerCase();
    }
    // Extract base language code (e.g., "zh" from "zh_CN", "en" from "en")
    return localeCode.split('_')[0].split('-')[0].toLowerCase();
  };

  panel.innerHTML = `
    <div class="vscode-settings-header">
      <span class="vscode-settings-title" data-i18n="tab_settings">${Localization.translate('tab_settings')}</span>
      <div class="vscode-language-selector">
        <button class="vscode-language-btn" data-setting="locale-btn">${getLocaleDisplayCode(currentLocale)}</button>
        <div class="vscode-language-dropdown" style="display: none;">
          <div class="vscode-language-option" data-locale="auto" data-i18n="settings_language_auto">${Localization.translate('settings_language_auto')}</div>
        </div>
      </div>
      <button class="vscode-settings-close" data-i18n-title="close" title="${Localization.translate('close') || 'Close'}">×</button>
    </div>
    <div class="vscode-settings-content">
      <div class="vscode-settings-group">
        <label class="vscode-settings-label" data-i18n="settings_theme_label">${Localization.translate('settings_theme_label')}</label>
        <select class="vscode-settings-select" data-setting="theme">
          <option value="default">Default</option>
        </select>
      </div>
      <div class="vscode-settings-group">
        <label class="vscode-settings-label" data-i18n="settings_frontmatter_display">${Localization.translate('settings_frontmatter_display')}</label>
        <select class="vscode-settings-select" data-setting="frontmatterDisplay">
          <option value="hide" ${frontmatterDisplay === 'hide' ? 'selected' : ''} data-i18n="settings_frontmatter_hide">${Localization.translate('settings_frontmatter_hide')}</option>
          <option value="table" ${frontmatterDisplay === 'table' ? 'selected' : ''} data-i18n="settings_frontmatter_table">${Localization.translate('settings_frontmatter_table')}</option>
          <option value="raw" ${frontmatterDisplay === 'raw' ? 'selected' : ''} data-i18n="settings_frontmatter_raw">${Localization.translate('settings_frontmatter_raw')}</option>
        </select>
      </div>
      <div class="vscode-settings-group">
        <label class="vscode-settings-label" data-i18n="settings_docx_emoji_style">${Localization.translate('settings_docx_emoji_style')}</label>
        <select class="vscode-settings-select" data-setting="emojiStyle">
          <option value="system" ${docxEmojiStyle === 'system' ? 'selected' : ''} data-i18n="settings_docx_emoji_style_system">${Localization.translate('settings_docx_emoji_style_system')}</option>
          <option value="windows" ${docxEmojiStyle === 'windows' ? 'selected' : ''} data-i18n="settings_docx_emoji_style_windows">${Localization.translate('settings_docx_emoji_style_windows')}</option>
          <option value="apple" ${docxEmojiStyle === 'apple' ? 'selected' : ''} data-i18n="settings_docx_emoji_style_apple">${Localization.translate('settings_docx_emoji_style_apple')}</option>
        </select>
      </div>
      <div class="vscode-settings-group">
        <label class="vscode-settings-checkbox">
          <input type="checkbox" data-setting="tableMergeEmpty" ${tableMergeEmpty ? 'checked' : ''}>
          <span data-i18n="settings_table_merge_empty">${Localization.translate('settings_table_merge_empty')}</span>
        </label>
      </div>
      <div class="vscode-settings-group">
        <label class="vscode-settings-label" data-i18n="settings_table_layout">${Localization.translate('settings_table_layout')}</label>
        <select class="vscode-settings-select" data-setting="tableLayout">
          <option value="left" ${tableLayout === 'left' ? 'selected' : ''} data-i18n="settings_table_layout_left">${Localization.translate('settings_table_layout_left')}</option>
          <option value="center" ${tableLayout === 'center' ? 'selected' : ''} data-i18n="settings_table_layout_center">${Localization.translate('settings_table_layout_center')}</option>
          <option value="center-full-width" ${tableLayout === 'center-full-width' ? 'selected' : ''} data-i18n="settings_table_layout_full_width">${Localization.translate('settings_table_layout_full_width')}</option>
        </select>
      </div>
      <div class="vscode-settings-group">
        <label class="vscode-settings-label" data-i18n="settings_docx_hr_display">${Localization.translate('settings_docx_hr_display')}</label>
        <select class="vscode-settings-select" data-setting="docxHrDisplay">
          <option value="hide" ${docxHrDisplay === 'hide' ? 'selected' : ''} data-i18n="settings_docx_hr_display_hide">${Localization.translate('settings_docx_hr_display_hide')}</option>
          <option value="line" ${docxHrDisplay === 'line' ? 'selected' : ''} data-i18n="settings_docx_hr_display_line">${Localization.translate('settings_docx_hr_display_line')}</option>
          <option value="pageBreak" ${docxHrDisplay === 'pageBreak' ? 'selected' : ''} data-i18n="settings_docx_hr_display_page_break">${Localization.translate('settings_docx_hr_display_page_break')}</option>
        </select>
      </div>
      <div class="vscode-settings-divider"></div>
      <div class="vscode-settings-group">
        <div class="vscode-cache-stats">
          <div class="vscode-cache-stat-item">
            <span class="vscode-cache-stat-label" data-i18n="cache_stat_item_label">${Localization.translate('cache_stat_item_label')}</span>
            <span class="vscode-cache-stat-value" data-cache-stat="items">-</span>
          </div>
          <div class="vscode-cache-stat-item">
            <span class="vscode-cache-stat-label" data-i18n="cache_stat_size_label">${Localization.translate('cache_stat_size_label')}</span>
            <span class="vscode-cache-stat-value" data-cache-stat="size">-</span>
          </div>
        </div>
        <button class="vscode-cache-clear-btn" data-i18n="cache_clear">${Localization.translate('cache_clear')}</button>
      </div>
    </div>
  `;

  // Get elements
  const closeBtn = panel.querySelector('.vscode-settings-close') as HTMLButtonElement;
  const themeSelect = panel.querySelector('[data-setting="theme"]') as HTMLSelectElement;
  const languageBtn = panel.querySelector('.vscode-language-btn') as HTMLButtonElement;
  const languageDropdown = panel.querySelector('.vscode-language-dropdown') as HTMLDivElement;
  const docxHrDisplaySelect = panel.querySelector('[data-setting="docxHrDisplay"]') as HTMLSelectElement;
  const tableMergeEmptyCheckbox = panel.querySelector('[data-setting="tableMergeEmpty"]') as HTMLInputElement;
  const tableLayoutSelect = panel.querySelector('[data-setting="tableLayout"]') as HTMLSelectElement;
  const emojiStyleSelect = panel.querySelector('[data-setting="emojiStyle"]') as HTMLSelectElement;
  const frontmatterDisplaySelect = panel.querySelector('[data-setting="frontmatterDisplay"]') as HTMLSelectElement;
  const clearCacheBtn = panel.querySelector('.vscode-cache-clear-btn') as HTMLButtonElement;
  const cacheItemsValue = panel.querySelector('[data-cache-stat="items"]') as HTMLElement;
  const cacheSizeValue = panel.querySelector('[data-cache-stat="size"]') as HTMLElement;

  // Track current locale for language button
  let activeLocale = currentLocale;

  // Set initial values
  if (themeSelect) themeSelect.value = currentTheme;
  if (docxHrDisplaySelect) docxHrDisplaySelect.value = docxHrDisplay;
  if (tableMergeEmptyCheckbox) tableMergeEmptyCheckbox.checked = tableMergeEmpty;
  if (tableLayoutSelect) tableLayoutSelect.value = tableLayout;
  if (emojiStyleSelect) emojiStyleSelect.value = docxEmojiStyle;
  if (frontmatterDisplaySelect) frontmatterDisplaySelect.value = frontmatterDisplay;

  // Bind events
  closeBtn?.addEventListener('click', () => {
    hide();
    onClose?.();
  });

  themeSelect?.addEventListener('change', () => {
    onThemeChange?.(themeSelect.value);
  });

  // Language button click handler
  languageBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = languageDropdown.style.display !== 'none';
    languageDropdown.style.display = isVisible ? 'none' : 'block';
  });

  // Close language dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!languageBtn?.contains(e.target as Node) && !languageDropdown?.contains(e.target as Node)) {
      if (languageDropdown) languageDropdown.style.display = 'none';
    }
  });

  docxHrDisplaySelect?.addEventListener('change', () => {
    onDocxHrDisplayChange?.(docxHrDisplaySelect.value as 'pageBreak' | 'line' | 'hide');
  });

  tableMergeEmptyCheckbox?.addEventListener('change', () => {
    options.onTableMergeEmptyChange?.(tableMergeEmptyCheckbox.checked);
  });

  tableLayoutSelect?.addEventListener('change', () => {
    options.onTableLayoutChange?.(tableLayoutSelect.value as TableLayout);
  });

  emojiStyleSelect?.addEventListener('change', () => {
    options.onDocxEmojiStyleChange?.(emojiStyleSelect.value as EmojiStyle);
  });

  frontmatterDisplaySelect?.addEventListener('change', () => {
    options.onFrontmatterDisplayChange?.(frontmatterDisplaySelect.value as FrontmatterDisplay);
  });

  // Handle clear cache button - no confirm dialog in sandboxed webview
  // Just clear directly, the action is not destructive enough to warrant confirmation
  clearCacheBtn?.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    clearCacheBtn.textContent = '...';
    try {
      await options.onClearCache?.();
    } catch (err) {
      console.error('Failed to clear cache:', err);
    } finally {
      clearCacheBtn.disabled = false;
      clearCacheBtn.textContent = Localization.translate('cache_clear');
    }
  });

  // Click outside to close
  const handleClickOutside = (e: MouseEvent) => {
    if (visible && !panel.contains(e.target as Node)) {
      // Don't close if clicking the settings button itself
      const target = e.target as HTMLElement;
      if (target.closest('[data-action="settings"]')) {
        return;
      }
      hide();
      onClose?.();
    }
  };

  function show(anchorEl: HTMLElement): void {
    if (visible) return;
    
    // Position panel below anchor, fixed to right edge of page
    const rect = anchorEl.getBoundingClientRect();
    
    // Fixed position relative to page right edge
    const rightMargin = 13; // Margin from page right edge
    
    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.left = 'auto';
    panel.style.right = `${rightMargin}px`;
    panel.style.display = 'block';
    panel.style.zIndex = '10000';
    visible = true;

    // Notify caller to refresh dynamic data (e.g., cache stats)
    options.onShow?.();

    // Add click outside listener (delayed to avoid immediate close from the same click)
    requestAnimationFrame(() => {
      document.addEventListener('click', handleClickOutside);
    });
  }

  function showAtPosition(x: number, y: number): void {
    if (visible) return;
    
    // Fixed position relative to page right edge
    const rightMargin = 13; // Margin from page right edge
    
    panel.style.position = 'fixed';
    panel.style.top = `${y}px`;
    panel.style.left = 'auto';
    panel.style.right = `${rightMargin}px`;
    panel.style.display = 'block';
    panel.style.zIndex = '10000';
    visible = true;

    // Notify caller to refresh dynamic data (e.g., cache stats)
    options.onShow?.();

    // Add click outside listener (delayed to avoid immediate close from the same click)
    requestAnimationFrame(() => {
      document.addEventListener('click', handleClickOutside);
    });
  }

  function hide(): void {
    if (!visible) return;
    
    panel.style.display = 'none';
    visible = false;
    document.removeEventListener('click', handleClickOutside);
  }

  function setThemes(themes: ThemeOption[]): void {
    if (!themeSelect) return;

    // Group by category
    const byCategory = new Map<string, ThemeOption[]>();
    themes.forEach(theme => {
      const cat = theme.category || 'Other';
      if (!byCategory.has(cat)) {
        byCategory.set(cat, []);
      }
      byCategory.get(cat)!.push(theme);
    });

    // Build options
    themeSelect.innerHTML = '';
    
    if (byCategory.size <= 1) {
      // No categories or single category, just list themes
      themes.forEach(theme => {
        const opt = document.createElement('option');
        opt.value = theme.id;
        opt.textContent = theme.name;
        opt.selected = theme.id === currentTheme;
        themeSelect.appendChild(opt);
      });
    } else {
      // Group by category
      byCategory.forEach((catThemes, category) => {
        const group = document.createElement('optgroup');
        group.label = category;
        
        catThemes.forEach(theme => {
          const opt = document.createElement('option');
          opt.value = theme.id;
          opt.textContent = theme.name;
          opt.selected = theme.id === currentTheme;
          group.appendChild(opt);
        });
        
        themeSelect.appendChild(group);
      });
    }
  }

  function setLocales(locales: LocaleOption[]): void {
    if (!languageDropdown) return;

    // Clear and rebuild dropdown options
    languageDropdown.innerHTML = `<div class="vscode-language-option${activeLocale === 'auto' ? ' selected' : ''}" data-locale="auto" data-i18n="settings_language_auto">${Localization.translate('settings_language_auto')}</div>`;
    
    locales.forEach(loc => {
      const option = document.createElement('div');
      option.className = `vscode-language-option${loc.code === activeLocale ? ' selected' : ''}`;
      option.setAttribute('data-locale', loc.code);
      option.textContent = loc.name;
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        activeLocale = loc.code;
        if (languageBtn) languageBtn.textContent = getLocaleDisplayCode(loc.code);
        languageDropdown.style.display = 'none';
        // Update selected state
        languageDropdown.querySelectorAll('.vscode-language-option').forEach(opt => {
          opt.classList.toggle('selected', opt.getAttribute('data-locale') === loc.code);
        });
        onLocaleChange?.(loc.code);
      });
      languageDropdown.appendChild(option);
    });

    // Add click handler for auto option
    const autoOption = languageDropdown.querySelector('[data-locale="auto"]');
    autoOption?.addEventListener('click', (e) => {
      e.stopPropagation();
      activeLocale = 'auto';
      if (languageBtn) languageBtn.textContent = getLocaleDisplayCode('auto');
      languageDropdown.style.display = 'none';
      // Update selected state
      languageDropdown.querySelectorAll('.vscode-language-option').forEach(opt => {
        opt.classList.toggle('selected', opt.getAttribute('data-locale') === 'auto');
      });
      onLocaleChange?.('auto');
    });
  }

  function updateLabels(): void {
    // Update all elements with data-i18n attribute
    panel.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = Localization.translate(key);
      }
    });
    // Update elements with data-i18n-title attribute
    panel.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        (el as HTMLElement).title = Localization.translate(key) || '';
      }
    });
  }

  function setCacheStats(stats: CacheStats): void {
    if (cacheItemsValue) {
      cacheItemsValue.textContent = `${stats.itemCount}/${stats.maxItems}`;
    }
    if (cacheSizeValue) {
      cacheSizeValue.textContent = stats.totalSizeMB;
    }
  }

  return {
    show,
    showAtPosition,
    hide,
    isVisible: () => visible,
    setThemes,
    setLocales,
    updateLabels,
    setCacheStats,
    getElement: () => panel,
    dispose(): void {
      document.removeEventListener('click', handleClickOutside);
      panel.remove();
    }
  };
}
