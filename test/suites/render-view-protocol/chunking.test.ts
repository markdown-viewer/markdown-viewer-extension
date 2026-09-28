/**
 * Relay framing contract: chunking.
 *
 * The app's JavaScript bridge has a per-message size limit (Android's
 * `JavascriptInterface` is a Binder transaction, ~1 MB with ~512 KB already
 * dangerous; WKWebView carried 4 MB in the probe) and a message that is too large
 * is *dropped*, not rejected — so nothing may ever hand an oversized message to
 * the bridge. `src/messaging/relay-chunking.ts` is the bound, and these cases pin
 * the framing rules themselves, without a device or a browser:
 *
 *   - small messages pass through untouched (the common case must not pay for it);
 *   - a large message arrives byte-identical after reassembly;
 *   - slices are code units, so a slice boundary may split a surrogate pair and
 *     the join still yields the original string;
 *   - the sender never has more than `window` frames in flight;
 *   - a peer that stops acking cannot wedge the queue (the stream is dropped);
 *   - the receiver never assembles more than its cap, and drops what contradicts
 *     what it was told.
 *
 * The mirror cases on the Dart side (`mobile/test/services/relay_chunking_test.dart`)
 * use the same fixtures, so the two implementations cannot drift apart silently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RelayChunkProfiles,
  RelayChunkReceiver,
  RelayChunkSender,
  RelayFrameTypes,
  RelayProtocolVersion,
  readRelayLimits,
  resolveRelayChunkLimits,
  type RelayChunkLimits,
} from '../../../src/messaging/relay-chunking';

/**
 * Fixture shared with the Dart mirror. CJK + a variation selector + an astral
 * emoji: 6 UTF-16 code units per unit, so a 515-code-unit chunk boundary lands in
 * the middle of the astral pair (the case both sides must survive).
 */
const SHARED_FIXTURE = '图表\u26F0\uFE0F\u{1F680}'.repeat(1000);

/** Chunk size that splits an astral pair: 6 * 85 = 510, +4 = 514 → the pair sits at 514/515. */
const SHARED_SPLIT_CHUNK = 515;

const KIB = 1024;

function limits(overrides: Partial<RelayChunkLimits> = {}): RelayChunkLimits {
  return { maxMessageLength: 4 * KIB, chunkSize: 512, window: 1, ...overrides };
}

type WireFrame = {
  type: string;
  streamId: string;
  index: number;
  total: number;
  length: number;
  data: string;
};

type Link = {
  sender: RelayChunkSender;
  receiver: RelayChunkReceiver;
  /** Frames the sender handed to the bridge, oldest first. */
  inFlight: WireFrame[];
  /** Messages the receiver reassembled. */
  delivered: string[];
  /** Dropped streams, as `streamId: reason`. */
  drops: string[];
  /** Ack indexes the receiver sent, in order. */
  acks: number[];
  /** Delivers everything in flight, in order (the bridge does not reorder). */
  pump: () => void;
  /** Highest number of frames that were in flight at once. */
  peakInFlight: () => number;
};

/**
 * A synchronous link: the sender's frames queue up and `pump()` delivers them one
 * by one, the receiver acks each of them. Nothing is delivered that was not acked,
 * which is exactly the pacing rule under test.
 */
function createLink(linkLimits: RelayChunkLimits): Link {
  const inFlight: WireFrame[] = [];
  const delivered: string[] = [];
  const drops: string[] = [];
  const acks: number[] = [];
  let peak = 0;

  const sender = new RelayChunkSender({
    limits: linkLimits,
    post: (frame) => {
      inFlight.push(frame as WireFrame);
      peak = Math.max(peak, inFlight.length);
    },
    onDrop: (streamId, reason) => drops.push(`${streamId}: ${reason}`),
  });

  const receiver = new RelayChunkReceiver({
    onMessage: (text) => delivered.push(text),
    ack: (streamId, index) => {
      acks.push(index);
      sender.handleAck(streamId, index);
    },
    onDrop: (streamId, reason) => drops.push(`${streamId}: ${reason}`),
  });

  return {
    sender,
    receiver,
    inFlight,
    delivered,
    drops,
    acks,
    pump: () => {
      while (inFlight.length > 0) {
        receiver.handle(inFlight.shift());
      }
    },
    peakInFlight: () => peak,
  };
}

describe('relay chunking: limits', () => {
  it('uses the conservative profile for an unknown bridge', () => {
    assert.deepEqual(resolveRelayChunkLimits(), RelayChunkProfiles.default);
    assert.deepEqual(resolveRelayChunkLimits('nope'), RelayChunkProfiles.default);
    // Android's Binder path is the tight one; the default must not be the roomy one.
    assert.equal(RelayChunkProfiles.default.maxMessageLength, RelayChunkProfiles.android.maxMessageLength);
    assert.ok(RelayChunkProfiles.default.maxMessageLength < RelayChunkProfiles.apple.maxMessageLength);
  });

  it('accepts a well-formed limits payload and rejects contradictory ones', () => {
    const message = {
      type: RelayFrameTypes.LIMITS,
      protocol: RelayProtocolVersion,
      payload: { maxMessageLength: 1024, chunkSize: 512, window: 2 },
    };
    assert.deepEqual(readRelayLimits(message), { maxMessageLength: 1024, chunkSize: 512, window: 2 });

    // A frame must fit inside the budget it is framed for.
    assert.equal(
      readRelayLimits({ ...message, payload: { maxMessageLength: 512, chunkSize: 1024, window: 1 } }),
      null,
    );
    assert.equal(readRelayLimits({ ...message, payload: { maxMessageLength: 0, chunkSize: 1, window: 1 } }), null);
    assert.equal(readRelayLimits({ ...message, payload: { chunkSize: 512, window: 1 } }), null);
    assert.equal(readRelayLimits({ type: RelayFrameTypes.LIMITS }), null);
  });
});

describe('relay chunking: sender and receiver', () => {
  it('passes a message at the limit through untouched', () => {
    const link = createLink(limits({ maxMessageLength: 64, chunkSize: 32 }));
    assert.equal(link.sender.needsChunking('x'.repeat(64)), false);
    assert.equal(link.sender.needsChunking('x'.repeat(65)), true);

    link.sender.send('x'.repeat(64));
    assert.equal(link.inFlight.length, 0, 'a message within the limit must not be framed');
    assert.equal(link.sender.pendingStreams, 0);
  });

  it('reassembles an oversized message exactly', () => {
    const link = createLink(limits({ maxMessageLength: 256, chunkSize: 128 }));
    const text = JSON.stringify({ type: 'RESPONSE', data: SHARED_FIXTURE });
    assert.ok(link.sender.needsChunking(text));

    link.sender.send(text);
    // Window 1: exactly one frame may be in flight until it is acknowledged.
    assert.equal(link.inFlight.length, 1);
    assert.equal(link.inFlight[0].type, RelayFrameTypes.CHUNK);

    link.pump();
    assert.deepEqual(link.delivered, [text]);
    assert.deepEqual(link.drops, []);
    // The message took several frames, and every one of them fit the chunk size.
    assert.ok(link.acks.length > 1, `expected several frames, got ${link.acks.length}`);
  });

  it('slices on code units, so a split surrogate pair still joins exactly', () => {
    const link = createLink(
      limits({ maxMessageLength: 4 * SHARED_SPLIT_CHUNK, chunkSize: SHARED_SPLIT_CHUNK, window: 2 }),
    );
    link.sender.send(SHARED_FIXTURE);
    // The shared fixture's 86th unit starts at code unit 510: the astral emoji's
    // high surrogate is the last code unit of frame 0, the low surrogate the first
    // of frame 1. Both frames therefore carry a lone surrogate *as text*.
    assert.equal(link.inFlight[0].data.length, SHARED_SPLIT_CHUNK);
    const high = link.inFlight[0].data.charCodeAt(SHARED_SPLIT_CHUNK - 1);
    const low = link.inFlight[1].data.charCodeAt(0);
    assert.equal(high, SHARED_FIXTURE.charCodeAt(514));
    assert.ok(high >= 0xd800 && high <= 0xdbff, `frame 0 ends on a high surrogate (got ${high.toString(16)})`);
    assert.ok(low >= 0xdc00 && low <= 0xdfff, `frame 1 starts on a low surrogate (got ${low.toString(16)})`);

    link.pump();
    assert.deepEqual(link.delivered, [SHARED_FIXTURE]);
    // The join reproduces the original string, astral characters included.
    assert.equal(link.delivered[0].length, SHARED_FIXTURE.length);
    assert.ok(link.delivered[0].includes('\u{1F680}'));
  });

  it('keeps at most `window` frames in flight', () => {
    const single = createLink(limits({ maxMessageLength: 512, chunkSize: 128, window: 1 }));
    single.sender.send('y'.repeat(700));
    assert.equal(single.inFlight.length, 1, 'window 1 must wait for an ack before the second frame');

    const wide = createLink(limits({ maxMessageLength: 512, chunkSize: 128, window: 3 }));
    wide.sender.send('y'.repeat(700));
    assert.equal(wide.inFlight.length, 3);

    wide.pump();
    assert.equal(wide.delivered[0].length, 700);
    assert.ok(wide.peakInFlight() <= 3, `peak in flight was ${wide.peakInFlight()}`);
  });

  it('asks for the next frame only after each ack', () => {
    const link = createLink(limits({ maxMessageLength: 512, chunkSize: 128, window: 1 }));
    link.sender.send('z'.repeat(600));

    // Deliver one frame at a time: the next frame exists only after the ack.
    let delivered = 0;
    while (link.inFlight.length > 0 || link.receiver.openStreams > 0) {
      const frame = link.inFlight.shift();
      assert.ok(frame, 'the sender ran out of frames while the message was incomplete');
      link.receiver.handle(frame);
      delivered += 1;
      if (link.delivered.length > 0) {
        break;
      }
      assert.ok(link.inFlight.length <= 1, 'window 1 must never have two frames in flight');
    }
    assert.equal(link.delivered[0].length, 600);
    assert.ok(delivered > 1);
  });

  it('acknowledges a duplicate frame without appending it twice', () => {
    const link = createLink(limits({ maxMessageLength: 256, chunkSize: 128 }));
    const text = 'd'.repeat(300);
    link.sender.send(text);

    const first = link.inFlight.shift();
    assert.ok(first);
    link.receiver.handle(first);
    // The ack was lost, so the sender re-sends frame 0. A duplicate must not be
    // appended, and it must be acknowledged again.
    link.receiver.handle(first);
    link.pump();

    assert.deepEqual(link.delivered, [text]);
    assert.equal(link.acks.filter((index) => index === 0).length, 2);
  });

  it('tolerates acks arriving ahead of the contiguous prefix', () => {
    const link = createLink(limits({ maxMessageLength: 200, chunkSize: 100, window: 4 }));
    link.sender.send('a'.repeat(350));
    assert.equal(link.inFlight.length, 4);

    const frames = [...link.inFlight];
    // Ack out of order: the window advances once the prefix is complete.
    link.receiver.handle(frames[2]);
    link.receiver.handle(frames[0]);
    link.receiver.handle(frames[3]);
    link.receiver.handle(frames[1]);

    while (link.inFlight.length > 0) {
      link.receiver.handle(link.inFlight.shift());
    }
    assert.equal(link.delivered[0].length, 350);
  });
});

describe('relay chunking: failure paths', () => {
  it('drops a stream whose peer stops acking, and keeps sending later messages', () => {
    let now = 0;
    const timers: Array<() => void> = [];
    const inFlight: WireFrame[] = [];
    const drops: string[] = [];
    const sender = new RelayChunkSender({
      limits: limits({ maxMessageLength: 256, chunkSize: 128, window: 1 }),
      post: (frame) => inFlight.push(frame as WireFrame),
      onDrop: (streamId, reason) => drops.push(`${streamId}: ${reason}`),
      ackTimeoutMs: 1000,
      now: () => now,
      setTimeoutFn: (handler) => {
        timers.push(handler);
        return timers.length - 1;
      },
      clearTimeoutFn: () => {},
    });

    sender.send('q'.repeat(400));
    assert.equal(inFlight.length, 1);
    assert.equal(sender.pendingStreams, 1);

    // The peer never acks; the budget expires.
    now = 1000;
    for (const fire of timers.splice(0)) {
      fire();
    }
    assert.equal(sender.pendingStreams, 0, 'a wedged stream must not stay open forever');
    assert.match(drops[0], /no ack for frame 1\/4 within 1000ms/);

    // The next message is framed and sent as usual (nothing queued behind it).
    const before = inFlight.length;
    sender.send('w'.repeat(400));
    assert.equal(inFlight.length, before + 1);
  });

  it('drops a stream that contradicts what it announced', () => {
    const link = createLink(limits({ maxMessageLength: 100, chunkSize: 64, window: 4 }));
    link.sender.send('m'.repeat(300));
    const frames = [...link.inFlight];
    assert.ok(frames.length > 1, `expected several frames, got ${frames.length}`);

    // A frame that claims a different total is not the same message: drop it.
    link.receiver.handle({ ...frames[1], total: frames[1].total + 1 });
    assert.equal(link.delivered.length, 0);
    assert.match(link.drops[0], /out-of-order or inconsistent frame/);
    // …and the contradicting frame was acknowledged, so the peer is not left waiting.
    assert.equal(link.acks.at(-1), 1);
  });

  it('refuses to assemble more than its cap', () => {
    const delivered: string[] = [];
    const drops: string[] = [];
    const receiver = new RelayChunkReceiver({
      onMessage: (text) => delivered.push(text),
      ack: () => {},
      onDrop: (streamId, reason) => drops.push(reason),
      maxAssembledLength: 200,
    });

    receiver.handle({
      type: RelayFrameTypes.CHUNK,
      streamId: 's1',
      index: 0,
      total: 2,
      length: 4_000_000,
      data: 'x'.repeat(100),
    });

    assert.equal(delivered.length, 0);
    assert.match(drops[0], /invalid frame/);
  });

  it('drops a stream that goes idle while other traffic keeps arriving', () => {
    let now = 0;
    const delivered: string[] = [];
    const drops: string[] = [];
    const receiver = new RelayChunkReceiver({
      onMessage: (text) => delivered.push(text),
      ack: () => {},
      onDrop: (_streamId, reason) => drops.push(reason),
      idleTimeoutMs: 1000,
      now: () => now,
    });

    const frame = (streamId: string, index: number, total: number): unknown => ({
      type: RelayFrameTypes.CHUNK,
      streamId,
      index,
      total,
      length: total * 4,
      data: 'abcd',
    });

    receiver.handle(frame('old', 0, 2));
    assert.equal(receiver.openStreams, 1);

    // The sender of `old` vanished; a later frame from another stream sweeps it.
    now = 5000;
    receiver.handle(frame('new', 0, 1));
    assert.match(drops[0], /idle for 5000ms at frame 1\/2/);
    assert.deepEqual(delivered, ['abcd']);
    assert.equal(receiver.openStreams, 0);
  });

  it('ignores messages that are not frames', () => {
    const receiver = new RelayChunkReceiver({ onMessage: () => {}, ack: () => {} });
    assert.equal(receiver.handle({ type: 'RENDER_DIAGRAM', payload: {} }), false);
    assert.equal(receiver.handle('not an object'), false);
    assert.equal(receiver.handle(null), false);
  });
});
