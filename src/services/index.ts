/**
 * Services Module
 * 
 * Application-layer services that work across all platforms.
 */

export { CacheService } from './cache-service';
export type { CacheOperationPayload, CacheSetResult } from './cache-service';

export { StorageService } from './storage-service';

export { FileService } from './file-service';
export type { DownloadOptions } from './file-service';

export { FileStateService } from './file-state-service';

export { RendererService } from './renderer-service';
export type { RendererServiceOptions, RenderHostFactory } from './renderer-service';

export { BaseI18nService, DEFAULT_SETTING_LOCALE, FALLBACK_LOCALE } from './base-i18n-service';
export type { LocaleMessages, LocaleMessageEntry } from './base-i18n-service';

export { BaseDocumentService } from './document-service';

export { DirectResourceService, ProxyResourceService } from './resource-service';
export type { ResourceService } from './resource-service';

export { SettingsService, createSettingsService } from './settings-service';
export type { RefreshCallback, SettingsServiceConfig } from './settings-service';
