/// Diagram-rendering suite: the engine path end to end.
///
/// This is the suite that guards the render-surface migration (iframe → hidden
/// WebView): every assertion is written against *observable product behaviour*
/// (a PNG in the DOM, an error block for broken input), so the cases stay valid
/// when the surface underneath changes.
library;

import 'package:flutter_test/flutter_test.dart';

import 'helpers/mv_e2e.dart';
import 'helpers/mv_e2e_gating.dart';
import 'helpers/mv_fixtures.dart';

/// Selector for a finished diagram: the pipeline stamps `data-plugin-rendered`
/// on the element it inserted, whatever surface produced it.
const String kDiagramSelector = '[data-plugin-rendered="true"]';

const String kDiagramImageSelector = '.diagram-block img[src^="data:image/png"]';

void main() {
  group('diagram rendering', () {
    testWidgets('turns a mermaid block into a PNG image', (tester) async {
      final e2e = await MvE2E.launch(tester);

      await e2e.openDocument(kMermaidDocument);
      await e2e.waitForRenderedBlocks(1);

      expect(await e2e.evalInt("document.querySelectorAll('$kDiagramSelector').length"), 1);
      expect(await e2e.evalInt("document.querySelectorAll('$kDiagramImageSelector').length"), 1,
          reason: 'the diagram must be an <img> with a data: PNG source');
      // The block wrapper (not the <img>) carries the plugin metadata.
      expect(
        await e2e.evalInt(
          "document.querySelectorAll('.diagram-block[data-plugin-type=\"mermaid\"][data-plugin-rendered=\"true\"]').length",
        ),
        1,
        reason: 'the rendered block must be tagged as a finished mermaid diagram',
      );

      // A real PNG payload, not a placeholder-sized stub.
      final bytes = await e2e.evalInt(
        "document.querySelector('$kDiagramImageSelector')?.src.length ?? 0",
      );
      expect(bytes, greaterThan(2000),
          reason: 'a rendered mermaid PNG should be far larger than an empty image');

      await e2e.expectNoRenderErrors();
    });

    testWidgets('finishes every diagram in a document', (tester) async {
      final e2e = await MvE2E.launch(tester);

      await e2e.openDocument(kTwoDiagramDocument);
      await e2e.waitForRenderedBlocks(2);
      await e2e.waitForNoPendingPlaceholders();

      expect(await e2e.evalInt("document.querySelectorAll('$kDiagramImageSelector').length"), 2);
      await e2e.expectNoRenderErrors();
    });

    testWidgets('surfaces an error block when a diagram fails to parse', (tester) async {
      final e2e = await MvE2E.launch(tester);

      await e2e.openDocument(kBrokenDiagramDocument);
      await e2e.waitForSelector('.mv-plugin-error');

      expect(await e2e.evalInt("document.querySelectorAll('.diagram-block img').length"), 0);
      final message = await e2e.eval("document.querySelector('.mv-plugin-error')?.textContent");
      expect('$message', isNotEmpty);

      // The failure must also be reported to the host, not only drawn on screen.
      final errors = (await e2e.diagnostics()).where((d) => d['level'] == 'error').toList();
      expect(errors, isNotEmpty, reason: 'a failed diagram must reach the diagnostics sink');
    });

    group('theme switching', () {
      testWidgets('re-renders diagrams', (tester) async {
        final e2e = await MvE2E.launch(tester);

        await e2e.openDocument(kMermaidDocument);
        await e2e.waitForRenderedBlocks(1);
        final first = await e2e.eval("document.querySelector('$kDiagramImageSelector')?.src");

        await e2e.switchTheme('default');
        await e2e.waitForRenderedBlocks(1);

        final second = await e2e.eval("document.querySelector('$kDiagramImageSelector')?.src");
        expect(second, isNotNull, reason: 'the diagram must exist after the theme switch');
        expect('${second!}'.length, greaterThan(2000));
        if ('$first' != '$second') {
          // Different bytes are fine (theme restyle); identical is fine too when
          // the cached result is reused. What must not happen is a missing diagram.
          expect(await e2e.evalInt("document.querySelectorAll('$kDiagramImageSelector').length"), 1);
        }
        await e2e.expectNoRenderErrors();
      });
    });

    group('heavy payloads', () {
      // The 40-node graph rasterizes to megabytes — the payload the chunked
      // transport of the render-surface plan has to carry. Off by default so
      // emulator/CI runs stay inside their CPU budget (a starved guest ANRs
      // instead of failing); run it on a real device with `MV_E2E_HEAVY=1`.
      testWidgets(
        'rasterizes a 40-node graph into a multi-megabyte PNG [MV_E2E_HEAVY=1]',
        (tester) async {
          final e2e = await MvE2E.launch(tester);
          await e2e.openDocument(heavyDiagramDocument(), filename: 'heavy.md');
          await e2e.waitForRenderedBlocks(1, timeout: const Duration(minutes: 3));
          await e2e.waitForNoPendingPlaceholders(timeout: const Duration(minutes: 3));

          final srcLength = await e2e.evalInt(
            "document.querySelector('$kDiagramImageSelector')?.src.length ?? 0",
          );
          // Recorded so the relay's payload size is visible in the run log: this
          // is the number that decides when the chunked transport is required
          // (WKWebView carries multi-MB; Android's JavaScript interface is the
          // platform whose limit is in question).
          print('$kLogPrefix heavy diagram PNG data-URL length: $srcLength');
          // No digit separators: the app's pubspec pins a language version below
          // the 3.6 feature and `flutter build` rejects them.
          expect(srcLength, greaterThan(200000),
              reason: 'a 40-node graph should rasterize to a large PNG payload');
          await e2e.expectNoRenderErrors();
        },
        skip: !isHeavyE2EEnabled,
      );
    });
  });
}
