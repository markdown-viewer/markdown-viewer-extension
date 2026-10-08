import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isOpenapiFile, isOpenapiSource } from '../../../src/utils/openapi.ts';
import { isSafeUrl } from '../../../src/utils/url-safety.ts';
import { createBrowserRenderHarness, type BrowserRenderHarness } from '../../helpers/browser-render-harness.ts';

describe('OpenAPI preview', () => {
  let harness: BrowserRenderHarness;
  let fixtureDir: string;
  let fixture: string;

  before(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-openapi-'));
    fixture = path.join(fixtureDir, 'api.md');
    const yaml = await fs.readFile('test/fixtures/openapi/pets.yml', 'utf8');
    await fs.writeFile(fixture, `# API reference\n\n\`\`\`openapi\n${yaml}\n\`\`\`\n\n\`\`\`yaml\nname: ordinary config\n\`\`\`\n`);
    harness = await createBrowserRenderHarness({ inputPath: fixture });
  });

  after(async () => {
    await harness?.dispose();
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('recognizes OpenAPI/Swagger YAML without claiming ordinary YAML', () => {
    assert.equal(isOpenapiFile('openapi: 3.1.0\n', 'https://example.test/API.YML?raw=1#top'), true);
    assert.equal(isOpenapiSource('\uFEFF---\n"swagger": \'2.0\' # legacy\r\n'), true);
    assert.equal(isOpenapiSource('"openapi": "3.0.3"\n'), true);
    assert.equal(isOpenapiSource('openapi : 3.1.0\ninfo: {title: Test, version: "1"}\npaths: {}'), true);
    assert.equal(isOpenapiSource('  openapi: 3.1.0\n  info: {title: Test, version: "1"}\n  paths: {}'), true);
    assert.equal(isOpenapiSource('{openapi: 3.1.0, info: {title: Test, version: "1"}, paths: {}}'), true);
    assert.equal(isOpenapiSource('openapi: [\n'), false);
    assert.equal(isOpenapiSource('description: |\n  openapi: 3.1.0\n'), false);
    assert.equal(isOpenapiSource('openapi: false\n'), false);
    assert.equal(isOpenapiFile('openapi: 3.1.0\n', 'example.txt'), false);
  });

  it('renders endpoints and referenced schemas locally under the renderer CSP', async () => {
    await harness.snapshotDom(fixture, { timeoutMs: 30_000 });
    await harness.evaluateInPage(async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const root = document.querySelector('documd-openapi')?.shadowRoot;
        if (root?.querySelector<HTMLElement>('.redoc-wrap')?.innerText.includes('Get a pet')) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
    const result = await harness.evaluateInPage(() => {
      const preview = document.querySelector('documd-openapi');
      return {
        text: preview?.shadowRoot?.querySelector<HTMLElement>('.redoc-wrap')?.innerText ?? '',
        width: preview?.getBoundingClientRect().width ?? 0,
        ordinaryYaml: document.querySelector('code.language-yaml')?.textContent,
        escapedSource: preview?.querySelector('pre')?.textContent,
        xss: (window as Window & { openapiXss?: boolean }).openapiXss,
        globalRendererStyle: document.head.querySelector('style[data-styled]') !== null,
        unsafeDescription: preview?.shadowRoot?.querySelector('[onerror], script') !== null,
      };
    });
    assert.match(result.text, /Pet API/);
    assert.match(result.text, /Get a pet/);
    assert.match(result.text, /petName/);
    assert.ok(result.width > 100);
    assert.match(result.ordinaryYaml ?? '', /ordinary config/);
    assert.match(result.escapedSource ?? '', /onerror=/);
    assert.equal(result.xss, undefined);
    assert.equal(result.globalRendererStyle, false);
    assert.equal(result.unsafeDescription, false);
    assert.doesNotMatch(harness.consoleMessages().map((m) => m.text).join('\n'), /unsafe-eval|Refused to execute/);
  });

  it('rejects script protocols after browser URL normalization', () => {
    for (const url of ['java\nscript:alert(1)', 'java\tscript:alert(1)', '\u0000javascript:alert(1)']) {
      assert.equal(isSafeUrl(url), false);
    }
    assert.equal(isSafeUrl('https://example.test/docs'), true);
    assert.equal(isSafeUrl('../docs/index.html'), true);
  });

  it('remounts cached blocks, follows the viewer theme and scopes navigation', async () => {
    const result = await harness.evaluateInPage(async () => {
      const original = document.querySelector('documd-openapi')!;
      original.outerHTML = original.outerHTML;
      const restored = document.querySelector('documd-openapi') as HTMLElement & { ready: Promise<void> };
      await Promise.resolve(); // The lifecycle observer mounts the restored container.
      await restored.ready;
      document.documentElement.classList.add('dark');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const duplicate = restored.cloneNode(true) as HTMLElement & { ready: Promise<void> };
      restored.after(duplicate);
      await Promise.resolve();
      await duplicate.ready;
      const navigation: boolean[] = [];
      const beforeUrl = location.href;
      const originalScroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function () {
        navigation.push(this.getRootNode() === duplicate.shadowRoot);
      };
      try {
        duplicate.shadowRoot!.querySelector<HTMLElement>('.menu-content [role="menuitem"]')!.click();
      } finally {
        Element.prototype.scrollIntoView = originalScroll;
      }
      return {
        title: restored.shadowRoot?.querySelector<HTMLElement>('.redoc-wrap')?.innerText,
        dark: restored.shadowRoot?.querySelector('.dark-mode') !== null,
        navigation,
        unchangedUrl: location.href === beforeUrl,
      };
    });
    assert.match(result.title ?? '', /Pet API/);
    assert.equal(result.dark, true);
    assert.deepEqual(result.navigation, [true]);
    assert.equal(result.unchangedUrl, true);
  });

  it('reports invalid YAML instead of leaving an async task pending', async () => {
    await fs.writeFile(fixture, '# Invalid API\n\n```openapi\nopenapi: 3.1.0\ninfo: [\n```\n');
    await harness.snapshotDom(fixture, { timeoutMs: 10_000 });
    const result = await harness.evaluateInPage(() => document.querySelector('.mv-plugin-error[data-plugin-type="openapi"]')?.textContent);
    assert.ok(result, 'invalid YAML should produce a visible error');
    const diagnostics = await harness.diagnostics();
    assert.ok(diagnostics.some((item) => item.type === 'openapi' && item.level === 'error' && item.line === 3));
  });

  it('ignores the host URL fragment while initializing Redoc', async () => {
    await fs.writeFile(fixture, '```openapi\nopenapi: 3.1.0\ninfo: {title: Hash API, version: "1"}\npaths: {}\n```');
    try {
      await harness.evaluateInPage(() => { history.replaceState(null, '', '#100%'); });
      await harness.snapshotDom(fixture, { timeoutMs: 30_000 });
      const result = await harness.evaluateInPage(() => ({
        text: document.querySelector('documd-openapi')?.shadowRoot?.querySelector<HTMLElement>('.redoc-wrap')?.innerText,
        error: document.querySelector('.mv-plugin-error')?.textContent,
        hash: location.hash,
      }));
      assert.equal(result.error, undefined);
      assert.match(result.text ?? '', /Hash API/);
      assert.equal(result.hash, '#100%');
    } finally {
      await harness.evaluateInPage(() => { history.replaceState(null, '', location.href.split('#')[0]); });
    }
  });

  it('resolves nested and circular external references through the document service', async () => {
    await fs.mkdir(path.join(fixtureDir, 'schemas'), { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'schemas', 'Pet.yml'), 'type: object\nproperties:\n  petName: {type: string}\n  owner: {$ref: "./Owner.yml"}\n');
    await fs.writeFile(path.join(fixtureDir, 'schemas', 'Owner.yml'), 'type: object\nproperties:\n  ownerName: {type: string}\n  pet: {$ref: "./Pet.yml"}\n');
    const yaml = (await fs.readFile('test/fixtures/openapi/pets.yml', 'utf8'))
      .replace("'#/components/schemas/Pet'", '"./schemas/Pet.yml?raw=1"');
    await fs.writeFile(fixture, `\`\`\`openapi\n${yaml}\n\`\`\`\n`);
    await harness.snapshotDom(fixture, { timeoutMs: 30_000 });
    const result = await harness.evaluateInPage(() => ({
      text: document.querySelector('documd-openapi')?.shadowRoot?.querySelector<HTMLElement>('.redoc-wrap')?.innerText,
      error: document.querySelector('.mv-plugin-error')?.textContent,
    }));
    assert.equal(result.error, undefined);
    assert.match(result.text ?? '', /petName/);
    assert.match(result.text ?? '', /owner/);
  });

  it('resolves book chapter references from each chapter directory', async () => {
    const chapterDir = path.join(fixtureDir, 'child');
    await fs.mkdir(path.join(chapterDir, 'schemas'), { recursive: true });
    await fs.writeFile(path.join(chapterDir, 'schemas', 'ChapterPet.yml'), 'type: object\nproperties:\n  childPetName: {type: string}\n');
    const yaml = (await fs.readFile('test/fixtures/openapi/pets.yml', 'utf8'))
      .replace("'#/components/schemas/Pet'", '"./schemas/ChapterPet.yml"');
    await fs.writeFile(path.join(chapterDir, 'api.md'), `\`\`\`openapi\n${yaml}\n\`\`\`\n`);
    const result = await harness.renderBookDom([{ href: 'child/api.md', title: 'Child API' }], { inputPath: fixture, timeoutMs: 30_000 });
    assert.equal(result.chapters.length, 1);
    assert.match(result.chapters[0].html, /documd-openapi/);
    assert.doesNotMatch(result.chapters[0].html, /mv-plugin-error|book-chapter-error/);
  });
});
