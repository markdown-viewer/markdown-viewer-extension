/**
 * Firefox Render Worker (loaded as a separate <script> in background.html)
 *
 * Pulls in the heavy rendering libraries (Vega, Graphviz, DrawIO, etc.)
 * and bootstraps the render-worker pipeline.
 *
 * Separated from background.ts so that each file stays under the
 * 5 MB limit enforced by Firefox Add-ons (AMO).
 */

import { getWebExtensionApi } from '../../../src/utils/platform-info';
import { RenderTarget, isTargetedAt } from '../../../src/messaging/routing';
import { DirectResourceService } from '../../../src/services';
import { bootstrapRenderWorker } from '../../../src/renderers/worker/worker-bootstrap';
import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { ManualDispatchTransport } from './manual-dispatch-transport';

const browser = getWebExtensionApi();

// Platform API needed by renderers (e.g. StencilsService for DrawIO)
globalThis.platform = {
  resource: new DirectResourceService((path) => browser.runtime.getURL(path)),
} as unknown as typeof globalThis.platform;

// Transport shared with background.ts for message dispatching
const renderTransport = new ManualDispatchTransport();

const renderChannel = new RenderChannel(renderTransport, {
  source: 'firefox-background',
  timeoutMs: 300000,
  acceptRequest: (msg) => isTargetedAt(msg, RenderTarget.BackgroundRender),
});

const renderWorker = bootstrapRenderWorker(renderChannel, {
  getCanvas: () => document.getElementById('png-canvas') as HTMLCanvasElement | null,
  getReady: () => true,
});

// Initialize render worker when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    renderWorker.init();
  });
} else {
  renderWorker.init();
}

// Expose transport so background.ts can dispatch render messages to it
(globalThis as Record<string, unknown>).__renderTransport = renderTransport;
