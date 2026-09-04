/**
 * Settings Type Definitions
 * 
 * Unified types for settings management across all platforms.
 *
 * SettingKey / SettingTypes / DEFAULT_SETTINGS are AUTO-GENERATED from
 * `settings-schema.json` (via scripts/sync-settings.js) — do not edit them
 * by hand. This file keeps the hand-written service interfaces.
 */

import type { SettingKey, SettingTypes } from '../config/settings.generated';

export {
  DEFAULT_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  normalizeSetting,
} from '../config/settings.generated';
export type { SettingKey, SettingTypes } from '../config/settings.generated';

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
