/**
 * VS Code extension E2E: what the panel host must NOT do, and what `.yaml`
 * means for it.
 *
 * Three surface rules are pinned here, all of them consequences of the
 * source-surface work (plans/code-preview-toggle-plan.md):
 *
 *   1. **Preview only (R3).** The source surface is browser/workspace-only;
 *      in the panel the host editor *is* the source view. A preview that
 *      quietly grew `#mv-source-view` (or the `html[data-source-view]` flag)
 *      would mean the browser-only surface leaked into the panel build.
 *   2. **`.yaml` is a file-level capability (G6/G7).** `.yaml`/`.yml` are no
 *      longer a registered format — the extension is not activated by a YAML
 *      language and Obsidian/Firefox register nothing for it — yet Open Preview
 *      must still be offered on a YAML editor, and an OpenAPI document must
 *      still render its Redoc reference.
 *   3. **Ordinary YAML stays code.** Only a document that *is* OpenAPI (an
 *      `openapi: 3.x` / `swagger: '2.0'` key) may be taken over; anything else
 *      renders as a highlighted code block.
 *
 * Needs `npm run build:vscode` first. Skip with MV_SKIP_VSCODE_TESTS=1.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  captureWorkbench,
  evalJs,
  launchVSCode,
  previewFile,
  resetWorkbench,
  vscodeUnavailableReason,
  waitForPreviewFrame,
  type VSCodeHarness,
} from '../../helpers/vscode-launch.ts';

const WORKSPACE = path.resolve('test/fixtures/vscode');

/** Everything the surface contract is about, read from the live webview. */
const SURFACE_STATE_JS = `() => {
  const content = document.getElementById('markdown-content');
  return {
    hasSourceSurface: Boolean(document.getElementById('mv-source-view')),
    sourceFlag: document.documentElement.dataset.sourceView,
    sourceToggle: Boolean(document.getElementById('toggle-source-view-btn')),
    contentChildren: content ? content.children.length : 0,
    codeText: content?.querySelector('pre code')?.textContent || '',
    codeLanguage: content?.querySelector('pre code')?.className || '',
    // The capability reports a non-spec YAML document through the shared
    // message element: level decides the colours, the element is the same one
    // a render failure uses.
    notice: document.querySelector('[data-plugin-level="info"]')?.textContent || '',
    errorBlocks: document.querySelectorAll('.mv-plugin-error').length,
    // textContent, not innerText: a webview that is not the focused tab has no
    // layout, and layout-dependent reads come back empty there.
    redocText: document.querySelector('documd-openapi')?.shadowRoot
      ?.querySelector('.redoc-wrap')?.textContent || '',
  };
}`;

interface SurfaceState {
  hasSourceSurface: boolean;
  sourceFlag: string | undefined;
  sourceToggle: boolean;
  contentChildren: number;
  codeText: string;
  codeLanguage: string;
  notice: string;
  errorBlocks: number;
  redocText: string;
}

function assertNoSourceSurface(state: SurfaceState, label: string): void {
  assert.equal(state.hasSourceSurface, false, `${label}: no source surface in a panel host`);
  assert.equal(state.sourceFlag, undefined, `${label}: no source-surface state flag`);
  assert.equal(state.sourceToggle, false, `${label}: no source toggle in a panel host`);
}

const reason = vscodeUnavailableReason();

describe('VS Code extension: panel surface contract & YAML previews', { skip: reason ?? false }, () => {
  let harness: VSCodeHarness;

  before(async () => {
    harness = await launchVSCode({ workspaceFolder: WORKSPACE });
  });

  beforeEach(async () => {
    await resetWorkbench(harness.page);
  });

  after(async () => {
    await captureWorkbench(harness.page, 'vscode-panel-surface').catch(() => undefined);
    await harness.close();
  });

  it('previews markdown without growing a source surface', async () => {
    const { page } = harness;

    await previewFile(page, 'smoke.md');
    const frame = await waitForPreviewFrame(page, `() => {
      const content = document.getElementById('markdown-content');
      return Boolean(content && content.children.length > 0);
    }`);

    const state = await evalJs<SurfaceState>(frame, SURFACE_STATE_JS);

    assertNoSourceSurface(state, 'smoke.md');
    assert.ok(state.contentChildren > 0, 'the rendered document is in the content root');
  });

  it('previews an OpenAPI document as a reference, not as raw YAML', async () => {
    const { page } = harness;

    // `.yaml` is not a registered format any more: the command has to be
    // reachable through the contributed menu on a YAML editor (G6), which is
    // exactly what `previewFile` drives — quick open, then the command.
    await previewFile(page, 'pets.yml');
    // Wait for the reference itself, not just for "something rendered": the
    // async OpenAPI pass replaces the placeholder *after* the code block is in
    // the DOM.
    const frame = await waitForPreviewFrame(page, `() =>
      Boolean(document.querySelector('documd-openapi')?.shadowRoot
        ?.querySelector('.redoc-wrap')?.textContent?.includes('Get a pet'))`);

    const state = await evalJs<SurfaceState>(frame, SURFACE_STATE_JS);

    assert.match(state.redocText, /Pet API/, 'the OpenAPI document renders as a reference');
    assert.match(state.redocText, /petName/, 'referenced schemas are rendered');
    assertNoSourceSurface(state, 'pets.yml');
  });

  it('keeps ordinary YAML a highlighted code block', async () => {
    const { page } = harness;

    await previewFile(page, 'config.yaml');
    const frame = await waitForPreviewFrame(page, `() => {
      const content = document.getElementById('markdown-content');
      return Boolean(content && content.children.length > 0);
    }`);

    const state = await evalJs<SurfaceState>(frame, SURFACE_STATE_JS);

    assert.equal(state.redocText, '', 'ordinary YAML must not be taken over by the OpenAPI renderer');
    assert.match(state.codeLanguage, /language-yaml/, `yaml code block (class: ${state.codeLanguage})`);
    assert.match(state.codeText, /server:/, 'the YAML source is shown');
    // The capability says why there is no reference, at info level — a notice,
    // not a failure.
    assert.match(state.notice, /not an OpenAPI document/i, `info notice (got: ${state.notice})`);
    assert.equal(state.errorBlocks, 0, 'a non-spec YAML file is not an error');
    assertNoSourceSurface(state, 'config.yaml');
  });
});
