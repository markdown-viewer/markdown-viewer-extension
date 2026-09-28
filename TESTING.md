# Testing Architecture and E2E Requirements

This document records the agreed testing direction for the project. It is the
review checklist for the installed-extension E2E suite and its supporting
engineering structure.

## Decisions

### E2E execution

- Installed-extension E2E tests must run in a normal Node.js process.
- Playwright drives the browser directly and performs the assertions.
- A model-backed browser agent must not be used to execute, click through, or
  validate E2E tests.
- The test process must not call an LLM or require model tokens. Playwright
  still uses normal CPU, memory, browser, and CI time.
- The current implementation deliberately uses Node.js' native `node:test`
  runner with the existing `playwright-core` dependency. This keeps the
  migration small while preserving direct browser control.

### Test-layer separation

The project has two explicit test commands:

| Command | Runtime | Scope |
|---|---|---|
| `npm run test:unit` | fibjs | Compatibility-sensitive unit, DOM, browser-contract, export-contract and repository-gate suites registered by `test/all.test.js` — the gates (theme system + design, settings centralization, locale coverage, homepage i18n) run here instead of as separate manual check scripts |
| `npm run test:e2e` | Node.js + Playwright | The real built Chrome extension, including extension pages, file opening modes, workspace previews, SUMMARY navigation, context menus, clipboard payloads, and downloads |
| `npm run test:e2e:vscode` | Node.js + Playwright (Electron) | The real installed VS Code with the built extension from `dist/vscode`: contributed commands, the preview panel lifecycle, and what the webview actually renders |
| `npm test` | both (browser) | Runs `test:unit` first, then the independent extension E2E command. The VS Code layer is not part of `npm test`: it needs a local VS Code install, so it stays an explicit command (it self-skips when none is found) |

The installed-extension E2E suite is intentionally no longer imported by
`test/all.test.js`. This prevents extension lifecycle tests from depending on
the fibjs compatibility runtime.

## E2E entry points and scope

The Node.js entry point is:

```text
test/e2e/index.test.ts
```

It imports the installed-extension suites under:

```text
test/suites/extension-e2e/
```

The current E2E coverage includes:

- standalone `file://` document takeover;
- extension embed mode through `OPEN_DOCUMENT` messages;
- inline custom-element mode;
- workspace directory/file-tree preview through a mocked File System Access
  API;
- layout and stylesheet collection contracts across the fixture matrix;
- nested directories, relative assets, non-ASCII filenames, and SUMMARY
  chapter navigation;
- table, image, and diagram context menus;
- clipboard HTML/TSV payloads;
- real Excel, PNG, and SVG export payloads and filenames.

E2E tests must use local fixtures or in-process mocks. They must not depend on a
developer's absolute filesystem path, a remote demo site, an external API, or
an external service being available.

The VS Code layer follows the same rule. Its one external dependency is the
editor binary itself, resolved from `MV_VSCODE_EXECUTABLE` or the platform's
standard install location — never from a hard-coded developer path.

## Mobile E2E (Flutter + WebView)

The mobile layer has two speeds, both driven by the same entry point so local
runs and CI cannot drift:

```text
scripts/mobile-e2e.js        # --layer=unit | integration | all
```

| Layer | Command | Needs a device | What it covers |
|---|---|---|---|
| unit | `npm run test:mobile:unit` | no | pure Dart: debug-flag semantics, the integration seam's registry contract |
| integration | `npm run test:mobile:e2e` | yes | the real app on a device/emulator: document rendering, diagram rendering, theme switching, error blocks |

Integration suites live in `mobile/integration_test/` and run through
`flutter test integration_test -d <device>`. The app must be built for the
target first; the runner waits for an Android device to finish booting
(`sys.boot_completed`), then runs every suite in the directory.

### Suite organisation

Suites follow the same shape as the TypeScript layers: one file per area, with
`group(...)` for the unit under test and `testWidgets(...)` named as a behaviour
sentence (Dart's `describe`/`it`). Group names double as filters.

```bash
node scripts/mobile-e2e.js --list                      # discovered suites
node scripts/mobile-e2e.js --layer=integration --suite=diagram_render
node scripts/mobile-e2e.js --layer=integration --name='theme switching'
```

Phones run every file in a single `flutter test` invocation (one app build).
Desktop hosts cannot: `flutter test` relaunches the app per test file and the
second launch fails with `Unable to start the app on the device`, so on
`macos`/`linux`/`windows` the runner invokes one suite per process and aggregates
the results (`summary.json` records both).

### Asserting on a WebView

A platform view is opaque to Flutter's finders, so the assertions are made
*inside the page* and read back through
`WebViewController.runJavaScriptReturningResult`. Two seams exist for that:

- `mobile/lib/dev/mobile_e2e.dart` — the app publishes hooks (open a document,
  switch theme, wait for readiness) into a process-wide registry; tests never
  reach into private state.
- `window.__mvRenderDiagnostics` — the render pipeline's diagnostics sink,
  exposed by the mobile page so a failing case can say *why* a block is missing
  instead of only that the selector found nothing.

Both are non-release only (`kReleaseMode` short-circuits).

### Local device setup

**The fast loop for mobile work is macOS desktop** (no simulator to boot, ~30-40 s
per suite, same WKWebView family as iOS):

```bash
npm run test:mobile:fast                 # integration layer on macOS, all suites
npm run test:mobile:fast -- --suite=diagram_render
npm run test:mobile:unit                 # device-free Dart tests, ~15 s
```

Reach for the Android emulator / iOS simulator when the change touches their own
behaviour (IPC limits, WebView quirks, share-sheet paths), not for the inner loop.

```bash
# Android (the CI path)
$ANDROID_HOME/emulator/emulator -avd <avd> -gpu host -memory 4096 -cores 4 \
  -no-boot-anim -no-audio -no-snapshot-save &
npm run test:mobile:e2e -- --device=emulator-5554
```

Hardware GPU matters: a software-rendered guest under a loaded host ANRs its own
system apps (`X isn't responding`), which wedges the run instead of failing it.
The same applies to the emulator options used in CI.

### Android guest preparation

A cold-booted emulator starts a burst of Google services while the test is
already launching the app; on a loaded host several of them exceed Android's 20 s
service budget and ANR at once. Observed on API 35 right after boot:
`com.android.systemui`, Gboard, `com.google.android.as` (autofill), Messages RCS,
`com.android.phone` — six ANRs in under a minute, and the dialogs then own the
screen. The runner's Android preflight handles it:

| Step | What and why |
|---|---|
| report | logs ANRs recorded since boot, with package names, so the cause is visible |
| clear | `am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS` — BACK does **not** dismiss a system ANR dialog, this does |
| prevent | `settings put global hide_error_dialogs 1` (+ `anr_show_background 0`) — persists on the AVD |
| settle | waits `MV_E2E_BOOT_SETTLE_SECONDS` (default 20, `0` disables) so the boot burst finishes first |

The ANRs never fail a run by themselves, but they steal focus and hide what
actually broke. To avoid the burst entirely, let the emulator save a snapshot
(drop `-no-snapshot-save`) and boot from it next time.

The trigger is **host load**, not the test: the same cold-boot-then-test sequence
produced six ANRs while this machine was also building (load average 18-26) and
zero ANRs on an idle host (`am_anr` is logged by ActivityManager regardless of the
dialog setting, so zero means the guest really did not stall). `hide_error_dialogs`
persists on the AVD across emulator restarts; the preflight also reports ANRs that
appear *during* the settle window, which is the signal that the host is starved.

`MV_E2E_HEAVY=1` enables the multi-megabyte diagram case (40-node graph). Keep it
on real devices: rasterizing that payload is the heaviest thing in the suite.

### Verified baseline

| Layer | Result | Wall clock |
|---|---|---|
| unit (`--layer=unit`) | 11/11 passed | ~15 s |
| integration, Android emulator (warm Gradle) | 8 passed, 3 skipped (heavy + two render-surface migration cases), 0 failed | ~3.4 min incl. guest preparation (cold APK build adds ~5 min) |
| integration, iOS simulator | 8 passed, 3 skipped, 0 failed | ~3.7 min |
| integration, macOS desktop (per-suite mode) | 8 passed, 3 skipped, 0 failed | ~2.5 min total (4 suites × 30-40 s) |
| integration, macOS desktop with `MV_RENDER_VIEW=1` (hidden render WebView) | 8 passed, 3 skipped, 0 failed — including both migration cases (status query, restart recovery) | ~4.6 min |

Three traps worth knowing before writing new cases:

- **No digit separators in Dart**: `200_000` fails the app build with
  `requires the experimental 'digit-separators' language feature`, because
  `mobile/pubspec.yaml` pins an SDK constraint below the 3.6 feature. The
  analyzer does not flag it; only `flutter build`/`flutter test` on a device does.
- **Diagram metadata lives on the block wrapper**: `.diagram-block` carries
  `data-plugin-type` / `data-plugin-rendered` (see
  `src/plugins/plugin-html-utils.ts:145-153`); the `<img>` inside only carries
  the PNG. Assert on the wrapper.
- **`runJavaScriptReturningResult` rejects null on Apple platforms** (Android
  returns the string `"null"`, WKWebView raises `ArgumentError`). The harness wraps
  every expression to return a JSON string, and side effects go through
  `runJs` (`runJavaScript`, no result) instead.

### Render-surface mode (migration)

The mobile app can render diagrams either in the long-standing in-page iframe or
in its own hidden WebView, relayed by Dart
(`plans/mobile-render-view-webview-plan.md`). The switch is a developer/test flag
until the rollout:

```bash
MV_RENDER_VIEW=1 npm run test:mobile:fast        # hidden render WebView path
npm run test:mobile:fast                          # in-page iframe path (shipped)
```

The runner forwards it as `--dart-define=MV_RENDER_VIEW=…`, so the same command
works on the emulator/simulator jobs. The migration cases in
`mobile/integration_test/render_view_test.dart` only run when the mode is on —
they read the page's `window.__mvRenderView` flag rather than assuming it.

Readiness is **eventual, not a boot constant**: Dart warms the surface only after
the display page is interactive (two bundles at once ANR the app on a slow
device), so the status seam reports `unknown` for a while — 650 ms on the iOS
simulator, 590 ms on the Android emulator, 500 ms on macOS desktop. Cases wait for
`ready` (`waitForRenderSurfaceReady`) instead of sampling it right after launch; a
surface that never reports ready fails with its own status dump.

The migration suite itself (`--suite=render_view`) is the fastest way to check the
surface on one device: 2 passed on macOS desktop, iOS simulator and Android
emulator, and 2 skipped with the mode off (the gate).

### Debugging during a run

`MV_WEBVIEW_DEBUG=1` (as `--dart-define`, or a process env on desktop) turns on
WebView content debugging: `chrome://inspect` on Android, the Safari Web
Inspector on iOS/macOS. The runner passes it for integration runs. Release
builds cannot enable it.
Two knobs for the *browser* suites, both off by default:

- `MV_DEBUG_PAGEERR=1` — print full stacks for page errors. Playwright reports a
  thrown page error without a stack otherwise, and a stack is what turns
  `TypeError: Cannot assign to read only property 'undefined'` into a file/line.
- The **pane/viewer timelines** — the workspace suite sets
  `window.__mvE2ETrace = true` in `addInitScript` and dumps both sinks when a
  document wait fails:
  - `window.__mvWsTrace` (pane decisions: hand-over, pane claims, render
    confirmation, viewer replies),
  - `documentElement.dataset.mvTrace` + `window.__mvEvents` (viewer: boot
    hand-off, viewer init, open requests, presentations, render start/end with
    the document each one rendered).

  These exist because the pane's failures are *orderings* — the toolbar showing
  file A while the content root holds file B — and a snapshot taken after the
  fact cannot show that two documents raced. Every entry carries a per-document
  id and a per-evaluation module id, so "two copies of the bundle" can be
  confirmed or ruled out from a single log. Recording costs one boolean read per
  event when the flag is unset.
### CI

`.github/workflows/ci.yml` has three mobile jobs, all running this same script:

| Job | Runner | Layers |
|---|---|---|
| `mobile-e2e` | ubuntu + KVM Android emulator (API 35, x86_64) | unit, then integration |
| `mobile-e2e-ios` | macos-latest + booted iOS simulator | integration |
| `mobile-e2e-macos` | macos-latest (desktop, no simulator to boot) | integration |

Each uploads its `test-results/mobile-e2e*` directory on failure. The iOS and
macOS jobs deliberately run only the integration layer — the unit layer already
runs in the Android job, and macOS runner minutes are the expensive ones.

The iOS job exists because the app's minimum is iOS 15.0 (`mobile/ios/Podfile`,
`Runner.xcodeproj`, `AppFrameworkInfo.plist`). Plugins still declare older
minimums, so the Podfile `post_install` raises every pod target to 15.0 — keep
those three places in sync when the minimum moves again.

The macOS desktop target was raised to 12.0 the same way (`mobile/macos/Podfile`
+ `Runner.xcodeproj`). A release build was verified on 2026-09-28
(`LSMinimumSystemVersion = 12.0` in the built app).

One toolchain caveat: a **universal** (x86_64 + arm64) macOS build fails on
Xcode 27 with `Binary …FlutterMacOS does not contain architectures "x86_64 arm64"`,
because this `lipo` accepts only one architecture per `-verify_arch` call while
Flutter 3.38 passes the whole list (`packages/flutter_tools/lib/src/build_system/targets/darwin.dart:73`).
Single-architecture builds pass — Flutter forwards `FLUTTER_XCODE_*` to xcodebuild:

```bash
FLUTTER_XCODE_ARCHS=arm64 npm run build:macos
```

The release workflow builds Android only, so it is unaffected.

## VS Code extension E2E

The Node.js entry point is `test/e2e/vscode.test.ts`, which imports the suites
under `test/suites/vscode-e2e/`. The launch harness lives in
`test/helpers/vscode-launch.ts`.

### Why the editor is driven from outside

The extension is loaded into a real VS Code through `--extensionDevelopmentPath`
with `dist/vscode` and driven with Playwright's Electron support. This is
deliberate: the official `@vscode/test-electron` runner executes test code
*inside* the extension host, where only the `vscode` API surface is observable
(command registered, message posted). The failures users report live one layer
further out — render output inside the webview, theme bundles, resource URIs,
palette availability of a command, the panel title — and those need control of
the renderer. Reaching the webview is the point of this layer: the webview runs
in its own frame with its own bundle, its own CSP, and its own stylesheet
collection.

Both halves are asserted on purpose. A suite mixes workbench assertions
(palette, tabs, panel title) with webview assertions (rendered DOM, computed
typography, decoded images) so that a host/webview contract break is attributed
to the right half.

### Constraints specific to this layer

- `npm run build:vscode` must run before the suite. `assertVscodeBuilt()` fails
  fast when `dist/vscode` is missing, but a **stale** build is not detectable:
  a theme layout change that was never rebuilt shows up as a typography
  assertion failure against the old bundle.
- Every launch gets a throwaway `--user-data-dir` and `--extensions-dir`, so
  the developer's own profile, settings and installed extensions are never
  read or written. The launch also disables the Git and AI surfaces and pins
  the settings that produce first-run prompts; a prompt that takes focus while
  the suite drives the palette reads as "the test hung", not as environment
  noise.
- The editor is launched with Chromium's background/occlusion throttling off.
  A test window covered by another window is otherwise treated as backgrounded
  and throttles timers and animation frames, which turns a developer's local run
  red while CI (xvfb, nothing occludes) stays green.
- The suite drives the same entry points a user does (command palette, quick
  open, editor tabs). It must not call extension commands through an API the
  user has no equivalent of.
- **Commands are invoked by ID, never by label.** The palette's fuzzy search
  reorders under "recently used": measured, the `…to the Side` command ranked
  FIRST while the query was the plain command's own label. The label is used
  only to assert which row the palette offered, matched modulo VS Code's
  `<category>: ` prefix and `, <keybinding>` suffix in `aria-label` (equality
  against the bare title misses every categorised command; a substring test also
  accepts `View: Close All Editors in Group`). ID invocation plus that row check
  and the fail-fast on a command a `when` clause excludes is what fixed the
  flakiness; both were measured green across five consecutive runs with and
  without the reset below.
- **Every case starts from a reset workbench** (`resetWorkbench` in
  `beforeEach`: revert unsaved buffers → close all editors → single column
  layout, all reached through `workbench.action.*` IDs). Cases still open what
  they need themselves, so the reset removes state coupling rather than
  supplying setup. It is kept for stability and timing: without it the
  quick-open activation fallback is reached far more often, which stretched
  single cases from 1-2s to 6-12s. Closing the preview panel also disposes the
  webview, so each case opens a fresh one.

### Quick input traps (these cost real debugging time)

- **Never select a webview frame by URL shape.** A live webview contributes more
  than one `vscode-webview://` frame, and the content document is not the one
  whose URL reads like a page document. Probe candidates for the state under
  test (`waitForPreviewFrame`) and keep the frame whose DOM satisfies it.
- **The quick input carries its mode in the value.** A leading `>` means command
  mode; anything else is file search. Writing a command query with a plain fill
  wipes the prefix and silently switches the widget to file search, where a
  contributed command name matches no file — "No matching results" for a
  command that is perfectly healthy. The harness sets the mode explicitly
  (`setPaletteQuery(page, query, 'command' | 'file')`) and verifies the value.
- **Read results structurally.** Real rows carry `role="option"`, and their
  `aria-label` is the clean label; `textContent` carries keybinding glyphs and
  section titles ("file results") painted inside the last row, so text-based
  filtering deletes real results.
- **A command palette is sectioned.** Commands and file results live in
  separate lists in the same overlay; scope reads to `.quick-input-widget`, not
  to one `.quick-input-list`.
- **`when` clauses decide whether a command exists at all.** The source-level
  preview commands require a supported TEXT EDITOR to be the active editor; with
  a webview panel focused, the palette answers with a "similar commands"
  section. Wait for the file's tab to be active before querying them
  (`waitForActiveEditorTab`), and remember there can be several editor groups
  once a preview is opened beside the source. When the command is not offered at
  all, say so and stop — the row walk fails fast instead of scrolling an
  unrelated list.
- **Ranking is not a contract.** Even with an ID query the highlight is moved
  onto the intended row explicitly (`selectPaletteRow`), because fuzzy scoring
  can put a neighbour first.
- **Activation is not focus.** A tab can be active while the webview still owns
  the keyboard; typing then disappears without any error (and a dirty-tab check
  still passes if the first keystrokes landed). Wait for the editor to own
  `document.activeElement` before typing (`waitForEditorFocus`).
- **Skipping is explicit or reported**: `MV_SKIP_VSCODE_TESTS=1` opts out, and a
  machine without VS Code reports the group as skipped with the reason instead
  of failing.

### Shared driver components

Both browser-driving layers stand on one set of primitives, in
`test/helpers/page-driver.ts`. A new suite calls them; it does not re-implement
them, and a fix to a driving mechanic belongs there rather than in a suite:

| Component | What it removes from suites |
|---|---|
| `evalJs` / `waitFor` | Function-body strings are mandatory (CSP blocks eval'd function sources; the bundler injects a `__name` helper into compiled closures), so evaluation goes through one place |
| `waitForStable` | The bounded "stopped changing" settle for lists and panels that fill in on their own scheduler |
| `waitForFrame` | Frames appear asynchronously; waiting for the frame is a component, not a sleep |
| `retryInteraction` | The repository's retry policy in one place: repeat the user-level interaction when a race or stall was the obstacle, never re-check an assertion, always log the retry |
| `describeFrames` / `trace` | Failure output answers "which frame, which step" without a debugger |
| `installPageDiagnostics` | Console errors, warnings and uncaught page errors (including CSP violations that are invisible in the UI) reach the test log |

Platform layers build on top and are the only place platform knowledge lives:
`extension-launch.ts` + `extension-e2e.ts` for the installed browser extension,
`vscode-launch.ts` for the editor. A VS Code suite should be able to state its
case in calls like `previewFile`, `focusEditorTab`, `runExtensionCommand`,
`paletteRowsFor` and `waitForPreviewFrame`; the header of `vscode-launch.ts`
documents that recipe and the four traps it absorbs (quick-input mode in the
value, structural result reading, `when` clauses hiding commands, and active tab
versus keyboard focus).

### Coverage and known gaps

Current cases: preview command contribution, webview rendering with typography
and image checks, single-panel reuse, live buffer following, `ViewColumn.Beside`
placement, settings panel against the bundled theme registry, export menu
formats, absence of the commands for unsupported files, and diagram rendering
(both a fenced block and a standalone `.mermaid` document).

Diagrams are rasterised on every platform: the render frame hands back a
`data:image/png` `<img>` in VS Code and in the browser build alike (the
installed-extension suites assert `.diagram-block img` too). The inline SVG
exists only as the save-as-SVG artifact, so a diagram assertion must expect an
image — hard-coding `svg` reports a healthy render path as broken.

Not covered yet: export execution (the save path goes through a native save
dialog), search, TOC, scroll sync, and remote/workspace resource edge cases.

## Modular code management baseline

Modular code management is a baseline engineering requirement, not a later
optimization. The test architecture must make production behavior, browser
plumbing, and test data easy to change independently.

### Production code

- Keep one primary responsibility per module. A module should not combine
  Markdown transformation, browser lifecycle, filesystem access, UI wiring,
  and export serialization without a clear boundary.
- Keep domain and serialization logic independent of browser-only and
  extension-only APIs wherever practical.
- Put platform-specific behavior behind small adapters. Keep Chrome APIs,
  `file://` handling, clipboard, download, and File System Access details at
  the edges of the system.
- Expose typed, intentional contracts between modules. Avoid reaching into
  another module's private state or relying on import-time side effects.
- Prevent circular dependencies. Shared utilities belong in a focused module,
  not in an unowned catch-all file.

### Test code

- Keep test entry points thin: they assemble suites; they do not contain
  production logic or duplicate browser setup.
- Group suites by capability and behavior, not by incidental implementation
  detail.
- Put reusable browser lifecycle, extension bootstrap, polling, and
  instrumentation in shared helpers or fixtures.
- Keep fixture data local, named, and independent from a developer's machine.
- A test should state the behavior under test; helper code should hide only
  mechanics, not the important assertion or business condition.
- New shared code must have a clear consumer and a focused contract test. Do
  not create a generic abstraction merely to avoid a few lines of setup.

### Current repository map

Use the existing directories as the default module boundaries:

| Area | Responsibility |
|---|---|
| `src/core/` | Markdown/document processing and core viewer behavior |
| `src/renderers/` | Diagram, chart, canvas, and other content renderers |
| `src/exporters/` | DOCX, EPUB, HTML, and other output transformations |
| `src/integration/`, `src/messaging/`, `src/services/` | Host-page, transport, storage, and platform integration boundaries |
| `src/ui/` | Viewer and interaction UI behavior |
| `chrome/src/` | Chrome extension shell, workspace, popup, and webview adapters |
| `test/helpers/` | Reusable test harnesses and mechanics |
| `test/gates/` | Repository gate libraries (theme, settings, locale, homepage i18n) imported by the `project-gates` suite and by the platform builds |
| `test/suites/` | Capability-focused unit, contract, and E2E suites |
| `test/fixtures/` | Versioned local test inputs and assets |

New code should fit an existing boundary before introducing a new top-level
module. If a boundary is unclear, define the responsibility and dependency
direction in the change rather than allowing a large mixed-purpose file to
become the de facto architecture.

The intended dependency direction is:

```text
production domain modules
        ↓
platform/browser adapters
        ↓
thin E2E fixtures and test helpers
        ↓
focused behavior suites
        ↓
Node.js + Playwright entry point
```

The direction may be adapted for a specific platform, but E2E tests must not
become the owner of production behavior or the only place where a module's
contract is defined.

## Local workflow

Install dependencies and build the artifacts needed by the tests:

```bash
git submodule update --init docs   # homepage-i18n gate reads docs/index.html + docs/assets/js/i18n
npm install
npm run build:cli
npm run build:chrome
```

Run the three layers independently while developing:

```bash
npm run test:unit
npm run test:e2e
npm run test:e2e:vscode   # needs npm run build:vscode first
```

`npm run test:e2e` intentionally does not rebuild the extension on every run.
This keeps reruns fast; the caller must build `dist/chrome` first. CI builds
the CLI and Chrome extension once, then runs both test layers.

The E2E command pins `--test-concurrency=1`: node:test would otherwise run the
suite files in parallel processes, and the resulting CPU contention has been
observed to turn a first render into the documented cold-start stall (three
files in parallel: 100/103 passing; serialized: 103/103). New browser-driving
suite files inherit the sequential execution and must not assume CPU headroom.

The E2E browser must be available at the Playwright-compatible Chromium
revision. In CI this is installed with:

```bash
npm install --no-save playwright@^1.62.1
npx playwright install chromium --with-deps
```

The `playwright` package version must stay aligned with the resolved
`playwright-core` version. Extension E2E uses the `chromium` channel because
the branded Chrome channel refuses the unpacked-extension launch flags used by
these tests.

## Stability and speed requirements

The following rules apply to new and modified E2E tests:

- Launch one isolated persistent browser context per suite or worker, with a
  unique temporary profile. Always close the context and remove temporary
  files in teardown.
- Reuse the context and pages within a suite where state isolation is not
  compromised; do not launch a new browser for every assertion.
- Prefer Playwright locators, DOM assertions, browser events, download events,
  and explicit application-ready signals over arbitrary delays.
- Keep polling bounded and diagnostic. A timeout should identify the missing
  business state, selector, frame, or event.
- Disable or bypass animations in tests when the final layout is the behavior
  under test.
- Keep tests deterministic by pinning settings and fixture data.
- Assert semantic output and payload bytes, not only screenshots or visual
  similarity.
- Capture console errors and uncaught page errors so browser failures are
  visible in CI output.
- **Wait for the state under test, not for a proxy for it.** A blob URL is not a
  loaded image, a visible panel is not a populated selector, the first service
  worker is not the extension's worker, a focused window is not a focused
  editor. Each of those proxies has produced a CI red that reads like a product
  bug: the fix is always to wait for the real condition and leave the assertion
  as the contract, so a genuine failure still fails.
- Only introduce parallel execution after confirming that browser profiles,
  downloads, extension storage, and fixture state are isolated.

### Known follow-up work

- The VS Code layer runs in CI as a separate job and a **gate** (`vscode` in
  `.github/workflows/ci.yml`): `ubuntu-latest` + `xvfb` (preinstalled; `xauth`
  must be installed explicitly or Debian's `xvfb-run` aborts) + a **pinned** VS
  Code download cached under `.cache/vscode-e2e`, with
  `MV_VSCODE_EXTRA_ARGS=--no-sandbox` for the runner's namespace restrictions.
  Local runs are 10/10 across repeated runs; the runner is the less hostile
  environment (nothing occludes the window), so a red CI run is worth reading
  before assuming flake.
- Coverage beyond the panel and the command surface is still open: export
  execution (the DOCX / HTML / EPUB save path goes through a native save dialog),
  search, TOC, scroll sync, and the remote/workspace-file resource cases.
- Coverage beyond the panel and the command surface is still open: export
  execution (the DOCX / HTML / EPUB save path goes through a native save dialog),
  search, TOC, scroll sync, and the remote/workspace-file resource cases.

The installed-extension suites now share their browser bootstrap, extension
identity lookup, frame lookup, readiness polling, image settling, diagnostics,
and teardown through `test/helpers/extension-e2e.ts`. The launch options
(browser channel, extension flags, headless handling for old Chrome builds,
`MV_CHROME_EXECUTABLE`) stay in `test/helpers/extension-launch.ts`, which also
serves the browser-menu probe suite; the E2E harness layers the per-suite
lifecycle (temporary profile, extension id, tracing, teardown) on top of it.
Suite-level arbitrary sleep calls have been removed; the helper's short,
bounded polling intervals are synchronization mechanics with diagnostic
timeouts, not readiness guesses.

The `MV_E2E_ARTIFACT_DIR` environment variable enables one lightweight
Playwright trace with screenshots per installed-extension suite. CI writes
them under `test-results/extension-e2e` and uploads them only when the E2E step
fails. Local runs leave the variable unset unless interactive failure
diagnosis is needed. Traces are diagnostic artifacts, not substitutes for
deterministic assertions.

## CI requirements

`.github/workflows/ci.yml` must keep the following order:

1. Check out the repository with submodules (`actions/checkout` with
   `submodules: true`): the homepage-i18n gate reads `docs/index.html` and
   `docs/assets/js/i18n/*.js`, so a bare checkout fails it.
2. Install Node.js dependencies.
3. Provide the fibjs build that supplies the CSSOM behavior required by the
   compatibility suite.
4. Install Google Chrome for contract suites that use the `chrome` channel.
5. Install the Playwright-compatible Chromium revision for extension E2E.
6. Build `dist/cli` and `dist/chrome`.
7. Run `npm run test:unit`.
8. Run `npm run test:e2e` in a separate native Node.js process.

The CI gate must fail when either test layer fails. `MV_SKIP_EXT_TESTS=1` is a
local diagnostic escape hatch only and must not be used by CI.

The `chrome-matrix` job is separate from that gate: it runs the same extension
suites against real old Chrome for Testing builds through
`MV_CHROME_EXECUTABLE` (see `scripts/chrome-test-matrix.js`). Only its
contextMenus probe is a gate; the full-suite run on the oldest version is
informational because of the known cold-start stall.

## Handling a stalled fixture

A fixture case may retry once when a wait times out, and the embed suite warms
the diagram pipeline up before the matrix. Both are documented stall
mitigations, not a licence to retry real assertion failures: the retry only
triggers on a timeout, is logged, and a second failure still fails the test.

## Review checklist

- [x] Extension E2E runs through Node.js and direct Playwright control.
- [x] The VS Code layer drives the real editor from outside the extension host
      and asserts inside the webview, not only the `vscode` API surface.
- [x] No model-backed browser agent is part of test execution.
- [x] Extension E2E is separated from the fibjs aggregate entry point.
- [x] `npm test` still represents the complete local test command.
- [x] CI runs the two layers explicitly.
- [x] Extension tests use local fixtures, mocks, temporary profiles, and
      teardown.
- [x] Shared extension bootstrap, polling, diagnostics, and teardown live in a
      reusable test helper.
- [x] Production and test responsibilities are documented as separate module
      boundaries.
- [x] Current extension E2E passes with 98 tests.
- [x] Replace arbitrary suite waits with application-ready signals or bounded
      stability/event waits.
- [x] Add failure traces with screenshots where CI diagnostics justify the
      cost.
