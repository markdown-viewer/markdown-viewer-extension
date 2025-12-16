// Chrome Offscreen Render Worker Adapter
// Bridges Chrome extension messaging with shared render-worker-core

import {
  handleRender,
  setThemeConfig,
  initRenderEnvironment,
  MessageTypes
} from '../../renderers/render-worker-core.js';

// Add error listeners for debugging
window.addEventListener('error', (event) => {
  chrome.runtime.sendMessage({
    type: 'offscreenError',
    error: event.error?.message || 'Unknown error',
    filename: event.filename,
    lineno: event.lineno
  }).catch(() => { });
});

window.addEventListener('unhandledrejection', (event) => {
  chrome.runtime.sendMessage({
    type: 'offscreenError',
    error: `Unhandled promise rejection: ${event.reason}`,
    filename: 'Promise',
    lineno: 0
  }).catch(() => { });
});

// Optimize canvas performance on page load
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.style.backgroundColor = 'transparent';
  document.body.style.backgroundColor = 'transparent';

  // Initialize render environment using shared core
  const canvas = document.getElementById('png-canvas');
  initRenderEnvironment({ canvas });

  // Send ready signal when DOM is loaded
  chrome.runtime.sendMessage({
    type: 'offscreenDOMReady'
  }).catch(() => { });
});

// Establish connection with background script for lifecycle monitoring
const port = chrome.runtime.connect({ name: 'offscreen' });

// Notify background script that offscreen document is ready
chrome.runtime.sendMessage({
  type: 'offscreenReady'
}).catch(() => {
  // Ignore errors if background script isn't ready
});

// Message handler for rendering requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  if (message.type === 'setThemeConfig') {
    // Update theme configuration using shared core
    setThemeConfig(message.config);
    sendResponse({ success: true });
    return true;
  }
  
  // Handle unified render messages
  if (message.action === MessageTypes.RENDER_DIAGRAM || message.action === 'RENDER_DIAGRAM') {
    // Check message source using Chrome's sender object
    // - sender.tab exists → from content script → SKIP (let background handle)
    // - sender.tab is undefined → from background/extension → PROCESS
    if (sender.tab) {
      return; // Don't send response, let background handle it
    }
    
    // Process render task using shared core
    handleRender({
      renderType: message.renderType,
      input: message.input,
      themeConfig: message.themeConfig,
      extraParams: message.extraParams
    }).then(result => {
      sendResponse(result);
    }).catch(error => {
      console.error('Render error:', error);
      sendResponse({ error: error.message });
    });
    
    return true;
  }
});

// Signal that the offscreen document is ready
chrome.runtime.sendMessage({ type: 'offscreenReady' }).catch(() => {
  // Ignore errors
});
