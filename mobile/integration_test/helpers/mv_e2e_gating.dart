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

/// True when `MV_E2E_HEAVY=1` is set in the *test host* environment.
///
/// On a device the app process does not inherit the launcher environment, so
/// integration tests read it from `--dart-define`-free tooling by checking the
/// host process. `flutter test` runs the test code inside the app process, hence
/// `Platform.environment` is the device's — CI passes it through both ways.
bool get isHeavyE2EEnabled {
  final value = Platform.environment['MV_E2E_HEAVY'];
  return value == '1' || value == 'true';
}
