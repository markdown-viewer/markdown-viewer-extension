// Mobile Iframe Render Worker Adapter
// Bridges iframe postMessage with shared render-worker-core

import {
  handleRender,
  setThemeConfig,
  initRenderEnvironment,
  MessageTypes
} from '../../renderers/render-worker-core.js';

// Signal ready state
let isReady = false;
let readyAcknowledged = false;
let readyInterval = null;

/**
 * Send log to parent window for debugging
 */
function logToParent(...args) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: 'RENDER_FRAME_LOG',
        args: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))
      }, '*');
    }
  } catch (e) {
    // Ignore
  }
}

/**
 * Send message to parent window
 */
function sendToParent(message) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, '*');
    } else {
      console.warn('[RenderWorker] No parent window');
    }
  } catch (e) {
    console.error('[RenderWorker] postMessage failed:', e);
  }
}

/**
 * Send response to parent
 */
function sendResponse(requestId, result = null, error = null) {
  const response = {
    type: MessageTypes.RESPONSE,
    requestId
  };
  
  if (error) {
    response.error = error;
  } else {
    response.result = result;
  }
  
  sendToParent(response);
}

/**
 * Handle incoming messages from parent
 */
window.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  const { type, requestId } = message;

  // Handle theme config update
  if (type === MessageTypes.SET_THEME_CONFIG || type === 'SET_THEME_CONFIG') {
    console.log('[RenderWorker] SET_THEME_CONFIG received:', message.config);
    setThemeConfig(message.config);
    sendResponse(requestId, { success: true });
    return;
  }

  // Handle render request
  if (type === MessageTypes.RENDER_DIAGRAM || type === 'RENDER_DIAGRAM') {
    console.log('[RenderWorker] RENDER_DIAGRAM received:', message.renderType);
    try {
      const result = await handleRender({
        renderType: message.renderType,
        input: message.input,
        themeConfig: message.themeConfig,
        extraParams: message.extraParams
      });
      sendResponse(requestId, result);
    } catch (error) {
      console.error('[RenderWorker] Render error:', error);
      sendResponse(requestId, null, error.message);
    }
    return;
  }

  // Handle ping (check if ready)
  if (type === MessageTypes.PING || type === 'PING') {
    sendResponse(requestId, { ready: isReady });
    return;
  }
});

// Listen for acknowledgment from parent
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message && (message.type === MessageTypes.READY_ACK || message.type === 'READY_ACK')) {
    readyAcknowledged = true;
    if (readyInterval) {
      clearInterval(readyInterval);
      readyInterval = null;
    }
    console.log('[RenderWorker] Ready acknowledged');
  }
});

/**
 * Initialize render worker
 */
function initialize() {
  console.log('[RenderWorker] Initializing...');
  
  // Initialize render environment using shared core
  const canvas = document.getElementById('png-canvas');
  initRenderEnvironment({ canvas });

  isReady = true;

  // Keep sending ready signal until acknowledged
  // This handles the case where parent's listener isn't set up yet
  const sendReady = () => {
    if (!readyAcknowledged) {
      console.log('[RenderWorker] Sending RENDER_FRAME_READY');
      sendToParent({ type: 'RENDER_FRAME_READY' });
    }
  };
  
  sendReady();
  readyInterval = setInterval(sendReady, 100);
  
  // Stop after 10 seconds
  setTimeout(() => {
    if (readyInterval) {
      clearInterval(readyInterval);
      readyInterval = null;
    }
  }, 10000);

  console.log('[RenderWorker] Ready');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
