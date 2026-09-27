/// Mobile E2E harness.
///
/// One entry point for every integration test: boot the app once, wait for the
/// display WebView, then drive it the way a reader would (open a document,
/// switch theme) and assert on the DOM the render pipeline produced.
///
/// Design rules (learned from the extension/CLI suites):
///   - No fixed sleeps: every wait polls a page-side condition with a deadline.
///   - Every failure carries the page state (DOM snapshot + render diagnostics)
///     so a red CI run is diagnosable from the log alone.
///   - Helpers print with an `[mvE2E]` prefix; the CI runner tees stdout into
///     `test-results/mobile-e2e/`.
///
/// Runs with:
///   `flutter test integration_test -d <device> --dart-define=MV_WEBVIEW_DEBUG=1`
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'package:markdown_viewer_mobile/dev/mobile_e2e.dart';
import 'package:markdown_viewer_mobile/main.dart' as app;

/// Marker used by every helper log line, so the CI log can be grepped.
const String kLogPrefix = '[mvE2E]';

/// Default budget for "the document finished rendering".
const Duration kRenderTimeout = Duration(seconds: 45);

/// Boots the app for one test file and exposes its hooks.
class MvE2E {
  MvE2E._(this.tester, this.hooks);

  final WidgetTester tester;
  final MobileE2EHooks hooks;

  WebViewController get controller => hooks.controller;

  /// WebView DOM evaluation, normalised across platforms.
  ///
  /// Two platform traps are handled here:
  ///   - `WKWebView.runJavaScriptReturningResult` **throws** `ArgumentError` when
  ///     the script yields `null`/`undefined` (Android returns the string
  ///     "null"), so every expression is wrapped to hand back a JSON string;
  ///   - Apple JSON-encodes the result ("true", "\"text\"") while Android gives
  ///     the plain value (true, text), so the value is unwrapped until it is a
  ///     Dart value again.
  Future<Object?> eval(String expression) async {
    final Object raw = await controller.runJavaScriptReturningResult(_wrap(expression));
    return _unwrap(raw);
  }

  /// Fire-and-forget JavaScript: for side effects whose return value is
  /// irrelevant (clearing the diagnostics sink, triggering a test hook).
  ///
  /// Required on Apple platforms, where the *Returning* variant rejects null.
  Future<void> runJs(String expression) => controller.runJavaScript('void ($expression);');

  /// Integer helper (counts, lengths).
  Future<int> evalInt(String expression) async {
    final value = await eval(expression);
    if (value is int) return value;
    if (value is double) return value.toInt();
    return int.tryParse('$value') ?? 0;
  }

  /// Boots the app and waits until the display WebView is live.
  ///
  /// Also initialises the integration binding, so call this first in every
  /// test file.
  static Future<MvE2E> launch(
    WidgetTester tester, {
    Duration timeout = const Duration(seconds: 90),
  }) async {
    IntegrationTestWidgetsFlutterBinding.ensureInitialized();
    _log('launching app');

    app.main();
    await _pumpUntil(tester, () => MobileE2E.current != null, timeout: timeout);

    final hooks = await MobileE2E.waitForHooks(timeout: timeout);
    await hooks.waitUntilWebViewReady(timeout: timeout);
    _log('display WebView ready (isWebViewReady=${hooks.isWebViewReady})');

    return MvE2E._(tester, hooks);
  }

  /// Opens markdown through the app's own document path.
  Future<void> openDocument(String markdown, {String filename = 'e2e-document.md'}) async {
    await clearDiagnostics();
    _log('opening document: $filename (${markdown.length} chars)');
    await hooks.openMarkdown(markdown, filename: filename);
    await tester.pump();
  }

  /// Switches the document theme through the app's own settings path.
  Future<void> switchTheme(String themeId) async {
    _log('switching theme: $themeId');
    await hooks.switchTheme(themeId);
    await tester.pump();
  }

  /// Polls until the render pipeline reports [count] finished plugin blocks.
  ///
  /// "Finished" = the block element carries `data-plugin-rendered="true"`, which
  /// the shared pipeline sets for every plugin result it inserted.
  Future<void> waitForRenderedBlocks(int count, {Duration timeout = kRenderTimeout}) async {
    await _waitFor(
      'rendered blocks >= $count',
      () async => (await evalInt(
            'document.querySelectorAll(\'[data-plugin-rendered="true"]\').length',
          )) >=
          count,
      timeout: timeout,
    );
  }

  /// Polls until [selector] matches at least [count] elements.
  Future<void> waitForSelector(String selector, {int count = 1, Duration timeout = kRenderTimeout}) async {
    final escaped = selector.replaceAll(r'\', r'\\').replaceAll("'", r"\'");
    await _waitFor(
      '$selector >= $count',
      () async => (await evalInt("document.querySelectorAll('$escaped').length")) >= count,
      timeout: timeout,
    );
  }

  /// Polls until every pending diagram placeholder has been resolved.
  ///
  /// The pipeline inserts `<div class="async-placeholder">` for each async
  /// plugin block and replaces it when the render lands (or with an error block).
  Future<void> waitForNoPendingPlaceholders({Duration timeout = kRenderTimeout}) async {
    await _waitFor(
      'no pending placeholders',
      () async => (await evalInt("document.querySelectorAll('.async-placeholder').length")) == 0,
      timeout: timeout,
    );
  }

  /// Render diagnostics recorded by the page (errors and warnings).
  Future<List<Map<String, Object?>>> diagnostics() async {
    final value = await eval('window.__mvRenderDiagnostics.get()');
    if (value is! List) return const <Map<String, Object?>>[];
    return value
        .whereType<Map<Object?, Object?>>()
        .map((entry) => entry.cast<String, Object?>())
        .toList(growable: false);
  }

  /// Clears the page's diagnostics sink (call before opening a document).
  Future<void> clearDiagnostics() => runJs('window.__mvRenderDiagnostics.clear()');

  /// Fails if the pipeline recorded an `error`-level diagnostic.
  Future<void> expectNoRenderErrors() async {
    final errors = (await diagnostics())
        .where((d) => d['level'] == 'error')
        .toList(growable: false);
    if (errors.isNotEmpty) {
      fail('render pipeline recorded ${errors.length} error diagnostic(s):\n'
          '${const JsonEncoder.withIndent('  ').convert(errors)}\n'
          '${await snapshot()}');
    }
  }

  /// Text snapshot of the rendered DOM, for failure messages and CI logs.
  Future<String> snapshot({int maxChars = 4000}) async {
    final value = await eval(
      "document.getElementById('markdown-content') ? "
      "document.getElementById('markdown-content').innerHTML : '(no #markdown-content)'",
    );
    final text = value is String ? value : '$value';
    return text.length <= maxChars ? text : '${text.substring(0, maxChars)}… (truncated)';
  }

  /// Dumps DOM + diagnostics to stdout. Call this in a failing case (or in a
  /// `tearDown`) so the CI log carries the evidence.
  Future<void> dumpDiagnostics({String reason = 'failure'}) async {
    final items = await diagnostics();
    _log('diagnostics on $reason: ${jsonEncode(items)}');
    _log('DOM snapshot on $reason:\n${await snapshot()}');
  }

  Future<void> _waitFor(
    String what,
    Future<bool> Function() predicate, {
    required Duration timeout,
    Duration interval = const Duration(milliseconds: 250),
  }) async {
    final deadline = DateTime.now().add(timeout);
    Object? lastError;
    while (DateTime.now().isBefore(deadline)) {
      try {
        if (await predicate()) {
          _log('ok: $what');
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await tester.pump(interval);
    }

    await dumpDiagnostics(reason: 'timeout waiting for $what');
    fail('timed out after ${timeout.inSeconds}s waiting for $what'
        '${lastError == null ? '' : '\nlast error: $lastError'}');
  }
}

/// Pumps frames until [condition] is true (no fixed sleeps, no `pumpAndSettle`
/// — the app has perpetual animations and the WebView keeps scheduling work).
Future<void> _pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  required Duration timeout,
  Duration interval = const Duration(milliseconds: 100),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (condition()) return;
    await tester.pump(interval);
  }
  throw TimeoutException('condition not met within $timeout');
}

Object? _normalizeEvalResult(Object raw) {
  if (raw is! String) return raw;

  // Apple wraps every result in JSON; Android does not.
  if (raw.isEmpty) return raw;
  final first = raw[0];
  final looksJson = first == '{' || first == '[' || first == '"' ||
      raw == 'true' || raw == 'false' || raw == 'null' || double.tryParse(raw) != null;
  if (!looksJson) return raw;

  try {
    return jsonDecode(raw);
  } catch (_) {
    return raw;
  }
}

/// Wraps an expression so the WebView never sees a null return value.
String _wrap(String expression) =>
    'JSON.stringify((() => { try { return ($expression) ?? null; } '
    'catch (error) { return { __evalError: String(error) }; } })())';

/// Unwraps platform quirks until the value is a plain Dart value.
Object? _unwrap(Object raw) {
  var value = _normalizeEvalResult(raw);
  // The wrapper returns a JSON *string*; on Apple that string is itself
  // JSON-encoded once more, so unwrap strings that still look like JSON.
  for (var i = 0; i < 2 && value is String; i++) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) break;
    final first = trimmed[0];
    final jsonish = first == '{' || first == '[' || first == '"' ||
        trimmed == 'null' || trimmed == 'true' || trimmed == 'false' ||
        double.tryParse(trimmed) != null;
    if (!jsonish) break;
    try {
      value = jsonDecode(trimmed);
    } catch (_) {
      break;
    }
  }
  return value;
}

void _log(String message) {
  // ignore: avoid_print — the CI runner captures stdout as the E2E artifact.
  print('$kLogPrefix $message');
}
