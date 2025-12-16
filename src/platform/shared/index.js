/**
 * Platform Shared Module
 * 
 * Exports common base classes and utilities shared across all platforms.
 */

export {
  BaseCacheService,
  BaseI18nService,
  BaseRendererService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE
} from './base-services.js';

// Note: Render worker related code is in src/renderers/:
// - render-worker-core.js    - Shared rendering logic
// - render-worker-chrome.js  - Chrome offscreen adapter
// - render-worker-mobile.js  - Mobile iframe adapter
// - render-worker.html       - Shared HTML template

