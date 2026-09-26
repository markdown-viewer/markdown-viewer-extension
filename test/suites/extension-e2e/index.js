// Suite group: installed-extension E2E (Node.js test runner + Playwright).
// Need `npm run build:chrome` (dist/chrome) and Playwright Chromium
// (channel:'chromium' — branded Chrome refuses --load-extension).
// Set MV_CHROME_EXECUTABLE to run against a specific build instead of the
// bundled one (see scripts/chrome-test-matrix.mjs).
import './extension-installed.test.ts';
import './context-menu-e2e.test.ts';
import './browser-context-menu.test.ts';
import './remote-document-images.test.ts';
import './query-string-preview.test.ts';
import './code-view.test.ts';
import './workspace-file-switch.test.ts';
