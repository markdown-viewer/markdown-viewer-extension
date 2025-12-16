/**
 * Shared Render Worker Core
 * 
 * Platform-agnostic rendering logic shared between:
 * - Chrome extension's offscreen document (render-worker-chrome.js)
 * - Mobile WebView's render iframe (render-worker-mobile.js)
 * 
 * Each platform provides its own message adapter that calls these functions.
 */

import { renderers } from './index.js';

// Create renderer map for quick lookup
const rendererMap = new Map(
  renderers.map(r => [r.type, r])
);

// Store current theme configuration
let currentThemeConfig = null;

/**
 * Set theme configuration
 * @param {object} config - Theme configuration
 */
export function setThemeConfig(config) {
  currentThemeConfig = config;
}

/**
 * Get current theme configuration
 * @returns {object|null} Current theme config
 */
export function getThemeConfig() {
  return currentThemeConfig;
}

/**
 * Handle render request
 * @param {object} options - Render options
 * @param {string} options.renderType - Type of renderer (mermaid, vega, etc.)
 * @param {string|object} options.input - Content to render
 * @param {object} [options.themeConfig] - Theme configuration (optional, uses current if not provided)
 * @param {object} [options.extraParams] - Additional renderer parameters
 * @returns {Promise<object>} Render result with base64/svg, width, height
 */
export async function handleRender({ renderType, input, themeConfig, extraParams = {} }) {
  // Update theme config if provided
  if (themeConfig) {
    currentThemeConfig = themeConfig;
  }

  // Find renderer
  const renderer = rendererMap.get(renderType);
  if (!renderer) {
    throw new Error(`No renderer found for type: ${renderType}`);
  }

  // Perform render with current theme config
  return await renderer.render(input, currentThemeConfig, extraParams);
}

/**
 * Get list of available renderer types
 * @returns {string[]} Array of renderer type names
 */
export function getAvailableRenderers() {
  return Array.from(rendererMap.keys());
}

/**
 * Check if a renderer type is available
 * @param {string} type - Renderer type
 * @returns {boolean} True if renderer exists
 */
export function hasRenderer(type) {
  return rendererMap.has(type);
}

/**
 * Initialize render environment
 * Call this on DOM ready to optimize canvas performance
 * @param {object} options - Initialization options
 * @param {HTMLCanvasElement} [options.canvas] - Canvas element for PNG conversion
 */
export function initRenderEnvironment({ canvas } = {}) {
  // Pre-initialize canvas context for better performance
  if (canvas) {
    canvas.getContext('2d', { willReadFrequently: true });
  }

  // Initialize Mermaid if available
  if (typeof window !== 'undefined' && window.mermaid && typeof window.mermaid.initialize === 'function') {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    });
  }
}

// Message type constants for consistency
export const MessageTypes = {
  // Requests
  RENDER_DIAGRAM: 'RENDER_DIAGRAM',
  SET_THEME_CONFIG: 'SET_THEME_CONFIG',
  PING: 'PING',
  
  // Responses
  RESPONSE: 'RESPONSE',
  
  // Lifecycle
  READY: 'READY',
  READY_ACK: 'READY_ACK',
  ERROR: 'ERROR'
};
