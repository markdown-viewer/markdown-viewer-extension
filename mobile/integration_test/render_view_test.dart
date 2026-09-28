/// Render-surface suite: the *hidden render WebView* migration
/// (`plans/mobile-render-view-webview-plan.md`).
///
/// These are the acceptance cases for Phase 1–3 of that plan. They are written
/// before the feature exists and skip while the app still renders diagrams in
/// the in-page iframe, so the suite doubles as the migration checklist — flipping
/// `renderView` to `webview` turns it into a gate.
///
/// Skips are explicit rather than deleted, because the pass criteria *are* the
/// deliverable.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:markdown_viewer_mobile/dev/relay_limits_override.dart';

import 'helpers/mv_e2e.dart';
import 'helpers/mv_fixtures.dart';

const String kDiagramImageSelector = '.diagram-block img[src^="data:image/png"]';

/// The render surface is the *active* surface for this run.
///
/// The status seam itself is always installed (it is harmless diagnostics), so
/// the gate has to ask the mode — Dart publishes `window.__mvRenderView` with the
/// surface the page should use (`mobile/lib/dev/render_view_mode.dart`).
Future<bool> hasRenderSurfaceSeam(MvE2E e2e) async =>
    await e2e.eval(
          'window.__mvRenderView === true && typeof window.__mvRenderSurface === "object"',
        ) ==
        true;

void main() {
  group('render surface', () {
    testWidgets('reports ready through the host', (tester) async {
      final e2e = await MvE2E.launch(tester);
      if (!await hasRenderSurfaceSeam(e2e)) {
        markTestSkipped('render surface status seam not implemented yet (Phase 1)');
        return;
      }

      // The surface is warmed after the display page is interactive, so at
      // boot the page still reports `unknown`; readiness is what it eventually
      // reports, and what the display side waits for before the first diagram.
      final status = await e2e.waitForRenderSurfaceReady();
      expect(status['state'], 'ready');
      expect(status['renderers'], isNotEmpty,
          reason: 'a ready surface announces the engines it registered');
      expect(status['error'], isNull, reason: 'a ready surface reports no failure');
    });

    testWidgets('keeps rendering after the surface restarts', (tester) async {
      final e2e = await MvE2E.launch(tester);
      if (!await hasRenderSurfaceSeam(e2e)) {
        markTestSkipped('render surface restart hook not implemented yet (Phase 2)');
        return;
      }

      await e2e.openDocument(kMermaidDocument);
      await e2e.waitForRenderedBlocks(1);

      // The reload hook is a side effect: it returns nothing, so it must not go
      // through the value-returning evaluation path. Its absence must fail the
      // case, not turn it into a render that never restarted anything.
      final hasHook =
          await e2e.eval('typeof window.__mvRenderSurface.__debugReloadForTest === "function"');
      expect(hasHook, isTrue, reason: 'the restart case needs the supervisor reload hook');

      await e2e.runJs(
        'window.__mvRenderSurface.__debugReloadForTest && window.__mvRenderSurface.__debugReloadForTest()',
      );

      final reloaded = await e2e.waitForRenderSurfaceReload();
      final logs = MvE2E.renderSurfaceLogs(reloaded);
      final reloadAt = logs.lastIndexOf(MvE2E.kSupervisorReloadLog);
      expect(reloadAt, isNonNegative, reason: 'the hook must reach the supervisor: $logs');
      expect(
        logs.skip(reloadAt).any((line) => line.startsWith('ready (')),
        isTrue,
        reason: 'a restarted surface must report ready again: $logs',
      );

      await e2e.switchTheme('default');
      await e2e.waitForRenderedBlocks(1);
      await e2e.waitForNoPendingPlaceholders();

      expect(await e2e.evalInt("document.querySelectorAll('.mv-plugin-error').length"), 0,
          reason: 'a restarted render surface must not leave error blocks behind');
      expect(await e2e.evalInt("document.querySelectorAll('$kDiagramImageSelector').length"), 1);
    });

    testWidgets('carries what the bridge cannot hold in frames', (tester) async {
      final e2e = await MvE2E.launch(tester);
      if (!await hasRenderSurfaceSeam(e2e)) {
        markTestSkipped('relay framing not implemented yet (Phase 2.2)');
        return;
      }

      final ready = await e2e.waitForRenderSurfaceReady();
      final before = _chunkCounters(ready);
      final pushBefore = ready['push'] is int ? ready['push']! as int : 0;

      // A source unique to this run: with a warm render cache the service answers
      // from the cache and *nothing* crosses the bridge, which would leave the
      // "framing ran" assertions below vacuous.
      final document = kMermaidDocument.replaceFirst(
        'graph LR',
        'graph LR\n  %% relay-framing ${DateTime.now().microsecondsSinceEpoch}',
      );
      await e2e.openDocument(document);
      await e2e.waitForRenderedBlocks(1);
      await e2e.waitForNoPendingPlaceholders();
      await e2e.expectNoRenderErrors();

      // A snapshot newer than the traffic this case caused: the counters are
      // maxima, so the one from before the render would prove nothing.
      final after = _chunkCounters(await e2e.waitForRenderSurfacePush(push: pushBefore));
      final limit = after['limit']!;

      // The render itself must have crossed the relay: if the display page had
      // rendered in the in-page iframe instead (the mode is published by Dart, and
      // a page that touches the renderer before it arrives freezes that choice),
      // every assertion below would be vacuous.
      expect(after['messagesReceived'], greaterThan(before['messagesReceived'] ?? 0),
          reason: 'the diagram must have been rendered through the relay');

      // The invariant that motivates the whole layer: no single message on the
      // bridge may exceed its limit — the platform drops what it cannot carry, so
      // a violation here is a silently missing diagram on a real device.
      expect(after['maxMessageSent'], lessThanOrEqualTo(limit),
          reason: 'nothing Dart sent may exceed the bridge limit (${after['maxMessageSent']} > $limit)');
      expect(after['maxMessageReceived'], lessThanOrEqualTo(limit),
          reason: 'nothing a page sent may exceed the bridge limit (${after['maxMessageReceived']} > $limit)');

      if (isSmallRelayLimitsEnabled) {
        // MV_E2E_RELAY_SMALL: the payloads are bigger than the budget, so this run
        // proves the framing path end to end — frames on the bridge, the result
        // reassembled into a diagram. Without it the platform's real limit is
        // megabytes and a diagram result would cross in one piece.
        expect(after['sent'], greaterThan(before['sent'] ?? 0),
            reason: 'the result needed framing, so frames must have crossed');
        expect(after['received'], greaterThan(before['received'] ?? 0));
        expect(after['maxAssembledOut'], greaterThan(limit),
            reason: 'the payload that crossed in frames was larger than the bridge limit');
        expect(await e2e.evalInt("document.querySelectorAll('$kDiagramImageSelector').length"), 1,
            reason: 'a framed result must come back assembled into an image');
        debugPrint('$kLogPrefix ok: framed ${after['sent']} frames above a $limit char budget '
            '(largest message ${after['maxAssembledOut']} chars)');
      }
    });
  });
}

/// Reads the supervisor's bridge-traffic counters out of a status snapshot.
Map<String, int> _chunkCounters(Map<String, Object?> status) {
  final chunks = status['chunks'];
  if (chunks is! Map) {
    fail('the supervisor reported no bridge-traffic counters: ${jsonEncode(status)}');
  }
  final counters = <String, int>{};
  chunks.forEach((key, value) {
    final number = value is int ? value : (value is double ? value.toInt() : int.tryParse('$value'));
    if (number != null) {
      counters['$key'] = number;
    }
  });
  for (final key in <String>['messagesSent', 'messagesReceived', 'sent', 'received', 'maxMessageSent', 'maxMessageReceived', 'maxAssembledOut', 'limit']) {
    if (!counters.containsKey(key)) {
      fail('the bridge-traffic counters are missing "$key": ${jsonEncode(status)}');
    }
  }
  return counters;
}
