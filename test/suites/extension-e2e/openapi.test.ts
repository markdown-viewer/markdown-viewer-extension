import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Page, Frame } from 'playwright-core';
import { launchExtensionContext, waitFor, waitForFrame, evalJs, POST_OPEN_DOCUMENT_JS, VIEWER_EMBED_READY_JS, MOCK_DIRECTORY_PICKER_JS, type ExtensionContextHarness } from '../../helpers/extension-e2e.ts';

/**
 * Show the rendered reference of an OpenAPI *document*.
 *
 * A `.yaml`/`.yml` file opens as source (G3): the spec text is what the file
 * was opened for, and the Redoc reference is one toggle click away. The mount
 * itself is async, so this waits for the reference, not for the click.
 *
 * Embedded ```openapi code blocks in markdown need no toggle — they are
 * ordinary code blocks now (R5), so no case here asserts a reference for them.
 */
async function showReferenceView(target: Page | Frame, readyText?: string): Promise<void> {
  // Drive by state, never by timing. The toggle is a per-document control: a
  // click that lands while the viewer still boots (or before the document it
  // belongs to is on screen) flips the *previous* mode and is then kept as the
  // new document's intent — measured as "the reference never appears". Waiting
  // for the source face proves the viewer booted, the document was applied and
  // (being an OpenAPI document) opened as source.
  await waitFor(target, `() => document.documentElement.dataset.sourceView === '1'`, 30_000);
  await evalJs(target, `() => { document.getElementById('toggle-source-view-btn').click(); return true; }`);
  const probe = readyText
    ? `() => Boolean(document.querySelector('documd-openapi')?.shadowRoot?.querySelector('.redoc-wrap')?.textContent?.includes(${JSON.stringify(readyText)}))`
    : `() => Boolean(document.querySelector('documd-openapi')?.shadowRoot?.querySelector('.redoc-wrap'))`;
  await waitFor(target, probe, 30_000);
}

const SOURCE_STATE_JS = `() => {
  const button = document.getElementById('toggle-source-view-btn');
  return {
    sourceView: document.documentElement.dataset.sourceView,
    sourceText: document.querySelector('#mv-source-view pre code')?.textContent || '',
    toggleVisible: Boolean(button) && getComputedStyle(button).display !== 'none',
    toggleTitle: button ? button.title : null,
    references: document.querySelectorAll('documd-openapi').length,
  };
}`;

interface SourceState {
  sourceView: string | undefined;
  sourceText: string;
  toggleVisible: boolean;
  toggleTitle: string | null;
  references: number;
}

describe('installed extension — OpenAPI YAML', { skip: process.env.MV_SKIP_EXT_TESTS === '1' }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let fixtureDir: string;
  const casePages: Page[] = [];
  const fileUrl = (name: string) => pathToFileURL(path.join(fixtureDir, name)).href;

  /**
   * Open a fresh tab for a case.
   *
   * The viewer stashes a pending open in `sessionStorage` and replays it after
   * a reload (that is how a workspace file survives the boot hand-off), so a
   * shared tab hands the next case the *previous* case's document — measured as
   * a different case failing on each run.
   */
  async function openCasePage(url: string): Promise<Page> {
    const next = await harness.context.newPage();
    casePages.push(next);
    await next.goto(url);
    return next;
  }

  before(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-openapi-ext-'));
    const yaml = await fs.readFile('test/fixtures/openapi/pets.yml', 'utf8');
    await fs.writeFile(path.join(fixtureDir, 'pets.yml'), yaml);
    await fs.writeFile(path.join(fixtureDir, 'config.yaml'), 'name: plain configuration\n');
    await fs.writeFile(path.join(fixtureDir, 'apis.md'), `# APIs\n\n\`\`\`openapi\n${yaml}\n\`\`\`\n\n\`\`\`openapi\n${yaml.replace('Pet API', 'Second API').replace('Get a pet', 'Get another pet')}\n\`\`\`\n`);
    harness = await launchExtensionContext('mv-openapi-ext-');
    page = await harness.context.newPage();
    casePages.push(page);
  });

  after(async () => {
    await Promise.all(casePages.map((openPage) => openPage.close().catch(() => undefined)));
    await harness?.close();
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('opens a .yml file as source and toggles between the spec and its reference', async () => {
    page = await openCasePage(`chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`);
    await waitFor(page, VIEWER_EMBED_READY_JS);
    await evalJs(page, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT', filename: 'pets.yml', content: await fs.readFile(path.join(fixtureDir, 'pets.yml'), 'utf8'), fileDir: '',
    });

    // G3: an OpenAPI file opens as *source*, with the reference one toggle away.
    await waitFor(page, `() => document.documentElement.dataset.sourceView === '1'`, 30_000);
    const source = await evalJs<SourceState>(page, SOURCE_STATE_JS);
    assert.equal(source.toggleVisible, true, 'an OpenAPI file offers the source toggle');
    assert.equal(source.toggleTitle, 'Preview Mode', 'the toggle offers the reference while source is shown');
    assert.match(source.sourceText, /openapi: 3\.1\.0/, 'the spec text is shown, not a rendered skeleton');
    assert.equal(source.references, 0, 'nothing renders the reference until it is asked for');

    await showReferenceView(page, 'Get a pet');
    const rendered = await evalJs<SourceState>(page, SOURCE_STATE_JS);
    assert.equal(rendered.sourceView, undefined, 'the rendered face hides the source surface');
    assert.equal(rendered.toggleTitle, 'Source Mode', 'the toggle flips back to source');

    // ... and back: the surface is re-rendered from the document model.
    await evalJs(page, `() => { document.getElementById('toggle-source-view-btn').click(); return true; }`);
    await waitFor(page, `() => document.documentElement.dataset.sourceView === '1'`, 30_000);
    const again = await evalJs<SourceState>(page, SOURCE_STATE_JS);
    assert.match(again.sourceText, /openapi: 3\.1\.0/, 'source view comes back');

    // Ordinary YAML is a code-reading document: source only, no toggle.
    await evalJs(page, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT', filename: 'config.yaml', content: await fs.readFile(path.join(fixtureDir, 'config.yaml'), 'utf8'), fileDir: '',
    });
    await waitFor(page, `() => document.querySelector('#mv-source-view pre code[data-source-view-decorated="1"]')?.textContent.includes('plain configuration')`, 30_000);
    const plain = await evalJs<SourceState>(page, SOURCE_STATE_JS);
    assert.equal(plain.sourceView, '1', 'plain YAML renders as code-reading');
    assert.equal(plain.toggleVisible, false, 'plain YAML has no source toggle');
    assert.equal(plain.references, 0, 'plain YAML is never taken over by the reference renderer');
  });

  it('keeps embedded openapi code blocks as code (R5)', async () => {
    // What the preview shows is what DOCX exports: an embedded ```openapi block
    // is a code block, never a rendered reference.
    page = await openCasePage(fileUrl('apis.md'));
    // Wait for the state this case asserts (both fences rendered as code), not
    // for "something rendered": the first block lands while the second is still
    // streaming.
    await waitFor(page, `() => document.querySelectorAll('#markdown-content pre code').length === 2`, 30_000);
    const result = await evalJs<{ references: number; errors: number; blocks: number; first: string }>(page, `() => ({
      references: document.querySelectorAll('documd-openapi').length,
      errors: document.querySelectorAll('.mv-plugin-error').length,
      blocks: document.querySelectorAll('#markdown-content pre code').length,
      first: (document.querySelector('#markdown-content pre code')?.textContent || '').slice(0, 40),
    })`);
    assert.equal(result.references, 0, 'an embedded fence never mounts a reference');
    assert.equal(result.errors, 0, 'and it is not a render failure either');
    assert.equal(result.blocks, 2, 'both blocks render as code');
    assert.match(result.first, /openapi: 3\.1\.0/);
  });

  it('loads referenced YAML through the workspace file reader', async () => {
    const yaml = (await fs.readFile('test/fixtures/openapi/pets.yml', 'utf8'))
      .replace("'#/components/schemas/Pet'", '"./Schema.yml?raw=1"');
    const workspace = await harness.context.newPage();
    try {
      await workspace.addInitScript(`(${MOCK_DIRECTORY_PICKER_JS})(${JSON.stringify({
        'api.yml': yaml,
        'Schema.yml': 'type: object\nproperties:\n  workspacePetName: {type: string}\n',
      })})`);
      await workspace.goto(`chrome-extension://${harness.extensionId}/ui/workspace/workspace.html`);
      await workspace.locator('#pick-directory').click();
      await workspace.locator('.tree-item').filter({ hasText: 'api.yml' }).click();
      const frame = await waitForFrame(workspace, 'viewer-embed');
      await showReferenceView(frame, 'workspacePetName');
      assert.equal(await evalJs(frame, '() => document.querySelector(".mv-plugin-error")'), null);
    } finally {
      await workspace.close();
    }
  });

  it('loads cross-origin references without CORS headers in the standalone viewer and in the workspace', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/yaml' });
      response.end(request.url === '/schemas/Pet.yml'
        ? 'type: object\nproperties:\n  remotePetName: {type: string}\n  owner: {$ref: "./Owner.yml"}\n'
        : 'type: object\nproperties:\n  remoteOwnerName: {type: string}\n');
    });
    let workspace: Page | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const yaml = (await fs.readFile('test/fixtures/openapi/pets.yml', 'utf8'))
        .replace("'#/components/schemas/Pet'", JSON.stringify(`${origin}/schemas/Pet.yml`));

      // The standalone viewer, driven through its own document protocol: a
      // `.yml` file cannot be *navigated* to (Chrome downloads it), so this is
      // how a file page reaches the viewer.
      page = await openCasePage(`chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`);
      await waitFor(page, VIEWER_EMBED_READY_JS);
      await evalJs(page, POST_OPEN_DOCUMENT_JS, {
        type: 'OPEN_DOCUMENT', filename: 'remote.yml', content: yaml, fileDir: '',
      });
      await showReferenceView(page, 'remotePetName');
      assert.equal(await evalJs(page, `() => document.querySelector('.mv-plugin-error')?.textContent`), undefined);
      assert.match(await evalJs(page, `() => document.querySelector('documd-openapi').shadowRoot.querySelector('.redoc-wrap').innerText`), /remotePetName/);

      workspace = await harness.context.newPage();
      await workspace.addInitScript(`(${MOCK_DIRECTORY_PICKER_JS})(${JSON.stringify({ 'api.yml': yaml })})`);
      await workspace.goto(`chrome-extension://${harness.extensionId}/ui/workspace/workspace.html`);
      await workspace.locator('#pick-directory').click();
      await workspace.locator('.tree-item').filter({ hasText: 'api.yml' }).click();
      const frame = await waitForFrame(workspace, 'viewer-embed');
      await showReferenceView(frame, 'remotePetName');
      assert.equal(await evalJs(frame, `() => document.querySelector('.mv-plugin-error')?.textContent`), undefined);
      assert.match(await evalJs(frame, `() => document.querySelector('documd-openapi').shadowRoot.querySelector('.redoc-wrap').innerText`), /remotePetName/);
    } finally {
      await workspace?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks script URLs in metadata without relying on CSP', async () => {
    const unsafe = 'javascript:window.openapiLinkXss=42;void(0)';
    const yaml = `openapi: 3.1.0\ninfo:\n  title: Link safety\n  version: '1'\n  termsOfService: ${JSON.stringify(unsafe)}\n  contact: {email: hello@example.test, url: ${JSON.stringify(unsafe.replace('javascript', 'java\tscript'))}}\n  license: {name: View license, url: ${JSON.stringify('\u0000' + unsafe)}}\nexternalDocs: {description: Unsafe docs, url: ${JSON.stringify(unsafe.replace('javascript', 'java\nscript'))}}\npaths: {}\n`;
    page = await openCasePage(`chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`);
    await waitFor(page, VIEWER_EMBED_READY_JS);
    await evalJs(page, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT', filename: 'links.yml', content: yaml, fileDir: '',
    });
    await showReferenceView(page);
    assert.equal(await evalJs(page, `() => [...document.querySelector('documd-openapi').shadowRoot.querySelectorAll('a[href]')].filter(a => a.protocol === 'javascript:').length`), 0);
    assert.equal(await evalJs(page, `() => document.querySelector('documd-openapi').shadowRoot.querySelector('a[href="mailto:hello@example.test"]') !== null`), true);
    await page.locator('documd-openapi a').filter({ hasText: 'View license' }).click();
    assert.equal(await evalJs(page, '() => window.openapiLinkXss'), undefined);
    // A click in the same task as a URL update must be blocked before the
    // MutationObserver gets a chance to clean the new attribute.
    await evalJs(page, `() => {
      const link = [...document.querySelector('documd-openapi').shadowRoot.querySelectorAll('a')].find(a => a.textContent === 'View license');
      link.href = 'java\\nscript:window.openapiLinkXss=42;void(0)';
      link.click();
    }`);
    assert.equal(await evalJs(page, '() => window.openapiLinkXss'), undefined);
  });

  it('updates the active endpoint when the host container scrolls', async () => {
    page = await openCasePage(`chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`);
    await waitFor(page, VIEWER_EMBED_READY_JS);
    const yaml = `openapi: 3.1.0\ninfo: {title: Scroll API, version: '1'}\npaths:\n  /one:\n    get:\n      operationId: one\n      summary: First\n      description: ${JSON.stringify('Long description. '.repeat(500))}\n      responses: {'200': {description: OK}}\n  /two:\n    get:\n      operationId: two\n      summary: Second\n      responses: {'200': {description: OK}}\n`;
    await evalJs(page, POST_OPEN_DOCUMENT_JS, { type: 'OPEN_DOCUMENT', filename: 'scroll.yml', content: yaml, fileDir: '' });
    await showReferenceView(page);
    await waitFor(page, `() => document.querySelector('documd-openapi')?.shadowRoot?.querySelector('[data-section-id="operation/two"]')`, 30_000);
    await evalJs(page, `() => {
      document.querySelector('#markdown-wrapper').style.cssText = 'position:fixed;inset:0;height:100vh;overflow:auto;margin:0';
      document.body.style.overflow = 'hidden';
    }`);
    await page.locator('documd-openapi [data-item-id="operation/one"]').click();
    await waitFor(page, `() => document.querySelector('documd-openapi').shadowRoot.querySelector('.menu-content .active')?.textContent.includes('First')`, 3_000);
    await evalJs(page, `() => {
      const wrapper = document.querySelector('#markdown-wrapper');
      const second = document.querySelector('documd-openapi').shadowRoot.querySelector('[data-section-id="operation/two"]');
      wrapper.appendChild(Object.assign(document.createElement('div'), { style: 'height:2000px' }));
      wrapper.scrollTop += second.getBoundingClientRect().top - wrapper.getBoundingClientRect().top + 2;
    }`);
    await waitFor(page, `() => document.querySelector('documd-openapi').shadowRoot.querySelector('.menu-content .active')?.textContent.includes('Second')`, 3_000);
  });
});
