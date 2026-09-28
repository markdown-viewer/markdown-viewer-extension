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
 *
 * Size is bounded here (§5.2, risk R2): a serialized message larger than this
 * bridge's limit is framed into ack-paced chunks and reassembled on the other
 * side, so a multi-megabyte diagram result cannot be silently dropped by the
 * bridge (Android's JavaScriptInterface is a Binder transaction; the probe carried
 * 4 MB on WKWebView). Dart publishes the per-platform limits when asked; until
 * that reply arrives the conservative profile is used, because framing too eagerly
 * only costs latency.
 */

import {
  RelayChunkReceiver,
  RelayChunkSender,
  RelayFrameTypes,
  RelayProtocolVersion,
  isRelayChunkAck,
  isRelayLimits,
  readRelayLimits,
  resolveRelayChunkLimits,
  type RelayChunkLimits,
} from '../../../src/messaging/relay-chunking';
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

export type FlutterRelayTransportOptions = {
  /** Starts with these limits instead of the conservative profile (tests). */
  limits?: RelayChunkLimits;
  /** Per-frame ack budget (tests use a short one). */
  ackTimeoutMs?: number;
  /** Diagnostics sink; defaults to a console warning. */
  onDiagnostic?: (message: string) => void;
};

export class FlutterRelayTransport implements MessageTransport {
  private limits: RelayChunkLimits;
  private readonly sender: RelayChunkSender;
  private readonly receiver: RelayChunkReceiver;
  private readonly onDiagnostic?: (message: string) => void;

  private announced = false;
  private reportedProtocol: number | null = null;
  private inboundHandler: ((message: unknown, meta?: TransportMeta) => void) | null = null;
  private inboundMeta: TransportMeta | undefined;

  constructor(options: FlutterRelayTransportOptions = {}) {
    this.limits = options.limits ?? resolveRelayChunkLimits();
    this.onDiagnostic = options.onDiagnostic;
    this.sender = new RelayChunkSender({
      limits: this.limits,
      post: (frame) => this.postFrame(frame),
      onDrop: (streamId, reason) => this.diagnose(`chunk stream ${streamId} dropped: ${reason}`),
      ...(options.ackTimeoutMs ? { ackTimeoutMs: options.ackTimeoutMs } : null),
    });
    this.receiver = new RelayChunkReceiver({
      onMessage: (text) => this.deliverAssembled(text),
      ack: (streamId, index) => this.postFrame({ type: RelayFrameTypes.ACK, streamId, index }),
      onDrop: (streamId, reason) => this.diagnose(`chunk stream ${streamId} dropped: ${reason}`),
    });
  }

  /** Limits in force (Dart's reply, or the conservative default before it arrives). */
  get chunkLimits(): RelayChunkLimits {
    return this.limits;
  }

  /** Protocol version Dart answered with (null until the limits reply arrives). */
  get relayProtocol(): number | null {
    return this.reportedProtocol;
  }

  send(message: unknown): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (!this.sender.needsChunking(text)) {
      this.postText(text);
      return;
    }
    this.sender.send(text);
  }

  onMessage(handler: (message: unknown, meta?: TransportMeta) => void): Unsubscribe {
    const previous = window[RELAY_INBOX_NAME];

    const meta: TransportMeta = {
      raw: { source: 'flutter-relay' },
      respond: (message: unknown) => {
        this.send(message);
      },
    };
    this.inboundHandler = handler;
    this.inboundMeta = meta;

    // A diagnostics wrapper installed by the page (mobile/src/webview/main.ts)
    // sees what actually arrived on the wire; the chunk layer decides what reaches
    // the channel, and hands reassembled messages to the same handler.
    const relayMessage = (payload: unknown): void => {
      this.handleIncoming(payload);
    };

    window[RELAY_INBOX_NAME] = (payload: unknown) => {
      relayMessage(payload);
      previous?.(payload);
    };

    // Also accept window.postMessage delivery, so the render page can be driven
    // from a desktop browser (and from the L1 protocol suites) without Dart.
    const postMessageListener = (event: MessageEvent) => relayMessage(event.data);
    window.addEventListener('message', postMessageListener);

    this.announce();

    return () => {
      window.removeEventListener('message', postMessageListener);
      window[RELAY_INBOX_NAME] = previous;
      this.inboundHandler = null;
      this.inboundMeta = undefined;
      this.sender.cancelAll('transport detached');
    };
  }

  /**
   * Tells Dart this side is listening, so it replies with the limits of the bridge
   * it is on. Asking rather than being told removes the ordering question:
   * whichever WebView boots first learns the limits before it sends much.
   */
  private announce(): void {
    if (this.announced) {
      return;
    }
    this.announced = true;
    this.postText(JSON.stringify({
      type: RelayFrameTypes.HELLO,
      protocol: RelayProtocolVersion,
      payload: {},
    }));
  }

  private handleIncoming(payload: unknown): void {
    const message = typeof payload === 'string' ? safeParse(payload) : payload;

    if (isRelayLimits(message)) {
      this.adoptLimits(message);
      return;
    }

    if (isRelayChunkAck(message)) {
      this.sender.handleAck(message.streamId, message.index);
      return;
    }

    if (this.receiver.handle(message)) {
      return;
    }

    this.inboundHandler?.(message, this.inboundMeta);
  }

  private adoptLimits(message: unknown): void {
    const protocol = (message as { protocol?: unknown }).protocol;
    this.reportedProtocol = typeof protocol === 'number' ? protocol : null;
    if (this.reportedProtocol !== null && this.reportedProtocol !== RelayProtocolVersion) {
      this.diagnose(
        `relay protocol mismatch: bridge speaks v${this.reportedProtocol}, this bundle speaks v${RelayProtocolVersion} (stale page bundle?)`,
      );
    }

    const limits = readRelayLimits(message);
    if (!limits) {
      this.diagnose('ignoring malformed RELAY_LIMITS payload');
      return;
    }
    this.limits = limits;
    // Streams already in flight finish under the old framing (their frames carry
    // their own total/length); everything sent afterwards uses the new one.
    this.sender.setLimits(limits);
  }

  /** One reassembled (or small) message for the channel. */
  private deliverAssembled(text: string): void {
    const message = safeParse(text);
    if (!this.inboundHandler) {
      this.diagnose('reassembled message arrived with no subscriber; dropped');
      return;
    }
    this.inboundHandler(message, this.inboundMeta);
  }

  private postText(text: string): void {
    const channel = window[RELAY_CHANNEL_NAME];
    if (channel && typeof channel.postMessage === 'function') {
      channel.postMessage(text);
      return;
    }
    // Parity with the host-services transport: a missing channel is logged, not
    // thrown — the render surface should stay usable for debugging in a plain
    // browser tab, where Dart is absent.
    // eslint-disable-next-line no-console
    console.warn('[FlutterRelayTransport] Relay channel not available');
  }

  private postFrame(frame: unknown): void {
    this.postText(JSON.stringify(frame));
  }

  private diagnose(message: string): void {
    if (this.onDiagnostic) {
      this.onDiagnostic(message);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[FlutterRelayTransport] ${message}`);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

