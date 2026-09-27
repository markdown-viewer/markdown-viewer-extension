/// WebView content-debugging switch (DevTools / Safari inspector).
///
/// Why this exists: the mobile app hosts diagram rendering in its own WebView
/// surface. Being able to attach DevTools (`chrome://inspect` on Android) or
/// the Safari Web Inspector (iOS/macOS) to that surface — and to the display
/// WebView — is what makes render-pipeline issues diagnosable.
///
/// Resolution order:
///   1. Release builds are hard-off (const-folded; no define/env can turn it on).
///   2. `--dart-define=MV_WEBVIEW_DEBUG=1` (compile-time; works on every device,
///      including `flutter test integration_test ... -d <device>`).
///   3. `MV_WEBVIEW_DEBUG` process environment — desktop only, because iOS and
///      Android app processes do not inherit the launcher's environment.
///   4. Default: on in debug builds, off in profile/release.
///
/// Platform notes:
///   - Android: `AndroidWebViewController.enableDebugging` is a *process-global*
///     static (`WebView.setWebContentsDebuggingEnabled`) and must run before any
///     WebView is created. It cannot be toggled per WebView.
///   - iOS/macOS: `WebKitWebViewController.setInspectable` is per-controller
///     (iOS 16.4+ / macOS 13.3+); call it for *every* WebView that should show up
///     in the inspector.
library;

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

/// The define/env key used by tooling and docs.
const String kWebViewDebugKey = 'MV_WEBVIEW_DEBUG';

const String _defineValue = String.fromEnvironment(kWebViewDebugKey);

/// Whether WebView content debugging should be enabled in this process.
bool get isWebViewDebugEnabled {
  // Never in release: compile-time constant, so the whole feature drops out.
  if (kReleaseMode) {
    return false;
  }

  if (_defineValue.isNotEmpty) {
    return parseWebViewDebugFlag(_defineValue) ?? kDebugMode;
  }

  // Desktop can read the environment; iOS/Android cannot.
  if (Platform.isMacOS || Platform.isLinux || Platform.isWindows) {
    final env = Platform.environment[kWebViewDebugKey];
    if (env != null && env.isNotEmpty) {
      return parseWebViewDebugFlag(env) ?? kDebugMode;
    }
  }

  return kDebugMode;
}

/// Parses a flag value. Returns null when the value is not recognised, so
/// callers fall back to their own default instead of silently disabling
/// debugging because of a typo (`MV_WEBVIEW_DEBUG=flase`).
@visibleForTesting
bool? parseWebViewDebugFlag(String raw) {
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
