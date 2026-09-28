/**
 * FlutterRelayTransport
 *
 * Raw transport for messages that cross *between* the app's two WebViews, with
 * Dart as the relay in the middle (see plans/mobile-render-view-webview-plan.md):
 *
 *   JS -> Dart   window.MarkdownViewerRender.postMessage(JSON.stringify(...))
 *   Dart -> JS   window.__receiveRenderMessage(payload)
 *
 * Both sides use this same class — Dart decides who a message belongs to from
 * *which controller* delivered it, so the channel names are identical on purpose.
 *
 * Kept deliberately separate from FlutterJsChannelTransport (the display
 * WebView's host-services channel): a render response must never be mistaken for
 * a service response, and vice versa.
 */

import type { MessageTransport, TransportMeta, Unsubscribe } from '../../../src/messaging/transports/transport';

declare global {
  interface Window {
    MarkdownViewerRender?: {
      postMessage: (message: string) => void;
    };
    __receiveRenderMessage?: (payload: unknown) => void;
  }
}

/** Channel Dart registers for render relay traffic (both WebViews use the name). */
export const RELAY_CHANNEL_NAME = 'MarkdownViewerRender';

/** Function Dart calls to deliver a relayed message. */
export const RELAY_INBOX_NAME = '__receiveRenderMessage';

export class FlutterRelayTransport implements MessageTransport {
  send(message: unknown): void {
    const json = JSON.stringify(message);
    const channel = window[RELAY_CHANNEL_NAME];
    if (channel && typeof channel.postMessage === 'function') {
      channel.postMessage(json);
      return;
    }
    // Parity with the host-services transport: a missing channel is logged, not
    // thrown — the render surface should stay usable for debugging in a plain
    // browser tab, where Dart is absent.
    // eslint-disable-next-line no-console
    console.warn('[FlutterRelayTransport] Relay channel not available');
  }

  onMessage(handler: (message: unknown, meta?: TransportMeta) => void): Unsubscribe {
    const previous = window[RELAY_INBOX_NAME];

    const meta: TransportMeta = {
      raw: { source: 'flutter-relay' },
      respond: (message: unknown) => {
        this.send(message);
      },
    };

    window[RELAY_INBOX_NAME] = (payload: unknown) => {
      handler(payload, meta);
      previous?.(payload);
    };

    // Also accept window.postMessage delivery, so the render page can be driven
    // from a desktop browser (and from the L1 protocol suites) without Dart.
    const postMessageListener = (event: MessageEvent) => handler(event.data, { raw: event, respond: meta.respond });
    window.addEventListener('message', postMessageListener);

    return () => {
      window.removeEventListener('message', postMessageListener);
      window[RELAY_INBOX_NAME] = previous;
    };
  }
}
