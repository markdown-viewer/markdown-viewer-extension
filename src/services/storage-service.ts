/**
 * Unified Storage Service
 *
 * Provides consistent storage API across all platforms using ServiceChannel.
 * Each platform's backend handles the actual storage mechanism:
 * - Chrome: chrome.storage.local (via background script)
 * - VSCode: workspaceState/globalState (via extension host)
 * - Mobile: SharedPreferences/UserDefaults (via Flutter)
 */

import { ServiceChannel } from '../messaging/channels/service-channel';

export class StorageService {
  constructor(private channel: ServiceChannel) {}

  /**
   * Get values for the specified keys
   * @param keys - Single key or array of keys to retrieve
   * @returns Object with key-value pairs
   */
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    return this.channel.send('STORAGE_GET', { keys }) as Promise<Record<string, unknown>>;
  }

  /**
   * Set multiple key-value pairs
   * @param items - Object with key-value pairs to store
   */
  async set(items: Record<string, unknown>): Promise<void> {
    await this.channel.send('STORAGE_SET', { items });
  }

  /**
   * Remove values for the specified keys
   * @param keys - Single key or array of keys to remove
   */
  async remove(keys: string | string[]): Promise<void> {
    await this.channel.send('STORAGE_REMOVE', { keys });
  }
}
