/**
 * EPUB stylesheet contract tests.
 *
 * The EPUB stylesheet must be the RAW collected content CSS (same source as
 * Web / HTML / PDF) with embedded fonts — the exporter must NOT rewrite,
 * downgrade or special-case it for EPUB. Phase 1 of the style architecture
 * refactor removed :is() / color-mix() / each-line / fit-content from the
 * shared content CSS, so this contract is enforceable end-to-end.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import { createBrowserRenderHarness, type BrowserRenderHarness } from '../../helpers/browser-render-harness.ts';

const BODY_TEXT_FIXTURE = path.resolve('test/fixtures/layout/body-text.md');

describe('EPUB stylesheet contract (shared content CSS, no rewriting)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: BODY_TEXT_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  it('does not contain any modern-CSS syntax that EPUB readers reject', async () => {
    const css = await harness.collectEpubCss(BODY_TEXT_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 120_000,
    });
    assert.ok(!css.includes(':is('), 'EPUB CSS must not contain :is()');
    assert.ok(!css.includes('color-mix('), 'EPUB CSS must not contain color-mix()');
    assert.ok(!css.includes('each-line'), 'EPUB CSS must not contain each-line');
    assert.ok(!css.includes('fit-content'), 'EPUB CSS must not contain fit-content');
  });

  it('carries the shared content-root rules from the theme', async () => {
    const css = await harness.collectEpubCss(BODY_TEXT_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 120_000,
    });
    assert.ok(css.includes('#markdown-content p'), 'Body paragraph rule should be present');
    assert.ok(css.includes('.markdown-viewer-content'), 'Alternate content root should be present');
    assert.ok(/--md-accent-bg:\s*#[0-9a-f]{6};/.test(css), 'Accent background should be a concrete hex color');
  });

  it('keeps @font-face rules for offline fonts', async () => {
    const css = await harness.collectEpubCss(BODY_TEXT_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 120_000,
    });
    assert.ok(css.includes('@font-face'), 'KaTeX @font-face rules should be preserved for EPUB');
  });

  it('does not leak environment media rules (@media print / responsive widths)', async () => {
    const css = await harness.collectEpubCss(BODY_TEXT_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 120_000,
    });
    assert.ok(!css.includes('@media print'), 'EPUB CSS must not contain @media print (print paging rules)');
    assert.ok(
      !/@media[^{]*\((?:min|max)-width/.test(css),
      'EPUB CSS must not contain responsive width media queries (unknown reader viewport)',
    );
  });

  it('carries content media sizing rules from the shared CSS, not the EPUB layout appendix', async () => {
    const css = await harness.collectEpubCss(BODY_TEXT_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 120_000,
    });

    // Shared CSS (styles.css) must be the only source of content sizing:
    //  - svg max-width comes from the shared rule (no !important),
    //  - .diagram-block max-width comes from the shared rule (no !important),
    //  - img already has its shared max-width rule,
    //  - the EPUB-only merged `img, svg { ... !important }` appendix rule is gone.
    assert.ok(
      /#markdown-content svg\s*\{[^}]*max-width\s*:\s*100%[^}]*\}/.test(css)
        && !/#markdown-content svg\s*\{[^}]*!important/.test(css),
      'svg max-width must come from the shared CSS rule (no !important)',
    );
    assert.ok(
      /#markdown-content \.diagram-block[^{]*\{[^}]*max-width\s*:\s*100%[^}]*\}/.test(css)
        && !/#markdown-content \.diagram-block[^{]*\{[^}]*!important/.test(css),
      '.diagram-block max-width must come from the shared CSS rule (no !important)',
    );
    assert.ok(
      /#markdown-content img\s*\{[^}]*max-width\s*:\s*100%[^}]*height\s*:\s*auto/.test(css),
      'img must keep its shared max-width/height-auto rule',
    );
    assert.ok(
      !css.includes('#markdown-content img, #markdown-content svg'),
      'EPUB appendix must not re-declare the merged img/svg !important rule',
    );
    assert.ok(
      !css.includes('overflow: visible !important'),
      'EPUB appendix must not carry the defensive .diagram-block overflow rule',
    );
  });

  it('does not append any EPUB-specific layout overrides to the content root', async () => {
    const css = await harness.collectEpubCss(BODY_TEXT_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 120_000,
    });

    // The content root is pure content in the shared CSS (page chrome lives on
    // #markdown-page), so EPUB must NOT append an override block at all.
    assert.ok(
      !css.includes('max-width: none !important'),
      'EPUB must not append the content-root chrome override (max-width: none !important)',
    );
    assert.ok(
      !css.includes('box-shadow: none !important'),
      'EPUB must not append the content-root chrome override (box-shadow: none !important)',
    );
    assert.ok(
      !css.includes('EPUB layout overrides'),
      'EPUB stylesheet must not carry an exporter-specific layout appendix',
    );
  });

  it('layout rules cover both content-root selectors (dual root)', async () => {
    const css = await harness.collectEpubCss(BODY_TEXT_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableMergeEmpty: false,
      tableLayout: 'center',
      imageLayout: 'center',
      diagramLayout: 'center',
      timeoutMs: 120_000,
    });

    // Hosts that render into a child `.markdown-viewer-content` (GitBook
    // embed, custom elements) must hit the same layout rules as hosts that
    // render directly into `#markdown-content` — a single content-root
    // contract for the layout classes.
    assert.ok(
      css.includes('.markdown-viewer-content.image-layout-center p > img:only-child'),
      'image-layout-center must cover the alternate content root',
    );
    assert.ok(
      css.includes('.markdown-viewer-content.image-layout-left p > img:only-child'),
      'image-layout-left must cover the alternate content root',
    );
    assert.ok(
      css.includes('.markdown-viewer-content.diagram-layout-left .diagram-block'),
      'diagram-layout-left must cover the alternate content root',
    );
    assert.ok(
      css.includes('#markdown-content .markdown-viewer-content.diagram-layout-left .diagram-block'),
      'diagram-layout-left must cover the nested child content root (specificity guard)',
    );
    assert.ok(
      css.includes('#markdown-content .markdown-viewer-content.table-layout-left table'),
      'table-layout-left must cover the nested child content root (specificity guard)',
    );
  });
});
