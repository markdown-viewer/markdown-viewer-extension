/// Registry semantics of the integration-test seam (`MobileE2E`).
///
/// The harness lives or dies by this contract: a test that grabs hooks too early
/// must wait (not fail), a test on a release build must fail loudly, and a stale
/// registration must never leak into the next case.
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'package:markdown_viewer_mobile/dev/mobile_e2e.dart';

class _FakeHooks implements MobileE2EHooks {
  _FakeHooks();

  @override
  WebViewController get controller => throw UnimplementedError('not needed for registry tests');

  @override
  bool get isWebViewReady => true;

  @override
  Future<void> openMarkdown(String content, {String filename = 'x.md'}) async {}

  @override
  Future<void> switchTheme(String themeId) async {}

  @override
  Future<void> waitUntilWebViewReady({Duration timeout = const Duration(seconds: 60)}) async {}
}

void main() {
  setUp(MobileE2E.resetForTesting);
  tearDown(MobileE2E.resetForTesting);

  test('current is null before the app registers', () {
    expect(MobileE2E.current, isNull);
  });

  test('register publishes hooks to current', () {
    final hooks = _FakeHooks();
    MobileE2E.register(hooks);
    expect(MobileE2E.current, same(hooks));
  });

  test('waitForHooks resolves after registration', () async {
    final hooks = _FakeHooks();
    final pending = MobileE2E.waitForHooks(timeout: const Duration(seconds: 2));
    MobileE2E.register(hooks);
    expect(await pending, same(hooks));
  });

  test('waitForHooks resolves immediately when hooks already exist', () async {
    final hooks = _FakeHooks();
    MobileE2E.register(hooks);
    expect(await MobileE2E.waitForHooks(timeout: const Duration(seconds: 1)), same(hooks));
  });

  test('waitForHooks times out with an actionable message', () async {
    await expectLater(
      MobileE2E.waitForHooks(timeout: const Duration(milliseconds: 50)),
      throwsA(isA<TimeoutException>()),
    );
    // A timed-out waiter must not be kept alive by the registry.
    final hooks = _FakeHooks();
    MobileE2E.register(hooks);
    expect(MobileE2E.current, same(hooks));
  });

  test('unregister clears the registry so the next case starts clean', () {
    MobileE2E.register(_FakeHooks());
    MobileE2E.unregister();
    expect(MobileE2E.current, isNull);
  });
}
