/**
 * Direct Transport
 *
 * Creates a pair of in-memory connected transports for same-process
 * communication. A.send() triggers B.onMessage() and vice versa.
 *
 * Replaces postMessage-based transport when host and webview run in the
 * same JavaScript context (e.g. Obsidian plugins).
 */

import type { MessageTransport, TransportMeta, Unsubscribe } from '../../../src/messaging/transports/transport';

/**
 * Create a connected pair of transports: [hostTransport, webviewTransport].
 *
 * Messages sent on one end are delivered synchronously (via microtask) to
 * handlers registered on the other end.
 */
export function createDirectTransportPair(): [MessageTransport, MessageTransport] {
  type Handler = (message: unknown, meta?: TransportMeta) => void;

  let handlerA: Handler | null = null;
  let handlerB: Handler | null = null;

  const transportA: MessageTransport = {
    send(message: unknown) {
      // A sends → B receives (async to match postMessage timing)
      const handler = handlerB;
      if (handler) {
        Promise.resolve().then(() => handler(message));
      }
    },
    onMessage(handler: Handler): Unsubscribe {
      handlerA = handler;
      return () => { handlerA = null; };
    },
    close() {
      handlerA = null;
    },
  };

  const transportB: MessageTransport = {
    send(message: unknown) {
      // B sends → A receives
      const handler = handlerA;
      if (handler) {
        Promise.resolve().then(() => handler(message));
      }
    },
    onMessage(handler: Handler): Unsubscribe {
      handlerB = handler;
      return () => { handlerB = null; };
    },
    close() {
      handlerB = null;
    },
  };

  return [transportA, transportB];
}
