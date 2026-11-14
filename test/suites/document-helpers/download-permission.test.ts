/**
 * `requestDownloadsPermission` — the export click's permission probe.
 *
 * The export toolbar asks the background for the optional "downloads"
 * permission before it starts. That request has to be best-effort: the service
 * worker cannot show the prompt, so Chrome can leave the message unanswered
 * forever. An unbounded await froze DOCX, EPUB and HTML exports of remote
 * documents (the toolbar button never even reached its "downloading" state);
 * these cases pin the deadline that keeps the export moving.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  DOWNLOAD_PERMISSION_TIMEOUT_MS,
  requestDownloadsPermission,
} from '../../../chrome/src/webview/download-permission.ts';

interface ChromeStubOptions {
  /** How the stubbed `sendMessage` treats the request. */
  behaviour: 'grant' | 'deny' | 'never-answer' | 'throw';
  /** Observed message payloads. */
  sent?: unknown[];
}

function installChromeStub(options: ChromeStubOptions): void {
  const stub = {
    runtime: {
      lastError: undefined as { message?: string } | undefined,
      sendMessage(message: unknown, callback?: (response?: unknown) => void): void {
        options.sent?.push(message);
        if (options.behaviour === 'throw') {
          throw new Error('no receiver');
        }
        if (options.behaviour === 'never-answer') {
          return; // The real-world failure: the callback never fires.
        }
        callback?.({ granted: options.behaviour === 'grant' });
      },
    },
  };
  (globalThis as unknown as { chrome?: unknown }).chrome = stub;
}

/** The suite must not leak a stubbed `chrome` into the next test file. */
afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('requestDownloadsPermission', () => {
  it('sends the message the background understands', async () => {
    const sent: unknown[] = [];
    installChromeStub({ behaviour: 'grant', sent });

    assert.strictEqual(await requestDownloadsPermission(), true);
    assert.deepStrictEqual(sent, [{ type: 'REQUEST_DOWNLOADS_PERMISSION' }]);
  });

  it('reports a denied prompt as not granted', async () => {
    installChromeStub({ behaviour: 'deny' });
    assert.strictEqual(await requestDownloadsPermission(), false);
  });

  it('gives up when the background never answers', async () => {
    installChromeStub({ behaviour: 'never-answer' });

    const startedAt = Date.now();
    assert.strictEqual(await requestDownloadsPermission(40), false);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed >= 30, `the deadline must be honoured (waited ${elapsed}ms)`);
    assert.ok(elapsed < 2000, `the deadline must be short (waited ${elapsed}ms)`);
  });

  it('treats a throwing sendMessage as not granted', async () => {
    installChromeStub({ behaviour: 'throw' });
    assert.strictEqual(await requestDownloadsPermission(), false);
  });

  it('resolves false when the host has no extension runtime', async () => {
    assert.strictEqual(await requestDownloadsPermission(), false);
  });

  it('uses a deadline short enough to keep the export responsive', () => {
    // A prompt the service worker cannot show never answers, so every remote
    // export would otherwise wait this long for nothing.
    assert.ok(DOWNLOAD_PERMISSION_TIMEOUT_MS > 0);
    assert.ok(
      DOWNLOAD_PERMISSION_TIMEOUT_MS <= 2000,
      'the permission probe must not delay an export by more than 2s',
    );
  });
});
