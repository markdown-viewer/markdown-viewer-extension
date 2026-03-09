// Mobile/VSCode Iframe Render Worker
// Entry point for the render iframe in Flutter WebView or VSCode srcdoc

// Send ready message immediately before any imports fail
try {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'RENDER_FRAME_READY' }, '*');
  }
} catch (e) {
  // Ignore errors
}

import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { WindowPostMessageTransport } from '../../../src/messaging/transports/window-postmessage-transport';

import { bootstrapRenderWorker } from '../../../src/renderers/worker/worker-bootstrap';
import { MessageTypes } from '../../../src/renderers/render-worker-core';
import { ProxyResourceService } from '../../../src/services';

type ReadyAckMessage = {
  type?: string;
};

// ============================================================================
// Platform API for Iframe Render Worker
// ============================================================================

// Set up minimal platform API for services that need resource.fetch
// (e.g., StencilsService for DrawIO stencils)
// Uses ProxyResourceService to fetch resources via parent window
globalThis.platform = {
  resource: new ProxyResourceService(window.parent)
} as unknown as typeof globalThis.platform;

// ============================================================================

function initialize(): void {
  let isReady = false;
  let readyAcknowledged = false;
  let readyInterval: ReturnType<typeof setInterval> | null = null;

  const renderChannel = new RenderChannel(
    new WindowPostMessageTransport(window.parent, {
      targetOrigin: '*',
      acceptSource: window.parent,
    }),
    {
      source: 'iframe-render',
      timeoutMs: 60_000,
    }
  );

  const worker = bootstrapRenderWorker(renderChannel, {
    getCanvas: () => document.getElementById('png-canvas') as HTMLCanvasElement | null,
    getReady: () => isReady,
  });

  window.addEventListener('message', (event: MessageEvent<ReadyAckMessage>) => {
    const message = event.data;
    if (message && (message.type === MessageTypes.READY_ACK || message.type === 'READY_ACK')) {
      readyAcknowledged = true;
      if (readyInterval) {
        clearInterval(readyInterval);
        readyInterval = null;
      }
    }
  });

  const sendReady = (): void => {
    if (readyAcknowledged) return;

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'RENDER_FRAME_READY' }, '*');
      }
    } catch (e) {
      // Ignore errors
    }
  };

  worker.init();
  isReady = true;

  sendReady();
  readyInterval = setInterval(sendReady, 100);

  // Stop sending ready after 10 seconds
  setTimeout(() => {
    if (readyInterval) {
      clearInterval(readyInterval);
      readyInterval = null;
    }
  }, 10_000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
