// Suite group: browser/CLI contract suites (fibjs test runner).
// Need `npm run build:cli` (dist/cli assets) and a browser: the CLI starts
// Playwright's bundled Chromium and falls back to installed Chrome.
import './cli.test.js';
import './cli-browser-launch.test.js';
import './cli-assets.test.ts';
import './cli-assets-e2e.test.ts';
import './cli-browser-e2e.test.ts';
import './cli-html-injection-e2e.test.ts';
import './renderer-page-csp.test.ts';
import './host-css-scoping.test.js';
import './browser-render-harness.test.ts';
import './browser-baseline.test.ts';
import './html-export-layout.test.ts';
import './list-indent-contract.test.ts';
import './epub-styles-contract.test.ts';
import './epub-reader-environments.test.ts';
import './theme-to-css-content-root.test.ts';
import './theme-table-css.test.ts';
import './theme-task-list-css.test.ts';
import './theme-checkbox-render.test.ts';
import './theme-color-scheme-contract.test.ts';
import './font-config.test.ts';
import './element-contract.test.ts';
