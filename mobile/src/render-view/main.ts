/**
 * Mobile Render View entry point.
 *
 * The diagram engine's own hidden WebView (see
 * plans/mobile-render-view-webview-plan.md). It is the mobile counterpart of the
 * Chrome offscreen document: same shared worker bootstrap, same render request
 * types, different transport — messages are relayed by Dart instead of by
 * `chrome.runtime`, and resources are fetched through the host instead of from a
 * shared origin.
 *
 * Design rules that come from the hidden-surface measurements (§3.1 of the plan):
 *   - never depend on `requestAnimationFrame` or `setInterval` — a hidden surface
 *     does not get animation frames and its intervals are throttled, while
 *     `setTimeout` keeps its normal timing;
 *   - announce readiness and uncaught errors over the relay, because nothing else
 *     can see this surface (no console in the app's logs, no Flutter widget).
 */

import { RenderChannel } from '../../../src/messaging/channels/render-channel';
import { RenderTarget, isTargetedAt } from '../../../src/messaging/routing';
import { getAvailableRenderers } from '../../../src/renderers/render-worker-core';
import { bootstrapRenderWorker } from '../../../src/renderers/worker/worker-bootstrap';
import { FlutterRelayTransport } from '../transports/flutter-relay-transport';

import { RelayResourceService } from './relay-resource-service';
import {
  RenderSurfaceMessageTypes,
  type RenderSurfaceErrorPayload,
  type RenderSurfaceReadyPayload,
} from './protocol';

let isReady = false;

const channel = new RenderChannel(new FlutterRelayTransport(), {
  source: 'mobile-render-view',
  timeoutMs: 60_000,
  // Only render requests addressed to this surface are handled here; host
  // service traffic (storage, files) belongs to the display side.
  acceptRequest: (message) => isTargetedAt(message, RenderTarget.RenderView),
});

// Minimal platform API for the shared services that need it (DrawIO stencils).
globalThis.platform = {
  resource: new RelayResourceService(channel),
} as unknown as typeof globalThis.platform;

const worker = bootstrapRenderWorker(channel, {
  getCanvas: () => document.getElementById('png-canvas') as HTMLCanvasElement | null,
  getReady: () => isReady,
});

function announceReady(): void {
  const payload: RenderSurfaceReadyPayload = {
    renderers: getAvailableRenderers(),
    // The surface renders into a fixed 1400px-wide layout (same as the iframe it
    // replaces); reporting it makes a mis-sized surface visible in the logs.
    bodyWidth: document.body ? Math.round(document.body.getBoundingClientRect().width) : 0,
  };
  channel.post(RenderSurfaceMessageTypes.READY, payload);
}

function announceError(payload: RenderSurfaceErrorPayload): void {
  channel.post(RenderSurfaceMessageTypes.ERROR, payload);
}

// Nothing else sees this surface's failures, so report them over the relay.
window.addEventListener('error', (event) => {
  announceError({
    message: event.error instanceof Error ? event.error.message : String(event.message || 'Unknown error'),
    filename: event.filename,
    lineno: event.lineno,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  announceError({
    message: reason instanceof Error ? reason.message : `Unhandled promise rejection: ${String(reason)}`,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

function initialize(): void {
  worker.init();
  isReady = true;
  channel.post(RenderSurfaceMessageTypes.DOM_READY, {});
  announceReady();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
