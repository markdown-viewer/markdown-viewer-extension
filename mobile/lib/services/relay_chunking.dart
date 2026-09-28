/// Relay chunking (Dart side).
///
/// Mirror of `src/messaging/relay-chunking.ts`: the app's JavaScript bridge has a
/// per-message size limit (Android's `JavascriptInterface` is a Binder
/// transaction, ~1 MB with ~512 KB already dangerous; WKWebView carried 4 MB in
/// the probe), so a serialized message larger than the limit is framed into
/// ack-paced chunks and reassembled on the other side. Dart is the relay, so it
/// frames what it sends to either WebView and reassembles what either WebView
/// frames to it.
///
/// The two implementations must agree on the wire format; both suites pin the same
/// fixtures (`test/suites/render-view-protocol/chunking.test.ts` and
/// `mobile/test/relay_chunking_test.dart`).
///
/// Slices are taken on UTF-16 code units (`String.substring`) exactly like
/// `String.prototype.slice` on the JavaScript side, and each frame travels as a
/// JSON string, so reassembly is an exact round trip even when a slice lands in
/// the middle of a surrogate pair.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

/// Framing version (see the TS constant of the same name).
const int relayProtocolVersion = 1;

/// Frame type names — the same strings the TypeScript side uses.
abstract final class RelayFrameTypes {
  /// Page -> host: "I am listening; tell me the limits of this bridge".
  static const String hello = 'RELAY_HELLO';

  /// Host -> page: the per-platform limits this bridge can carry.
  static const String limits = 'RELAY_LIMITS';

  /// Either direction: one slice of a larger message.
  static const String chunk = 'RELAY_CHUNK';

  /// Either direction: "frame N is buffered, send the next one".
  static const String ack = 'RELAY_CHUNK_ACK';
}

/// Per-bridge limits; `default` is the conservative (Android) profile, used until
/// the host publishes the real ones.
class RelayChunkLimits {
  const RelayChunkLimits({
    required this.maxMessageLength,
    required this.chunkSize,
    required this.window,
  });

  /// Largest serialized message allowed across the bridge in one piece.
  final int maxMessageLength;

  /// Characters of the serialized message carried by one frame.
  final int chunkSize;

  /// Frames in flight before the sender waits for an ack.
  final int window;

  Map<String, Object?> toJson() => <String, Object?>{
        'maxMessageLength': maxMessageLength,
        'chunkSize': chunkSize,
        'window': window,
      };

  @override
  String toString() => 'max $maxMessageLength chars, ${chunkSize}B chunks, window $window';
}

const RelayChunkLimits _androidLimits = RelayChunkLimits(
  maxMessageLength: 192 * 1024,
  chunkSize: 128 * 1024,
  window: 1,
);

const RelayChunkLimits _appleLimits = RelayChunkLimits(
  maxMessageLength: 8 * 1024 * 1024,
  chunkSize: 512 * 1024,
  window: 4,
);

/// Named profiles, same names as the TS side.
const Map<String, RelayChunkLimits> relayChunkProfiles = <String, RelayChunkLimits>{
  'android': _androidLimits,
  'apple': _appleLimits,
  'default': _androidLimits,
};

RelayChunkLimits resolveRelayChunkLimits([String? profile]) =>
    relayChunkProfiles[profile] ?? relayChunkProfiles['default']!;

/// The profile for the bridge this app runs on: Android's `JavascriptInterface`
/// is the tight one (Binder), WKWebView on iOS/macOS carried 4 MB in the probe.
String defaultRelayChunkProfile() {
  if (Platform.isAndroid) return 'android';
  if (Platform.isIOS || Platform.isMacOS) return 'apple';
  return 'default';
}

/// Per-frame ack budget (a bridge round trip, not a network call).
const Duration relayAckTimeout = Duration(seconds: 10);

/// Refuse to assemble more than this, whatever the sender claims (memory guard).
const int relayMaxAssembledLength = 64 * 1024 * 1024;

/// Decodes a numeric field, tolerating the int/double split that JSON decoding
/// produces (and strings, which a future bridge implementation might use).
int? readIntField(Object? value) {
  if (value is int) return value;
  if (value is double && value == value.roundToDouble()) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

/// Reads the limits out of a `RELAY_LIMITS` payload, ignoring malformed values.
RelayChunkLimits? readRelayLimits(Map<String, dynamic> message) {
  final payload = message['payload'];
  if (payload is! Map) return null;
  final maxMessageLength = readIntField(payload['maxMessageLength']);
  final chunkSize = readIntField(payload['chunkSize']);
  final window = readIntField(payload['window']);
  if (maxMessageLength == null || chunkSize == null || window == null) return null;
  if (maxMessageLength <= 0 || chunkSize <= 0 || window <= 0) return null;
  if (chunkSize > maxMessageLength) return null;
  return RelayChunkLimits(maxMessageLength: maxMessageLength, chunkSize: chunkSize, window: window);
}

/// Splits oversized messages into ack-paced frames.
///
/// Dart drives its own sends (it owns the WebView controllers), so a send is a
/// sequential loop rather than an event-pumped queue: frames go out in batches of
/// [RelayChunkLimits.window] and the loop waits for the oldest outstanding ack.
class RelayChunkSender {
  RelayChunkSender({
    required this.limits,
    required Future<void> Function(String frameJson) post,
    void Function(String streamId, String reason)? onDrop,
    Duration ackTimeout = relayAckTimeout,
  })  : _post = post,
        _onDrop = onDrop,
        _ackTimeout = ackTimeout;

  RelayChunkLimits limits;
  final Future<void> Function(String frameJson) _post;
  final void Function(String streamId, String reason)? _onDrop;
  final Duration _ackTimeout;

  final Map<String, _OutgoingStream> _streams = <String, _OutgoingStream>{};
  int _counter = 0;

  /// Streams still awaiting acks (diagnostics).
  int get pendingStreams => _streams.length;

  /// Whether [text] needs framing at all.
  bool needsChunking(String text) => text.length > limits.maxMessageLength;

  /// Frames and delivers [text], resolving once every frame is acknowledged.
  Future<void> send(String text, {String? label}) async {
    if (!needsChunking(text)) {
      await _post(text);
      return;
    }

    _counter += 1;
    final streamId = 'd$_counter-${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}';
    final total = (text.length + limits.chunkSize - 1) ~/ limits.chunkSize;
    final stream = _OutgoingStream(streamId: streamId, total: total);
    _streams[streamId] = stream;

    try {
      var sent = 0;
      while (stream.acked < total) {
        while (sent < total && sent - stream.acked < limits.window && !stream.dropped) {
          final index = sent;
          sent += 1;
          final start = index * limits.chunkSize;
          final end = start + limits.chunkSize;
          await _post(jsonEncode(<String, Object?>{
            'type': 'RELAY_CHUNK',
            'streamId': streamId,
            'index': index,
            'total': total,
            'length': text.length,
            'data': text.substring(start, end < text.length ? end : text.length),
          }));
          // The post may have failed (page navigated away): stop framing this
          // stream instead of streaming frames nobody will read.
          if (stream.dropped || !_streams.containsKey(streamId)) return;
        }
        if (stream.dropped) return;
        // An ack can land while the batch is in flight — the last frame's ack
        // routinely does, because the peer acks on arrival — so the wait below has
        // to re-check the stream rather than trust the condition that let us into
        // the batch. Without this, a fully acknowledged stream indexes past its
        // waiters (`List.[]` RangeError) instead of finishing.
        if (stream.acked >= total) {
          break;
        }
        await stream.waiters[stream.acked].future.timeout(_ackTimeout);
        if (stream.dropped) return;
      }
    } on TimeoutException {
      _drop(streamId, 'no ack for frame ${stream.acked + 1}/$total within ${_ackTimeout.inMilliseconds}ms');
    } finally {
      _streams.remove(streamId);
    }
  }

  /// One frame was received by the peer.
  void handleAck(String streamId, int index) {
    final stream = _streams[streamId];
    if (stream == null) return;
    if (index < stream.acked || stream.ahead.contains(index)) return;
    stream.ahead.add(index);
    while (stream.ahead.remove(stream.acked)) {
      if (stream.acked < stream.waiters.length && !stream.waiters[stream.acked].isCompleted) {
        stream.waiters[stream.acked].complete();
      }
      stream.acked += 1;
    }
  }

  /// Drops an open stream (transport teardown, page unload).
  void cancelAll(String reason) {
    for (final streamId in _streams.keys.toList(growable: false)) {
      _drop(streamId, reason);
    }
  }

  void _drop(String streamId, String reason) {
    final stream = _streams.remove(streamId);
    if (stream == null) return;
    stream.dropped = true;
    // Release a send loop that is waiting for an ack that will never come. The
    // waiter is completed (not failed) on purpose: a failed completer nobody
    // awaits would surface as an uncaught async error.
    final awaited = stream.waiters[stream.acked];
    if (!awaited.isCompleted) {
      awaited.complete();
    }
    _onDrop?.call(streamId, reason);
  }

  /// Test seam: how many frames have been acknowledged for [streamId].
  int ackedFrames(String streamId) => _streams[streamId]?.acked ?? -1;
}

class _OutgoingStream {
  _OutgoingStream({required this.streamId, required this.total})
      : waiters = List<Completer<void>>.generate(total, (_) => Completer<void>());

  final String streamId;
  final int total;
  final List<Completer<void>> waiters;
  int acked = 0;
  bool dropped = false;
  final Set<int> ahead = <int>{};
}

/// Reassembles framed messages.
///
/// Frames of one stream arrive in order (the bridge preserves message order and
/// the sender is window-paced), so assembly is a straight append. A duplicate
/// frame — the sender did not see our ack — is acknowledged again and not appended.
class RelayChunkReceiver {
  RelayChunkReceiver({
    required void Function(String text) onMessage,
    required void Function(String streamId, int index) ack,
    void Function(String streamId, String reason)? onDrop,
    int maxAssembledLength = relayMaxAssembledLength,
    Duration idleTimeout = const Duration(seconds: 30),
    DateTime Function()? now,
  })  : _onMessage = onMessage,
        _ack = ack,
        _onDrop = onDrop,
        _maxAssembledLength = maxAssembledLength,
        _idleTimeout = idleTimeout,
        _now = now ?? DateTime.now;

  final void Function(String text) _onMessage;
  final void Function(String streamId, int index) _ack;
  final void Function(String streamId, String reason)? _onDrop;
  final int _maxAssembledLength;
  final Duration _idleTimeout;
  final DateTime Function() _now;

  final Map<String, _IncomingStream> _streams = <String, _IncomingStream>{};

  /// Streams still being assembled (diagnostics).
  int get openStreams => _streams.length;

  /// Consumes chunk frames. Returns true when the message belonged to the framing
  /// layer (including malformed frames, which are dropped rather than forwarded).
  bool handle(Map<String, dynamic> message) {
    if (message['type'] != RelayFrameTypes.chunk) return false;

    final streamId = message['streamId'];
    final index = readIntField(message['index']);
    final total = readIntField(message['total']);
    final length = readIntField(message['length']);
    final data = message['data'];

    if (streamId is! String || index == null || total == null || length == null || data is! String) {
      _onDrop?.call(streamId is String ? streamId : 'unknown', 'malformed chunk frame');
      return true;
    }

    _sweepIdle();

    if (index < 0 || total <= 0 || index >= total || length <= 0 || length > _maxAssembledLength) {
      _ack(streamId, index);
      _streams.remove(streamId);
      _onDrop?.call(streamId, 'invalid frame $index/$total ($length chars)');
      return true;
    }

    var stream = _streams[streamId];
    if (stream == null) {
      stream = _IncomingStream(total: total, length: length, lastAt: _now());
      _streams[streamId] = stream;
    }

    if (index < stream.received) {
      // Duplicate: the sender did not see our ack. Confirm it again.
      _ack(streamId, index);
      return true;
    }

    if (index != stream.received || total != stream.total || length != stream.length) {
      _ack(streamId, index);
      _streams.remove(streamId);
      _onDrop?.call(
        streamId,
        'out-of-order or inconsistent frame: got index $index/$total, expected ${stream.received}/${stream.total}',
      );
      return true;
    }

    stream.parts.add(data);
    stream.received += 1;
    stream.buffered += data.length;
    stream.lastAt = _now();
    _ack(streamId, index);

    if (stream.buffered > _maxAssembledLength) {
      _streams.remove(streamId);
      _onDrop?.call(streamId, 'assembled message exceeded $_maxAssembledLength chars');
      return true;
    }

    if (stream.received == stream.total) {
      _streams.remove(streamId);
      final text = stream.parts.join();
      if (text.length != stream.length) {
        _onDrop?.call(streamId, 'reassembled ${text.length} chars, expected ${stream.length}');
        return true;
      }
      _onMessage(text);
    }

    return true;
  }

  /// Drops streams whose sender went away mid-transfer. Checked lazily on the next
  /// frame instead of on a timer: the render surface is a hidden document, where
  /// interval timers are throttled (see plan §3.1).
  void _sweepIdle() {
    final now = _now();
    final stale = <String>[];
    for (final entry in _streams.entries) {
      if (now.difference(entry.value.lastAt) >= _idleTimeout) {
        stale.add(entry.key);
      }
    }
    for (final streamId in stale) {
      final stream = _streams.remove(streamId);
      if (stream != null) {
        _onDrop?.call(streamId, 'idle at frame ${stream.received}/${stream.total}');
      }
    }
  }
}

class _IncomingStream {
  _IncomingStream({required this.total, required this.length, required this.lastAt});

  final int total;
  final int length;
  final List<String> parts = <String>[];
  int received = 0;
  int buffered = 0;
  DateTime lastAt;
}
