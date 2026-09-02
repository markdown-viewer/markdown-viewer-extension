/**
 * EPUB export contract tests — run the REAL single-document EPUB export
 * pipeline in the headless browser, unpack the produced .epub and verify
 * the three reported issues end-to-end:
 *
 * 1. Body font stack must match Web (cross-platform CJK fallbacks).
 * 2. Line-height rule must be present (readers that respect CSS get 1.5).
 * 3. Diagram centering rule (.diagram-block margin) and the content-root
 *    diagram-layout class must be present.
 *
 * Uses demo/test.md — the same document the user exports.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import JSZip from 'jszip';

import { createBrowserRenderHarness, type BrowserRenderHarness } from '../../helpers/browser-render-harness.ts';

const TEST_DOC = path.resolve('demo/test.md');

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
  timeoutMs: 180_000,
} as const;

interface UnpackedEpub {
  styles: string;
  chapters: string[];
}

async function unpackEpub(base64: string): Promise<UnpackedEpub> {
  const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
  const styles = await zip.file('OEBPS/style.css')?.async('string');
  assert.ok(typeof styles === 'string', 'EPUB must contain OEBPS/style.css');
  const chapters = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^OEBPS\/\d+-.*\.xhtml$/.test(name))
      .map(async (name) => zip.files[name].async('string')),
  );
  assert.ok(chapters.length > 0, 'EPUB must contain at least one chapter');
  return { styles, chapters };
}

describe('EPUB export contract (real pipeline)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: TEST_DOC });
  });

  after(async () => {
    await harness.dispose();
  });

  it('produces an EPUB whose stylesheet carries the diagram centering rule', async () => {
    const { base64 } = await harness.renderEpub(TEST_DOC, FIXED_PARAMS);
    const { styles } = await unpackEpub(base64);

    // The shared content CSS (styles.css) centers .diagram-block with auto margins.
    assert.ok(
      /#markdown-content \.diagram-block[^{]*\{[^}]*margin\s*:\s*20px\s+auto/i.test(styles)
        || /#markdown-content \.diagram-block[^{]*\{[^}]*margin[^}]*auto/i.test(styles),
      'EPUB stylesheet must contain the diagram centering rule (margin auto)'
    );
  });

  it('produces an EPUB whose chapter root carries diagram-layout-center', async () => {
    const { base64 } = await harness.renderEpub(TEST_DOC, FIXED_PARAMS);
    const { chapters } = await unpackEpub(base64);
    for (const chapter of chapters) {
      const root = chapter.match(/id="markdown-content"[^>]*class="([^"]*)"/);
      assert.ok(root, 'Chapter must contain #markdown-content with a class');
      assert.ok(
        root[1].includes('diagram-layout-center'),
        `Chapter root must carry diagram-layout-center (got "${root[1]}")`
      );
    }
  });

  it('produces an EPUB whose stylesheet carries the Web body font stack (CJK fallbacks)', async () => {
    const { base64 } = await harness.renderEpub(TEST_DOC, FIXED_PARAMS);
    const { styles } = await unpackEpub(base64);

    assert.ok(styles.includes('PingFang SC'), 'Font stack must include PingFang SC');
    assert.ok(styles.includes('Noto Sans CJK SC'), 'Font stack must include Noto Sans CJK SC');
    assert.ok(styles.includes('Microsoft YaHei'), 'Font stack must include Microsoft YaHei');
    assert.ok(
      /#markdown-content[^{]*\{[^}]*font-family:[^}]*FangSong/i.test(styles),
      'Font stack must keep FangSong as the primary font'
    );
  });

  it('produces an EPUB whose stylesheet carries the line-height rule', async () => {
    const { base64 } = await harness.renderEpub(TEST_DOC, FIXED_PARAMS);
    const { styles } = await unpackEpub(base64);

    assert.ok(
      /#markdown-content[^{]*\{[^}]*line-height:\s*1\.5/i.test(styles),
      'EPUB stylesheet must carry the Web line-height (1.5)'
    );
  });

  it('produces an EPUB whose stylesheet has no exporter-specific layout appendix', async () => {
    const { base64 } = await harness.renderEpub(TEST_DOC, FIXED_PARAMS);
    const { styles } = await unpackEpub(base64);

    // The content root is pure content (shared CSS); the exporter must not
    // append its own override block on top of the collected stylesheet.
    assert.ok(
      !styles.includes('EPUB layout overrides'),
      'EPUB stylesheet must not carry an exporter layout appendix'
    );
    assert.ok(
      !styles.includes('max-width: none !important'),
      'EPUB stylesheet must not override the content root max-width'
    );
  });

  it('single-file EPUB opens directly on the content (nav stays non-linear)', async () => {
    const { base64 } = await harness.renderEpub(TEST_DOC, FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const opf = await zip.files['OEBPS/content.opf'].async('string');

    const spine = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/)?.[1] || '';
    const itemrefs = Array.from(spine.matchAll(/<itemref[^>]*>/g)).map((m) => m[0]);
    assert.ok(itemrefs.length >= 1, 'spine must list at least the chapter');

    // A single-file book must not force a TOC page in front of the content:
    // the nav is non-linear, so readers skip it and open on the chapter.
    const navRef = itemrefs.find((r) => r.includes('idref="nav"'));
    assert.ok(navRef, 'nav must stay in the spine (EPUB spec requirement)');
    assert.ok(
      navRef.includes('linear="no"'),
      'single-file nav must be non-linear so readers open directly on the content'
    );
    const firstLinear = itemrefs.find((r) => !r.includes('linear="no"'));
    assert.ok(firstLinear, 'spine must contain at least one linear item');
    assert.ok(
      !firstLinear.includes('nav'),
      `first linear spine item must be the chapter, not the nav (got "${firstLinear}")`
    );
  });

  it('chapter content root uses the canonical <div> tag', async () => {
    const { base64 } = await harness.renderEpub(TEST_DOC, FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const chapterName = Object.keys(zip.files).find((n) => /^OEBPS\/\d+-.*\.xhtml$/.test(n));
    assert.ok(chapterName, 'EPUB must contain a chapter');
    const chapter = await zip.files[chapterName].async('string');

    // The content root tag must be the canonical <div> in every pipeline
    // (the CLI renderer page used <main>, the webview used <div>, and the
    // EPUB chapter keeps the serialized tag — a per-pipeline tag drift).
    assert.ok(
      /<div\b[^>]*id="markdown-content"/.test(chapter),
      'chapter content root must be a <div id="markdown-content">'
    );
  });
});
