/**
 * The built render surface, driven the way Dart drives it.
 *
 * `mobile/build/mobile/render-view.html` is the diagram engine's own hidden
 * WebView (see plans/mobile-render-view-webview-plan.md). Nothing else can see
 * that document — no widget, no console in the app's logs — so this suite loads
 * the *built* page in Chromium and plays Dart's side of the relay:
 *
 *   - it answers the surface's `RELAY_HELLO` with the bridge's limits;
 *   - it reassembles framed messages and acknowledges every frame, exactly like
 *     `mobile/lib/services/relay_chunking.dart` (the same wire format the unit
 *     suite pins) — so the transport's framing is exercised against a page, not
 *     only against itself;
 *   - it records every message that crossed the "bridge", which is how the size
 *     bound is checked: no single message may exceed the limit, whatever the
 *     payload;
 *   - it checks the surface does not read files or the network itself — all of its
 *     resource access has to go through the relay (that is why the relay exists).
 *
 * Everything the browser is asked to do goes through *expression strings*, the
 * repository's page-driving rule (see test/helpers/page-driver.ts): serialized
 * functions and their arguments do not survive every host, and a silently missing
 * argument looks exactly like a hung surface.
 *
 * The suite needs `npm run build:mobile`; without it the case fails with that
 * instruction rather than passing on a missing bundle. `RV_DEBUG=1` prints the
 * page's console, errors and failed requests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { Browser, BrowserContext, Page } from 'playwright-core';

import { launchBrowser } from '../../../scripts/documd.js';

const DIST = path.resolve('mobile/build/mobile');
const PAGE = 'render-view.html';

/**
 * Bridge limits used for the run: deliberately tiny, so that both directions have
 * to frame (a real Android bridge allows 192 KB, and a diagram result stays under
 * it often enough to hide a broken framing layer).
 */
const TEST_LIMITS = { maxMessageLength: 8 * 1024, chunkSize: 2 * 1024, window: 1 };

const MERMAID = [
  'graph TD',
  '  A[Start] --> B{Decision}',
  '  B -->|yes| C[Ship it]',
  '  B -->|no| D[Fix it]',
  '  C --> E[Done]',
  '  D --> E',
].join('\n');

type BridgeRecord = {
  /** Serialized length of every message the page posted (page -> Dart). */
  lengths: number[];
  /** Serialized length of every message Dart delivered (Dart -> page). */
  dartLengths: number[];
  /** Types the page sent, in order. */
  types: string[];
  /** Messages that were reassembled from frames (by type). */
  reassembled: string[];
  /** Maximum reassembled-message length. */
  maxAssembled: number;
  /** Maximum reassembled *response* length (the payload the framing exists for). */
  maxResponseAssembled: number;
  /** Frames the page sent (a frame = one relay message of type RELAY_CHUNK). */
  frames: number;
  /** The limits the stub published, as the page received them. */
  publishedLimits: unknown;
  /** Direct `file:`/`http:` accesses attempted by the surface (must stay empty). */
  directReads: string[];
};

/**
 * Dart's side of the relay: the JS channel the page posts into, plus the framing
 * rules. Injected as a script *before* the page's own scripts, so the surface
 * never sees a bridge that is not there.
 */
function installDartStub(limits: typeof TEST_LIMITS): void {
  const record: BridgeRecord = {
    lengths: [],
    dartLengths: [],
    types: [],
    reassembled: [],
    maxAssembled: 0,
    maxResponseAssembled: 0,
    frames: 0,
    publishedLimits: undefined,
    directReads: [],
  };
  (window as unknown as { __bridgeRecord: BridgeRecord }).__bridgeRecord = record;

  const streams = new Map<string, { parts: string[]; received: number; total: number; length: number }>();
  let streamSeq = 0;

  const inbox = (): ((payload: unknown) => void) | undefined =>
    (window as unknown as { __receiveRenderMessage?: (payload: unknown) => void }).__receiveRenderMessage;

  /**
   * Dart -> page: what the app's supervisor does. A message over the bridge's
   * limit is framed and the frames are delivered one by one — the page's
   * transport reassembles them before the channel sees anything.
   */
  const toPage = (message: unknown): void => {
    const deliver = inbox();
    if (!deliver) {
      return;
    }
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    record.dartLengths.push(text.length);
    if (text.length <= limits.maxMessageLength) {
      deliver(text);
      return;
    }
    streamSeq += 1;
    const streamId = `dart-${streamSeq}`;
    const total = Math.ceil(text.length / limits.chunkSize);
    for (let index = 0; index < total; index += 1) {
      const frame = JSON.stringify({
        type: 'RELAY_CHUNK',
        streamId,
        index,
        total,
        length: text.length,
        data: text.slice(index * limits.chunkSize, (index + 1) * limits.chunkSize),
      });
      record.dartLengths.push(frame.length);
      deliver(frame);
    }
  };

  /** Hands a reassembled message to the page, the way Dart delivers one. */
  const deliver = (text: string): void => {
    let message: { type?: string } | null = null;
    try {
      message = JSON.parse(text) as { type?: string };
    } catch {
      return;
    }
    if (message?.type) {
      record.reassembled.push(message.type);
    }
    record.maxAssembled = Math.max(record.maxAssembled, text.length);
    if (message?.type === 'RESPONSE') {
      record.maxResponseAssembled = Math.max(record.maxResponseAssembled, text.length);
    }
    inbox()?.(text);
  };

  /** Page -> Dart: the page's transport framed whatever needed it already. */
  const accept = (message: Record<string, unknown>): void => {
    const type = String(message.type ?? '');

    if (type === 'RELAY_HELLO') {
      record.publishedLimits = limits;
      toPage({ type: 'RELAY_LIMITS', protocol: 1, payload: limits });
      return;
    }
    if (type === 'RELAY_CHUNK_ACK') {
      return;
    }
    if (type === 'RELAY_CHUNK') {
      record.frames += 1;
      const streamId = String(message.streamId);
      let stream = streams.get(streamId);
      if (!stream) {
        stream = { parts: [], received: 0, total: Number(message.total), length: Number(message.length) };
        streams.set(streamId, stream);
      }
      if (Number(message.index) === stream.received) {
        stream.parts.push(String(message.data));
        stream.received += 1;
      }
      toPage({ type: 'RELAY_CHUNK_ACK', streamId, index: Number(message.index) });
      if (stream.received === stream.total) {
        streams.delete(streamId);
        deliver(stream.parts.join(''));
      }
      return;
    }

    record.types.push(type);
    if (type === 'FETCH_ASSET' || type === 'READ_RELATIVE_FILE' || type === 'FETCH_REMOTE') {
      // Host services answer these; the stub reports "not found" so the surface
      // can finish whatever it was doing.
      toPage({
        type: 'RESPONSE',
        requestId: String(message.id ?? ''),
        ok: false,
        error: { message: 'host stub: no such resource' },
      });
      return;
    }
    if (type === 'RENDER_SURFACE_READY' || type === 'RENDER_SURFACE_DOM_READY' || type === 'RENDER_SURFACE_LOG') {
      return;
    }
    if (type === 'RENDER_SURFACE_ERROR') {
      record.types.push('SURFACE_ERROR');
      return;
    }

    // Anything else is a message for the *host page* (a render response), which
    // is where Dart would forward it.
    deliver(JSON.stringify(message));
  };

  (window as unknown as { MarkdownViewerRender: { postMessage: (text: string) => void } }).MarkdownViewerRender = {
    postMessage: (text: string) => {
      record.lengths.push(text.length);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      accept(message);
    },
  };

  // The surface must not read files or remote URLs itself: every resource goes
  // through the relay. Watch both spellings of "read something directly".
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('file:') || /^https?:/i.test(url)) {
      record.directReads.push(url);
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const href = typeof url === 'string' ? url : url.href;
    if (href.startsWith('file:') || /^https?:/i.test(href)) {
      record.directReads.push(href);
    }
    return (originalOpen as unknown as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
}

/**
 * The stub as a standalone script, with the limits already bound in: nothing about
 * this relies on the host passing arguments into the page correctly.
 */
const DART_STUB_SCRIPT = `(${installDartStub.toString()})(${JSON.stringify(TEST_LIMITS)});`;

/** Evaluate an expression in the page (strings only — see the module header). */
function evalInPage<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate(expression) as Promise<T>;
}

function readRecord(page: Page): Promise<BridgeRecord> {
  return evalInPage<BridgeRecord>(page, 'window.__bridgeRecord');
}

/** Poll an expression until it is true, without relying on arbitrary sleeps. */
async function waitInPage(page: Page, expression: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if ((await evalInPage<unknown>(page, expression)) === true) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const record = await readRecord(page).catch(() => null);
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label}` +
          (lastError ? ` (last error: ${String(lastError).slice(0, 200)})` : '') +
          `\nbridge record: ${JSON.stringify(record)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Delivers a message into the surface the way Dart does. */
function deliverToSurface(page: Page, message: unknown): Promise<unknown> {
  const text = JSON.stringify(message);
  return evalInPage(page, `window.__receiveRenderMessage && window.__receiveRenderMessage(${JSON.stringify(text)})`);
}

describe('render surface relay (built page, Chromium)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: http.Server;
  let origin: string;

  before(async () => {
    assert.ok(
      fs.existsSync(path.join(DIST, 'render-view.js')),
      `missing ${path.join(DIST, 'render-view.js')} — run "npm run build:mobile" before this suite`,
    );

    server = http.createServer((request, response) => {
      // No `writeHead(...).end(...)` chaining: fibjs's writeHead returns undefined,
      // so a chained call answers 500 instead of the file.
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const file = path.join(DIST, path.normalize(url.pathname).replace(/^([/\\])+/, ''));
        if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        const type = file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : 'application/octet-stream';
        response.writeHead(200, { 'content-type': type });
        response.end(fs.readFileSync(file));
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;

    browser = await launchBrowser({});
    context = await browser.newContext();
  });

  after(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  async function openSurface(): Promise<Page> {
    const page = await context.newPage();
    if (process.env.RV_DEBUG) {
      page.on('pageerror', (error) => console.log('[pageerror]', String(error).slice(0, 400)));
      page.on('console', (message) => console.log('[console]', message.type(), message.text().slice(0, 200)));
      page.on('requestfailed', (request) => console.log('[requestfailed]', request.url(), request.failure()?.errorText));
    }
    await page.addInitScript(DART_STUB_SCRIPT);
    await page.goto(`${origin}/${PAGE}`, { waitUntil: 'load' });
    await waitInPage(page, 'typeof window.__bridgeRecord === "object"', 30_000, 'the Dart stub to install');
    return page;
  }

  /** Waits for the surface to announce readiness over the relay. */
  async function waitForReady(page: Page): Promise<BridgeRecord> {
    await waitInPage(
      page,
      'window.__bridgeRecord.types.includes("RENDER_SURFACE_READY")',
      30_000,
      'RENDER_SURFACE_READY',
    );
    const record = await readRecord(page);
    assert.deepEqual(record.publishedLimits, TEST_LIMITS, 'the surface must pick up the limits Dart publishes');
    return record;
  }

  /** Sends a render request into the surface and waits for its response. */
  async function askSurface(page: Page, message: unknown, timeoutMs = 60_000): Promise<void> {
    const countBefore = (await readRecord(page)).reassembled.filter((type) => type === 'RESPONSE').length;
    await deliverToSurface(page, message);
    await waitInPage(
      page,
      `window.__bridgeRecord.reassembled.filter((type) => type === "RESPONSE").length > ${countBefore}` +
        ' && !window.__bridgeRecord.types.includes("SURFACE_ERROR")',
      timeoutMs,
      `a RESPONSE for ${JSON.stringify(message).slice(0, 60)}`,
    );
  }

  it('boots, announces readiness, and picks up the bridge limits', async () => {
    const page = await openSurface();
    const record = await waitForReady(page);

    assert.ok(record.types.includes('RENDER_SURFACE_DOM_READY'), `types: ${record.types.join(',')}`);
    assert.equal(record.types.filter((type) => type === 'SURFACE_ERROR').length, 0, 'the surface reported an uncaught error');
    await page.close();
  });

  it('carries a result larger than the bridge limit in frames', async () => {
    const page = await openSurface();
    const before = await waitForReady(page);

    // The request itself is over the limit too, so both directions frame: this
    // stub's Dart side frames it (the surface must reassemble it) and the surface
    // frames its answer.
    const source = `${MERMAID}\n%% ${'图表\u26F0\uFE0F\u{1F680}'.repeat(8000)}`;
    await askSurface(page, {
      type: 'RENDER_DIAGRAM',
      id: 'rv-big',
      __target: 'render-view',
      payload: { renderType: 'mermaid', input: source, themeConfig: { themeId: 'default' } },
    });

    const record = await readRecord(page);
    const newFrames = record.frames - before.frames;

    // Nothing may cross the bridge over the limit — in either direction. That is
    // the whole point of the framing layer.
    const oversizeFromPage = record.lengths.filter((length) => length > TEST_LIMITS.maxMessageLength);
    const oversizeFromDart = record.dartLengths.filter((length) => length > TEST_LIMITS.maxMessageLength);
    assert.deepEqual(oversizeFromPage, [], `page -> Dart messages over the limit: ${oversizeFromPage.join(', ')}`);
    assert.deepEqual(oversizeFromDart, [], `Dart -> page messages over the limit: ${oversizeFromDart.join(', ')}`);

    // …and the response arrived whole: a payload larger than any single frame could
    // carry, so it can only have been reassembled from several.
    assert.ok(
      newFrames > 1,
      `a response over the limit must take several frames, got ${newFrames} for ${record.maxResponseAssembled} chars`,
    );
    assert.ok(
      record.maxResponseAssembled > TEST_LIMITS.maxMessageLength,
      `the reassembled response was only ${record.maxResponseAssembled} chars`,
    );
    await page.close();
  });

  it('answers a render request with a PNG data URL', async () => {
    const page = await openSurface();
    await waitForReady(page);

    // Keep the reassembled response itself, so the payload can be checked rather
    // than only its size.
    await evalInPage(page, `(() => {
      window.__lastAnswer = undefined;
      const original = window.__receiveRenderMessage;
      window.__receiveRenderMessage = (payload) => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        try {
          const message = JSON.parse(text);
          if (message && message.type === 'RESPONSE') window.__lastAnswer = text;
        } catch {}
        if (original) original(payload);
      };
      return true;
    })()`);

    await askSurface(page, {
      type: 'RENDER_DIAGRAM',
      id: 'rv-1',
      __target: 'render-view',
      payload: { renderType: 'mermaid', input: MERMAID },
    });

    const answer = await evalInPage<{ ok?: boolean; length: number; magic: string; width: number; format: string } | null>(
      page,
      `(() => {
        const text = window.__lastAnswer;
        if (!text) return null;
        const parsed = JSON.parse(text);
        const data = parsed.data || {};
        const base64 = data.base64 || '';
        return {
          ok: parsed.ok,
          length: base64.length,
          // Decoded in the page: a PNG's magic bytes, so this is an image and not a
          // placeholder string.
          magic: base64 ? atob(base64.slice(0, 8)).slice(0, 4) : '',
          width: data.width || 0,
          format: data.format || '',
        };
      })()`,
    );

    assert.ok(answer, 'no RESPONSE reached the bridge');
    assert.equal(answer.ok, true, 'the surface answered with an error');
    assert.equal(answer.format, 'png', `the result announced format ${answer.format}`);
    assert.ok(answer.length > 1000, `base64 payload too short: ${answer.length}`);
    assert.equal(answer.magic, '\u0089PNG', 'the payload must be a PNG, not a placeholder');
    assert.ok(answer.width > 0, 'the result carried no width');
    await page.close();
  });

  it('never reads files or the network itself', async () => {
    const page = await openSurface();
    await waitForReady(page);
    await askSurface(page, {
      type: 'RENDER_DIAGRAM',
      id: 'rv-2',
      __target: 'render-view',
      payload: { renderType: 'mermaid', input: MERMAID },
    });

    const record = await readRecord(page);
    // The page's own scripts load over http (that is the harness serving the
    // document); what must not happen is the *surface* reading resources itself.
    assert.deepEqual(record.directReads, [], `the surface read directly: ${record.directReads.join(', ')}`);
    await page.close();
  });
});
