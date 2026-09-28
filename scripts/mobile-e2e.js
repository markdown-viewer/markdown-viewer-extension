#!/usr/bin/env node
/**
 * Mobile E2E runner.
 *
 * One entry point for local runs and CI, so both execute the same thing:
 *
 *   node scripts/mobile-e2e.js --layer=unit          # Dart unit tests (no device)
 *   node scripts/mobile-e2e.js --layer=integration   # Flutter integration_test (needs a device)
 *   node scripts/mobile-e2e.js --layer=all           # both, in order
 *
 * Layers
 *   unit        `flutter test test/` — pure Dart, no device, seconds.
 *   integration `flutter test integration_test -d <device>` — the real app on a
 *               device/emulator/simulator. Device resolution order:
 *                 --device=<id> → MV_E2E_DEVICE → auto-detect from `flutter devices`
 *               With no device and MV_E2E_ALLOW_SKIP=1 the layer is skipped with
 *               a warning (exit 0); otherwise it fails (exit 1).
 *
 * Flags
 *   --layer=unit|integration|all  which layer(s) to run (default: all)
 *   --device=<id>                 device for the integration layer
 *   --suite=<name>                run only these suites (repeatable)
 *   --name=<regex>                run only cases whose full name matches
 *   --list                        list the discovered suites and exit
 *
 * Why a script instead of three npm one-liners: CI needs device detection,
 * artifact capture and a machine-readable summary; contributors need the exact
 * same invocation locally. Keeping it dependency-free means it also runs under
 * fibjs' Node compatibility if that ever becomes useful.
 *
 * Env:
 *   MV_E2E_DEVICE              device id passed to `flutter test -d`
 *   MV_E2E_ALLOW_SKIP          '1' → no device is not an error
 *   MV_E2E_ARTIFACT_DIR        where logs/summary are written (default test-results/mobile-e2e)
 *   MV_E2E_TIMEOUT_MIN         per-layer timeout in minutes (default 30)
 *   MV_E2E_BUILD               '0' → never auto-build the WebView assets
 *   MV_E2E_BOOT_SETTLE_SECONDS Android only: quiet period after boot (default 20)
 *   MV_E2E_RETRY_HANG        '0' → do not re-run an invocation whose harness hung
 *   (tests read MV_E2E_HEAVY themselves — see mobile/integration_test/helpers)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const mobileDir = path.join(projectRoot, 'mobile');

const artifactDir = path.resolve(
  projectRoot,
  process.env.MV_E2E_ARTIFACT_DIR || 'test-results/mobile-e2e',
);
const allowSkip = process.env.MV_E2E_ALLOW_SKIP === '1';
const timeoutMinutes = Number(process.env.MV_E2E_TIMEOUT_MIN || 30);
const autoBuild = process.env.MV_E2E_BUILD !== '0';

function log(message) {
  console.log(`[mobile-e2e] ${message}`);
}

function run(command, args, options = {}) {
  const label = `${command} ${args.join(' ')}`;
  log(`$ ${label}`);
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: timeoutMinutes * 60_000,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
  });
  const durationMs = Date.now() - startedAt;
  return {
    label,
    status: result.status ?? (result.error ? 1 : 0),
    durationMs,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function flutterAvailable() {
  const probe = run('flutter', ['--version'], { capture: true });
  return probe.status === 0;
}

/** WebView assets are Flutter assets (`build/mobile/`), so the app cannot render without them. */
function ensureWebViewAssets() {
  const indexPath = path.join(mobileDir, 'build', 'mobile', 'index.html');
  if (fs.existsSync(indexPath)) {
    log('WebView assets present (mobile/build/mobile)');
    return 0;
  }
  if (!autoBuild) {
    log('WebView assets missing and MV_E2E_BUILD=0 → integration layer cannot run');
    return 1;
  }
  log('WebView assets missing → building (node mobile/build.js)');
  const build = run('node', ['mobile/build.js']);
  return build.status;
}

/** Resolves the device id for `flutter test -d`. */
function resolveDevice(explicit) {
  if (explicit) return { id: explicit, source: 'argument' };
  if (process.env.MV_E2E_DEVICE) return { id: process.env.MV_E2E_DEVICE, source: 'MV_E2E_DEVICE' };

  const probe = run('flutter', ['devices', '--machine'], { capture: true });
  if (probe.status !== 0) return { id: null, source: 'unavailable', error: probe.error || probe.stderr };

  let devices = [];
  try {
    devices = JSON.parse(probe.stdout);
  } catch (error) {
    return { id: null, source: 'unparseable', error: String(error) };
  }

  // Prefer a mobile device: that is what the suites exist for. A desktop device
  // would still work, but its WebView is the desktop engine, not the phone one.
  const mobile = devices.find((d) => /^(ios|android)/i.test(d.targetPlatform || ''));
  if (mobile) return { id: mobile.id, source: 'auto (mobile device)' };

  // Desktop fallback keeps the harness usable when no phone is attached.
  const desktop = devices.find((d) => /darwin|windows|linux/.test(d.targetPlatform || ''));
  if (desktop) return { id: desktop.id, source: `auto (desktop: ${desktop.targetPlatform})`, desktop: true };

  return { id: null, source: 'none' };
}

function writeArtifact(name, content) {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, name), content);
}

/** Locates adb for the preflight (env first, then PATH, then the macOS SDK default). */
function resolveAdb() {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    'adb',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8', timeout: 15_000 });
    if (probe.status === 0) return candidate;
  }

  const defaultPath = path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
  if (fs.existsSync(defaultPath)) return defaultPath;
  return null;
}

function adb(adbPath, args, timeoutMs = 30_000) {
  return spawnSync(adbPath, args, { encoding: 'utf8', timeout: timeoutMs });
}

/**
 * Waits until an Android device is actually usable.
 *
 * Why this exists: an emulator that has not finished booting (or a guest whose
 * system apps are ANR'ing under host load) still shows up in `flutter devices`.
 * The test run then fails with a confusing "lost connection to device" instead
 * of "the device is not ready". Checking `sys.boot_completed` + bootanim here
 * turns that into one actionable line.
 */
function preflightAndroidDevice(adbPath, deviceId) {
  log(`preflight: waiting for ${deviceId} to boot (adb ${adbPath})`);
  const waited = adb(adbPath, ['-s', deviceId, 'wait-for-device'], 300_000);
  if (waited.status !== 0) {
    return `adb could not reach ${deviceId}: ${waited.stderr || waited.error || 'unknown error'}`;
  }

  const deadline = Date.now() + 300_000;
  let booted = false;
  let bootanim = '';
  while (Date.now() < deadline) {
    const completed = adb(adbPath, ['-s', deviceId, 'shell', 'getprop', 'sys.boot_completed'], 20_000);
    bootanim = (adb(adbPath, ['-s', deviceId, 'shell', 'getprop', 'init.svc.bootanim'], 20_000).stdout || '').trim();
    if ((completed.stdout || '').trim() === '1' && bootanim === 'stopped') {
      booted = true;
      break;
    }
    spawnSync('sleep', ['3']);
  }
  if (!booted) {
    return `${deviceId} did not finish booting within 5min (sys.boot_completed!=1, bootanim="${bootanim}")`;
  }

  const sanity = adb(adbPath, ['-s', deviceId, 'shell', 'echo', 'ok'], 20_000);
  if (!(sanity.stdout || '').includes('ok')) {
    return `${deviceId} is not answering shell commands — the guest is likely wedged (ANR under host load)`;
  }

  prepareAndroidGuest(adbPath, deviceId);

  // Best effort: record what is focused, so a blocked run is diagnosable later.
  const focus = adb(adbPath, ['-s', deviceId, 'shell', 'dumpsys', 'window'], 30_000);
  const focusLine = (focus.stdout || '').split('\n').find((line) => line.includes('mCurrentFocus'));
  log(`preflight: ok — ${focusLine ? focusLine.trim() : 'focus unknown'}`);
  return null;
}

/**
 * Makes a booted Android guest usable for a test run.
 *
 * A cold-booted emulator starts a burst of Google services while the test is
 * already running; several of them exceed the 20 s service budget on a loaded
 * host and ANR at once (observed: Gboard, AiAi autofill, Messages RCS,
 * com.android.phone). The dialogs that follow steal focus and can swallow the
 * first taps of a run, and they obscure what actually failed. Two things help:
 *
 *   - hide_error_dialogs / anr_show_background: the canonical CI switch that
 *     keeps the guest from drawing those dialogs at all;
 *   - a short settle window after boot, so the burst finishes before the app
 *     starts (MV_E2E_BOOT_SETTLE_SECONDS, 0 disables it).
 *
 * ANRs already recorded are reported, so a slow guest is visible in the log even
 * when nothing fails.
 */
function prepareAndroidGuest(adbPath, deviceId) {
  const events = adb(adbPath, ['-s', deviceId, 'logcat', '-b', 'events', '-d'], 30_000);
  const anrs = (events.stdout || '')
    .split('\n')
    .filter((line) => line.includes('am_anr'))
    .map((line) => {
      const match = line.match(/am_anr\s*:\s*\[\d+,\d+,([^,:]+)/);
      return match ? match[1] : null;
    })
    .filter(Boolean);
  if (anrs.length > 0) {
    const unique = [...new Set(anrs)];
    log(`preflight: ${anrs.length} ANR(s) since boot (${unique.slice(0, 5).join(', ')}) — expected on a cold emulator under load`);
  }

  // A dialog may already be on screen from before this run. BACK does not
  // dismiss a system ANR dialog; closing system dialogs does (verified on API 35:
  // focus moves from "Application Not Responding" back to the launcher).
  const focus = adb(adbPath, ['-s', deviceId, 'shell', 'dumpsys', 'window'], 30_000);
  if ((focus.stdout || '').includes('Not Responding')) {
    log('preflight: clearing an ANR dialog that is on screen');
    adb(adbPath, [
      '-s', deviceId, 'shell', 'am', 'broadcast',
      '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS',
    ], 20_000);
  }

  // Hide future ones: the canonical CI switch (no dialog for ANRs or crashes).
  adb(adbPath, ['-s', deviceId, 'shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1'], 20_000);
  adb(adbPath, ['-s', deviceId, 'shell', 'settings', 'put', 'secure', 'anr_show_background', '0'], 20_000);

  const settleSeconds = Number(process.env.MV_E2E_BOOT_SETTLE_SECONDS ?? 20);
  if (settleSeconds > 0) {
    log(`preflight: letting the guest settle for ${settleSeconds}s (MV_E2E_BOOT_SETTLE_SECONDS)`);
    spawnSync('sleep', [String(settleSeconds)]);

    // A guest that keeps ANR'ing during the settle window is starved (host load),
    // not busy booting — worth saying out loud before the run blames the app.
    const after = adb(adbPath, ['-s', deviceId, 'logcat', '-b', 'events', '-d'], 30_000);
    const afterCount = (after.stdout || '').split('\n').filter((line) => line.includes('am_anr')).length;
    if (afterCount > anrs.length) {
      log(`preflight: ${afterCount - anrs.length} further ANR(s) during the settle window — the host is overloaded`);
    }
  }
}

/** Android device ids come from `flutter devices` (emulator-5554) or adb serials. */
function isAndroidDeviceId(id) {
  return /^emulator-\d+$/.test(id) || /^(localhost:|[0-9.]+:)\d+$/.test(id) || /^\w{8,}$/.test(id);
}

function preflightDevice(deviceId) {
  if (!isAndroidDeviceId(deviceId)) {
    log(`preflight: skipped (non-Android device ${deviceId})`);
    return null;
  }
  const adbPath = resolveAdb();
  if (!adbPath) {
    log('preflight: adb not found — skipping device boot check');
    return null;
  }
  return preflightAndroidDevice(adbPath, deviceId);
}

function runUnitLayer() {
  const result = run('flutter', ['test', 'test/'], { cwd: mobileDir });
  writeArtifact('unit.log', `$ ${result.label}\n\nexit=${result.status}\n`);
  return result;
}

/** Desktop hosts relaunch the app per test file and are flakier at it than phones. */
function isDesktopDevice(deviceId) {
  return deviceId === 'macos' || deviceId === 'linux' || deviceId === 'windows';
}

/** Every `*_test.dart` in integration_test/, discovered the way `flutter test` does. */
function discoverSuites() {
  const dir = path.join(mobileDir, 'integration_test');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('_test.dart'))
    .sort();
}

/**
 * Maps `--suite=smoke` / `--suite=smoke_test.dart` onto suite files.
 *
 * Passing files explicitly (instead of the directory) keeps the run honest when
 * a suite is being rewritten: `flutter test integration_test` resolves the
 * directory up front, so a file that disappears mid-flight fails the whole run
 * with a bare "No such file or directory" from the generated listener.
 */
function resolveSuites(selection) {
  const available = discoverSuites();
  if (selection.length === 0) return available;

  return selection.map((wanted) => {
    const name = wanted.endsWith('.dart') ? wanted : `${wanted}_test.dart`;
    const match = available.find((candidate) => candidate === name || candidate === wanted);
    if (!match) {
      throw new Error(
        `unknown suite "${wanted}" — available: ${available.map((s) => s.replace(/_test\.dart$/, '')).join(', ')}`,
      );
    }
    return match;
  });
}

/**
 * Signatures of a *harness* hang rather than a failing test.
 *
 * Measured on the iOS CI job: every case reported ok, then the run sat until
 * `flutter test`'s own 12-minute budget expired, the tool could not terminate the
 * app (`Unable to terminate com.xicilion.markdownviewer`) and the run was killed.
 * Nothing about the app failed — the device never told the tool it was done — so
 * re-running the same invocation is the honest recovery, and it is logged.
 */
function looksLikeHarnessHang(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  return /Test timed out after \d+ minutes/.test(output)
    || /Unable to terminate /.test(output)
    || /lost connection to device/i.test(output);
}

function runIntegrationLayer(deviceId, suites, nameFilter) {
  const startedAt = Date.now();
  const header = (label) => [
    `$ ${label}`,
    `device: ${deviceId}`,
    '',
  ].join('\n');

  // Desktop hosts launch one app process per test file and do not survive the
  // relaunch (`Unable to start the app on the device`), so each suite gets its
  // own invocation there. Phone targets and simulators run the whole list in one
  // go, which is what keeps their runs to a single app build.
  const perSuite = isDesktopDevice(deviceId) && suites.length > 1;
  const invocations = perSuite ? suites.map((suite) => [suite]) : [suites];
  const retryHangs = process.env.MV_E2E_RETRY_HANG !== '0';

  const logs = [];
  let status = 0;
  const suiteResults = [];

  for (const invocation of invocations) {
    const args = [
      'test',
      ...invocation.map((suite) => path.join('integration_test', suite)),
      '-d',
      deviceId,
      '--dart-define=MV_WEBVIEW_DEBUG=1',
      // Render-surface mode for the suites (mobile/lib/dev/render_view_mode.dart);
      // the migration cases need it on, everything else runs with the iframe path.
      `--dart-define=MV_RENDER_VIEW=${process.env.MV_RENDER_VIEW || '0'}`,
      // Heavy cases (mobile/integration_test/helpers/mv_e2e_gating.dart): on a
      // device this define is the only way to reach them, since the app process
      // does not inherit the launcher's environment.
      `--dart-define=MV_E2E_HEAVY=${process.env.MV_E2E_HEAVY || '0'}`,
    ];
    if (nameFilter) args.push(`--plain-name=${nameFilter}`);

    let result = run('flutter', args, { cwd: mobileDir, capture: true });
    let retried = false;
    if (retryHangs && result.status !== 0 && looksLikeHarnessHang(result)) {
      // Logged, not hidden: the first attempt's output stays in the artifact.
      log(`[retry] ${invocation.join(', ')} — the device harness hung (all assertions had reported); running it once more`);
      logs.push(header(result.label) + result.stdout + result.stderr);
      result = run('flutter', args, { cwd: mobileDir, capture: true });
      retried = true;
    }

    logs.push(header(result.label) + result.stdout + result.stderr);
    suiteResults.push({
      suites: invocation,
      status: result.status,
      durationMs: result.durationMs,
      ...(retried ? { retried: 'harness hang' } : null),
    });
    if (result.status !== 0) status = result.status;

    // Surface the harness log in the job output: the E2E evidence must be visible
    // without downloading artifacts (diagnostics dumps are printed by the harness).
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  const trailer = [
    '',
    `mode: ${perSuite ? 'one invocation per suite (desktop host)' : 'single invocation'} `,
    `duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    `exit: ${status}`,
    '',
  ].join('\n');
  writeArtifact('integration.log', logs.join('\n\n') + trailer);

  return { status, durationMs: Date.now() - startedAt, suites: suiteResults, perSuite };
}

function main() {
  const args = process.argv.slice(2);
  const layerArg = args.find((a) => a.startsWith('--layer='));
  const deviceArg = args.find((a) => a.startsWith('--device='));
  const nameArg = args.find((a) => a.startsWith('--name='));
  const suiteArgs = args.filter((a) => a.startsWith('--suite=')).map((a) => a.split('=')[1]);
  const layer = layerArg ? layerArg.split('=')[1] : 'all';
  const explicitDevice = deviceArg ? deviceArg.split('=')[1] : null;
  const nameFilter = nameArg ? nameArg.split('=')[1] : null;

  if (args.includes('--list')) {
    console.log('integration suites:');
    for (const suite of discoverSuites()) {
      console.log(`  ${suite.replace(/_test\.dart$/, '')}  (integration_test/${suite})`);
    }
    return;
  }

  if (!['unit', 'integration', 'all'].includes(layer)) {
    console.error(`[mobile-e2e] unknown --layer=${layer} (expected unit|integration|all)`);
    process.exit(2);
  }

  let suites;
  try {
    suites = resolveSuites(suiteArgs);
  } catch (error) {
    console.error(`[mobile-e2e] ${error.message}`);
    process.exit(2);
  }

  const summary = { layer, startedAt: new Date().toISOString(), layers: [] };

  if (!flutterAvailable()) {
    console.error('[mobile-e2e] `flutter` is not on PATH — install the Flutter SDK first');
    writeArtifact('summary.json', JSON.stringify({ ...summary, error: 'flutter-missing' }, null, 2));
    process.exit(1);
  }

  if (layer === 'unit' || layer === 'all') {
    log('layer: unit (Dart tests, no device)');
    const result = runUnitLayer();
    summary.layers.push({ name: 'unit', status: result.status, durationMs: result.durationMs });
    if (result.status !== 0) {
      summary.finishedAt = new Date().toISOString();
      writeArtifact('summary.json', JSON.stringify(summary, null, 2));
      process.exit(result.status);
    }
  }

  if (layer === 'integration' || layer === 'all') {
    log('layer: integration (Flutter integration_test on a device)');
    log(`suites: ${suites.map((s) => s.replace(/_test\.dart$/, '')).join(', ')}`);
    if (nameFilter) log(`name filter: ${nameFilter}`);

    const assets = ensureWebViewAssets();
    if (assets !== 0) {
      summary.layers.push({ name: 'integration', status: assets, skipped: 'no WebView assets' });
      summary.finishedAt = new Date().toISOString();
      writeArtifact('summary.json', JSON.stringify(summary, null, 2));
      process.exit(assets);
    }

    const device = resolveDevice(explicitDevice);
    log(`device: ${device.id || '(none)'} — ${device.source}`);

    if (suites.length === 0) {
      const message = 'no integration suites found (mobile/integration_test/*_test.dart)';
      console.error(`[mobile-e2e] ${message}`);
      summary.layers.push({ name: 'integration', status: 1, error: message });
      summary.finishedAt = new Date().toISOString();
      writeArtifact('summary.json', JSON.stringify(summary, null, 2));
      process.exit(1);
    }

    if (!device.id) {
      const message = 'no device/emulator available for integration tests '
        + '(start one, or pass --device=<id> / MV_E2E_DEVICE=<id>)';
      if (allowSkip) {
        log(`skipping integration layer: ${message}`);
        summary.layers.push({ name: 'integration', skipped: message });
        summary.finishedAt = new Date().toISOString();
        writeArtifact('summary.json', JSON.stringify(summary, null, 2));
        process.exit(0);
      }
      console.error(`[mobile-e2e] ${message}`);
      summary.layers.push({ name: 'integration', status: 1, error: message });
      summary.finishedAt = new Date().toISOString();
      writeArtifact('summary.json', JSON.stringify(summary, null, 2));
      process.exit(1);
    }

    const preflightError = preflightDevice(device.id);
    if (preflightError) {
      if (allowSkip) {
        log(`skipping integration layer: ${preflightError}`);
        summary.layers.push({ name: 'integration', skipped: preflightError });
        summary.finishedAt = new Date().toISOString();
        writeArtifact('summary.json', JSON.stringify(summary, null, 2));
        process.exit(0);
      }
      console.error(`[mobile-e2e] device preflight failed: ${preflightError}`);
      summary.layers.push({ name: 'integration', status: 1, error: preflightError });
      summary.finishedAt = new Date().toISOString();
      writeArtifact('summary.json', JSON.stringify(summary, null, 2));
      process.exit(1);
    }

    const result = runIntegrationLayer(device.id, suites, nameFilter);
    summary.layers.push({
      name: 'integration',
      status: result.status,
      durationMs: result.durationMs,
      device: device.id,
      deviceSource: device.source,
      suites: result.suites,
      perSuite: result.perSuite,
    });
    summary.finishedAt = new Date().toISOString();
    writeArtifact('summary.json', JSON.stringify(summary, null, 2));
    process.exit(result.status);  }

  summary.finishedAt = new Date().toISOString();
  writeArtifact('summary.json', JSON.stringify(summary, null, 2));
  log('done');
}

main();
