/// Gating for the expensive cases.
///
/// Emulator/CI runs must stay light: a guest starved of CPU does not fail
/// cleanly, it ANRs (`X isn't responding`) and wedges the run. The cases that
/// rasterize multi-megabyte payloads therefore only run when asked for, and are
/// expected to run on a real device.
///
///   `MV_E2E_HEAVY=1 flutter test integration_test -d <real device>`
library;

import 'dart:io';

const String _defineValue = String.fromEnvironment(kHeavyE2EKey);

/// The define/env key used by tooling and docs.
const String kHeavyE2EKey = 'MV_E2E_HEAVY';

/// True when the heavy cases are enabled.
///
/// Two sources on purpose: a device's app process does not inherit the launcher's
/// environment, so `--dart-define=MV_E2E_HEAVY=1` (what the runner passes) is the
/// one that works everywhere; the process environment covers desktop runs.
bool get isHeavyE2EEnabled {
  if (_defineValue == '1' || _defineValue.toLowerCase() == 'true') {
    return true;
  }

  final value = Platform.environment[kHeavyE2EKey];
  return value == '1' || value == 'true';
}
