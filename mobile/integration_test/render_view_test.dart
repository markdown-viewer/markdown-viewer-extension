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

import 'package:flutter_test/flutter_test.dart';

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

      expect(await e2e.eval('window.__mvRenderSurface.state'), 'ready');
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
      // through the value-returning evaluation path.
      await e2e.runJs(
        'window.__mvRenderSurface.__debugReloadForTest && window.__mvRenderSurface.__debugReloadForTest()',
      );

      await e2e.switchTheme('default');
      await e2e.waitForRenderedBlocks(1);
      await e2e.waitForNoPendingPlaceholders();

      expect(await e2e.evalInt("document.querySelectorAll('.mv-plugin-error').length"), 0,
          reason: 'a restarted render surface must not leave error blocks behind');
      expect(await e2e.evalInt("document.querySelectorAll('$kDiagramImageSelector').length"), 1);
    });
  });
}
