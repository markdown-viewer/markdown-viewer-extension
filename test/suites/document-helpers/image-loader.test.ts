/**
 * `image-loader` — the deadline an export's image load depends on.
 *
 * DOCX fetches image bytes through `loadImageAsBuffer`; HTML/EPUB inline them
 * through the same loader. A request that receives neither `load` nor `error`
 * (a black-holed proxy, a host that never answers) used to leave the export
 * spinning at 0% forever — reproduced with a local document whose remote image
 * never arrived. These cases pin the deadline with a stubbed `Image`, which is
 * deterministic (no network, no sockets) and covers both entry points.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  IMAGE_LOAD_TIMEOUT_MS,
  loadImageAsBuffer,
  loadImageAsDataUrl,
} from '../../../src/utils/image-loader.ts';

interface FakeImageBehaviour {
  /** `never` holds the request open; `error` fails on the next tick. */
  mode: 'never' | 'error';
}

interface FakeImageInstance {
  instance: FakeImage;
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  private currentSrc = '';

  static instances: FakeImage[] = [];
  static behaviour: FakeImageBehaviour['mode'] = 'never';

  constructor() {
    FakeImage.instances.push(this);
  }

  get src(): string {
    return this.currentSrc;
  }

  set src(value: string) {
    this.currentSrc = value;
    if (FakeImage.behaviour === 'error') {
      setTimeout(() => this.onerror?.(), 0);
    }
    // `never`: the request stays open, exactly like a stalled host.
  }

  removeAttribute(_name: string): void {
    this.onload = null;
    this.onerror = null;
  }
}

function installFakeImage(mode: FakeImageBehaviour['mode']): FakeImageInstance {
  FakeImage.instances = [];
  FakeImage.behaviour = mode;
  (globalThis as unknown as { Image?: unknown }).Image = FakeImage;
  return {
    get instance(): FakeImage {
      const first = FakeImage.instances[0];
      assert.ok(first, 'the loader must create an Image element');
      return first;
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { Image?: unknown }).Image;
});

describe('image-loader deadline', () => {
  it('gives up on an image that never finishes loading', async () => {
    const handle = installFakeImage('never');

    const startedAt = Date.now();
    const result = await loadImageAsBuffer('https://example.com/stalled.png', 60);
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(result, null, 'a timed-out image must be reported as unloadable');
    assert.ok(elapsed >= 50, `the deadline must be honoured (waited ${elapsed}ms)`);
    assert.ok(elapsed < 2000, `the deadline must be short (waited ${elapsed}ms)`);
    assert.strictEqual(handle.instance.onload, null, 'the element must be detached from the loader');
  });

  it('applies the same deadline to the data-URL path used by HTML/EPUB', async () => {
    installFakeImage('never');

    const startedAt = Date.now();
    const result = await loadImageAsDataUrl('https://example.com/stalled.png', 60);
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(result, null);
    assert.ok(elapsed < 2000, `the deadline must be short (waited ${elapsed}ms)`);
  });

  it('still reports a broken image immediately, without waiting for the deadline', async () => {
    installFakeImage('error');

    const startedAt = Date.now();
    const result = await loadImageAsBuffer('https://example.com/missing.png', 5000);
    const elapsed = Date.now() - startedAt;

    assert.strictEqual(result, null);
    assert.ok(elapsed < 1000, `a load error must not wait for the deadline (waited ${elapsed}ms)`);
  });

  it('uses a deadline that cannot hold an export hostage', () => {
    assert.ok(IMAGE_LOAD_TIMEOUT_MS > 0);
    assert.ok(
      IMAGE_LOAD_TIMEOUT_MS <= 30_000,
      'a single image must not delay an export by more than 30s',
    );
  });
});
