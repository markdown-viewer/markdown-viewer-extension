/**
 * BaseMessageChannel
 *
 * Implements request/response correlation, timeouts and listener dispatch.
 */

import type { ResponseEnvelope } from '../types/messaging';
import type { MessageTransport, TransportMeta, Unsubscribe } from './transports/transport';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ChannelOptions = {
  timeoutMs?: number;
  debug?: boolean;
  source?: string;

  /**
   * Optional filter to decide whether an incoming request should be handled.
   * If it returns false, the request is ignored and no response is sent.
   */
  acceptRequest?: (message: unknown, meta?: TransportMeta) => boolean;
};

export abstract class BaseMessageChannel {
  protected readonly transport: MessageTransport;
  protected readonly timeoutMs: number;
  protected readonly debug: boolean;
  protected readonly source?: string;
  protected readonly acceptRequest?: (message: unknown, meta?: TransportMeta) => boolean;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<(payload: unknown, meta?: unknown) => unknown>>();
  private readonly anyListeners = new Set<(message: unknown, meta?: TransportMeta) => void>();
  private readonly requestHandlers = new Map<string, (payload: unknown, meta?: TransportMeta) => unknown>();
  private unsubscribe?: Unsubscribe;
  private counter = 0;

  constructor(transport: MessageTransport, options: ChannelOptions = {}) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.debug = options.debug ?? false;
    this.source = options.source;
    this.acceptRequest = options.acceptRequest;

    this.unsubscribe = this.transport.onMessage((message, meta) => {
      this.handleIncoming(message, meta);
    });
  }

  protected nextId(): string {
    this.counter += 1;
    return `${Date.now()}-${this.counter}`;
  }

  /**
   * Normalize a raw message into either a ResponseEnvelope or a request-like object.
   *
   * This base implementation only handles JSON string payloads (some transports
   * deliver envelopes as JSON).
   */
  protected normalizeIncoming(message: unknown): unknown {
    if (typeof message === 'string') {
      try {
        return JSON.parse(message);
      } catch {
        return message;
      }
    }

    if (!message || typeof message !== 'object') return message;
    return message;
  }

  protected isResponseEnvelope(message: unknown): message is ResponseEnvelope {
    return Boolean(
      message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'RESPONSE' &&
        typeof (message as { requestId?: unknown }).requestId === 'string'
    );
  }

  protected handleIncoming(raw: unknown, meta?: unknown): void {
    const transportMeta = meta as TransportMeta | undefined;
    const message = this.normalizeIncoming(raw);

    if (this.isResponseEnvelope(message)) {
      this.handleResponse(message);
      return;
    }

    // Notify any-listeners (for push-style message consumption).
    for (const listener of this.anyListeners) {
      try {
        listener(message, transportMeta);
      } catch (err) {
        if (this.debug) {
          // eslint-disable-next-line no-console
          console.error('[BaseMessageChannel] onAny error', err);
        }
      }
    }

    if (!message || typeof message !== 'object') return;

    const type = (message as { type?: unknown }).type;
    const payload = (message as { payload?: unknown }).payload;
    const id = (message as { id?: unknown }).id;

    if (typeof type !== 'string') return;

    // Request handler (RPC)
    if (typeof id === 'string' && this.requestHandlers.has(type)) {
      if (this.acceptRequest && this.acceptRequest(message, transportMeta) === false) {
        return;
      }
      const handler = this.requestHandlers.get(type)!;
      Promise.resolve()
        .then(() => handler(payload, transportMeta))
        .then((data) => {
          const response: ResponseEnvelope = {
            type: 'RESPONSE',
            requestId: id,
            ok: true,
            data,
          };
          if (transportMeta?.respond) {
            transportMeta.respond(response);
          } else {
            void this.transport.send(response);
          }
        })
        .catch((err) => {
          const error = err as Error;
          const response: ResponseEnvelope = {
            type: 'RESPONSE',
            requestId: id,
            ok: false,
            error: {
              code: (error as unknown as { code?: string }).code,
              message: error?.message || 'Unknown error',
              details: (error as unknown as { details?: unknown }).details,
            },
          };
          if (transportMeta?.respond) {
            transportMeta.respond(response);
          } else {
            void this.transport.send(response);
          }
        });
      return;
    }

    const handlers = this.listeners.get(type);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        handler(payload, transportMeta);
      } catch (err) {
        // Intentionally swallow to isolate handlers.
        if (this.debug) {
          // eslint-disable-next-line no-console
          console.error('[BaseMessageChannel] handler error', err);
        }
      }
    }
  }

  protected handleResponse(response: ResponseEnvelope): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);

    if (response.ok) {
      pending.resolve(response.data);
      return;
    }

    const message = response.error?.message || 'Unknown error';
    const error = new Error(message);
    (error as unknown as { code?: string; details?: unknown }).code = response.error?.code;
    (error as unknown as { code?: string; details?: unknown }).details = response.error?.details;
    pending.reject(error);
  }

  on(type: string, handler: (payload: unknown, meta?: unknown) => unknown): Unsubscribe {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
    return () => this.off(type, handler);
  }

  /**
   * Subscribe to all non-response inbound messages.
   */
  onAny(handler: (message: unknown, meta?: TransportMeta) => void): Unsubscribe {
    this.anyListeners.add(handler);
    return () => this.anyListeners.delete(handler);
  }

  off(type: string, handler: (payload: unknown, meta?: unknown) => unknown): void {
    this.listeners.get(type)?.delete(handler);
  }

  async send(
    type: string,
    payload: unknown,
    options: { timeoutMs?: number; target?: string } = {},
  ): Promise<unknown> {
    const id = this.nextId();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    const envelope = {
      id,
      type,
      payload,
      timestamp: Date.now(),
      ...(this.source ? { source: this.source } : null),
      // Transport-level routing hint (see src/messaging/routing.ts). A surface
      // that shares one bus with others (and with host services) says who the
      // message is for; the payload stays untouched.
      ...(options.target ? { __target: options.target } : null),
    };

    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Message timeout: ${type} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });

    const maybeResponse = await this.transport.send(envelope);

    // Some transports can return an immediate response (e.g. chrome.runtime.sendMessage callback).
    if (maybeResponse !== undefined) {
      this.handleIncoming(maybeResponse, { raw: 'send-return' } satisfies TransportMeta);
    }
    return result;
  }

  post(type: string, payload: unknown, options: { target?: string } = {}): void {
    const envelope = {
      id: this.nextId(),
      type,
      payload,
      timestamp: Date.now(),
      ...(this.source ? { source: this.source } : null),
      ...(options.target ? { __target: options.target } : null),
    };

    void this.transport.send(envelope);
  }

  /**
   * Register a request handler.
   */
  handle(type: string, handler: (payload: unknown, meta?: TransportMeta) => unknown): Unsubscribe {
    this.requestHandlers.set(type, handler);
    return () => {
      if (this.requestHandlers.get(type) === handler) {
        this.requestHandlers.delete(type);
      }
    };
  }

  close(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel closed'));
      this.pending.delete(id);
    }
    this.listeners.clear();
    this.unsubscribe?.();
    this.transport.close?.();
  }
}
