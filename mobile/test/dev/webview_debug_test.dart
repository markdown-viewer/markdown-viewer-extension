/// `MV_WEBVIEW_DEBUG` flag semantics.
///
/// The flag decides whether DevTools / the Safari inspector can attach to the
/// app's WebView surfaces. Two properties matter and are easy to break:
///   1. release builds are hard-off (no define or env can turn it on);
///   2. an unrecognised value must not silently disable debugging.
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:markdown_viewer_mobile/dev/webview_debug.dart';

void main() {
  group('parseWebViewDebugFlag', () {
    test('accepts the documented truthy spellings', () {
      for (final value in <String>['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
        expect(parseWebViewDebugFlag(value), isTrue, reason: 'value: "$value"');
      }
    });

    test('accepts the documented falsy spellings', () {
      for (final value in <String>['0', 'false', 'FALSE', 'no', 'off', ' off ']) {
        expect(parseWebViewDebugFlag(value), isFalse, reason: 'value: "$value"');
      }
    });

    test('returns null for unknown values so callers keep their own default', () {
      for (final value in <String>['', 'flase', 'maybe', '2']) {
        expect(parseWebViewDebugFlag(value), isNull, reason: 'value: "$value"');
      }
    });
  });

  group('isWebViewDebugEnabled', () {
    test('is on in unit-test (debug) builds without a define', () {
      expect(isWebViewDebugEnabled, isTrue);
    });

    test('honours the compile-time define when present', () {
      // `flutter test --dart-define=MV_WEBVIEW_DEBUG=0` runs this file with the
      // define set; without it the default above applies.
      const defineValue = String.fromEnvironment(kWebViewDebugKey);
      if (defineValue.isNotEmpty) {
        expect(isWebViewDebugEnabled, parseWebViewDebugFlag(defineValue));
      }
    });
  });
}
