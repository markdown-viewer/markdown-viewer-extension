/// Integration-test hooks for the running mobile app.
///
/// Integration tests (`integration_test/`) run **inside** the app process, so
/// they can only reach app internals the app exposes. This registry is that
/// seam: the home page registers a hooks object on startup, tests grab it and
/// drive the real product paths (open a document, switch theme) instead of
/// poking at private state.
///
/// Registration is limited to non-release builds; in release the registry stays
/// empty and every hook is a no-op for the test runner (nothing is compiled out
/// of the app's own behaviour — only the test seam is skipped).
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// The app surface a mobile E2E test is allowed to drive.
abstract class MobileE2EHooks {
  /// The display WebView controller (for `runJavaScriptReturningResult`).
  WebViewController get controller;

  /// True once the display WebView signalled readiness (`__mobileWebViewReady`).
  bool get isWebViewReady;

  /// Loads markdown through the app's own document path.
  Future<void> openMarkdown(String content, {String filename});

  /// Switches the document theme through the app's own theme path.
  Future<void> switchTheme(String themeId);

  /// Completes when the display WebView is ready (or throws on timeout).
  Future<void> waitUntilWebViewReady({Duration timeout});
}

/// Process-wide registry the app publishes its hooks into.
class MobileE2E {
  MobileE2E._();

  static MobileE2EHooks? _hooks;
  static final List<Completer<MobileE2EHooks>> _waiters = <Completer<MobileE2EHooks>>[];

  /// Currently registered hooks, if the app is up.
  static MobileE2EHooks? get current => _hooks;

  /// Called by the app (non-release only) once its WebView exists.
  static void register(MobileE2EHooks hooks) {
    _hooks = hooks;
    final pending = List<Completer<MobileE2EHooks>>.of(_waiters);
    _waiters.clear();
    for (final completer in pending) {
      if (!completer.isCompleted) {
        completer.complete(hooks);
      }
    }
  }

  /// Called by the app on dispose.
  static void unregister() {
    _hooks = null;
  }

  /// Waits for the app to publish its hooks.
  static Future<MobileE2EHooks> waitForHooks({
    Duration timeout = const Duration(seconds: 60),
  }) {
    final hooks = _hooks;
    if (hooks != null) {
      return Future<MobileE2EHooks>.value(hooks);
    }

    final completer = Completer<MobileE2EHooks>();
    _waiters.add(completer);
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        _waiters.remove(completer);
        throw TimeoutException(
          'MobileE2E hooks were never registered — is the app running a '
          'non-release build with WebView support?',
          timeout,
        );
      },
    );
  }

  /// Test-only reset between cases.
  @visibleForTesting
  static void resetForTesting() {
    _hooks = null;
    _waiters.clear();
  }
}
