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
import { DirectFetchService, ProxyFetchService, type FetchService } from '../../../src/renderers/worker/services';
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

/**
 * Detect if running in VSCode srcdoc iframe
 * VSCode uses srcdoc which results in about:srcdoc URL
 * Mobile uses iframe src URL which is different
 */
function isVSCodeSrcdoc(): boolean {
  try {
    // srcdoc iframes have location.href === 'about:srcdoc'
    return window.location.href === 'about:srcdoc';
  } catch {
    return false;
  }
}

/**
 * Create appropriate fetch service based on environment
 */
function createFetchService(): FetchService {
  if (isVSCodeSrcdoc()) {
    // VSCode srcdoc cannot fetch directly due to CSP, use proxy
    return new ProxyFetchService();
  } else {
    // Mobile/other can fetch directly
    return new DirectFetchService();
  }
}

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

  // Create appropriate fetch service based on environment
  const fetchService = createFetchService();

  const worker = bootstrapRenderWorker(renderChannel, {
    getCanvas: () => document.getElementById('png-canvas') as HTMLCanvasElement | null,
    getReady: () => isReady,
    // Inject services for renderers
    services: {
      fetch: fetchService,
    },
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
