/**
 * Installed Chrome extension E2E entry point.
 *
 * This suite intentionally runs under Node.js' native test runner. The
 * browser is driven directly by Playwright; no model-backed browser agent is
 * involved in test execution.
 *
 * Run with `npm run test:e2e` after building the extension.
 */

import '../suites/extension-e2e/index.js';
