/**
 * VS Code extension E2E entry point.
 *
 * This suite runs under Node.js' native test runner and drives the real
 * installed VS Code (Electron) through Playwright — no extension-host test
 * runner, no model-backed agent. It complements `test/e2e/index.test.ts`
 * (installed Chrome extension): the same shared webview code is exercised
 * through a different host, and the host-specific half (commands, panel
 * lifecycle, resource URIs, status bar) only exists here.
 *
 * Run with `npm run test:e2e:vscode` after `npm run build:vscode`.
 *
 * The run opens a real VS Code window and takes focus while it works: VS Code is
 * an Electron app and has no headless mode, so that is the cost of the local
 * run. The "headless" form is the CI job, where a virtual display (xvfb) stands
 * in for the screen.
 *
 * `--test-concurrency=1` for the same reason as the browser suites: each file
 * launches a real application, and parallel launches change render timing.
 *
 * Unlike the Chrome suites this one depends on a local VS Code install; when
 * none is found the group reports itself as skipped instead of failing (see
 * MV_VSCODE_EXECUTABLE / MV_SKIP_VSCODE_TESTS).
 */

import '../suites/vscode-e2e/index.js';
