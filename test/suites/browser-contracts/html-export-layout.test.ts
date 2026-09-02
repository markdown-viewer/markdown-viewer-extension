/**
 * HTML export layout contract tests.
 *
 * The exported standalone HTML must render with the SAME layout semantics as
 * the live viewer — the exporter must not re-state or override the shared
 * layout rules (single CSS source). Each assertion mirrors the corresponding
 * Web-preview baseline assertion in browser-baseline.test.ts.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
  type BrowserLayoutMeasurement,
} from '../../helpers/browser-render-harness.ts';

const LAYOUT_DIR = path.resolve('test/fixtures/layout');

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  timeoutMs: 120_000,
} as const;

const CENTER = { tableLayout: 'center', imageLayout: 'center', diagramLayout: 'center' } as const;

function px(value: string): number {
  return parseFloat(value);
}

function firstOf(measurements: BrowserLayoutMeasurement[], selector: string) {
  const item = measurements.find((m) => m.selector === selector);
  assert.ok(item, `No measurement for selector "${selector}"`);
  assert.ok(item.elements.length > 0, `Selector "${selector}" matched no elements`);
  return item.elements[0];
}

describe('HTML export layout contract (single CSS source)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(LAYOUT_DIR, 'image-center.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  it('centers images in exported HTML like the live viewer', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'image-center.md'),
      ['#markdown-content img'],
      { ...FIXED_PARAMS, ...CENTER },
    );
    const img = firstOf(m, '#markdown-content img');
    assert.equal(img.display, 'block');
    assert.equal(img.marginLeft, img.marginRight, 'Exported centered image needs symmetric margins');
    assert.ok(px(img.marginLeft) > 0);
  });

  it('left-aligns images in exported HTML like the live viewer', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'image-left.md'),
      ['#markdown-content img'],
      { ...FIXED_PARAMS, ...CENTER, imageLayout: 'left' },
    );
    const img = firstOf(m, '#markdown-content img');
    assert.equal(img.display, 'block', 'Exported left image should be block-level like the viewer');
    assert.equal(img.marginLeft, '0px');
  });

  it('centers tables in exported HTML like the live viewer', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'table-center.md'),
      ['#markdown-content table'],
      { ...FIXED_PARAMS, ...CENTER },
    );
    const table = firstOf(m, '#markdown-content table');
    assert.ok(Math.abs(px(table.marginLeft) - px(table.marginRight)) < 1,
      'Exported centered table needs symmetric margins');
    assert.ok(px(table.marginLeft) > 0);
  });

  it('left-aligns tables in exported HTML like the live viewer', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'table-left.md'),
      ['#markdown-content table'],
      { ...FIXED_PARAMS, ...CENTER, tableLayout: 'left' },
    );
    const table = firstOf(m, '#markdown-content table');
    assert.equal(table.marginLeft, '0px');
  });

  it('stretches full-width tables in exported HTML like the live viewer', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'table-full.md'),
      ['#markdown-content table'],
      { ...FIXED_PARAMS, ...CENTER, tableLayout: 'center-full-width' },
    );
    const table = firstOf(m, '#markdown-content table');
    assert.equal(table.display, 'table');
    assert.ok(table.width > 800, `Exported full-width table should span the content width (${table.width}px)`);
  });

  it('centers diagrams in exported HTML like the live viewer', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'diagram-center.md'),
      ['.diagram-block'],
      { ...FIXED_PARAMS, ...CENTER },
    );
    const block = firstOf(m, '.diagram-block');
    assert.equal(block.marginLeft, block.marginRight);
    assert.ok(px(block.marginLeft) > 0);
  });

  it('left-aligns diagrams in exported HTML like the live viewer', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'diagram-left.md'),
      ['.diagram-block'],
      { ...FIXED_PARAMS, ...CENTER, diagramLayout: 'left' },
    );
    const block = firstOf(m, '.diagram-block');
    assert.equal(block.marginLeft, '0px');
    assert.equal(block.textAlign, 'left');
  });

  it('embeds only content CSS — no environment media rules (@media print / widths)', async () => {
    const html = await harness.renderHtml(path.join(LAYOUT_DIR, 'body-text.md'), {
      ...FIXED_PARAMS,
      ...CENTER,
    });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(styleMatch, 'Exported HTML must embed a <style> block');
    const styles = styleMatch[1];
    assert.ok(!styles.includes('@media print'), 'Exported HTML must not contain @media print');
    assert.ok(
      !/@media[^{]*\((?:min|max)-width/.test(styles),
      'Exported HTML must not contain responsive width media queries',
    );
  });

  it('exports the content root without exporter-side chrome overrides', async () => {
    const html = await harness.renderHtml(path.join(LAYOUT_DIR, 'body-text.md'), {
      ...FIXED_PARAMS,
      ...CENTER,
    });
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(styleMatch, 'Exported HTML must embed a <style> block');
    const styles = styleMatch[1];

    // Content-root chrome (padding/shadow) lives in the shared CSS on
    // #markdown-page. The exporter must not re-state or override it.
    assert.ok(
      !/#markdown-content\s*\{[^}]*padding\s*:\s*40px\s*!important/.test(styles),
      'Exporter must not re-declare the content-root padding override',
    );
    assert.ok(
      !/#markdown-content\s*\{[^}]*box-shadow[^}]*!important/.test(styles),
      'Exporter must not re-declare the content-root shadow override',
    );
    assert.ok(
      !/#markdown-page\s*\{[^}]*padding\s*:\s*0\s*!important/.test(styles),
      'Exporter must not zero out the shared #markdown-page padding',
    );
  });

  it('renders the shared content-root chrome: page carries the card, content root is pure', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'body-text.md'),
      ['#markdown-page', '#markdown-content'],
      { ...FIXED_PARAMS, ...CENTER },
    );
    const page = firstOf(m, '#markdown-page');
    const content = firstOf(m, '#markdown-content');
    assert.equal(content.paddingTop, '0px', 'Content root must be pure content (no padding)');
    assert.equal(
      page.paddingTop,
      '20px',
      'Page container must carry a modest card gutter (20px, matching the panel layouts)',
    );
  });

  it('preserves the live content-root state in the exported HTML', async () => {
    const html = await harness.renderHtml(path.join(LAYOUT_DIR, 'image-center.md'), {
      ...FIXED_PARAMS,
      ...CENTER,
    });
    const rootTag = html.match(/<div\b[^>]*id="markdown-content"[^>]*>/);
    assert.ok(rootTag, 'Exported HTML must contain the content root');
    assert.ok(
      rootTag[0].includes('table-layout-center'),
      'Exported content root must keep the live table-layout class',
    );
    assert.ok(
      rootTag[0].includes('image-layout-center'),
      'Exported content root must keep the live image-layout class',
    );
    assert.ok(
      rootTag[0].includes('diagram-layout-center'),
      'Exported content root must keep the live diagram-layout class',
    );
  });

  it('preserves authored img width/alt through the SVG takeover', async () => {
    const html = await harness.renderHtml(path.join(LAYOUT_DIR, 'image-width.md'), {
      ...FIXED_PARAMS,
      ...CENTER,
    });
    const badge = html.match(/<img\b[^>]*>/g)?.find((tag) => tag.includes('data:image/png'));
    assert.ok(badge, 'Taken-over SVG image must be replaced with a rendered PNG');
    assert.match(badge, /width="24"/, 'Authored width="24" attribute must survive the takeover');
    assert.match(badge, /alt="docu\.md"/, 'Authored alt text must survive the takeover');
    assert.match(badge, /class="diagram-inline"/, 'Badge image stays inline');
    assert.ok(
      !/width="18"/.test(badge),
      'Natural SVG width must not override the authored width attribute',
    );
  });

  it('lays out a taken-over image at its authored width', async () => {
    const m = await harness.measureHtmlLayout(
      path.join(LAYOUT_DIR, 'image-width.md'),
      ['#markdown-content img'],
      { ...FIXED_PARAMS, ...CENTER },
    );
    const badge = firstOf(m, '#markdown-content img');
    assert.equal(badge.width, 24, 'Authored width="24" must win over the natural SVG size');
    assert.equal(badge.display, 'inline', 'Badge image must stay inline like the source markup');
  });

  it('reports plugin render failures as concise warnings with the source line', async () => {
    const before = harness.consoleMessages().length;
    await harness.renderHtml(path.join(LAYOUT_DIR, 'invalid-mermaid.md'), {
      ...FIXED_PARAMS,
      ...CENTER,
    });
    const messages = harness.consoleMessages().slice(before);
    const pluginWarnings = messages.filter((m) => m.text.includes('PluginTask'));
    assert.ok(pluginWarnings.length >= 1, 'a failed diagram must be reported to the console');
    for (const message of pluginWarnings) {
      assert.equal(message.type, 'warning', 'plugin render failures must be warnings, not errors');
      assert.match(message.text, /mermaid/, 'the warning must name the diagram type');
      assert.match(message.text, /line 3/, 'the warning must name the real document line (not the block-relative line)');
      assert.ok(
        !/at detectType|at [A-Za-z]/.test(message.text),
        'the warning must not include a stack trace',
      );
    }
  });

  it('defines the embedded/panel modes once in the shared CSS (mv-embed)', () => {
    // <markdown-viewer> elements, the iframe embed and editor panels all opt
    // into the shared .mv-embed (and .mv-panel) layout — platforms must not
    // re-implement these rules in their own style sheets.
    const css = fs.readFileSync(path.resolve('src/ui/styles.css'), 'utf8');
    assert.match(
      css,
      /\.mv-embed #toolbar\s*\{[^}]*display:\s*none !important/s,
      'embedded mode must hide the toolbar',
    );
    assert.match(
      css,
      /\.mv-embed #markdown-page\s*\{[^}]*padding:\s*0 !important/s,
      'embedded mode must drop the card gutter',
    );
    assert.match(
      css,
      /\.mv-embed #markdown-page\s*\{[^}]*box-shadow:\s*none !important/s,
      'embedded mode must drop the card shadow',
    );
    assert.match(
      css,
      /\.mv-embed #markdown-content\s*\{[^}]*padding:\s*20px/s,
      'embedded mode must pin the content gutter to 20px',
    );
    assert.match(
      css,
      /\.mv-embed\.mv-panel #table-of-contents[^{]*\{[^}]*display:\s*none !important/s,
      'panel variant must hide the TOC',
    );
  });
});
