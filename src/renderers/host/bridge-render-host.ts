import type { RenderHost } from './render-host';

import { RenderChannel } from '../../messaging/channels/render-channel';
import { RenderTarget } from '../../messaging/routing';
import type { MessageTransport } from '../../messaging/transports/transport';

/**
 * Render host for platforms where the render worker lives behind a host-side
 * supervisor instead of a document in the same runtime.
 *
 * Mobile is the case this exists for: the worker runs in the app's second,
 * hidden WebView, Dart owns both surfaces and relays between them
 * (see plans/mobile-render-view-webview-plan.md). The host side of that relay is
 * a plain MessageTransport, so this class holds no platform knowledge — it sends
 * render requests addressed to the render surface and asks the host for
 * readiness.
 */

export type BridgeRenderHostOptions = {
  /** Transport that reaches the supervisor (Dart), e.g. the Flutter relay channel. */
  transport: MessageTransport;
  /** Identifier of this side in message envelopes. */
  source: string;
  /** Request timeout for render work. */
  timeoutMs?: number;
  /** How long to wait for the render surface to report ready. */
  readyTimeoutMs?: number;
};

/** Reply of the supervisor's render-surface status request. */
type RenderSurfaceStatus = {
  state?: string;
  error?: string;
  renderers?: string[];
  readyMs?: number;
};

export class BridgeRenderHost implements RenderHost {
  private readonly transport: MessageTransport;
  private readonly source: string;
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;

  private channel: RenderChannel | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(options: BridgeRenderHostOptions) {
    this.transport = options.transport;
    this.source = options.source;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  }

  private getChannel(): RenderChannel {
    if (!this.channel) {
      this.channel = new RenderChannel(this.transport, {
        source: this.source,
        timeoutMs: this.timeoutMs,
      });
    }
    return this.channel;
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.probeUntilReady().catch((error) => {
        // Do not cache a failure: the surface may still finish coming up, and a
        // later render should be able to succeed.
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  /**
   * The supervisor answers once the surface is ready (or gives up after its own
   * budget), so this is one request rather than a poll: the queuing/retry logic
   * lives on the side that can see the surface's lifecycle.
   */
  private async probeUntilReady(): Promise<void> {
    const status = (await this.getChannel().send(
      'RENDER_VIEW_STATUS',
      {},
      { timeoutMs: this.readyTimeoutMs, target: RenderTarget.Host },
    )) as RenderSurfaceStatus;

    if (status?.state !== 'ready') {
      throw new Error(`Render view not ready: ${status?.state ?? 'unknown'}${status?.error ? ` (${status.error})` : ''}`);
    }
  }

  async send<T = unknown>(type: string, payload: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureReady();
    return (await this.getChannel().send(type, payload, {
      timeoutMs: timeoutMs ?? this.timeoutMs,
      target: RenderTarget.RenderView,
    })) as T;
  }

  async cleanup(): Promise<void> {
    this.channel?.close();
    this.channel = null;
    this.readyPromise = null;
  }
}
