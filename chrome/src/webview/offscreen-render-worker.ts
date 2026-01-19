// Chrome Offscreen Render Worker Adapter
// Bridges Chrome extension messaging with shared render-worker-core

import type { RendererThemeConfig } from '../../../src/types/index';

import { bootstrapRenderWorker } from '../../../src/renderers/worker/worker-bootstrap';
import { DirectFetchService } from '../../../src/renderers/worker/services';
import { DirectResourceService } from '../../../src/services';

import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { ChromeRuntimeTransport } from '../transports/chrome-runtime-transport';

// ============================================================================
// Platform API for Offscreen Worker
// ============================================================================

// Set up minimal platform API for services that need resource.fetch
// (e.g., StencilsService for DrawIO stencils)
globalThis.platform = {
  resource: new DirectResourceService((path) => chrome.runtime.getURL(path))
} as unknown as typeof globalThis.platform;

// ============================================================================

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sendOffscreenLifecycle(type: string, payload?: Record<string, unknown>): void {
  chrome.runtime
    .sendMessage({
      id: createRequestId(),
      type,
      payload: payload || {},
      timestamp: Date.now(),
      source: 'chrome-offscreen',
    })
    .catch(() => {
      // Ignore errors (e.g. background not ready)
    });
}

// Add error listeners for debugging
window.addEventListener('error', (event) => {
  const errorMessage = event.error?.message || 'Unknown error';
  sendOffscreenLifecycle('OFFSCREEN_ERROR', {
    error: errorMessage,
    filename: event.filename,
    lineno: event.lineno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const errorMessage = `Unhandled promise rejection: ${event.reason}`;
  sendOffscreenLifecycle('OFFSCREEN_ERROR', {
    error: errorMessage,
    filename: 'Promise',
    lineno: 0,
  });
});

// Optimize canvas performance on page load
document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.style.backgroundColor = 'transparent';
  document.body.style.backgroundColor = 'transparent';

  // Initialize render environment using shared bootstrap
  worker.init();

  // Send ready signal when DOM is loaded
  sendOffscreenLifecycle('OFFSCREEN_DOM_READY');
});

// Establish connection with background script for lifecycle monitoring
const port = chrome.runtime.connect({ name: 'offscreen' });

// Notify background script that offscreen document is ready
sendOffscreenLifecycle('OFFSCREEN_READY');

// Render RPC channel (offscreen only handles messages targeted to it)
// Uses willRespond: true because offscreen needs to send async responses
const renderChannel = new RenderChannel(new ChromeRuntimeTransport({ willRespond: true }), {
  source: 'chrome-offscreen',
  timeoutMs: 300000,
  acceptRequest: (msg) => {
    if (!msg || typeof msg !== 'object') return false;
    const target = (msg as { __target?: unknown }).__target;
    return target === 'offscreen';
  },
});

// Chrome offscreen can fetch directly (no CSP restrictions)
const directFetchService = new DirectFetchService();

const worker = bootstrapRenderWorker(renderChannel, {
  getCanvas: () => document.getElementById('png-canvas') as HTMLCanvasElement | null,
  // Offscreen document is always ready once loaded
  getReady: () => true,
  // Inject services for renderers
  services: {
    fetch: directFetchService,
  },
});
