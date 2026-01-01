/**
 * Platform detection for popup context
 * 
 * Popup runs in extension context (Chrome/Firefox only) where the full
 * platform API may not be initialized. These helpers provide simple
 * platform detection for popup-specific code.
 */

/**
 * Check if running in Firefox extension
 * Uses browser global presence as primary check, userAgent as fallback
 */
export function isFirefoxPopup(): boolean {
  // Firefox provides 'browser' global, Chrome doesn't
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).browser !== 'undefined') {
    return true;
  }
  // Fallback: check userAgent (less reliable but catches edge cases)
  if (typeof navigator !== 'undefined' && navigator.userAgent?.includes('Firefox')) {
    return true;
  }
  return false;
}

/**
 * Check if running in Chrome extension
 */
export function isChromePopup(): boolean {
  return !isFirefoxPopup();
}
