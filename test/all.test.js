/**
 * Compatibility/unit tests — the single fibjs test entry.
 *
 * Run with:  npm run test:unit
 *
 * The whole suite passes under fibjs v0.38+ (node:test API, TS loading, and
 * xml DOM). Installed-extension E2E tests run separately under Node.js via
 * `npm run test:e2e`, because browser automation belongs in a native Node.js
 * + Playwright process rather than this fibjs compatibility suite.
 *
 * The suites are grouped in test/suites/*.js — see each group's header for
 * its requirements. Group order matters for shared globals:
 *   1. core-markdown loads mathjax (docx-math-converter) BEFORE
 *      markdown-processor installs the global xml `document`;
 *   2. html-plugin scopes its fake document to its own suite;
 *   3. heavyweight browser/export groups go last so their before() hooks never
 *      run before the fast unit suites.
 */

import './suites/core-markdown/index.js';
import './suites/document-helpers/index.js';
import './suites/table-export/index.js';
import './suites/plugin-rewrites/index.js';
import './suites/renderers-theme/index.js';
import './suites/charset-recovery/index.js';
import './suites/browser-contracts/index.js';
import './suites/export-contracts/index.js';
