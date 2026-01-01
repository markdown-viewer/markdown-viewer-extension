/**
 * Platform Utility Functions
 * 
 * Provides convenient helpers for platform detection.
 * Use these instead of direct platform checks for cleaner code.
 */

import type { PlatformType } from '../types/platform';

/**
 * Get the current platform type
 * @returns Platform type or undefined if platform not initialized
 */
export function getPlatformType(): PlatformType | undefined {
  return (globalThis.platform as { platform?: PlatformType } | undefined)?.platform;
}

/**
 * Check if running in Chrome extension
 */
export function isChrome(): boolean {
  return getPlatformType() === 'chrome';
}

/**
 * Check if running in Firefox extension
 */
export function isFirefox(): boolean {
  return getPlatformType() === 'firefox';
}

/**
 * Check if running in VS Code webview
 */
export function isVSCode(): boolean {
  return getPlatformType() === 'vscode';
}

/**
 * Check if running in mobile app (Flutter)
 */
export function isMobile(): boolean {
  return getPlatformType() === 'mobile';
}

/**
 * Check if running in a browser extension (Chrome or Firefox)
 */
export function isExtension(): boolean {
  const platform = getPlatformType();
  return platform === 'chrome' || platform === 'firefox';
}

/**
 * Check if running in a desktop environment (extensions or VS Code)
 */
export function isDesktop(): boolean {
  const platform = getPlatformType();
  return platform === 'chrome' || platform === 'firefox' || platform === 'vscode';
}

/**
 * Check if the platform supports local file reading
 * Firefox has CORS restrictions that prevent reading file:// URLs
 */
export function supportsLocalFileReading(): boolean {
  const platform = getPlatformType();
  // Firefox cannot read local files due to CORS
  return platform !== 'firefox';
}

/**
 * Check if the platform requires URI rewriting for images
 * VS Code and Mobile need relative paths converted to absolute URIs
 */
export function needsImageUriRewrite(): boolean {
  const platform = getPlatformType();
  return platform === 'vscode' || platform === 'mobile';
}
