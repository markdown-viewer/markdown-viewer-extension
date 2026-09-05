import type { PlatformType } from '../types/platform';

declare const MV_PLATFORM: PlatformType | undefined;
declare const MV_RUNTIME: 'popup' | 'content' | 'background' | 'webview' | 'worker' | 'shared' | undefined;

const PLATFORM_SET = new Set<PlatformType>(['chrome', 'firefox', 'mobile', 'vscode', 'obsidian']);

function isPlatformType(value: unknown): value is PlatformType {
  return typeof value === 'string' && PLATFORM_SET.has(value as PlatformType);
}

function getInjectedPlatform(): PlatformType | null {
  const runtime = typeof MV_RUNTIME === 'string' ? MV_RUNTIME : 'shared';
  if (!['popup', 'content', 'background', 'webview', 'worker', 'shared'].includes(runtime)) {
    return null;
  }

  if (typeof MV_PLATFORM === 'string' && isPlatformType(MV_PLATFORM)) {
    return MV_PLATFORM;
  }

  return null;
}

function getGlobalPlatform(): PlatformType | null {
  const platform = globalThis.platform?.platform;
  return isPlatformType(platform) ? platform : null;
}

/**
 * Resolve current platform identity.
 * Priority: build-time marker -> runtime platform object.
 */
export function getPlatformIdentity(): PlatformType | null {
  const injected = getInjectedPlatform();
  if (injected) {
    return injected;
  }

  const global = getGlobalPlatform();
  if (global) {
    return global;
  }

  return null;
}

export function isPlatform(platform: PlatformType): boolean {
  return getPlatformIdentity() === platform;
}

type BrowserGlobalLike = {
  browser?: WebExtensionApiLike;
};

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => void | boolean | Promise<unknown>;

type StorageChangeLike = {
  oldValue?: unknown;
  newValue?: unknown;
};

type StorageOnChangedListener = (
  changes: Record<string, StorageChangeLike>,
  areaName: string
) => void;

type WebExtensionApiLike = {
  runtime: {
    id?: string;
    sendMessage: (message: unknown) => Promise<unknown>;
    getURL: (path: string) => string;
    onMessage: {
      addListener: (listener: RuntimeMessageListener) => void;
      removeListener: (listener: RuntimeMessageListener) => void;
    };
  };
  storage: {
    local: {
      get: (keys: string[] | string | Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    onChanged?: {
      addListener: (listener: StorageOnChangedListener) => void;
      removeListener?: (listener: StorageOnChangedListener) => void;
    };
  };
  i18n?: {
    getUILanguage: () => string;
    getMessage: (key: string, substitutions?: string | string[]) => string;
  };
  permissions?: {
    contains: (permissions: { permissions: string[] }) => Promise<boolean>;
  };
  downloads?: {
    download: (options: { url: string; filename?: string; saveAs?: boolean }) => Promise<number | string | undefined>;
  };
  extension?: {
    /** Firefox 153+/Chrome: true when file:// access is granted to this extension. */
    isAllowedFileSchemeAccess?: () => Promise<boolean>;
  };
  tabs?: {
    create: (options: { url: string }) => Promise<unknown>;
  };
};

/**
 * Resolve browser extension API object (`browser` in Firefox, `chrome` in Chrome).
 * Requires explicit platform identity from build markers or global platform.
 */
export function getWebExtensionApi(): WebExtensionApiLike {
  const globalLike = globalThis as unknown as BrowserGlobalLike;
  const identity = getPlatformIdentity();

  if (identity === 'firefox' && globalLike.browser) {
    return globalLike.browser;
  }

  if (identity === 'chrome' && typeof chrome !== 'undefined') {
    return chrome as unknown as WebExtensionApiLike;
  }

  throw new Error('Unable to resolve WebExtension API: missing MV_PLATFORM or globalThis.platform.platform');
}
