import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Page } from 'playwright-core';
import { launchExtensionContext, waitFor, waitForFrame, evalJs, POST_OPEN_DOCUMENT_JS, VIEWER_EMBED_READY_JS, MOCK_DIRECTORY_PICKER_JS, type ExtensionContextHarness } from '../../helpers/extension-e2e.ts';

describe('installed extension — OpenAPI YAML', { skip: process.env.MV_SKIP_EXT_TESTS === '1' }, () => {
  let harness: ExtensionContextHarness;
  let page: Page;
  let fixtureDir: string;
  const fileUrl = (name: string) => pathToFileURL(path.join(fixtureDir, name)).href;

  before(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-openapi-ext-'));
    const yaml = await fs.readFile('test/fixtures/openapi/pets.yml', 'utf8');
    await fs.writeFile(path.join(fixtureDir, 'pets.yml'), yaml);
    await fs.writeFile(path.join(fixtureDir, 'config.yaml'), 'name: plain configuration\n');
    await fs.writeFile(path.join(fixtureDir, 'apis.md'), `# APIs\n\n\`\`\`openapi\n${yaml}\n\`\`\`\n\n\`\`\`openapi\n${yaml.replace('Pet API', 'Second API').replace('Get a pet', 'Get another pet')}\n\`\`\`\n`);
    harness = await launchExtensionContext('mv-openapi-ext-');
    page = await harness.context.newPage();
  });

  after(async () => {
    await harness?.close();
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('opens a .yml file as an API reference and preserves ordinary YAML source view', async () => {
    await page.goto(`chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`);
    await waitFor(page, VIEWER_EMBED_READY_JS);
    await evalJs(page, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT', filename: 'pets.yml', content: await fs.readFile(path.join(fixtureDir, 'pets.yml'), 'utf8'), fileDir: '',
    });
    await waitFor(page, `() => document.querySelector('documd-openapi')?.shadowRoot?.querySelector('.redoc-wrap')?.innerText.includes('Get a pet')`, 30_000);
    assert.equal(await evalJs(page, '() => document.documentElement.dataset.codeView'), undefined);

    await evalJs(page, POST_OPEN_DOCUMENT_JS, {
      type: 'OPEN_DOCUMENT', filename: 'config.yaml', content: await fs.readFile(path.join(fixtureDir, 'config.yaml'), 'utf8'), fileDir: '',
    });
    await waitFor(page, `() => document.querySelector('pre code[data-code-view-decorated="1"]')?.textContent.includes('plain configuration')`, 30_000);
    assert.equal(await evalJs(page, '() => document.documentElement.dataset.codeView'), '1');
    assert.equal(await evalJs(page, '() => document.querySelectorAll("documd-openapi").length'), 0);
  });

  it('renders two independent OpenAPI code blocks in Markdown', async () => {
    await page.goto(fileUrl('apis.md'));
    await waitFor(page, `() => document.querySelector('#markdown-content')?.children.length > 0`, 30_000);
    await waitFor(page, `() => document.querySelectorAll('documd-openapi').length === 2`, 30_000);
    await page.locator('documd-openapi').last().scrollIntoViewIfNeeded();
    await waitFor(page, `() => {
      const previews = [...document.querySelectorAll('documd-openapi')];
      return previews.length === 2 && previews[0].shadowRoot?.querySelector('.redoc-wrap')?.innerText.includes('Get a pet')
        && previews[1].shadowRoot?.querySelector('.redoc-wrap')?.innerText.includes('Get another pet');
    }`, 30_000).catch(async (error) => {
      const messages = await evalJs(page, `() => [...document.querySelectorAll('.mv-plugin-error')].map(el => el.textContent)`);
      throw new Error(`${error.message}\n${JSON.stringify(messages)}`);
    });
    const titles = await evalJs(page, `() => [...document.querySelectorAll('documd-openapi')].map(el => el.shadowRoot.querySelector('.redoc-wrap').innerText)`);
    assert.match(titles[0], /Pet API/);
    assert.match(titles[1], /Second API/);
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
      await waitFor(frame, `() => document.querySelector('documd-openapi')?.shadowRoot?.querySelector('.redoc-wrap')?.innerText.includes('workspacePetName')`, 30_000).catch(async (error) => {
        const details = await evalJs(frame, `() => ({ preview: document.querySelector('documd-openapi')?.shadowRoot?.textContent, errors: [...document.querySelectorAll('.mv-plugin-error')].map(el => el.textContent) })`);
        throw new Error(`${error.message}\n${JSON.stringify(details)}`);
      });
      assert.equal(await evalJs(frame, '() => document.querySelector(".mv-plugin-error")'), null);
    } finally {
      await workspace.close();
    }
  });

  it('loads cross-origin references without CORS headers on file pages and in the workspace', async () => {
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
      await fs.writeFile(path.join(fixtureDir, 'remote.md'), `\`\`\`openapi\n${yaml}\n\`\`\`\n`);
      await page.goto(fileUrl('remote.md'));
      await waitFor(page, `() => document.querySelector('.mv-plugin-error') || document.querySelector('documd-openapi')?.shadowRoot?.querySelector('.redoc-wrap')`, 30_000);
      assert.equal(await evalJs(page, `() => document.querySelector('.mv-plugin-error')?.textContent`), undefined);
      assert.match(await evalJs(page, `() => document.querySelector('documd-openapi').shadowRoot.querySelector('.redoc-wrap').innerText`), /remotePetName/);

      workspace = await harness.context.newPage();
      await workspace.addInitScript(`(${MOCK_DIRECTORY_PICKER_JS})(${JSON.stringify({ 'api.yml': yaml })})`);
      await workspace.goto(`chrome-extension://${harness.extensionId}/ui/workspace/workspace.html`);
      await workspace.locator('#pick-directory').click();
      await workspace.locator('.tree-item').filter({ hasText: 'api.yml' }).click();
      const frame = await waitForFrame(workspace, 'viewer-embed');
      await waitFor(frame, `() => document.querySelector('.mv-plugin-error') || document.querySelector('documd-openapi')?.shadowRoot?.querySelector('.redoc-wrap')`, 30_000);
      assert.equal(await evalJs(frame, `() => document.querySelector('.mv-plugin-error')?.textContent`), undefined);
      assert.match(await evalJs(frame, `() => document.querySelector('documd-openapi').shadowRoot.querySelector('.redoc-wrap').innerText`), /remotePetName/);
    } finally {
      await workspace?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks script URLs in metadata on a native file page without relying on CSP', async () => {
    const unsafe = 'javascript:window.openapiLinkXss=42;void(0)';
    const yaml = `openapi: 3.1.0\ninfo:\n  title: Link safety\n  version: '1'\n  termsOfService: ${JSON.stringify(unsafe)}\n  contact: {email: hello@example.test, url: ${JSON.stringify(unsafe.replace('javascript', 'java\tscript'))}}\n  license: {name: View license, url: ${JSON.stringify('\u0000' + unsafe)}}\nexternalDocs: {description: Unsafe docs, url: ${JSON.stringify(unsafe.replace('javascript', 'java\nscript'))}}\npaths: {}\n`;
    await fs.writeFile(path.join(fixtureDir, 'links.md'), `\`\`\`openapi\n${yaml}\n\`\`\`\n`);
    await page.goto(fileUrl('links.md'));
    await waitFor(page, `() => document.querySelector('documd-openapi')?.shadowRoot?.querySelector('.redoc-wrap')`, 30_000);
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
    await page.goto(`chrome-extension://${harness.extensionId}/ui/workspace/viewer-embed.html?embed=1`);
    await waitFor(page, VIEWER_EMBED_READY_JS);
    const yaml = `openapi: 3.1.0\ninfo: {title: Scroll API, version: '1'}\npaths:\n  /one:\n    get:\n      operationId: one\n      summary: First\n      description: ${JSON.stringify('Long description. '.repeat(500))}\n      responses: {'200': {description: OK}}\n  /two:\n    get:\n      operationId: two\n      summary: Second\n      responses: {'200': {description: OK}}\n`;
    await evalJs(page, POST_OPEN_DOCUMENT_JS, { type: 'OPEN_DOCUMENT', filename: 'scroll.yml', content: yaml, fileDir: '' });
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
