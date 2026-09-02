/**
 * ALL tests — the single test entry for the fibjs test runner.
 *
 * Run with:  fibjs test/all.test.js   (this is `npm test`)
 *
 * The whole suite passes under fibjs v0.38+ (node:test API, TS loading,
 * directory imports, xml DOM, playwright-core browser driving). Files that
 * need browser assets (dist/cli via build:cli, dist/chrome via build:chrome)
 * simply require those builds to have run first.
 *
 * The suites are grouped in test/suites/*.js — see each group's header for
 * its requirements. Group order matters for shared globals:
 *   1. core-markdown loads mathjax (docx-math-converter) BEFORE
 *      markdown-processor installs the global xml `document`;
 *   2. html-plugin scopes its fake document to its own suite;
 *   3. heavyweight browser/export/extension groups go last so their before()
 *      hooks never run before the fast unit suites.
 */

import './suites/core-markdown/index.js';
import './suites/document-helpers/index.js';
import './suites/plugin-rewrites/index.js';
import './suites/renderers-theme/index.js';
import './suites/charset-recovery/index.js';
import './suites/browser-contracts/index.js';
import './suites/export-contracts/index.js';
import './suites/extension-e2e/index.js';
