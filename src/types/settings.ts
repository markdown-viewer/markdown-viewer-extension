/**
 * Settings Type Definitions
 * 
 * Unified types for settings management across all platforms.
 */

/**
 * All available setting keys
 */
export type SettingKey = 
  | 'themeId'
  | 'tableMergeEmpty'
  | 'frontmatterDisplay'
  | 'preferredLocale'
  | 'docxHrAsPageBreak'
  | 'docxEmojiStyle';

/**
 * Setting value types mapped by key
 */
export interface SettingTypes {
  themeId: string;
  tableMergeEmpty: boolean;
  frontmatterDisplay: 'hide' | 'table' | 'raw';
  preferredLocale: string;
  docxHrAsPageBreak: boolean;
  docxEmojiStyle: 'native' | 'twemoji';
}

/**
 * Default values for all settings
 */
export const DEFAULT_SETTINGS: SettingTypes = {
  themeId: 'default',
  tableMergeEmpty: true,
  frontmatterDisplay: 'hide',
  preferredLocale: 'auto',
  docxHrAsPageBreak: false,
  docxEmojiStyle: 'twemoji',
};

/**
 * Options for setting a value
 */
export interface SetSettingOptions {
  /**
   * Whether to trigger a refresh/re-render after the setting is changed.
   * Default: false
   */
  refresh?: boolean;
}

/**
 * Unified settings service interface.
 * 
 * Business code should use this service to read/write settings.
 * Direct access to storage APIs is not allowed.
 */
export interface ISettingsService {
  /**
   * Get a setting value by key.
   * @param key - The setting key
   * @returns The setting value, or the default value if not set
   */
  get<K extends SettingKey>(key: K): Promise<SettingTypes[K]>;

  /**
   * Set a setting value.
   * @param key - The setting key
   * @param value - The new value
   * @param options - Options including whether to trigger refresh
   */
  set<K extends SettingKey>(
    key: K,
    value: SettingTypes[K],
    options?: SetSettingOptions
  ): Promise<void>;

  /**
   * Get all settings.
   * @returns All settings with their current values
   */
  getAll(): Promise<SettingTypes>;

  /**
   * Subscribe to setting changes.
   * @param listener - Callback when a setting changes
   * @returns Unsubscribe function
   */
  onChange?(listener: (key: SettingKey, value: unknown) => void): () => void;
}
