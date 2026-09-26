/**
 * File delivery routing.
 *
 * `deliverFile` picks the one mechanism the current document can actually use:
 * an embedded viewer hands the file to its host page (Chrome refuses downloads
 * inside the extension-page iframe), a sandboxed document goes through the
 * platform file service (Chrome blocks its anchor downloads), everything else
 * downloads with a plain anchor.
 *
 * The browser-level proof for each branch lives in the installed-extension
 * suites; what is pinned here is the *decision*, because the harness cannot
 * grant Chrome's optional "downloads" permission and the sandboxed case is
 * otherwise invisible (no download, no error).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { deliverFile } from '../../../src/utils/file-download.ts';

type Call = Record<string, unknown>;

/** Platform stub recording what the delivery asks the platform to do. */
function createPlatformStub(): { calls: Call[]; platform: unknown } {
  const calls: Call[] = [];
  return {
    calls,
    platform: {
      file: {
        requestDownloadPermission: async () => {
          calls.push({ type: 'permission' });
          return true;
        },
        download: async (blob: Blob, filename: string, options?: { mimeType?: string }) => {
          calls.push({
            type: 'download',
            filename,
            mimeType: options?.mimeType,
            blobType: blob.type,
            body: typeof blob.text === 'function' ? await blob.text() : '',
          });
        },
      },
    },
  };
}

const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalPlatform = globals.platform;

function setWindow(value: unknown): void {
  globals.window = value;
}

afterEach(() => {
  if (originalWindow === undefined) delete globals.window;
  else globals.window = originalWindow;
  if (originalPlatform === undefined) delete globals.platform;
  else globals.platform = originalPlatform;
});

describe('deliverFile', () => {
  it('hands the file to the host page when the viewer is embedded', async () => {
    const messages: unknown[] = [];
    setWindow({
      origin: 'null',
      location: { protocol: 'chrome-extension:' },
      parent: { postMessage: (message: unknown) => messages.push(message) },
    });
    const stub = createPlatformStub();
    globals.platform = stub.platform;

    await deliverFile({ filename: 'app.ts', mimeType: 'text/plain;charset=utf-8', content: 'export {};\n' });

    assert.deepEqual(messages, [{
      type: 'SAVE_FILE',
      filename: 'app.ts',
      mimeType: 'text/plain;charset=utf-8',
      content: 'export {};\n',
    }]);
    assert.deepEqual(stub.calls, [], 'the embedded viewer must not download locally');
  });

  it('writes a sandboxed document through the platform file service', async () => {
    // raw.githubusercontent.com serves raw files with `Content-Security-Policy:
    // sandbox`, which makes the document's origin opaque and blocks its anchor
    // downloads — `window.origin` is how that is observable.
    setWindow({ origin: 'null', location: { protocol: 'https:' } });
    const stub = createPlatformStub();
    globals.platform = stub.platform;

    await deliverFile({
      filename: 'footnote-postprocessor.ts',
      mimeType: 'text/plain;charset=utf-8',
      content: 'export const x = 1;\n',
    });

    assert.deepEqual(stub.calls.map((call) => call.type), ['permission', 'download']);
    assert.strictEqual(stub.calls[1].filename, 'footnote-postprocessor.ts');
    assert.strictEqual(stub.calls[1].body, 'export const x = 1;\n');
    // Chrome rewrites the extension of a download whose declared type disagrees
    // with the name (text/plain `.ts` → `.txt`), so the platform path declares
    // a type that owns no extension.
    assert.strictEqual(stub.calls[1].mimeType, 'application/octet-stream');
    assert.strictEqual(stub.calls[1].blobType, 'application/octet-stream');
  });

  it('keeps base64 payloads byte-exact on the platform path', async () => {
    setWindow({ origin: 'null', location: { protocol: 'https:' } });
    const stub = createPlatformStub();
    globals.platform = stub.platform;

    // "hello" — the image/table menus hand binary over this way.
    await deliverFile({ filename: 'logo.png', mimeType: 'image/png', content: 'aGVsbG8=', encoding: 'base64' });

    assert.strictEqual(stub.calls[1].body, 'hello');
  });
});
