/**
 * Platform Entry Point
 * 
 * This module initializes and exports the platform API instance.
 * Import this module to get the platform-specific implementation.
 */

import { chromePlatform } from './api-impl.js';

// Set global platform instance
// This allows other modules to access platform services without importing
globalThis.platform = chromePlatform;

// Export for explicit imports
export default chromePlatform;
export { chromePlatform as platform };
