/**
 * Relay Chunking
 *
 * The mobile app talks to its hidden render WebView through the platform's
 * JavaScript bridge (Android's `JavascriptInterface`, iOS/macOS's
 * `WKScriptMessageHandler`). On Android that path is a Binder transaction, which
 * has a hard per-message size limit (community measurements: ~1 MB, with
 * ~512 KB already dangerous); a diagram's PNG base64 can exceed it on real
 * documents. A message that is too large does not fail loudly — it is dropped —
 * so the size has to be bounded *before* anything is sent
 * (see plans/mobile-render-view-webview-plan.md §5.2, risk R2).
 *
 * This module is that bound, and it is deliberately transport-level: it frames
 * an already-serialized message, so every kind of traffic (render requests,
 * responses, theme pushes, host requests, lifecycle events) is protected by the
 * same rule and no payload shape is special-cased.
 *
 * Rules:
 *   - a message at or below the limit is sent as it always was, untouched;
 *   - a larger message becomes N frames of `chunkSize` characters;
 *   - the sender never has more than `window` unacknowledged frames in flight,
 *     so a slow receiver cannot be flooded (the receiver ACKs each frame as soon
 *     as it has buffered it);
 *   - a stream that stops making progress is abandoned so it cannot wedge the
 *     queue forever, and the receiver drops idle streams for the same reason.
 *
 * Frames carry slices of the JSON *text*; the product of the reassembly is the
 * exact original string, so nothing downstream needs to know chunking exists.
 */

/** Frame types used by the relay's chunking layer (transport-level, not requests). */
export const RelayFrameTypes = {
  /** Page -> host: "I am listening; tell me the limits of this bridge". */
  HELLO: 'RELAY_HELLO',
  /** Host -> page: the per-platform limits this bridge can carry. */
  LIMITS: 'RELAY_LIMITS',
  /** Either direction: one slice of a larger message. */
  CHUNK: 'RELAY_CHUNK',
  /** Either direction: "frame N is buffered, send the next one". */
  ACK: 'RELAY_CHUNK_ACK',
} as const;

export type RelayFrameType = typeof RelayFrameTypes[keyof typeof RelayFrameTypes];

/**
 * Framing version. Both sides of the relay are built from this repository, so a
 * mismatch means one of them is a stale bundle (a real failure mode on mobile,
 * where the render page ships as a Flutter asset next to the app): the page logs
 * it instead of silently mis-framing.
 */
export const RelayProtocolVersion = 1;

export type RelayChunkLimits = {
  /** Largest serialized message allowed across the bridge in one piece. */
  maxMessageLength: number;
  /** Characters of the serialized message carried by one frame. */
  chunkSize: number;
  /** Frames in flight before the sender waits for an ACK. */
  window: number;
};

/**
 * Per-platform limits. `default` is the *conservative* profile (Android's): an
 * unknown bridge is treated as the tight one, because chunking too eagerly only
 * costs latency while chunking too late loses the message.
 */
export const RelayChunkProfiles: Record<'android' | 'apple' | 'default', RelayChunkLimits> = {
  android: { maxMessageLength: 192 * 1024, chunkSize: 128 * 1024, window: 1 },
  apple: { maxMessageLength: 8 * 1024 * 1024, chunkSize: 512 * 1024, window: 4 },
  default: { maxMessageLength: 192 * 1024, chunkSize: 128 * 1024, window: 1 },
};

export type RelayChunkProfileName = keyof typeof RelayChunkProfiles;

export function resolveRelayChunkLimits(profile?: string | null): RelayChunkLimits {
  const name = (profile ?? 'default') as RelayChunkProfileName;
  return RelayChunkProfiles[name] ?? RelayChunkProfiles.default;
}

/** Default budget for one frame's acknowledgement (a bridge round trip, not a network call). */
export const RelayAckTimeoutMs = 10_000;

/** Refuse to assemble more than this, whatever the sender claims (memory guard). */
export const RelayMaxAssembledLength = 64 * 1024 * 1024;

type ChunkFrame = {
  type: typeof RelayFrameTypes.CHUNK;
  streamId: string;
  index: number;
  total: number;
  /** Total characters of the whole message, so the receiver can verify the join. */
  length: number;
  data: string;
};

type ChunkAckFrame = {
  type: typeof RelayFrameTypes.ACK;
  streamId: string;
  index: number;
};

function readObject(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  return message as Record<string, unknown>;
}

export function isRelayChunkFrame(message: unknown): message is ChunkFrame {
  const obj = readObject(message);
  return Boolean(
    obj &&
      obj.type === RelayFrameTypes.CHUNK &&
      typeof obj.streamId === 'string' &&
      typeof obj.data === 'string' &&
      typeof obj.index === 'number' &&
      typeof obj.total === 'number' &&
      typeof obj.length === 'number',
  );
}

export function isRelayChunkAck(message: unknown): message is ChunkAckFrame {
  const obj = readObject(message);
  return Boolean(
    obj && obj.type === RelayFrameTypes.ACK && typeof obj.streamId === 'string' && typeof obj.index === 'number',
  );
}

export function isRelayLimits(message: unknown): boolean {
  const obj = readObject(message);
  return Boolean(obj && obj.type === RelayFrameTypes.LIMITS);
}

export function isRelayHello(message: unknown): boolean {
  const obj = readObject(message);
  return Boolean(obj && obj.type === RelayFrameTypes.HELLO);
}

/**
 * Reads the limits out of a `RELAY_LIMITS` payload, ignoring anything malformed.
 */
export function readRelayLimits(message: unknown): RelayChunkLimits | null {
  const obj = readObject(message);
  const payload = readObject(obj?.payload);
  if (!payload) {
    return null;
  }
  const maxMessageLength = payload.maxMessageLength;
  const chunkSize = payload.chunkSize;
  const window = payload.window;
  if (typeof maxMessageLength !== 'number' || typeof chunkSize !== 'number' || typeof window !== 'number') {
    return null;
  }
  if (maxMessageLength <= 0 || chunkSize <= 0 || window <= 0) {
    return null;
  }
  // A frame must fit in the message budget it is framed for.
  if (chunkSize > maxMessageLength) {
    return null;
  }
  return { maxMessageLength, chunkSize, window };
}

export type RelayChunkSenderOptions = {
  limits: RelayChunkLimits;
  /** Hands one frame to the bridge. */
  post: (frame: ChunkFrame) => void;
  /** Reports an abandoned stream (no ACK progress); diagnostics only. */
  onDrop?: (streamId: string, reason: string) => void;
  ackTimeoutMs?: number;
  now?: () => number;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

type OutgoingStream = {
  streamId: string;
  text: string;
  total: number;
  next: number;
  /** How many leading frames are acknowledged (a contiguous prefix). */
  acked: number;
  /** Acks that arrived ahead of the contiguous prefix. */
  ahead: Set<number>;
  timer: unknown;
  lastAckAt: number;
};

/**
 * Splits oversized messages into ACK-paced frames.
 *
 * One message = one stream; several streams may be open at once (a render
 * response while a theme push is in flight), each paced on its own.
 */
export class RelayChunkSender {
  private limits: RelayChunkLimits;
  private readonly post: (frame: ChunkFrame) => void;
  private readonly onDrop?: (streamId: string, reason: string) => void;
  private readonly ackTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, timeoutMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly streams = new Map<string, OutgoingStream>();
  private counter = 0;

  constructor(options: RelayChunkSenderOptions) {
    this.limits = options.limits;
    this.post = options.post;
    this.onDrop = options.onDrop;
    this.ackTimeoutMs = options.ackTimeoutMs ?? RelayAckTimeoutMs;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimeoutFn ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
    this.clearTimer = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Streams that still have frames to acknowledge. */
  get pendingStreams(): number {
    return this.streams.size;
  }

  /**
   * Adopts the limits the host published. Streams already in flight finish under
   * the old framing (their frames carry their own `total`/`length`); everything
   * sent afterwards uses the new one.
   */
  setLimits(limits: RelayChunkLimits): void {
    this.limits = limits;
  }

  /** The limits in force for new streams. */
  get currentLimits(): RelayChunkLimits {
    return this.limits;
  }

  /** Whether [text] needs framing at all. */
  needsChunking(text: string): boolean {
    return text.length > this.limits.maxMessageLength;
  }

  /**
   * Frames and sends [text]. Returns the stream id, or null when the text fits in
   * one message and was therefore not framed (the caller sends it as it is).
   */
  send(text: string): string | null {
    if (!this.needsChunking(text)) {
      return null;
    }

    this.counter += 1;
    const streamId = `s${this.counter}-${Date.now().toString(36)}`;
    const total = Math.ceil(text.length / this.limits.chunkSize);
    const stream: OutgoingStream = {
      streamId,
      text,
      total,
      next: 0,
      acked: 0,
      ahead: new Set<number>(),
      timer: null,
      lastAckAt: this.now(),
    };
    this.streams.set(streamId, stream);
    this.pump(stream);
    return streamId;
  }

  /** One frame was received by the peer. */
  handleAck(streamId: string, index: number): void {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }

    if (index < stream.acked || stream.ahead.has(index)) {
      // A duplicate ack (the peer answered twice): harmless.
      return;
    }
    stream.ahead.add(index);
    while (stream.ahead.delete(stream.acked)) {
      stream.acked += 1;
    }
    stream.lastAckAt = this.now();

    if (stream.acked >= stream.total) {
      this.finish(stream);
      return;
    }
    this.pump(stream);
  }

  /** Drops every open stream (transport teardown, page unload, test cleanup). */
  cancelAll(reason: string): void {
    for (const stream of [...this.streams.values()]) {
      this.finish(stream, reason);
    }
  }

  private pump(stream: OutgoingStream): void {
    while (
      this.streams.has(stream.streamId) &&
      stream.next < stream.total &&
      stream.next - stream.acked < this.limits.window
    ) {
      const index = stream.next;
      stream.next += 1;
      this.post({
        type: RelayFrameTypes.CHUNK,
        streamId: stream.streamId,
        index,
        total: stream.total,
        length: stream.text.length,
        data: stream.text.slice(index * this.limits.chunkSize, (index + 1) * this.limits.chunkSize),
      });
    }
    this.armTimeout(stream);
  }

  private armTimeout(stream: OutgoingStream): void {
    if (stream.timer !== null) {
      this.clearTimer(stream.timer);
      stream.timer = null;
    }
    if (stream.acked >= stream.total) {
      return;
    }
    const armedAt = this.now();
    stream.timer = this.setTimer(() => {
      // No progress since this timer was armed: the peer is gone or wedged.
      // Dropping the stream keeps every later message from queueing behind it
      // forever. An ack that landed in the meantime re-armed the timer already.
      if (stream.lastAckAt > armedAt) {
        this.armTimeout(stream);
        return;
      }
      this.finish(stream, `no ack for frame ${stream.acked + 1}/${stream.total} within ${this.ackTimeoutMs}ms`);
    }, this.ackTimeoutMs);
  }

  private finish(stream: OutgoingStream, reason?: string): void {
    if (stream.timer !== null) {
      this.clearTimer(stream.timer);
      stream.timer = null;
    }
    if (!this.streams.delete(stream.streamId)) {
      return;
    }
    if (reason) {
      this.onDrop?.(stream.streamId, reason);
    }
  }
}

export type RelayChunkReceiverOptions = {
  /** Receives the reassembled message text. */
  onMessage: (text: string) => void;
  /** Answers a buffered frame (the pacing signal the sender waits for). */
  ack: (streamId: string, index: number) => void;
  /** Reports a dropped stream (protocol error, oversize, idle); diagnostics only. */
  onDrop?: (streamId: string, reason: string) => void;
  maxAssembledLength?: number;
  idleTimeoutMs?: number;
  now?: () => number;
};

type IncomingStream = {
  streamId: string;
  parts: string[];
  /** Next index expected (frames arrive in order; the bridge does not reorder). */
  received: number;
  total: number;
  length: number;
  buffered: number;
  lastAt: number;
};

/**
 * Reassembles framed messages.
 *
 * Frames of one stream arrive in order (the bridge preserves message order and the
 * sender is window-paced), so assembly is a straight append. A duplicate frame —
 * the sender re-sent after a lost ack — is acknowledged again and not appended.
 */
export class RelayChunkReceiver {
  private readonly onMessage: (text: string) => void;
  private readonly ack: (streamId: string, index: number) => void;
  private readonly onDrop?: (streamId: string, reason: string) => void;
  private readonly maxAssembledLength: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  private readonly streams = new Map<string, IncomingStream>();

  constructor(options: RelayChunkReceiverOptions) {
    this.onMessage = options.onMessage;
    this.ack = options.ack;
    this.onDrop = options.onDrop;
    this.maxAssembledLength = options.maxAssembledLength ?? RelayMaxAssembledLength;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Streams still being assembled (diagnostics). */
  get openStreams(): number {
    return this.streams.size;
  }

  /**
   * Consumes chunk frames. Returns true when the message was part of the framing
   * layer (including malformed frames, which are dropped rather than forwarded).
   */
  handle(message: unknown): boolean {
    if (!isRelayChunkFrame(message)) {
      return false;
    }

    this.sweepIdle();

    const frame = message;
    if (
      frame.index < 0 ||
      frame.total <= 0 ||
      frame.index >= frame.total ||
      frame.length <= 0 ||
      frame.length > this.maxAssembledLength
    ) {
      this.ack(frame.streamId, frame.index);
      this.onDrop?.(frame.streamId, `invalid frame ${frame.index}/${frame.total} (${frame.length} chars)`);
      this.streams.delete(frame.streamId);
      return true;
    }

    let stream = this.streams.get(frame.streamId);
    if (!stream) {
      stream = {
        streamId: frame.streamId,
        parts: [],
        received: 0,
        total: frame.total,
        length: frame.length,
        buffered: 0,
        lastAt: this.now(),
      };
      this.streams.set(frame.streamId, stream);
    }

    if (frame.index < stream.received) {
      // Duplicate: the sender did not see our ack. Confirm it again.
      this.ack(frame.streamId, frame.index);
      return true;
    }

    if (frame.index !== stream.received || frame.total !== stream.total || frame.length !== stream.length) {
      this.ack(frame.streamId, frame.index);
      this.streams.delete(frame.streamId);
      this.onDrop?.(
        frame.streamId,
        `out-of-order or inconsistent frame: got index ${frame.index}/${frame.total}, expected ${stream.received}/${stream.total}`,
      );
      return true;
    }

    stream.parts.push(frame.data);
    stream.received += 1;
    stream.buffered += frame.data.length;
    stream.lastAt = this.now();
    this.ack(frame.streamId, frame.index);

    if (stream.buffered > this.maxAssembledLength) {
      this.streams.delete(frame.streamId);
      this.onDrop?.(frame.streamId, `assembled message exceeded ${this.maxAssembledLength} chars`);
      return true;
    }

    if (stream.received === stream.total) {
      this.streams.delete(frame.streamId);
      const text = stream.parts.join('');
      if (text.length !== stream.length) {
        this.onDrop?.(frame.streamId, `reassembled ${text.length} chars, expected ${stream.length}`);
        return true;
      }
      this.onMessage(text);
    }

    return true;
  }

  /**
   * Drops streams whose sender went away mid-transfer. Checked lazily on the next
   * frame instead of on a timer: the render surface is a hidden document, where
   * interval timers are throttled (see plan §3.1).
   */
  private sweepIdle(): void {
    const now = this.now();
    for (const [streamId, stream] of [...this.streams]) {
      if (now - stream.lastAt >= this.idleTimeoutMs) {
        this.streams.delete(streamId);
        this.onDrop?.(streamId, `idle for ${now - stream.lastAt}ms at frame ${stream.received}/${stream.total}`);
      }
    }
  }
}
