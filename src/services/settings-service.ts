/**
 * Unified Settings Service Implementation
 * 
 * This service provides a consistent settings API across all platforms.
 * It abstracts the storage layer and provides:
 * - Type-safe get/set operations
 * - Automatic refresh notification on setting changes
 * - Platform-agnostic interface
 * 
 * Usage:
 * ```typescript
 * const settingsService = new SettingsService(platform.storage, notifyRefresh);
 * 
 * // Get a setting
 * const tableMergeEmpty = await settingsService.get('tableMergeEmpty');
 * 
 * // Set a setting with refresh
 * await settingsService.set('tableMergeEmpty', false, { refresh: true });
 * ```
 */

import type { StorageService } from '../types/platform';
import type { 
  ISettingsService, 
  SettingKey, 
  SettingTypes, 
  SetSettingOptions,
  DEFAULT_SETTINGS 
} from '../types/settings';

const STORAGE_KEY = 'markdownViewerSettings';

/**
 * Refresh callback type
 */
export type RefreshCallback = (key: SettingKey, value: unknown) => void | Promise<void>;

/**
 * Settings service configuration
 */
export interface SettingsServiceConfig {
  /**
   * Storage service for persistence
   */
  storage: StorageService;
  
  /**
   * Callback to trigger refresh after setting change
   * This is platform-specific (e.g., re-render, send message to tabs)
   */
  onRefresh?: RefreshCallback;
}

/**
 * Unified Settings Service
 * 
 * Provides type-safe access to settings with automatic refresh notification.
 */
export class SettingsService implements ISettingsService {
  private storage: StorageService;
  private onRefresh?: RefreshCallback;
  private listeners: Set<(key: SettingKey, value: unknown) => void> = new Set();

  constructor(config: SettingsServiceConfig) {
    this.storage = config.storage;
    this.onRefresh = config.onRefresh;
  }

  /**
   * Get all stored settings merged with defaults
   */
  private async getAllSettings(): Promise<SettingTypes> {
    const result = await this.storage.get([STORAGE_KEY]);
    const stored = (result[STORAGE_KEY] as Partial<SettingTypes>) || {};
    
    // Import defaults at runtime to avoid circular dependency
    const { DEFAULT_SETTINGS } = await import('../types/settings');
    
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
    };
  }

  /**
   * Get a setting value by key
   */
  async get<K extends SettingKey>(key: K): Promise<SettingTypes[K]> {
    const settings = await this.getAllSettings();
    return settings[key];
  }

  /**
   * Set a setting value
   */
  async set<K extends SettingKey>(
    key: K,
    value: SettingTypes[K],
    options?: SetSettingOptions
  ): Promise<void> {
    // Get current settings
    const result = await this.storage.get([STORAGE_KEY]);
    const current = (result[STORAGE_KEY] as Record<string, unknown>) || {};
    
    // Update the specific setting
    const updated = {
      ...current,
      [key]: value,
    };
    
    // Save to storage
    await this.storage.set({ [STORAGE_KEY]: updated });
    
    // Notify listeners
    this.notifyListeners(key, value);
    
    // Trigger refresh if requested
    if (options?.refresh && this.onRefresh) {
      await this.onRefresh(key, value);
    }
  }

  /**
   * Get all settings
   */
  async getAll(): Promise<SettingTypes> {
    return this.getAllSettings();
  }

  /**
   * Subscribe to setting changes
   */
  onChange(listener: (key: SettingKey, value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of a setting change
   */
  private notifyListeners(key: SettingKey, value: unknown): void {
    this.listeners.forEach(listener => {
      try {
        listener(key, value);
      } catch (error) {
        console.error('[SettingsService] Listener error:', error);
      }
    });
  }

  /**
   * Set the refresh callback (can be changed after initialization)
   */
  setRefreshCallback(callback: RefreshCallback): void {
    this.onRefresh = callback;
  }
}

/**
 * Create a settings service instance
 * 
 * @param storage - Storage service from platform
 * @param onRefresh - Optional callback to trigger refresh after setting change
 * @returns Settings service instance
 */
export function createSettingsService(
  storage: StorageService,
  onRefresh?: RefreshCallback
): SettingsService {
  return new SettingsService({
    storage,
    onRefresh,
  });
}
