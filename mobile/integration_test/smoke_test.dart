/// Smoke suite: the app boots, the display WebView comes up, and the testing
/// seam is reachable.
///
/// Run first when the harness itself is suspect — every other suite assumes what
/// these cases prove.
///
///   `flutter test integration_test/smoke_test.dart -d <device>`
library;

import 'package:flutter_test/flutter_test.dart';

import 'helpers/mv_e2e.dart';
import 'helpers/mv_fixtures.dart';

void main() {
  group('mobile app boot', () {
    testWidgets('boots and reports its WebView as ready', (tester) async {
      final e2e = await MvE2E.launch(tester);

      expect(await e2e.eval('window.__mobileWebViewReady === true'), isTrue,
          reason: 'the display page must announce readiness to the host');
      expect(
        await e2e.eval('typeof window.__mvRenderDiagnostics === "object"'),
        isTrue,
        reason: 'the E2E diagnostics seam must exist in non-release builds',
      );
      // The page owns the decision of which surface to warm, and Dart only calls
      // this hook after publishing the mode. A hook that is declared but never
      // assigned (which happened once) silently costs the iframe path its
      // background pre-load, and nothing else would notice.
      expect(
        await e2e.eval('typeof window.__mvRenderWakeRenderSurface === "function"'),
        isTrue,
        reason: 'Dart warms the render surface through this hook (see mobile/src/webview/main.ts)',
      );
    });

    testWidgets('renders a document into the DOM', (tester) async {
      final e2e = await MvE2E.launch(tester);

      await e2e.openDocument(kMinimalDocument);
      await e2e.waitForSelector('h1');

      expect(await e2e.evalInt("document.querySelectorAll('h1').length"), 1);
      expect(
        await e2e.eval("document.querySelector('h1')?.textContent"),
        contains('E2E heading'),
      );
      await e2e.expectNoRenderErrors();
    });
  });
}
