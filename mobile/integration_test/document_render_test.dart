/// Document-rendering suite: the markdown structures that must render without
/// any diagram engine involved (headings, tables, code, task lists, math,
/// quotes).
///
/// These are the cheap, fast cases that catch a broken *pipeline* — the thing a
/// render-surface migration must not disturb.
library;

import 'package:flutter_test/flutter_test.dart';

import 'helpers/mv_e2e.dart';
import 'helpers/mv_fixtures.dart';

void main() {
  group('document rendering', () {
    testWidgets('renders tables, code blocks, task lists, math and quotes', (tester) async {
      final e2e = await MvE2E.launch(tester);

      await e2e.openDocument(kStructureDocument);
      await e2e.waitForSelector('table');

      expect(await e2e.evalInt("document.querySelectorAll('table').length"), 1);
      expect(await e2e.evalInt("document.querySelectorAll('table td').length"), 2,
          reason: 'the table body must carry both cells');
      expect(await e2e.evalInt("document.querySelectorAll('pre code').length"), greaterThanOrEqualTo(1),
          reason: 'fenced code must render as <pre><code>');
      expect(await e2e.evalInt("document.querySelectorAll('input[type=\"checkbox\"]').length"), 2,
          reason: 'both task-list items must be interactive checkboxes');
      expect(await e2e.evalInt("document.querySelectorAll('.katex').length"), greaterThanOrEqualTo(1),
          reason: 'inline math must be KaTeX-rendered');
      expect(await e2e.evalInt("document.querySelectorAll('blockquote').length"), 1);

      await e2e.expectNoRenderErrors();
    });

    group('theme switching', () {
      testWidgets('keeps rendered content intact', (tester) async {
        final e2e = await MvE2E.launch(tester);

        await e2e.openDocument(kStructureDocument);
        await e2e.waitForSelector('table');
        final before = await e2e.evalInt("document.querySelectorAll('table td').length");

        await e2e.switchTheme('default');
        await e2e.waitForSelector('table');

        expect(await e2e.evalInt("document.querySelectorAll('table td').length"), before,
            reason: 'a theme switch must not drop rendered content');
        await e2e.expectNoRenderErrors();
      });
    });
  });
}
