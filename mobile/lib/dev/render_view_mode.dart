/// Render-surface mode flag (mobile).
///
/// Which surface renders diagrams:
///   - `iframe`  — the in-page hidden iframe (the long-standing path);
///   - `webview` — the app's own hidden WebView, relayed by Dart
///     (see plans/mobile-render-view-webview-plan.md).
///
/// For now this is a *developer/test* switch, not a user setting: the user-facing
/// `settings.renderView` (settings page, locales, migration of the default) lands
/// with the rollout in Phase 3, so that nothing user-visible changes while the
/// surface is still being verified.
///
/// Resolution order:
///   1. release builds are hard-off (the iframe path stays the shipped one);
///   2. `--dart-define=MV_RENDER_VIEW=1` (works on every device, including
///      `flutter test integration_test`);
///   3. `MV_RENDER_VIEW` process environment — desktop only, where the app
///      process inherits the launcher's environment.
library;

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

/// The define/env key used by tooling and docs.
const String kRenderViewModeKey = 'MV_RENDER_VIEW';

const String _defineValue = String.fromEnvironment(kRenderViewModeKey);

/// Whether diagrams should render in the app's hidden render WebView.
bool get isRenderViewEnabled {
  // Never in release: flipping the shipped default is a Phase 3 product change.
  if (kReleaseMode) {
    return false;
  }

  if (_defineValue.isNotEmpty) {
    return _parseFlag(_defineValue) ?? false;
  }

  if (Platform.isMacOS || Platform.isLinux || Platform.isWindows) {
    final env = Platform.environment[kRenderViewModeKey];
    if (env != null && env.isNotEmpty) {
      return _parseFlag(env) ?? false;
    }
  }

  return false;
}

bool? _parseFlag(String raw) {
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return null;
  }
}
