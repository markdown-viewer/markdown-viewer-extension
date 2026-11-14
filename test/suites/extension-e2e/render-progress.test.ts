/**
 * The render ring next to the file name reports real work.
 *
 * While a document is being rendered the toolbar shows an indeterminate-looking
 * ring (`#processing-indicator`, right after `#file-name`). It is not
 * indeterminate: it ticks once per asynchronous task — one per diagram, chart
 * or image — as each one finishes, and it starts empty on every batch.
 *
 * That wiring was lost in `caca39b` ("Refactor viewer initialization and
 * enhance runtime bridge"): `updateProgress` stayed defined and exported but
 * nothing called it any more, so the ring appeared and vanished without ever
 * moving. This suite pins the observable contract: while the indicator is
 * visible the stroke offset decreases, i.e. the ring follows the diagrams.
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
  VIEWER_UNVEILED_JS,
  WAIT_STANDALONE_READY_JS,
  evalJs,
  launchExtensionContext,
  waitFor,
  type ExtensionContextHarness,
} from '../../helpers/extension-e2e.ts';

const SKIP_EXT = process.env.MV_SKIP_EXT_TESTS === '1';

/** Ring circumference (r = 7): offset 43.98 = empty, 0 = complete. */
const RING_CIRCUMFERENCE = 43.98;

/** More diagrams than one, so the ring has multiple ticks to report. */
const DIAGRAM_COUNT = 4;

const DIAGRAMS = [
  'graph TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A',
  'graph LR\n  A[One] --> B[Two] --> C[Three]',
  'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
  'gantt\n  title Plan\n  section Work\n  Task :a1, 2024-01-01, 3d',
];

const DIAGRAM_DOCUMENT = DIAGRAMS
  .map((source, index) => `## Diagram ${index + 1}\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`)
  .join('\n');

interface RingSample {
  visible: boolean;
  offset: number | null;
  blocks: number;
}

/**
 * Sample the toolbar ring in the page itself.
 *
 * An init script runs before the document exists and survives the content
 * script's takeover, which is the only way to observe the first batch: every
 * sample requested from the test side is a round trip, and the indicator is on
 * screen only for the duration of the render.
 */
const RING_RECORDER_JS = `(() => {
  if (window.top !== window) return;
  window.__mvRingSamples = [];
  const sample = () => {
    const indicator = document.getElementById('processing-indicator');
    const circle = document.querySelector('.progress-circle-progress');
    const raw = circle
      ? circle.style.strokeDashoffset || circle.getAttribute('stroke-dashoffset') || ''
      : '';
    const offset = Number.parseFloat(raw);
    window.__mvRingSamples.push({
      visible: Boolean(indicator) && !indicator.classList.contains('hidden'),
      offset: Number.isFinite(offset) ? offset : null,
      blocks: document.querySelectorAll('#markdown-content .diagram-block').length,
    });
    setTimeout(sample, 20);
  };
  setTimeout(sample, 0);
})()`;

describe('installed Chrome extension — render progress ring', { skip: SKIP_EXT }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let server: http.Server | undefined;
  let origin = '';

  before(async () => {
    server = http.createServer((request, response) => {
      if ((request.url || '/') === '/diagrams.md') {
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        response.end(DIAGRAM_DOCUMENT);
        return;
      }
      response.writeHead(404).end('Not found');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    harness = await launchExtensionContext('mv-render-progress-');
    page = await harness.context.newPage();
  });

  after(async () => {
    await harness?.close();
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  });

  it('advances while the document diagrams are rendering', async () => {
    await page.bringToFront();
    await page.addInitScript(RING_RECORDER_JS);

    await page.goto(`${origin}/diagrams.md`, { waitUntil: 'load' });
    await waitFor(page, WAIT_STANDALONE_READY_JS);
    await waitFor(
      page,
      `() => document.querySelectorAll('#markdown-content .diagram-block').length >= ${DIAGRAM_COUNT}`,
      90_000,
    );
    await waitFor(page, VIEWER_UNVEILED_JS, 15_000);
    await waitFor(
      page,
      `() => document.getElementById('processing-indicator')?.classList.contains('hidden') === true`,
      30_000,
    );

    const samples = await evalJs<RingSample[]>(page, `() => window.__mvRingSamples || []`);
    const visible = samples.filter((sample) => sample.visible && sample.offset !== null);

    assert.ok(
      visible.length >= 3,
      `the indicator must be on screen while the diagrams render (saw ${visible.length} visible samples of ${samples.length})`,
    );

    // The batch starts from empty: a stale offset from a previous render is the
    // reason `processAll` emits its 0-of-total tick up front.
    const firstSample = visible[0];
    assert.ok(
      firstSample!.offset! > RING_CIRCUMFERENCE * 0.7,
      `the ring must start (nearly) empty, saw ${firstSample!.offset}`,
    );

    const lastSample = visible[visible.length - 1];
    assert.ok(
      lastSample!.offset! < firstSample!.offset!,
      `the ring must advance while the diagrams render (first ${firstSample!.offset}, last ${lastSample!.offset})`,
    );

    // One tick per finished diagram, not a binary "busy" flag: the ring has to
    // travel well past the first task before the load completes.
    const smallestOffset = Math.min(...visible.map((sample) => sample.offset!));
    assert.ok(
      smallestOffset <= RING_CIRCUMFERENCE * 0.5,
      `the ring must follow more than the first diagram, reached ${smallestOffset}`,
    );

    // Every sample taken while the indicator was up belongs to the same batch:
    // the offset never goes back up (no reset mid-flight, no jitter).
    for (let index = 1; index < visible.length; index += 1) {
      const previous = visible[index - 1]!.offset!;
      const current = visible[index]!.offset!;
      assert.ok(
        current <= previous + 0.01,
        `the ring must not jump backwards during one render (${previous} -> ${current})`,
      );
    }

    const finalState = await evalJs<{ hidden: boolean; blocks: number }>(page, `() => ({
      hidden: document.getElementById('processing-indicator')?.classList.contains('hidden') === true,
      blocks: document.querySelectorAll('#markdown-content .diagram-block').length,
    })`);
    assert.equal(finalState.hidden, true, 'the indicator is hidden once the render settles');
    assert.equal(finalState.blocks, DIAGRAM_COUNT, 'the render it reported on finished');
  });
});
