/**
 * Shared launch setup for the installed-extension e2e suites
 * (test/suites/extension-e2e/*).
 *
 * Default browser: Playwright's bundled Chromium via `channel: 'chromium'`.
 *   - `channel: 'chromium'` is the only channel that can load an extension:
 *     branded Chrome/Edge ignore `--load-extension` (Chrome 137+), and the
 *     default `chromium-headless-shell` has no extension support at all;
 *   - Playwright passes a bare `--headless`, which Chrome reads as the *new*
 *     headless mode from 132 on — extensions do work there.
 *
 * Low-version matrix: set `MV_CHROME_EXECUTABLE=/path/to/chrome` to run the same
 * suites against a specific build, e.g. a Chrome for Testing version fetched by
 * `node scripts/chrome-test-matrix.js`. Builds older than Chrome 132 read a
 * bare `--headless` as the *legacy* headless mode, which cannot load extensions,
 * so the flag is swapped for `--headless=new` (supported since Chrome 112).
 * `MV_EXT_HEADED=1` forces a visible window when debugging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { chromium, type BrowserContext } from 'playwright-core';

/** playwright-core keeps the persistent-context options inline — derive them. */
type LaunchPersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

export const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

/** Built unpacked extension (`npm run build:chrome`). */
export const EXT_DIR = path.resolve('dist/chrome');

/** Fail fast with the actionable message the suites used to inline. */
export function assertExtensionBuilt(): void {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    throw new Error('dist/chrome missing — run "node chrome/build.js" first');
  }
}

/** First Chrome version where a bare `--headless` means the new headless mode. */
const NEW_HEADLESS_DEFAULT_MAJOR = 132;

/** Major version of the given browser binary, or null when it cannot be read. */
export function browserMajorVersion(executablePath: string): number | null {
  try {
    const out = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 15000 });
    const match = out.match(/\b(\d+)\.\d+\.\d+\.\d+\b/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Path of the browser under test when MV_CHROME_EXECUTABLE is set. */
export function chromeExecutable(): string {
  const value = process.env.MV_CHROME_EXECUTABLE?.trim();
  return value ? path.resolve(value) : '';
}

export function extensionLaunchArgs(): string[] {
  return [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    '--disable-default-apps',
    // Let content scripts fetch file:// resources (fixture images).
    '--allow-file-access-from-files',
  ];
}

/**
 * Launch options for every installed-extension suite. `overrides` win over the
 * defaults (e.g. `{ acceptDownloads: true }`); `args` are appended, not replaced.
 */
export function extensionLaunchOptions(
  overrides: LaunchPersistentContextOptions = {},
): LaunchPersistentContextOptions {
  const executablePath = chromeExecutable();
  const headless = overrides.headless ?? process.env.MV_EXT_HEADED !== '1';
  const options: LaunchPersistentContextOptions = {
    viewport: { width: 1440, height: 900 },
    ...overrides,
    headless,
    args: [...extensionLaunchArgs(), ...(overrides.args ?? [])],
  };

  if (!executablePath) {
    return { ...options, channel: 'chromium' };
  }

  options.executablePath = executablePath;
  const major = browserMajorVersion(executablePath);
  if (headless && major !== null && major < NEW_HEADLESS_DEFAULT_MAJOR) {
    options.ignoreDefaultArgs = ['--headless'];
    options.args = ['--headless=new', ...(options.args ?? [])];
  }
  return options;
}

export async function launchExtensionContext(
  userDataDir: string,
  overrides: LaunchPersistentContextOptions = {},
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, extensionLaunchOptions(overrides));
}

/**
 * Service workers that belong to an extension (`chrome-extension://…`).
 *
 * Selection must not be positional: a run can register other workers first
 * (component extensions, page workers), and `serviceWorkers()[0]` then
 * evaluates inside the wrong context — where `chrome.contextMenus` and
 * `chrome.storage` simply do not exist. Measured on Chrome for Testing 122 in
 * CI: the contextMenus probe failed with "Cannot read properties of undefined
 * (reading 'update')" while Chrome 123 passed in the same run with identical
 * harness code.
 */
function extensionWorkers(context: BrowserContext): Worker[] {
  return context
    .serviceWorkers()
    .filter((worker) => worker.url().startsWith('chrome-extension://'));
}

/**
 * Resolve the extension id from the background service worker. Polling is more
 * reliable than waitForEvent('serviceworker') — on cold starts the worker
 * registration event can be missed while the profile is being created.
 *
 * When several extension workers are up, the one that exposes the APIs under
 * test (`chrome.contextMenus` — the extension under test always has it) wins,
 * so a component-extension worker cannot be mistaken for ours.
 */
export async function waitForExtensionId(context: BrowserContext): Promise<string> {
  const deadline = Date.now() + 40000;
  let seen: string[] = [];

  for (;;) {
    const workers = extensionWorkers(context);
    seen = workers.map((worker) => worker.url().slice(0, 60));

    for (const worker of workers) {
      const id = worker.url().split('/')[2];
      if (!id) continue;
      if (workers.length === 1) return id;

      const exposesApis = await worker
        .evaluate('typeof chrome !== "undefined" && typeof chrome.contextMenus !== "undefined"')
        .catch(() => false);
      if (exposesApis) return id;
    }

    if (workers.length > 0 && Date.now() >= deadline) {
      // Fall back to the first extension worker rather than failing: an
      // extension without the probed API is still identifiable by its URL.
      const id = workers[0].url().split('/')[2];
      if (id) return id;
    }

    if (Date.now() >= deadline) {
      const all = context.serviceWorkers().map((worker) => worker.url().slice(0, 60));
      throw new Error(
        `extension service worker not registered (timeout)` +
          ` | extension workers: ${seen.join(', ') || 'none'} | all workers: ${all.join(', ') || 'none'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
