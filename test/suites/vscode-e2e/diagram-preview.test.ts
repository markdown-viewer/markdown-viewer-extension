/**
 * VS Code extension E2E: diagram rendering through the render frame.
 *
 * Diagrams are the one render path that leaves the webview document: the
 * viewer fetches `webview/iframe-render.html` (built by `vscode/build.js`, with
 * the mermaid bundle inlined) and loads it into a sandboxed `srcdoc` frame,
 * then reads the produced raster back into an `<img>`.
 *
 * Diagrams come back as PNG on every platform — the browser build rasterises
 * them the same way (see the installed-extension suites' `.diagram-block img`
 * assertions) — so this suite locks the image contract, and the raster is what
 * the save-as-PNG/SVG surface exposes.
 *
 * The srcdoc boundary itself is VS Code-only (the browser build serves a real
 * URL), which is why this case lives here rather than in the browser suites.
 *
 * Two cases, one launch: a fenced block inside a document, and a standalone
 * `.mermaid` document (the extension's non-Markdown support).
 *
 * Run: `npm run test:e2e:vscode` (needs `npm run build:vscode` first).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  captureWorkbench,
  describePreviewState,
  evalJs,
  launchVSCode,
  previewFile,
  resetWorkbench,
  vscodeUnavailableReason,
  waitForPreviewFrame,
  type VSCodeHarness,
} from '../../helpers/vscode-launch.ts';

const WORKSPACE = path.resolve('test/fixtures/vscode');

/**
 * The rendered diagram, measured rather than merely found.
 *
 * The VS Code preview rasterises diagrams: the render frame hands back a PNG
 * (`<img src="data:image/png;base64,…">`), while the browser build keeps the
 * SVG inline. Both are a rendered diagram, so the assertion accepts either and
 * checks the shape that came back — hard-coding `svg` here would report the
 * VS Code path as broken.
 */
const DIAGRAM_JS = `() => {
  const block = document.querySelector('#markdown-content .diagram-block');
  const vector = block?.querySelector('svg');
  const raster = block?.querySelector('img');
  const node = vector || raster;
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return {
    kind: vector ? 'svg' : 'img',
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    viewBox: vector?.getAttribute('viewBox') || '',
    nodeCount: vector ? vector.querySelectorAll('*').length : 0,
    textLength: (vector?.textContent || '').trim().length,
    rasterSource: raster ? (raster.getAttribute('src') || '').slice(0, 24) : '',
    rasterDecoded: raster ? Boolean(raster.complete && raster.naturalWidth > 0) : false,
    rasterWidth: raster ? raster.naturalWidth : 0,
  };
}`;

/** A diagram exists in the preview, in whichever form this platform produces. */
const DIAGRAM_RENDERED_JS = `() => Boolean(document.querySelector('#markdown-content .diagram-block svg, #markdown-content .diagram-block img'))`;

const reason = vscodeUnavailableReason();

/** What the platform produced for one diagram. */
interface DiagramMeasure {
  kind: 'svg' | 'img';
  width: number;
  height: number;
  nodeCount: number;
  textLength: number;
  rasterSource: string;
  rasterDecoded: boolean;
  rasterWidth: number;
}

/** Assert a rendered diagram: a decoded, non-trivial PNG (the shared contract). */
function assertDiagram(diagram: DiagramMeasure): void {
  assert.ok(diagram, 'no diagram element found');
  assert.ok(
    diagram.width > 0 && diagram.height > 0,
    `diagram box: ${JSON.stringify(diagram)}`,
  );
  assert.equal(
    diagram.kind,
    'img',
    `diagrams render as rasterised PNG on every platform; an inline SVG means the render path changed (${JSON.stringify(diagram)})`,
  );
  assert.match(diagram.rasterSource, /^data:image\//, `diagram src: ${diagram.rasterSource}`);
  assert.equal(diagram.rasterDecoded, true, 'diagram image decoded');
  assert.ok(diagram.rasterWidth > 50, `diagram raster width: ${diagram.rasterWidth}`);
}

describe('VS Code extension: diagram preview', { skip: reason ?? false }, () => {
  let harness: VSCodeHarness;

  before(async () => {
    harness = await launchVSCode({ workspaceFolder: WORKSPACE });
  });

  // Every case starts from the same clean window. The render bundle is booted
  // once per window, so the reset keeps that warm instead of re-booting it.
  beforeEach(async () => {
    await resetWorkbench(harness.page);
  });

  after(async () => {
    await captureWorkbench(harness.page, 'vscode-diagram-preview').catch(() => undefined);
    await harness.close();
  });

  it('renders a fenced diagram through the sandboxed render frame', async () => {
    const { page } = harness;

    await previewFile(page, 'diagram.md');

    const frame = await waitForPreviewFrame(page, DIAGRAM_RENDERED_JS, 90000).catch(
      async (error: Error) => {
        // A missing diagram can mean "renders without the expected element",
        // "rendered an error block" or "never rendered" — say which one.
        throw new Error(`${error.message} | preview state: ${await describePreviewState(page)}`);
      },
    );

    const diagram = await evalJs<DiagramMeasure>(frame, DIAGRAM_JS);
    assertDiagram(diagram);

    // The SVG/PNG comes out of the render frame, which the VS Code host feeds
    // as an inlined srcdoc document (the webview CSP blocks a script-src'd
    // frame), so the built asset is part of the contract: if
    // webview/iframe-render.html stops being generated, the diagram path
    // changes shape here rather than silently in production.
    const renderFrames = page
      .frames()
      .filter((candidate) => candidate !== frame && candidate.url() !== 'about:blank');
    assert.ok(
      renderFrames.length >= 1,
      `render frame missing (frames: ${page.frames().map((f) => f.url().slice(0, 60)).join(', ')})`,
    );
  });

  /**
   * A standalone `.mermaid` document is the extension's non-Markdown support:
   * the same render path, but with the diagram source as the whole document.
   */
  it('renders a standalone .mermaid document', async () => {
    const { page } = harness;

    await previewFile(page, 'diagram.mermaid');
    const frame = await waitForPreviewFrame(page, DIAGRAM_RENDERED_JS, 90000).catch(
      async (error: Error) => {
        throw new Error(`${error.message} | preview state: ${await describePreviewState(page)}`);
      },
    );

    assertDiagram(await evalJs<DiagramMeasure>(frame, DIAGRAM_JS));
  });
});
