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
| `npm run test:unit` | fibjs | Compatibility-sensitive unit, DOM, browser-contract, and export-contract suites registered by `test/all.test.js` |
| `npm run test:e2e` | Node.js + Playwright | The real built Chrome extension, including extension pages, file opening modes, workspace previews, SUMMARY navigation, context menus, clipboard payloads, and downloads |
| `npm test` | both | Runs `test:unit` first, then the independent extension E2E command |

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
npm install
npm run build:cli
npm run build:chrome
```

Run the two layers independently while developing:

```bash
npm run test:unit
npm run test:e2e
```

`npm run test:e2e` intentionally does not rebuild the extension on every run.
This keeps reruns fast; the caller must build `dist/chrome` first. CI builds
the CLI and Chrome extension once, then runs both test layers.

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
- Only introduce parallel execution after confirming that browser profiles,
  downloads, extension storage, and fixture state are isolated.

### Known follow-up work

The installed-extension suites now share their browser bootstrap, extension
identity lookup, frame lookup, readiness polling, image settling, diagnostics,
and teardown through `test/helpers/extension-e2e.ts`. Suite-level arbitrary
sleep calls have been removed; the helper's short, bounded polling intervals
are synchronization mechanics with diagnostic timeouts, not readiness guesses.

The `MV_E2E_ARTIFACT_DIR` environment variable enables one lightweight
Playwright trace with screenshots per installed-extension suite. CI writes
them under `test-results/extension-e2e` and uploads them only when the E2E step
fails. Local runs leave the variable unset unless interactive failure
diagnosis is needed. Traces are diagnostic artifacts, not substitutes for
deterministic assertions.

## CI requirements

`.github/workflows/ci.yml` must keep the following order:

1. Install Node.js dependencies.
2. Provide the fibjs build that supplies the CSSOM behavior required by the
   compatibility suite.
3. Install Google Chrome for contract suites that use the `chrome` channel.
4. Install the Playwright-compatible Chromium revision for extension E2E.
5. Build `dist/cli` and `dist/chrome`.
6. Run `npm run test:unit`.
7. Run `npm run test:e2e` in a separate native Node.js process.

The CI gate must fail when either test layer fails. `MV_SKIP_EXT_TESTS=1` is a
local diagnostic escape hatch only and must not be used by CI.

## Review checklist

- [x] Extension E2E runs through Node.js and direct Playwright control.
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
