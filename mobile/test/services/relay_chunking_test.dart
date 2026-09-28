/// Relay framing contract: chunking (Dart side).
///
/// Mirror of `test/suites/render-view-protocol/chunking.test.ts`. Dart is the
/// relay, so *it* frames what it sends to either WebView and reassembles what
/// either WebView frames to it; the two implementations must agree on the wire
/// format, and the shared fixtures below are the same strings the TypeScript
/// suite uses (same frame counts, same frame lengths).
///
/// The properties that matter:
///   - a message at the limit is not framed (the common case pays nothing);
///   - an oversized message arrives byte-identical after reassembly;
///   - slices are UTF-16 code units, so a slice boundary may split a surrogate
///     pair and the join still yields the original string;
///   - never more than `window` frames in flight;
///   - a peer that stops acking cannot wedge a send (the stream is dropped);
///   - the receiver never assembles more than its cap, and drops what contradicts
///     what it was told.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:markdown_viewer_mobile/services/relay_chunking.dart';

/// Fixture shared with the TypeScript mirror: CJK + a variation selector + an
/// astral emoji (6 UTF-16 code units per unit), so a 515-code-unit boundary lands
/// in the middle of the astral pair.
final String sharedFixture = '图表\u26F0\uFE0F\u{1F680}' * 1000;

/// Chunk size that splits an astral pair: 6 * 85 = 510, +4 = 514 → the pair sits
/// at code units 514/515.
const int sharedSplitChunk = 515;

RelayChunkLimits limits({
  int maxMessageLength = 4 * 1024,
  int chunkSize = 512,
  int window = 1,
}) =>
    RelayChunkLimits(
      maxMessageLength: maxMessageLength,
      chunkSize: chunkSize,
      window: window,
    );

/// A synchronous link: the sender's frames queue up and [pump] delivers them one
/// by one, the receiver acking each of them.
class Link {
  Link(
    this.limits, {
    this.ackTimeout = relayAckTimeout,
    this.maxAssembledLength = relayMaxAssembledLength,
    this.idleTimeout = const Duration(seconds: 30),
    this.now,
    this.ackOnPost = false,
  }) {
    sender = RelayChunkSender(
      limits: limits,
      post: (text) async {
        // Raw: an unframed message is delivered as it is, a frame is JSON text.
        posted += 1;
        if (ackOnPost) {
          // The peer acks on arrival: the frame reaches the receiver *before* the
          // sender resumes, which is how a real bridge behaves (and the timing that
          // used to trip the sender's waiter indexing).
          receiver.handle(jsonDecode(text) as Map<String, dynamic>);
          return;
        }
        inFlight.add(text);
        if (inFlight.length > peak) peak = inFlight.length;
      },
      onDrop: (streamId, reason) => drops.add('$streamId: $reason'),
      ackTimeout: ackTimeout,
    );
    receiver = RelayChunkReceiver(
      onMessage: delivered.add,
      ack: (streamId, index) {
        acks.add(index);
        sender.handleAck(streamId, index);
      },
      onDrop: (streamId, reason) => drops.add('$streamId: $reason'),
      maxAssembledLength: maxAssembledLength,
      idleTimeout: idleTimeout,
      now: now,
    );
  }

  final RelayChunkLimits limits;
  late final RelayChunkSender sender;
  late final RelayChunkReceiver receiver;

  /// Bridge traffic not yet handed to the receiver (raw text, as it crossed).
  final List<String> inFlight = <String>[];
  final List<String> delivered = <String>[];
  final List<String> drops = <String>[];
  final List<int> acks = <int>[];

  /// How many messages (frames included) the sender handed to the bridge.
  int posted = 0;
  int peak = 0;

  final Duration ackTimeout;
  final int maxAssembledLength;
  final Duration idleTimeout;
  final DateTime Function()? now;

  /// When true the receiver is handed every frame from inside `post` (see above).
  final bool ackOnPost;

  /// The frames not yet delivered, decoded.
  List<Map<String, dynamic>> get frames =>
      inFlight.map((entry) => jsonDecode(entry) as Map<String, dynamic>).toList(growable: false);

  /// Delivers everything in flight, in order (the bridge does not reorder).
  void pump() {
    while (inFlight.isNotEmpty) {
      final decoded = jsonDecode(inFlight.removeAt(0));
      if (decoded is Map<String, dynamic>) {
        receiver.handle(decoded);
      }
    }
  }

  /// Pumps until [future] completes, yielding to the event loop between rounds
  /// (the sender awaits the bridge between frames).
  Future<void> pumpUntil(Future<void> future) async {
    for (var round = 0; round < 500; round += 1) {
      pump();
      final settled = await Future.any<bool>(<Future<bool>>[
        future.then((_) => true),
        Future<bool>.delayed(Duration.zero, () => false),
      ]);
      if (settled) return;
    }
    fail('sender did not finish while frames were being acknowledged');
  }

  /// Highest number of frames that were in flight at once.
  int peakInFlight() => peak;
}

void main() {
  group('relay chunking: limits', () {
    test('uses the conservative profile for an unknown bridge', () {
      expect(resolveRelayChunkLimits().maxMessageLength, resolveRelayChunkLimits('default').maxMessageLength);
      expect(resolveRelayChunkLimits('nope').chunkSize, relayChunkProfiles['default']!.chunkSize);
      // Android's Binder path is the tight one; the default must not be the roomy one.
      expect(
        resolveRelayChunkLimits('default').maxMessageLength,
        resolveRelayChunkLimits('android').maxMessageLength,
      );
      expect(
        resolveRelayChunkLimits('default').maxMessageLength,
        lessThan(resolveRelayChunkLimits('apple').maxMessageLength),
      );
    });

    test('accepts a well-formed limits payload and rejects contradictory ones', () {
      Map<String, dynamic> message(Map<String, dynamic> payload) => <String, dynamic>{
            'type': RelayFrameTypes.limits,
            'protocol': relayProtocolVersion,
            'payload': payload,
          };

      final parsed = readRelayLimits(message(<String, dynamic>{
        'maxMessageLength': 1024,
        'chunkSize': 512,
        'window': 2,
      }));
      expect(parsed, isNotNull);
      expect(parsed!.maxMessageLength, 1024);
      expect(parsed.chunkSize, 512);
      expect(parsed.window, 2);

      // A frame must fit inside the budget it is framed for.
      expect(
        readRelayLimits(message(<String, dynamic>{'maxMessageLength': 512, 'chunkSize': 1024, 'window': 1})),
        isNull,
      );
      expect(
        readRelayLimits(message(<String, dynamic>{'maxMessageLength': 0, 'chunkSize': 1, 'window': 1})),
        isNull,
      );
      expect(readRelayLimits(message(<String, dynamic>{'chunkSize': 512, 'window': 1})), isNull);
      expect(readRelayLimits(<String, dynamic>{'type': RelayFrameTypes.limits}), isNull);
    });

    test('picks the profile from the platform the bridge belongs to', () {
      // Whatever host this test runs on, the answer must be one of the profiles.
      expect(relayChunkProfiles.keys, contains(defaultRelayChunkProfile()));
    });
  });

  group('relay chunking: sender and receiver', () {
    test('passes a message at the limit through untouched', () async {
      final link = Link(limits(maxMessageLength: 64, chunkSize: 32));
      expect(link.sender.needsChunking('x' * 64), isFalse);
      expect(link.sender.needsChunking('x' * 65), isTrue);

      await link.sender.send('x' * 64);
      // The message crossed the bridge, but as a message — not as a frame.
      expect(link.posted, 1);
      expect(link.inFlight, hasLength(1));
      expect(link.inFlight.first, 'x' * 64);
      expect(link.sender.pendingStreams, 0, reason: 'a message within the limit must not be framed');
    });

    test('reassembles an oversized message exactly', () async {
      final link = Link(limits(maxMessageLength: 256, chunkSize: 128));
      final text = jsonEncode(<String, Object?>{'type': 'RESPONSE', 'data': sharedFixture});
      expect(link.sender.needsChunking(text), isTrue);

      final done = link.sender.send(text);
      // Window 1: exactly one frame may be in flight until it is acknowledged.
      await Future<void>.delayed(Duration.zero);
      expect(link.inFlight, hasLength(1));
      expect(link.frames.first['type'], RelayFrameTypes.chunk);

      await link.pumpUntil(done);
      expect(link.delivered, <String>[text]);
      expect(link.drops, isEmpty);
      // The message took several frames, each within the chunk size.
      expect(link.acks.length, greaterThan(1));
    });

    test('slices on code units, so a split surrogate pair still joins exactly', () async {
      final link = Link(limits(maxMessageLength: 4 * sharedSplitChunk, chunkSize: sharedSplitChunk, window: 2));
      final done = link.sender.send(sharedFixture);
      await Future<void>.delayed(Duration.zero);

      // Same numbers as the TypeScript mirror: the astral pair's high surrogate is
      // the last code unit of frame 0, the low surrogate the first of frame 1.
      expect(link.frames.first['data'].toString().length, sharedSplitChunk);
      final high = link.frames.first['data'].toString().codeUnitAt(sharedSplitChunk - 1);
      final low = link.frames[1]['data'].toString().codeUnitAt(0);
      expect(high, sharedFixture.codeUnitAt(514));
      expect(high, inInclusiveRange(0xd800, 0xdbff));
      expect(low, inInclusiveRange(0xdc00, 0xdfff));

      await link.pumpUntil(done);
      expect(link.delivered, <String>[sharedFixture]);
      expect(link.delivered.first.length, sharedFixture.length);
      expect(link.delivered.first.contains('\u{1F680}'), isTrue);
    });

    test('keeps at most `window` frames in flight', () async {
      final single = Link(limits(maxMessageLength: 512, chunkSize: 128, window: 1));
      final singleDone = single.sender.send('y' * 700);
      await Future<void>.delayed(Duration.zero);
      expect(single.inFlight, hasLength(1), reason: 'window 1 must wait for an ack');
      // Leave no stream open: a test that ends with a pending send would leak an
      // unfinished future into the next case.
      single.sender.cancelAll('test end');
      await singleDone;

      final wide = Link(limits(maxMessageLength: 512, chunkSize: 128, window: 3));
      final wideDone = wide.sender.send('y' * 700);
      await Future<void>.delayed(Duration.zero);
      expect(wide.inFlight, hasLength(3));

      await wide.pumpUntil(wideDone);
      expect(wide.delivered.first.length, 700);
      expect(wide.peakInFlight(), lessThanOrEqualTo(3));
    });

    test('finishes when the ack of the last frame lands while that frame is in flight', () async {
      // The peer acks on arrival, so the final ack routinely arrives while the
      // sender is still suspended in the post that carried the final frame. The
      // send loop re-checked nothing after such a batch and indexed its waiter list
      // with a fully acknowledged stream: `List.[]` RangeError (seen on macOS with
      // a 100 KB diagram result over a 2 KB frame budget, where the crash killed
      // the delivery *after* every ack had already arrived).
      final link = Link(limits(maxMessageLength: 64, chunkSize: 32), ackOnPost: true);
      final text = 'y' * 200; // 7 frames, the last one acked before the send resumes

      await link.sender.send(text);

      expect(link.delivered, <String>[text], reason: 'the framed message must arrive exactly once');
      expect(link.drops, isEmpty, reason: 'a fully acknowledged stream is not a dropped stream');
      expect(link.sender.pendingStreams, 0);
      expect(link.acks, <int>[0, 1, 2, 3, 4, 5, 6]);
    });

    test('acknowledges a duplicate frame without appending it twice', () async {
      final link = Link(limits(maxMessageLength: 256, chunkSize: 128));
      final text = 'd' * 300;
      final done = link.sender.send(text);
      await Future<void>.delayed(Duration.zero);

      final first = link.frames.first;
      link.inFlight.removeAt(0);
      link.receiver.handle(first);
      // The ack was lost, so the peer sends frame 0 again: it must not be appended
      // twice, and it must be acknowledged again.
      link.receiver.handle(first);

      await link.pumpUntil(done);
      expect(link.delivered, <String>[text]);
      expect(link.acks.where((index) => index == 0).length, 2);
    });
  });

  group('relay chunking: failure paths', () {
    test('drops a stream whose peer stops acking, and keeps sending later messages', () async {
      final link = Link(
        limits(maxMessageLength: 256, chunkSize: 128),
        ackTimeout: const Duration(milliseconds: 30),
      );

      await link.sender.send('q' * 400).timeout(const Duration(seconds: 2));
      expect(link.sender.pendingStreams, 0, reason: 'a wedged stream must not stay open forever');
      expect(link.drops, hasLength(1));
      expect(link.drops.first, contains('no ack for frame 1/'));

      // The next message is framed and delivered as usual.
      final before = link.posted;
      final done = link.sender.send('w' * 400);
      await link.pumpUntil(done);
      expect(link.posted, greaterThan(before));
      expect(link.delivered.last.length, 400);
    });

    test('drops a stream that contradicts what it announced', () {
      final link = Link(limits(maxMessageLength: 100, chunkSize: 64, window: 4));
      link.sender.send('m' * 300);
      link.pump();
      expect(link.delivered, isEmpty);

      // Replay a frame that claims a different total: it is not the same message.
      final frame = <String, dynamic>{
        'type': RelayFrameTypes.chunk,
        'streamId': 's1',
        'index': 1,
        'total': 9,
        'length': 300,
        'data': 'abcd',
      };
      link.receiver.handle(frame);
      expect(link.delivered, isEmpty);
      expect(link.drops.first, contains('inconsistent'));
      // …and the contradicting frame was acknowledged, so the peer is not waiting.
      expect(link.acks.last, 1);
    });

    test('refuses to assemble more than its cap', () {
      final link = Link(limits(), maxAssembledLength: 200);
      link.receiver.handle(<String, dynamic>{
        'type': RelayFrameTypes.chunk,
        'streamId': 's1',
        'index': 0,
        'total': 2,
        'length': 4000000,
        'data': 'x' * 100,
      });
      expect(link.delivered, isEmpty);
      expect(link.drops.first, contains('invalid frame'));
    });

    test('drops a stream that goes idle while other traffic keeps arriving', () {
      var now = DateTime(2026);
      final link = Link(
        limits(),
        idleTimeout: const Duration(seconds: 1),
        now: () => now,
      );

      Map<String, dynamic> frame(String streamId, int index, int total) => <String, dynamic>{
            'type': RelayFrameTypes.chunk,
            'streamId': streamId,
            'index': index,
            'total': total,
            'length': total * 4,
            'data': 'abcd',
          };

      link.receiver.handle(frame('old', 0, 2));
      expect(link.receiver.openStreams, 1);

      now = now.add(const Duration(seconds: 5));
      link.receiver.handle(frame('new', 0, 1));
      expect(link.drops.first, contains('idle'));
      expect(link.delivered, <String>['abcd']);
      expect(link.receiver.openStreams, 0);
    });

    test('ignores messages that are not frames', () {
      final link = Link(limits());
      expect(link.receiver.handle(<String, dynamic>{'type': 'RENDER_DIAGRAM', 'payload': <String, dynamic>{}}), isFalse);
      expect(link.receiver.handle(<String, dynamic>{'type': 'RELAY_CHUNK_ACK'}), isFalse);
    });

    test('stops framing when the stream is cancelled', () async {
      final link = Link(limits(maxMessageLength: 256, chunkSize: 128, window: 1));
      final done = link.sender.send('c' * 400);
      await Future<void>.delayed(Duration.zero);
      expect(link.inFlight, hasLength(1));

      link.sender.cancelAll('page unloaded');
      await done.timeout(const Duration(seconds: 2));
      expect(link.sender.pendingStreams, 0);
      expect(link.drops, hasLength(1));
    });
  });
}
