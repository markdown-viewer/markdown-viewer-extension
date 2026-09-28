/// Test-only override of the relay's bridge budget.
///
/// The relay frames a message that is larger than the bridge can carry
/// (`mobile/lib/services/relay_chunking.dart`). On Android the real limit is small
/// enough that an ordinary diagram result gets framed; on iOS/macOS it is
/// megabytes, so an end-to-end run there would never exercise the framing path —
/// the one asymmetry that lets a broken chunking layer ship unnoticed.
///
/// `MV_E2E_RELAY_SMALL=1` (dart-define, or the process environment on desktop)
/// makes the app use a deliberately tiny budget on every platform, so the L2
/// suite can prove that a result *is* carried in frames, over a real WebView
/// bridge, and comes back assembled.
///
/// Resolution order:
///   1. release builds are hard-off (the shipped default is the platform's real
///      limit; this is a test seam, not a setting);
///   2. `--dart-define=MV_E2E_RELAY_SMALL=1` (works on every device, including
///      `flutter test integration_test`);
///   3. `MV_E2E_RELAY_SMALL` process environment — desktop only, where the app
///      process inherits the launcher's environment.
library;

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

import '../services/relay_chunking.dart';

/// The define/env key used by tooling and docs.
const String kRelayLimitsSmallKey = 'MV_E2E_RELAY_SMALL';

const String _defineValue = String.fromEnvironment(kRelayLimitsSmallKey);

/// The tiny budget the override installs: small enough that a single diagram
/// result is carried in many frames, large enough to keep a run quick.
const RelayChunkLimits kSmallRelayLimits = RelayChunkLimits(
  maxMessageLength: 8 * 1024,
  chunkSize: 2 * 1024,
  window: 1,
);

/// Whether the small-budget override is active in this process.
bool get isSmallRelayLimitsEnabled {
  if (kReleaseMode) {
    return false;
  }

  if (_defineValue.isNotEmpty) {
    return parseRelayLimitsFlag(_defineValue) ?? false;
  }

  if (Platform.isMacOS || Platform.isLinux || Platform.isWindows) {
    final env = Platform.environment[kRelayLimitsSmallKey];
    if (env != null && env.isNotEmpty) {
      return parseRelayLimitsFlag(env) ?? false;
    }
  }

  return false;
}

/// The limits the app should use, or null for the platform's real ones.
RelayChunkLimits? relayChunkLimitsOverride() => isSmallRelayLimitsEnabled ? kSmallRelayLimits : null;

/// Parses a flag value; null when the value is not recognised, so a typo cannot
/// silently change what the transport does.
@visibleForTesting
bool? parseRelayLimitsFlag(String raw) {
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
