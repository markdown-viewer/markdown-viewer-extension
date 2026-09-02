/**
 * markdown-viewer custom element contract tests.
 *
 * The extension injects `core/element-runtime-main.js` (MAIN world) into HTML
 * pages that contain a <markdown-viewer> tag (see content-detector.ts). This
 * suite loads the REAL built bundle into a plain page and verifies the full
 * element contract the demo page (demo/demo.html) exercises:
 *  - custom element registration,
 *  - attribute reflection (value / mode / scroll-line getters+setters),
 *  - render() request/response protocol (mv:render-request → mv:response),
 *  - scrollToAnchor() / getCurrentLine().
 *
 * No extension is required: the page itself plays the role of the webview
 * runtime by answering the request events.
 *
 * IMPORTANT: all page-executed code is passed as STRINGS (IIFE form) —
 * tsx/esbuild injects a `__name` helper into compiled functions, so
 * serializing compiled functions into the browser page fails.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import { chromium, type Browser, type Page } from 'playwright-core';

const ELEMENT_RUNTIME_MAIN = path.resolve('dist/chrome/core/element-runtime-main.js');

async function evalJs<T>(page: Page, jsBody: string): Promise<T> {
  return page.evaluate(`(${jsBody})()`) as Promise<T>;
}

describe('markdown-viewer custom element contract (element-runtime-main.js)', () => {
  let browser: Browser;
  let page: Page;
  let pageErrors: string[];

  before(async () => {
    await fs.promises.access(ELEMENT_RUNTIME_MAIN).catch(() => {
      throw new Error('Chrome build artifacts are missing. Run "npm run build:chrome" first.');
    });
    browser = await chromium.launch({ channel: 'chrome' });
    page = await browser.newPage();
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('about:blank');
    await page.addScriptTag({ path: ELEMENT_RUNTIME_MAIN });

    // Play the webview runtime role: answer render requests and record
    // anchor requests, exactly like chrome/src/webview/element-runtime.ts.
    await evalJs(page, `
      () => {
        const requests = [];
        window.__elementRequests = requests;
        window.__failNextRender = false;
        window.__failNextExport = false;
        document.addEventListener('mv:render-request', (event) => {
          const detail = event.detail || {};
          requests.push({ type: 'render', markdown: detail.markdown });
          const fail = window.__failNextRender;
          window.__failNextRender = false;
          event.target.dispatchEvent(new CustomEvent('mv:response', {
            detail: { requestId: detail.requestId, ok: !fail, error: fail ? 'boom' : undefined },
          }));
        });
        document.addEventListener('mv:export-request', (event) => {
          const detail = event.detail || {};
          requests.push({
            type: 'export',
            format: detail.format,
            filename: detail.filename,
            title: detail.title,
            requestId: detail.requestId,
          });
          const fail = window.__failNextExport;
          window.__failNextExport = false;
          event.target.dispatchEvent(new CustomEvent('mv:response', {
            detail: { requestId: detail.requestId, ok: !fail, error: fail ? 'export-boom' : undefined },
          }));
        });
        document.addEventListener('mv:scroll-to-anchor-request', (event) => {
          const detail = event.detail || {};
          requests.push({ type: 'anchor', anchor: detail.anchor });
        });
      }
    `);
  });

  after(async () => {
    await browser.close();
  });

  it('registers the markdown-viewer custom element', async () => {
    const defined = await evalJs<boolean>(page, `
      () => Boolean(customElements.get('markdown-viewer'))
    `);
    assert.equal(defined, true, 'element-runtime-main.js must define markdown-viewer');
  });

  it('defines the element contract attributes and methods', async () => {
    const contract = await evalJs<{
      observed: string[];
      hasRender: boolean;
      hasScrollToAnchor: boolean;
      hasGetCurrentLine: boolean;
      hasExport: boolean;
    }>(page, `
      () => {
        const el = document.createElement('markdown-viewer');
        return {
          observed: el.constructor.observedAttributes || [],
          hasRender: typeof el.render === 'function',
          hasScrollToAnchor: typeof el.scrollToAnchor === 'function',
          hasGetCurrentLine: typeof el.getCurrentLine === 'function',
          hasExport: typeof el.export === 'function',
        };
      }
    `);
    assert.deepEqual(contract.observed, ['value', 'scroll-line', 'mode', 'data-mv-ready']);
    assert.equal(contract.hasRender, true);
    assert.equal(contract.hasScrollToAnchor, true);
    assert.equal(contract.hasGetCurrentLine, true);
    assert.equal(contract.hasExport, true, 'export() must be part of the element contract');
  });

  it('reflects the value / mode / scroll-line properties onto attributes', async () => {
    const result = await evalJs<{
      afterSet: { value: string | null; mode: string | null; scrollLine: string | null };
      readBack: { value: string | undefined; mode: string | undefined; scrollLine: number | undefined };
      cleared: { value: string | null; scrollLine: string | null };
    }>(page, `
      () => {
        const el = document.createElement('markdown-viewer');
        el.value = '# hello';
        el.mode = 'iframe';
        el.scrollLine = 42;
        const afterSet = {
          value: el.getAttribute('value'),
          mode: el.getAttribute('mode'),
          scrollLine: el.getAttribute('scroll-line'),
        };
        const readBack = { value: el.value, mode: el.mode, scrollLine: el.scrollLine };
        el.value = undefined;
        el.scrollLine = NaN;
        return {
          afterSet,
          readBack,
          cleared: { value: el.getAttribute('value'), scrollLine: el.getAttribute('scroll-line') },
        };
      }
    `);
    assert.deepEqual(result.afterSet, { value: '# hello', mode: 'iframe', scrollLine: '42' });
    assert.deepEqual(result.readBack, { value: '# hello', mode: 'iframe', scrollLine: 42 });
    assert.equal(result.cleared.value, null, 'value=undefined must remove the attribute');
    assert.equal(result.cleared.scrollLine, null, 'scrollLine=NaN must remove the attribute');
  });

  it('render() forwards the markdown via mv:render-request and resolves on mv:response', async () => {
    const requests = await evalJs<Array<{ type: string; markdown?: string }>>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        // Play the runtime's role: signal attachment before rendering.
        el.setAttribute('data-mv-ready', '1');
        await el.render('# demo');
        return window.__elementRequests.slice();
      }
    `);
    assert.equal(requests.length, 1, 'exactly one render request');
    assert.equal(requests[0].type, 'render');
    assert.equal(requests[0].markdown, '# demo');
  });

  it('render() queues requests made before the runtime attaches and flushes them on data-mv-ready', async () => {
    const requests = await evalJs<{ queuedBeforeReady: boolean; requests: Array<{ type: string; markdown?: string }> }>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        // Requests accumulate across tests; track the delta instead.
        const before = window.__elementRequests.length;
        // render() called BEFORE the runtime signals attachment: must be
        // queued, then flushed once data-mv-ready arrives (the isolated-world
        // runtime attaches asynchronously after this proxy is defined).
        const pending = el.render('# queued');
        let settled = false;
        void pending.then(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 30));
        const queuedBeforeReady = !settled && window.__elementRequests.length === before;
        el.setAttribute('data-mv-ready', '1');
        await pending;
        return {
          queuedBeforeReady,
          requests: window.__elementRequests.slice(before),
        };
      }
    `);
    assert.equal(requests.queuedBeforeReady, true, 'render() must not dispatch before the runtime is ready');
    assert.equal(requests.requests.length, 1, 'the queued render must flush exactly one request');
    assert.equal(requests.requests[0].type, 'render');
    assert.equal(requests.requests[0].markdown, '# queued');
  });

  it('render() rejects when the runtime answers with ok:false', async () => {
    const error = await evalJs<string | null>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        el.setAttribute('data-mv-ready', '1');
        window.__failNextRender = true;
        try {
          await el.render('x');
          return null;
        } catch (err) {
          return err.message;
        }
      }
    `);
    assert.equal(error, 'boom', 'render() must reject with the runtime error');
  });

  it('scrollToAnchor() forwards the anchor via mv:scroll-to-anchor-request', async () => {
    const anchors = await evalJs<Array<string | undefined>>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        el.setAttribute('data-mv-ready', '1');
        el.scrollToAnchor('section-1');
        // The anchor dispatch is queued until ready; wait a tick for the flush.
        await new Promise((r) => setTimeout(r, 10));
        return window.__elementRequests.filter((r) => r.type === 'anchor').map((r) => r.anchor);
      }
    `);
    assert.deepEqual(anchors, ['section-1']);
  });

  it('getCurrentLine() reads the data-mv-current-line attribute', async () => {
    const lines = await evalJs<{ before: number | null; after: number | null }>(page, `
      () => {
        const el = document.createElement('markdown-viewer');
        const before = el.getCurrentLine();
        el.setAttribute('data-mv-current-line', '7');
        const after = el.getCurrentLine();
        return { before, after };
      }
    `);
    assert.equal(lines.before, null, 'no attribute → null');
    assert.equal(lines.after, 7, 'attribute value must be parsed as a number');
  });

  it('export() forwards the format via mv:export-request and resolves on mv:response', async () => {
    const requests = await evalJs<Array<{ type: string; format?: string; filename?: string; title?: string }>>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        el.setAttribute('data-mv-ready', '1');
        await el.export('docx', { filename: 'lesson-1.md', title: 'Lesson 1' });
        return window.__elementRequests.filter((r) => r.type === 'export');
      }
    `);
    assert.equal(requests.length, 1, 'exactly one export request');
    assert.equal(requests[0].format, 'docx');
    assert.equal(requests[0].filename, 'lesson-1.md', 'options.filename must be forwarded');
    assert.equal(requests[0].title, 'Lesson 1', 'options.title must be forwarded');
    assert.ok(requests[0].requestId, 'a requestId must be attached for the response correlation');
  });

  it('export() forwards each supported format and the docs alias', async () => {
    const formats = await evalJs<Array<{ format?: string }>>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        el.setAttribute('data-mv-ready', '1');
        // Requests accumulate across tests; track the delta instead.
        const before = window.__elementRequests.filter((r) => r.type === 'export').length;
        for (const format of ['docx', 'epub', 'html', 'pdf', 'save', 'docs']) {
          await el.export(format);
        }
        return window.__elementRequests
          .filter((r) => r.type === 'export')
          .slice(before)
          .map((r) => ({ format: r.format }));
      }
    `);
    assert.deepEqual(
      formats,
      [
        { format: 'docx' },
        { format: 'epub' },
        { format: 'html' },
        { format: 'pdf' },
        { format: 'save' },
        { format: 'docs' },
      ],
      'all toolbar export formats (and the docs alias) must be forwarded',
    );
  });

  it('export() rejects when the runtime answers with ok:false', async () => {
    const error = await evalJs<string | null>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        el.setAttribute('data-mv-ready', '1');
        window.__failNextExport = true;
        try {
          await el.export('epub');
          return null;
        } catch (err) {
          return err.message;
        }
      }
    `);
    assert.equal(error, 'export-boom', 'export() must reject with the runtime error');
  });

  it('export() queues requests made before the runtime attaches and flushes them on data-mv-ready', async () => {
    const queued = await evalJs<{ queuedBeforeReady: boolean; requests: Array<{ type: string; format?: string }> }>(page, `
      async () => {
        const el = document.createElement('markdown-viewer');
        document.body.appendChild(el);
        const before = window.__elementRequests.filter((r) => r.type === 'export').length;
        const pending = el.export('html');
        let settled = false;
        void pending.then(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 30));
        const queuedBeforeReady = !settled
          && window.__elementRequests.filter((r) => r.type === 'export').length === before;
        el.setAttribute('data-mv-ready', '1');
        await pending;
        return {
          queuedBeforeReady,
          requests: window.__elementRequests.filter((r) => r.type === 'export').slice(before),
        };
      }
    `);
    assert.equal(queued.queuedBeforeReady, true, 'export() must not dispatch before the runtime is ready');
    assert.equal(queued.requests.length, 1, 'the queued export must flush exactly one request');
    assert.equal(queued.requests[0].format, 'html');
  });

  it('does not crash the page while defining and using the element', async () => {
    assert.deepEqual(pageErrors, [], 'element-runtime-main.js must not throw on load/use');
  });
});
