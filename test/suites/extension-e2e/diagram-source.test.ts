/**
 * Diagram & SVG documents: rendered by default, source one click away.
 *
 * A `.mermaid` / `.puml` / `.gv` / `.svg` file is a document with two faces. It
 * renders as a figure (that is why the file exists), and the toggle shows the
 * file's own source on the source surface — the same surface markdown and code
 * files use, so the line-numbered, full-bleed code view is one mechanism, not
 * three.
 *
 * Two things are pinned beyond "the toggle works":
 *   - the *rendered* figure stays mounted while its source is shown (the
 *     export contract: EPUB/HTML/PDF serialise the content root);
 *   - the surface carries the document's own language, so the highlighting is
 *     the file's, not markdown's.
 *
 * Fixtures are served over http: a `.mermaid` document is not something a
 * browser renders on its own, and the content-script viewer takes the page over
 * exactly as it does for a remote file.
 *
 * Needs `npm run build:chrome` + Playwright Chromium. Skip with
 * MV_SKIP_EXT_TESTS=1.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { type Page } from 'playwright-core';

import {
  POST_OPEN_DOCUMENT_JS,
  VIEWER_EMBED_READY_JS,
  VIEWER_UNVEILED_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  waitFor,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

const MERMAID_SOURCE = 'graph TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A\n';
const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">'
  + '<rect width="120" height="40" fill="#0b7285"/><text x="12" y="26" fill="#fff">logo</text></svg>\n';

/** Everything both faces are read through. */
const SURFACE_STATE_JS = `() => {
  const content = document.getElementById('markdown-content');
  const sourceRoot = document.getElementById('mv-source-view');
  const button = document.getElementById('toggle-source-view-btn');
  return {
    sourceView: document.documentElement.dataset.sourceView,
    sourceText: sourceRoot?.querySelector('pre code')?.textContent || '',
    sourceLanguage: sourceRoot?.querySelector('.mv-source')?.getAttribute('data-language') || null,
    toggleVisible: Boolean(button) && getComputedStyle(button).display !== 'none',
    toggleTitle: button ? button.title : null,
    renderedFigures: content ? content.querySelectorAll('.diagram-block').length : 0,
    renderedLength: (content?.textContent || '').length,
  };
}`;

interface SurfaceState {
  sourceView: string | undefined;
  sourceText: string;
  sourceLanguage: string | null;
  toggleVisible: boolean;
  toggleTitle: string | null;
  renderedFigures: number;
  renderedLength: number;
}

describe('installed Chrome extension — diagram & SVG source view', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let server: http.Server | undefined;
  let origin = '';

  before(async () => {
    server = http.createServer((request, response) => {
      const route = request.url || '/';
      if (route === '/diagrams/flow.mermaid') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(MERMAID_SOURCE);
        return;
      }
      if (route === '/images/logo.svg') {
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        response.end(SVG_SOURCE);
        return;
      }
      response.writeHead(404).end('Not found');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    harness = await launchExtensionContext('mv-diagram-source-');
    page = await harness.context.newPage();
  });

  after(async () => {
    await harness?.close();
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  });

  /** Toggle to the source face and wait for the surface to be laid out. */
  async function showSource(target: Page, expectedText: string): Promise<SurfaceState> {
    await evalJs(target, `() => { document.getElementById('toggle-source-view-btn').click(); return true; }`);
    await waitFor(target, `() => document.documentElement.dataset.sourceView === '1'`, 15_000);
    await waitFor(target, `() => Boolean(document.querySelector('#mv-source-view .mv-source-line'))`, 15_000);
    const state = await evalJs<SurfaceState>(target, SURFACE_STATE_JS);
    assert.match(state.sourceText, expectedText, `source face shows the document's own text`);
    return state;
  }

  it('shows a mermaid document as a figure and its source behind the toggle', async () => {
    await page.bringToFront();
    await page.goto(`${origin}/diagrams/flow.mermaid`, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(page, `() => Boolean(document.querySelector('#markdown-content .diagram-block'))`, 30_000);
    await waitFor(page, VIEWER_UNVEILED_JS, 15_000);

    const rendered = await evalJs<SurfaceState>(page, SURFACE_STATE_JS);
    assert.equal(rendered.sourceView, undefined, 'a diagram document opens rendered');
    assert.equal(rendered.toggleVisible, true, 'the figure offers its source');
    assert.equal(rendered.toggleTitle, 'Source Mode');
    assert.equal(rendered.renderedFigures, 1, 'the figure is mounted');

    const source = await showSource(page, /graph TD/);

    assert.equal(source.sourceLanguage, 'mermaid', 'the surface carries the document language');
    // The figure stays mounted (hidden, not cleared): an export taken from the
    // source face still serialises the rendered document.
    assert.equal(source.renderedFigures, 1, 'the rendered figure survives the switch');

    await evalJs(page, `() => { document.getElementById('toggle-source-view-btn').click(); return true; }`);
    await waitFor(page, `() => document.documentElement.dataset.sourceView === undefined`, 15_000);
    // The figure is rendered *again* (the rendered face is re-rendered from the
    // document model), and diagram rendering is asynchronous — wait for the
    // figure, not for the flag.
    await waitFor(page, `() => Boolean(document.querySelector('#markdown-content .diagram-block'))`, 30_000);
    const back = await evalJs<SurfaceState>(page, SURFACE_STATE_JS);
    assert.equal(back.toggleTitle, 'Source Mode', 'the toggle flips back');
    assert.equal(back.renderedFigures, 1, 'the figure is still the rendered face');
  });

  it('shows an SVG document as an image and its XML behind the toggle', async () => {
    // `.svg` reaches the viewer as a *document* through the workspace file
    // browser and the panel hosts; a standalone `.svg` page is an image
    // document owned by Chrome, so this drives the viewer's own protocol.
    await page.bringToFront();
    await page.goto(`chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`, { waitUntil: 'load' });
    await waitFor(page, VIEWER_EMBED_READY_JS, 15_000);
    await evalJs(page, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT', filename: 'logo.svg', content: SVG_SOURCE, fileDir: '',
    });
    await waitFor(page, `() => document.documentElement.dataset.viewerOpenedFilename === 'logo.svg'`, 30_000);
    await waitFor(page, `() => Boolean(document.querySelector('#markdown-content .diagram-block'))`, 30_000);

    const rendered = await evalJs<SurfaceState>(page, SURFACE_STATE_JS);
    assert.equal(rendered.sourceView, undefined, 'an SVG document opens rendered');
    assert.equal(rendered.toggleVisible, true, 'the image offers its source');

    const source = await showSource(page, /<svg/);

    assert.equal(source.sourceLanguage, 'xml', 'SVG source is highlighted as XML');
    assert.equal(source.renderedFigures, 1, 'the rendered image survives the switch');
  });
});
