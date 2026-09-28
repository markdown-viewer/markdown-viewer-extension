import 'dart:async';
import 'dart:convert';

import 'package:webview_flutter/webview_flutter.dart';

import 'relay_chunking.dart';

/// Owns the app's second, hidden WebView: the diagram engine's surface.
///
/// Diagrams used to render in a hidden iframe inside the display WebView, which
/// shared its process, its load chain and its fate (see
/// plans/mobile-render-view-webview-plan.md). The surface is now its own WebView,
/// and this service is the relay + supervisor Dart side:
///
///   display WebView  ──relay channel──▶  Dart  ──relay channel──▶  render surface
///                                       │
///                                       └─ answers the surface's host requests
///                                          (assets, relative files, remote files)
///
/// Responsibilities: readiness handshake, forwarding, host requests, heartbeat
/// and reload. It deliberately knows nothing about diagram types — the shared
/// render worker does.
///
/// The supervision numbers are the contract in plan §5.6 (the same state machine
/// Chrome's offscreen supervisor implements, in another language):
///
///   - readiness: one request answered once the surface is up (30 s watchdog),
///     with requests queued while it boots (64 messages) rather than failed;
///   - liveness: a PING every 30 s with an 8 s budget; two misses in a row reload
///     the surface;
///   - failures: the surface's own errors are forwarded (it has no visible
///     console), and the display side retries in-flight renders (idempotent);
///   - lifecycle: `DOM_READY` / `READY` / `ERROR`, named after Chrome's
///     `OFFSCREEN_*` events.
///
/// It also owns the bridge budget: a message larger than the platform's limit is
/// framed (see relay_chunking.dart) before it is handed to either WebView, and the
/// counters for that traffic travel with every status snapshot.
class RenderViewService {
  RenderViewService({
    required Future<WebViewController> Function() createController,
    this.readyTimeout = const Duration(seconds: 30),
    this.heartbeatInterval = const Duration(seconds: 30),
    this.heartbeatTimeout = const Duration(seconds: 8),
    RelayChunkLimits? chunkLimits,
    Duration? chunkAckTimeout,
  })  : _createController = createController,
        _limits = chunkLimits ?? resolveRelayChunkLimits(defaultRelayChunkProfile()),
        _chunkAckTimeout = chunkAckTimeout;

  /// Relay channel name. Both WebViews register the same name; Dart tells them
  /// apart by *which controller* delivered the message.
  static const String relayChannelName = 'MarkdownViewerRender';

  /// Function Dart calls in a page to deliver a relayed message.
  static const String relayInboxName = '__receiveRenderMessage';

  /// Host-service request types a surface may ask for.
  static const Set<String> hostRequestTypes = {
    'FETCH_ASSET',
    'READ_RELATIVE_FILE',
    'FETCH_REMOTE',
  };

  /// Lifecycle messages the surface sends (see mobile/src/render-view/protocol.ts).
  static const String messageReady = 'RENDER_SURFACE_READY';
  static const String messageDomReady = 'RENDER_SURFACE_DOM_READY';
  static const String messageError = 'RENDER_SURFACE_ERROR';

  /// Status request from the display side (answered here, not by the surface).
  static const String messageStatus = 'RENDER_VIEW_STATUS';

  /// Test-only: ask Dart to reload the surface (used by the E2E suite).
  static const String messageDebugReload = 'RENDER_VIEW_DEBUG_RELOAD';

  final Future<WebViewController> Function() _createController;

  /// Limits of the bridge this app is on (see relay_chunking.dart): a message
  /// larger than [RelayChunkLimits.maxMessageLength] is framed, because the
  /// platform bridge drops what it cannot carry (plan §5.2 / risk R2).
  final RelayChunkLimits _limits;

  /// Test seam: shorten the per-frame ack budget.
  final Duration? _chunkAckTimeout;

  /// How long to wait for the surface to report ready after a load.
  final Duration readyTimeout;

  /// Ping cadence and per-ping budget for the liveness check.
  final Duration heartbeatInterval;
  final Duration heartbeatTimeout;

  /// Resolver for host-service requests, provided by the app (it owns the file
  /// system and the asset bundle). Throws to report a failure back to the surface.
  Future<Object?> Function(String type, Map<String, dynamic> payload)? hostResolver;

  /// Display WebView controller: the other end of the relay.
  WebViewController? displayController;

  WebViewController? _controller;
  bool _loaded = false;
  bool _ready = false;
  String? _failure;
  DateTime? _loadedAt;
  List<String> _renderers = const <String>[];

  Timer? _heartbeat;
  int _missedHeartbeats = 0;

  /// Messages parked while the surface is still coming up (bounded).
  final List<String> _pending = <String>[];
  static const int _maxPending = 64;

  /// Chunk counters, so the app and the E2E seam can see that framing ran and how
  /// large the traffic actually was (the Android case that motivates it):
  ///
  ///   messagesSent/Received  messages that crossed (frames counted once each)
  ///   sent/received          frames that crossed in each direction
  ///   maxMessageSent/Received  the largest *single* bridge message, which is the
  ///                        number the bridge's limit bounds
  ///   maxAssembledOut      the largest *message* Dart framed for sending
  int _messagesSent = 0;
  int _messagesReceived = 0;
  int _framesSent = 0;
  int _framesReceived = 0;
  int _maxMessageSent = 0;
  int _maxMessageReceived = 0;
  int _maxAssembledOut = 0;

  /// Monotonic sequence of status snapshots *read*: every snapshot handed to the
  /// display side (a push, or the answer to its status request) carries a new
  /// number, so a reader that has seen #N knows whether what it holds is fresh.
  /// The counters above are maxima, which is exactly why that matters.
  int _statusSeq = 0;

  /// Reassembles framed traffic from each WebView (both directions can carry a
  /// payload the bridge cannot take whole).
  late final RelayChunkReceiver _fromDisplayReceiver = RelayChunkReceiver(
    onMessage: (text) => unawaited(handleRelayMessage(text, fromDisplay: true, reassembled: true)),
    ack: (streamId, index) => unawaited(_postText(displayController, _ackJson(streamId, index))),
    onDrop: (streamId, reason) => _logs.add('display stream $streamId dropped: $reason'),
  );

  late final RelayChunkReceiver _fromSurfaceReceiver = RelayChunkReceiver(
    onMessage: (text) => unawaited(handleRelayMessage(text, fromDisplay: false, reassembled: true)),
    ack: (streamId, index) => unawaited(_postText(_controller, _ackJson(streamId, index))),
    onDrop: (streamId, reason) => _logs.add('surface stream $streamId dropped: $reason'),
  );

  /// Frames what this side sends. Dart owns the controllers, so a send is a
  /// sequential loop inside the sender rather than an event-pumped queue.
  late final RelayChunkSender _toDisplaySender = RelayChunkSender(
    limits: _limits,
    post: (frameJson) {
      _framesSent += 1;
      return _postText(displayController, frameJson);
    },
    onDrop: (streamId, reason) => _logs.add('display stream $streamId dropped: $reason'),
    ackTimeout: _chunkAckTimeout ?? relayAckTimeout,
  );

  late final RelayChunkSender _toSurfaceSender = RelayChunkSender(
    limits: _limits,
    post: (frameJson) {
      _framesSent += 1;
      return _postText(_controller, frameJson);
    },
    onDrop: (streamId, reason) => _logs.add('surface stream $streamId dropped: $reason'),
    ackTimeout: _chunkAckTimeout ?? relayAckTimeout,
  );

  Completer<void>? _readyCompleter;
  final List<String> _logs = <String>[];

  /// The surface's controller (create the hidden WebView widget with it).
  WebViewController? get controller => _controller;

  /// Status snapshot for the display side and the E2E hooks.
  Map<String, Object?> get status {
    _statusSeq += 1;
    return <String, Object?>{
      'state': isReady
          ? 'ready'
          : (_failure != null ? 'failed' : (_loaded ? 'loading' : 'idle')),
      'readyMs': _loadedAt == null ? null : DateTime.now().difference(_loadedAt!).inMilliseconds,
      'renderers': _renderers,
      'push': _statusSeq,
      // Why the supervisor did what it did (framed a payload, dropped a stream,
      // reloaded the surface). The surface has no visible console, so a failed E2E
      // run has nothing else to quote — and the counters alone cannot say whether
      // framing *should* have run.
      'logs': _logs.length <= _maxStatusLogs
          ? List<String>.unmodifiable(_logs)
          : List<String>.unmodifiable(_logs.sublist(_logs.length - _maxStatusLogs)),
      'chunks': <String, Object?>{
        'messagesSent': _messagesSent,
        'messagesReceived': _messagesReceived,
        'sent': _framesSent,
        'received': _framesReceived,
        'maxMessageSent': _maxMessageSent,
        'maxMessageReceived': _maxMessageReceived,
        'maxAssembledOut': _maxAssembledOut,
        'limit': _limits.maxMessageLength,
        'chunkSize': _limits.chunkSize,
      },
      if (_failure != null) 'error': _failure,
    };
  }

  /// How many diagnostics a status snapshot carries (the tail: the newest lines are
  /// the ones that explain the traffic a case just caused).
  static const int _maxStatusLogs = 24;

  bool get isReady => _ready;

  /// Recent surface diagnostics (errors it reported, lifecycle notes).
  List<String> get logs => List<String>.unmodifiable(_logs);

  /// Creates the controller and starts loading the surface document.
  Future<WebViewController> start() async {
    if (_controller != null) {
      return _controller!;
    }

    final controller = await _createController();
    _controller = controller;
    await load();
    return controller;
  }

  /// (Re)loads the surface document and waits for its readiness handshake.
  Future<void> load() async {
    final controller = _controller;
    if (controller == null) {
      return;
    }

    _ready = false;
    _failure = null;
    _pending.clear();
    _readyCompleter = Completer<void>();
    _loaded = true;
    _loadedAt = DateTime.now();

    try {
      await controller.loadFlutterAsset('build/mobile/render-view.html');
    } catch (error) {
      _fail('surface load failed: $error');
      return;
    }

    unawaited(_armReadyWatchdog());
  }

  /// Waits until the surface reported ready (or fails).
  Future<void> ensureReady({Duration? timeout}) async {
    if (_ready) {
      return;
    }
    final completer = _readyCompleter;
    if (completer == null) {
      throw StateError('Render surface has not been started');
    }
    await completer.future.timeout(
      timeout ?? readyTimeout,
      onTimeout: () {
        _failure ??= 'surface did not report ready';
        throw TimeoutException('render surface not ready', timeout ?? readyTimeout);
      },
    );
  }

  /// Reloads the surface (recovery path for a hung or crashed surface).
  Future<void> reload() async {
    _stopHeartbeat();
    _logs.add('reload requested');
    await load();
    _broadcastStatus();
  }

  /// Stops the heartbeat and drops the surface state.
  void dispose() {
    _stopHeartbeat();
    _controller = null;
    _ready = false;
  }

  /// Handles one message that arrived on the relay channel.
  ///
  /// [fromDisplay] says which WebView delivered it; that is the whole routing
  /// table (see plan §5.1): the channel names are identical on purpose.
  ///
  /// [reassembled] marks a payload the framing layer put back together: it did not
  /// cross the bridge as one message — its frames did — so it must stay out of the
  /// per-message measurement below. Only a whole message can violate the bridge
  /// limit, and the E2E case that guards that invariant reads this number.
  Future<void> handleRelayMessage(
    String raw, {
    required bool fromDisplay,
    bool reassembled = false,
  }) async {
    if (!reassembled) {
      _messagesReceived += 1;
      if (raw.length > _maxMessageReceived) {
        // The bridge's limit bounds a single message; this is where that number is
        // observed (the E2E seam reads it, and a real device is the only place the
        // Android Binder limit can be checked).
        _maxMessageReceived = raw.length;
      }
    }

    Map<String, dynamic> message;
    try {
      message = jsonDecode(raw) as Map<String, dynamic>;
    } catch (error) {
      _logs.add('malformed relay message: $error');
      return;
    }

    final type = message['type'] as String?;
    if (type == null) {
      return;
    }

    if (_handleFramingMessage(message, type, fromDisplay: fromDisplay)) {
      return;
    }

    if (type == 'RESPONSE') {
      // Answers to our heartbeat (and to host requests we asked about).
      _settlePing(message);
    }

    if (fromDisplay) {
      await _handleFromDisplay(message, type);
    } else {
      await _handleFromSurface(message, type);
    }
  }

  /// The transport-level framing layer: hello/limits, frames and acks.
  ///
  /// Returns true when the message belongs to it and must not be routed further.
  /// Frames are consumed here because they are *not* relayed messages — they are
  /// the pieces of one, and the reassembled text comes back through
  /// [handleRelayMessage] as a normal arrival.
  bool _handleFramingMessage(
    Map<String, dynamic> message,
    String type, {
    required bool fromDisplay,
  }) {
    switch (type) {
      case RelayFrameTypes.hello:
        final protocol = readIntField(message['protocol']);
        if (protocol != null && protocol != relayProtocolVersion) {
          _logs.add(
            'relay protocol mismatch: page speaks v$protocol, app speaks v$relayProtocolVersion (stale page bundle?)',
          );
        }
        // Answer with the limits of the bridge this page is on. It asked rather
        // than being told so that whichever WebView boots first learns the limits
        // before it sends much.
        unawaited(_deliver(
          fromDisplay ? displayController : _controller,
          jsonEncode(<String, Object?>{
            'type': RelayFrameTypes.limits,
            'protocol': relayProtocolVersion,
            'payload': _limits.toJson(),
          }),
          toDisplay: fromDisplay,
        ));
        return true;

      case RelayFrameTypes.ack:
        final streamId = message['streamId'];
        final index = readIntField(message['index']);
        if (streamId is String && index != null) {
          (fromDisplay ? _toDisplaySender : _toSurfaceSender).handleAck(streamId, index);
        }
        return true;

      case RelayFrameTypes.chunk:
        _framesReceived += 1;
        (fromDisplay ? _fromDisplayReceiver : _fromSurfaceReceiver).handle(message);
        return true;

      default:
        return false;
    }
  }

  /// The ack frame that releases the next window of a sender.
  String _ackJson(String streamId, int index) => jsonEncode(<String, Object?>{
        'type': RelayFrameTypes.ack,
        'streamId': streamId,
        'index': index,
      });

  Future<void> _handleFromDisplay(Map<String, dynamic> message, String type) async {
    // Status probe from the display side: answered by the supervisor, and it
    // waits for readiness so a render request never fails just because it
    // arrived while the surface was still booting.
    if (type == messageStatus || type == messageDebugReload) {
      final id = message['id']?.toString();
      if (type == messageDebugReload) {
        await reload();
        _respondToDisplay(id, data: status);
        return;
      }
      try {
        await ensureReady();
        _respondToDisplay(id, data: status);
      } catch (error) {
        _respondToDisplay(id, error: error.toString());
      }
      return;
    }

    await _forwardToSurface(jsonEncode(message));
  }

  Future<void> _handleFromSurface(Map<String, dynamic> message, String type) async {
    final id = message['id']?.toString();
    final payload = message['payload'];

    switch (type) {
      case messageReady:
        final renderers = (payload is Map ? payload['renderers'] : null);
        if (renderers is List) {
          _renderers = renderers.map((entry) => entry.toString()).toList(growable: false);
        }
        _ready = true;
        _failure = null;
        _logs.add('ready (${_renderers.length} renderers)');
        _readyCompleter?.complete();
        _readyCompleter = null;
        _startHeartbeat();
        _broadcastStatus();
        await _flushPending();
        return;

      case messageDomReady:
        _logs.add('dom ready');
        // Forwarded as a push so the display side can use it for diagnostics.
        break;

      case messageError:
        final text = payload is Map ? (payload['message']?.toString() ?? 'unknown') : 'unknown';
        _logs.add('surface error: $text');
        break;

      default:
        // RENDER_DIAGRAM responses, logs, anything else the display side asked
        // for: hand it back.
        if (message['__target'] == 'host' || RenderViewService.hostRequestTypes.contains(type)) {
          await _answerHostRequest(message, type, id, payload);
          return;
        }
        break;
    }

    await _forwardToDisplay(jsonEncode(message));
  }

  /// Answers a host-service request from the surface (assets, files, remote).
  Future<void> _answerHostRequest(
    Map<String, dynamic> message,
    String type,
    String? id,
    Object? payload,
  ) async {
    final resolver = hostResolver;
    if (resolver == null) {
      _respondToSurface(id, error: 'host service unavailable: $type');
      return;
    }

    try {
      final data = await resolver(type, payload is Map ? Map<String, dynamic>.from(payload) : <String, dynamic>{});
      _respondToSurface(id, data: data);
    } catch (error) {
      _respondToSurface(id, error: error.toString());
    }
  }

  /// Sends a message to the surface, queueing it while the surface boots.
  Future<void> _forwardToSurface(String json) async {
    if (!_ready) {
      if (_failure != null) {
        _logs.add('dropped message while surface failed: ${json.length} bytes');
        return;
      }
      if (_pending.length >= _maxPending) {
        _pending.removeAt(0);
        _logs.add('pending queue full, dropped oldest message');
      }
      _pending.add(json);
      return;
    }

    await _deliver(_controller, json, toDisplay: false);
  }

  Future<void> _flushPending() async {
    if (_pending.isEmpty) {
      return;
    }
    final queued = List<String>.from(_pending);
    _pending.clear();
    for (final json in queued) {
      await _deliver(_controller, json, toDisplay: false);
    }
  }

  Future<void> _forwardToDisplay(String json) => _deliver(displayController, json, toDisplay: true);

  /// Delivers one relayed message into a page, framing it when the bridge cannot
  /// carry it whole.
  ///
  /// The size limit is a property of the platform bridge, not of the payload, so
  /// every kind of traffic goes through the same rule (plan §5.2 / risk R2): a
  /// serialized message over [RelayChunkLimits.maxMessageLength] becomes ack-paced
  /// frames, and the receiving page reassembles it before the channel sees it.
  Future<void> _deliver(WebViewController? controller, String json, {required bool toDisplay}) async {
    if (controller == null) {
      return;
    }
    if (json.length > _maxAssembledOut) {
      _maxAssembledOut = json.length;
    }

    final sender = toDisplay ? _toDisplaySender : _toSurfaceSender;
    if (!sender.needsChunking(json)) {
      await _postText(controller, json);
      return;
    }

    _logs.add('framing ${json.length} chars for ${toDisplay ? 'display' : 'surface'}');
    await sender.send(json);
    // A framed delivery changes every counter above, and the app's seam only ever
    // sees pushed snapshots: publish one, so a reader waiting for "the traffic I
    // just caused" gets it (the status request path excludes the counters' maxima
    // from being observed any other way).
    _broadcastStatus();
  }

  /// Hands one serialized message (or frame) to a WebView.
  Future<void> _postText(WebViewController? controller, String json) async {
    if (controller == null) {
      return;
    }
    _messagesSent += 1;
    if (json.length > _maxMessageSent) {
      _maxMessageSent = json.length;
    }
    try {
      await controller.runJavaScript(
        'window.$relayInboxName && window.$relayInboxName(${jsonEncode(json)});',
      );
    } catch (error) {
      _logs.add('delivery failed: $error');
    }
  }

  void _respondToSurface(String? id, {Object? data, String? error}) {
    if (id == null) {
      return;
    }
    unawaited(_deliver(
      _controller,
      jsonEncode(<String, Object?>{
        'type': 'RESPONSE',
        'requestId': id,
        'ok': error == null,
        if (error != null) 'error': {'message': error},
        if (error == null) 'data': data,
      }),
      toDisplay: false,
    ));
  }

  void _respondToDisplay(String? id, {Object? data, String? error}) {
    if (id == null) {
      return;
    }
    unawaited(_forwardToDisplay(jsonEncode(<String, Object?>{
      'type': 'RESPONSE',
      'requestId': id,
      'ok': error == null,
      if (error != null) 'error': {'message': error},
      if (error == null) 'data': data,
    })));
  }

  /// Tells the display side what the surface is doing (it shows nothing, but the
  /// E2E seam and the logs need it).
  void _broadcastStatus() {
    unawaited(_forwardToDisplay(jsonEncode(<String, Object?>{
      'type': messageStatus,
      'payload': status,
      'timestamp': DateTime.now().millisecondsSinceEpoch,
    })));
  }

  Future<void> _armReadyWatchdog() async {
    try {
      await ensureReady();
    } catch (error) {
      _fail(error.toString());
    }
  }

  void _fail(String reason) {
    _failure = reason;
    _logs.add('failed: $reason');
    _readyCompleter?.completeError(StateError(reason));
    _readyCompleter = null;
    _broadcastStatus();
  }

  /// Liveness: a PING the worker answers (it is part of the shared worker
  /// protocol). Two misses in a row mean the surface is gone — reload it.
  void _startHeartbeat() {
    _stopHeartbeat();
    _missedHeartbeats = 0;
    _heartbeat = Timer.periodic(heartbeatInterval, (_) => unawaited(_ping()));
  }

  void _stopHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = null;
    _missedHeartbeats = 0;
  }

  Future<void> _ping() async {
    final controller = _controller;
    if (controller == null || !_ready) {
      return;
    }

    final id = 'ping-${DateTime.now().microsecondsSinceEpoch}';
    final envelope = jsonEncode(<String, Object?>{
      'id': id,
      'type': 'PING',
      'payload': <String, Object?>{},
      '__target': 'render-view',
      'timestamp': DateTime.now().millisecondsSinceEpoch,
    });

    final answered = Completer<void>();
    // The response arrives through handleRelayMessage; treat a missing reply as a
    // miss. (The worker answers PING from the shared bootstrap.)
    _pendingPings[id] = answered;
    try {
      await _deliver(controller, envelope, toDisplay: false);
      await answered.future.timeout(heartbeatTimeout);
      _missedHeartbeats = 0;
    } on TimeoutException {
      _missedHeartbeats += 1;
      _logs.add('heartbeat missed ($_missedHeartbeats)');
      if (_missedHeartbeats >= 2) {
        _logs.add('surface unresponsive — reloading');
        await reload();
      }
    } catch (error) {
      _logs.add('heartbeat error: $error');
    } finally {
      _pendingPings.remove(id);
    }
  }

  final Map<String, Completer<void>> _pendingPings = <String, Completer<void>>{};

  /// Called from [handleRelayMessage] when a response matches an outstanding ping.
  void _settlePing(Map<String, dynamic> message) {
    final requestId = message['requestId']?.toString();
    if (requestId == null) {
      return;
    }
    final completer = _pendingPings[requestId];
    if (completer != null && !completer.isCompleted) {
      completer.complete();
    }
  }
}
