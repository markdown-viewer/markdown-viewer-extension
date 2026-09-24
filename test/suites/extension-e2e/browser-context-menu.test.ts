/**
 * Browser-level context menu (chrome.contextMenus): worker startup, menu
 * lifecycle and service worker console cleanliness, per Chrome version.
 *
 * Why this suite exists: the contextMenus methods have NO Promise support before
 * Chrome 123 (docs tag them "Promise — Chrome 123+"). On Chrome 120-122 a
 * promise-style `remove`/`update` returns undefined instead of rejecting, the
 * failure stays in runtime.lastError unread, and Chrome prints
 * `Unchecked runtime.lastError: Cannot find menu item with id ...` into the
 * service worker console. Users on those versions reported exactly that after
 * installing the zip build, because the worker removed the pre-5.x
 * `preview-as-markdown` id on every start.
 *
 * The suite therefore:
 *   1. proves the capture works (a JS console.error from the worker is seen),
 *      so the cleanliness assertions below are not vacuous;
 *   2. asserts the browser menu item exists after the startup create cycle;
 *   3. re-runs that create cycle (removeAll + create) and asserts it stays clean;
 *   4. asserts the storage-driven title update path stays clean;
 *   5. pins the version boundary: below 123 `contextMenus.remove` has no promise
 *      to reject (the reported bug), from 123 on it does.
 *
 * Not capturable: the literal "Unchecked runtime.lastError: ..." line. Chrome
 * emits it through its own console-message path, which Playwright's worker
 * console event does not forward (verified on Chrome 122: neither the worker
 * console nor a browser-level CDP session sees it, while a JS console.error from
 * the same worker is captured). The suite therefore asserts the cause — no
 * unread contextMenus failures — and the API shape per version.
 *
 * Runs headless against the REAL built extension (dist/chrome). Skip with
 * MV_SKIP_EXT_TESTS=1. Run `node chrome/build.js` first. Low-version matrix:
 * `node scripts/chrome-test-matrix.js` (sets MV_CHROME_EXECUTABLE per version).
 *
 * Not covered: a genuine worker cold start after install. chrome.runtime.reload()
 * unloads an unpacked extension without reloading it in this harness, and the
 * Playwright debugger keeps the worker attached, so Chrome never idles it out.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { BrowserContext, ConsoleMessage, Worker } from 'playwright-core';

import {
  SKIP_EXT,
  assertExtensionBuilt,
  browserMajorVersion,
  chromeExecutable,
  launchExtensionContext,
  waitForExtensionId,
} from '../../helpers/extension-launch.ts';

const MENU_ID = 'view-as-markdown';
const PROBE_ID = 'mv-probe-missing-item';
const DEBUG_SW = process.env.MV_DEBUG_SW_CONSOLE === '1';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Label used in test output so a matrix run is readable. */
function browserLabel(): string {
  const executable = chromeExecutable();
  if (!executable) return 'bundled chromium';
  const major = browserMajorVersion(executable);
  return `${path.basename(executable)}${major ? ` (Chrome ${major})` : ''}`;
}

describe(`installed Chrome extension — browser context menu [${browserLabel()}]`, { skip: SKIP_EXT }, () => {
  let context: BrowserContext;
  let userDataDir = '';
  let extensionId = '';
  let logs: string[] = [];
  const attached = new WeakSet<Worker>();

  /** Every service worker console line, prefixed by its source worker id. */
  const attachConsole = (worker: Worker): void => {
    if (attached.has(worker)) return;
    attached.add(worker);
    const id = worker.url().split('/')[2] ?? '?';
    logs.push(`# worker ${id.slice(0, 8)} attached`);
    worker.on('console', (msg: ConsoleMessage) => {
      const line = `${msg.type()}: ${msg.text()}`;
      logs.push(line);
      if (DEBUG_SW) {
        // eslint-disable-next-line no-console
        console.log('[sw]', line);
      }
    });
  };

  /**
   * The worker under test, addressed by identity.
   *
   * `serviceWorkers()[0]` is not that worker: other workers (component
   * extensions, pages) can be registered first, and evaluating inside one of
   * those reports `chrome.contextMenus` / `chrome.storage` as undefined — a
   * failure that looks like a product bug and is a harness mistake. Measured on
   * Chrome for Testing 122 in CI; Chrome 123 passed in the same run.
   */
  const currentWorker = (): Worker => {
    const workers = context.serviceWorkers();
    const mine = workers.find((worker) =>
      worker.url().startsWith(`chrome-extension://${extensionId}/`),
    );
    assert.ok(
      mine,
      `no service worker for extension ${extensionId}` +
        ` | workers seen: ${workers.map((w) => w.url().slice(0, 60)).join(', ') || 'none'}`,
    );
    return mine;
  };

  /** Poll until `predicate` holds (worker console events are asynchronous). */
  const waitUntil = async (predicate: () => boolean, timeoutMs = 10000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(200);
    }
    return false;
  };

  /** Run a function (source string) inside the service worker. */
  const swEval = async <T>(jsBody: string, arg?: unknown): Promise<T> => {
    const src = arg === undefined ? `(${jsBody})()` : `(${jsBody})(${JSON.stringify(arg)})`;
    return currentWorker().evaluate(src) as Promise<T>;
  };

  /**
   * The worker can be reachable before its API namespaces are usable, and on
   * some builds they appear a moment later. Every assertion below evaluates
   * inside that worker, so the wait happens once here: a startup race must not
   * surface as `Cannot read properties of undefined (reading 'update')`, which
   * reads like a product bug and is really the harness arriving too early.
   */
  const waitForWorkerApis = async (timeoutMs = 15000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ready = await currentWorker()
        .evaluate('typeof chrome !== "undefined" && !!chrome.contextMenus && !!chrome.storage')
        .catch(() => false);
      if (ready) return;
      if (Date.now() >= deadline) {
        const workers = context.serviceWorkers().map((worker) => worker.url().slice(0, 60));
        throw new Error(
          `extension service worker never exposed contextMenus/storage` +
            ` (extension ${extensionId}) | workers seen: ${workers.join(', ') || 'none'}`,
        );
      }
      await sleep(250);
    }
  };

  /** Non-destructive existence probe: update(id, {}) reports a missing item. */
  const probeMenuItem = async (worker: Worker = currentWorker()): Promise<string> =>
    worker.evaluate(
      `((id) => new Promise((resolve) => {
        chrome.contextMenus.update(id, {}, () => {
          resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : '');
        });
      }))(${JSON.stringify(MENU_ID)})`,
    ) as Promise<string>;

  const assertNoUnchecked = (lines: string[]): void => {
    const bad = lines.filter((line) => /Unchecked runtime\.lastError|Cannot find menu item/.test(line));
    assert.deepEqual(
      bad,
      [],
      `service worker logged context menu errors:\n  ${bad.join('\n  ')}\n\nfull capture:\n  ${lines.join('\n  ')}`,
    );
  };

  /**
   * The worker creates the menu asynchronously (it reads settings for the
   * localized title first), so poll until the item shows up instead of assuming
   * it exists the moment the worker is reachable.
   */
  const waitForMenu = async (timeoutMs = 15000): Promise<string> => {
    let error = await probeMenuItem();
    const deadline = Date.now() + timeoutMs;
    while (error && Date.now() < deadline) {
      await sleep(250);
      error = await probeMenuItem();
    }
    return error;
  };

  before(async () => {
    assertExtensionBuilt();

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-browser-menu-'));
    context = await launchExtensionContext(userDataDir);
    context.on('serviceworker', (worker: Worker) => attachConsole(worker));
    extensionId = await waitForExtensionId(context);
    // Only our workers: another extension's console noise must not be able to
    // trip the "no unchecked errors" assertions.
    context
      .serviceWorkers()
      .filter((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`))
      .forEach(attachConsole);
    await waitForWorkerApis();
  });

  after(async () => {
    await context?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('captures service worker console output', async () => {
    const from = logs.length;
    await swEval(`() => console.error('mv-sw-console-capture-check')`);
    const seen = await waitUntil(() =>
      logs.slice(from).some((line) => line.includes('mv-sw-console-capture-check')),
    );
    assert.ok(
      seen,
      'the worker console capture is broken — every later "no unchecked errors" check would pass vacuously',
    );
  });

  it('registers the browser menu item without unchecked errors', async () => {
    const from = logs.length;
    const error = await waitForMenu();
    assert.equal(error, '', `menu item ${MENU_ID} is missing in the browser menu registry: ${error}`);
    assertNoUnchecked(logs.slice(from));
  });

  it('re-runs the create cycle (removeAll + create) without console noise', async () => {
    const from = logs.length;

    // The startup path of chrome/src/host/background.ts: leftover items are
    // cleared before the item is recreated (menu items survive a worker restart,
    // which is why the unconditional remove by id used to log on Chrome < 123).
    // Menu items do not survive a browser restart, so this is also the code path
    // a fresh install runs. The probe leaves a temporary title behind; the next
    // settings-change test drives the real localized title back in.
    const error = await swEval<string>(`() => new Promise((resolve) => {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create(
          { id: ${JSON.stringify(MENU_ID)}, title: 'matrix probe', contexts: ['link', 'page'] },
          () => resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : ''),
        );
      });
    })`);
    assert.equal(error, '', `create cycle failed: ${error}`);

    assertNoUnchecked(logs.slice(from));
    assert.equal(await probeMenuItem(), '', `menu item ${MENU_ID} is missing after the create cycle`);
  });

  it('updates the menu title on a settings change without unchecked errors', async () => {
    const from = logs.length;
    await swEval('() => chrome.storage.local.set({ markdownViewerSettings: { preferredLocale: "zh_CN" } })');
    await sleep(1500);

    assertNoUnchecked(logs.slice(from));
    // The update path must not have needed a rebuild: the item is still there.
    const error = await waitForMenu(3000);
    assert.equal(error, '', `menu item ${MENU_ID} disappeared during the title update: ${error}`);
  });

  it('pins the Chrome 123 promise boundary for contextMenus', async () => {
    const major = await swEval<number>(
      '() => { const m = navigator.userAgent.match(/Chrome\\/(\\d+)/); return m ? Number(m[1]) : 0; }',
    );
    assert.ok(major > 0, 'could not read the Chrome major version from the service worker');

    // The mechanism behind the reported bug: on Chrome < 123 a promise-style call
    // has no promise to reject, so nothing in the extension can observe the
    // failure — Chrome reports it as an unchecked runtime.lastError instead. From
    // 123 on the same call returns a thenable and a rejection is catchable, which
    // is why the fix uses callbacks with an explicit lastError read (identical on
    // every version) instead of relying on the promise form.
    const shape = await swEval<string>(
      `() => { const r = chrome.contextMenus.remove(${JSON.stringify(PROBE_ID)}); ` +
        `Promise.resolve(r).catch(() => {}); ` +
        `return typeof r + ':' + Boolean(r && typeof r.then); }`,
    );

    if (major >= 123) {
      assert.equal(shape, 'object:true', `Chrome ${major} should return a promise from contextMenus.remove`);
    } else {
      assert.equal(
        shape,
        'undefined:false',
        `Chrome ${major} has no contextMenus promise support — the range the fix targets`,
      );
    }
  });
});
