/**
 * Whole-book chapter DOM contract tests.
 *
 * Renders a book through the REAL print renderer (renderBookForPrint — the
 * same pipeline the whole-book PDF/EPUB export uses) and asserts the
 * canonical chapter wrapper contract on every chapter:
 *
 *   .book-chapter > #markdown-content.markdown-viewer-content + layout classes
 *
 * The content root tag must be the canonical <div> and the layout classes
 * must live on the content root (single layer, matching the single-document
 * contract).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import JSZip from 'jszip';

import {
  createBrowserRenderHarness,
  type BookTocEntryInput,
  type BrowserRenderHarness,
} from './helpers/browser-render-harness.ts';

const BOOK_DIR = path.resolve('test/fixtures/book');

const PAGES = [
  { href: 'chapter1.md', title: 'Chapter One' },
  { href: 'chapter2.md', title: 'Chapter Two' },
] as const;

const GROUPED_TOC: BookTocEntryInput[] = [
  { type: 'heading', title: 'Guide', depth: 0 },
  { type: 'page', href: 'chapter1.md', title: 'Chapter One', depth: 1 },
  { type: 'heading', title: 'Reference', depth: 0 },
  { type: 'page', href: 'chapter2.md', title: 'Chapter Two', depth: 1 },
];

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
  inputPath: path.join(BOOK_DIR, 'chapter1.md'),
  timeoutMs: 180_000,
} as const;

describe('whole-book chapter DOM contract (book renderer)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(BOOK_DIR, 'chapter1.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  it('renders every page as a canonical chapter wrapper', async () => {
    const dom = await harness.renderBookDom([...PAGES], FIXED_PARAMS);
    assert.equal(dom.chapters.length, 2, 'book must render one chapter per page');

    for (const chapter of dom.chapters) {
      assert.ok(
        /^<div\b[^>]*id="markdown-content"/.test(chapter.html.trim()),
        'chapter content root must be a <div id="markdown-content">',
      );
      assert.ok(
        chapter.html.includes('markdown-viewer-content'),
        'chapter content root must carry .markdown-viewer-content',
      );
      assert.ok(
        chapter.html.includes('table-layout-center image-layout-center diagram-layout-center'),
        'chapter content root must carry the layout classes (single layer)',
      );
      assert.ok(
        /<h1[^>]*>/.test(chapter.html),
        'chapter content must render (h1 present)',
      );
    }
  });

  it('renders distinct content per chapter (no cross-page bleed)', async () => {
    const dom = await harness.renderBookDom([...PAGES], FIXED_PARAMS);
    const [first, second] = dom.chapters;
    assert.ok(first.html.includes('Chapter One'), 'first chapter keeps its own content');
    assert.ok(second.html.includes('Chapter Two'), 'second chapter keeps its own content');
    assert.ok(!first.html.includes('Chapter Two'), 'no cross-page bleed into the first chapter');
  });

  it('threads the layout parameters into every chapter', async () => {
    const dom = await harness.renderBookDom([...PAGES], {
      ...FIXED_PARAMS,
      tableLayout: 'left',
      imageLayout: 'left',
      diagramLayout: 'left',
    });
    for (const chapter of dom.chapters) {
      assert.ok(
        chapter.html.includes('table-layout-left image-layout-left diagram-layout-left'),
        'chapter content root must carry the requested layout classes',
      );
    }
  });
});

describe('whole-book EPUB contract (real pipeline)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(BOOK_DIR, 'chapter1.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  it('packages every page as a canonical chapter', async () => {
    const { base64 } = await harness.renderBookEpub([...PAGES], FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));

    const chapterNames = Object.keys(zip.files)
      .filter((n) => /^OEBPS\/\d+-.*\.xhtml$/.test(n))
      .sort();
    assert.equal(chapterNames.length, 2, 'whole-book EPUB must contain one chapter per page');

    for (const name of chapterNames) {
      const chapter = await zip.files[name].async('string');
      assert.ok(
        /<div\b[^>]*id="markdown-content"/.test(chapter),
        `${name} content root must be a <div id="markdown-content">`,
      );
      assert.ok(
        chapter.includes('markdown-viewer-content'),
        `${name} content root must carry .markdown-viewer-content`,
      );
      assert.ok(
        chapter.includes('table-layout-center image-layout-center diagram-layout-center'),
        `${name} content root must carry the layout classes`,
      );
    }
  });

  it('keeps the linear TOC first (whole-book navigation)', async () => {
    const { base64 } = await harness.renderBookEpub([...PAGES], FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const opf = await zip.files['OEBPS/content.opf'].async('string');

    const spine = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/)?.[1] || '';
    const itemrefs = Array.from(spine.matchAll(/<itemref[^>]*>/g)).map((m) => m[0]);
    assert.ok(
      itemrefs[0].includes('idref="nav"') && itemrefs[0].includes('linear="yes"'),
      'whole-book spine must open with the linear nav (TOC page)',
    );
    assert.equal(
      itemrefs.filter((r) => r.includes('idref="chapter-')).length,
      2,
      'spine must list every chapter',
    );

    const nav = await zip.files['OEBPS/nav.xhtml'].async('string');
    for (const page of PAGES) {
      assert.ok(nav.includes(page.title), `nav must list "${page.title}"`);
    }
  });

  it('groups the EPUB nav under summary headings', async () => {
    const { base64 } = await harness.renderBookEpub([...PAGES], {
      ...FIXED_PARAMS,
      tocEntries: GROUPED_TOC,
    });
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const nav = await zip.files['OEBPS/nav.xhtml'].async('string');
    const ncx = await zip.files['OEBPS/toc.ncx'].async('string');

    assert.match(nav, /<span>Guide<\/span>[\s\S]*<a href="00-Chapter-One.xhtml">Chapter One<\/a>/);
    assert.match(nav, /<span>Reference<\/span>[\s\S]*<a href="01-Chapter-Two.xhtml">Chapter Two<\/a>/);
    assert.match(ncx, /<navLabel><text>Guide<\/text><\/navLabel>[\s\S]*<content src="00-Chapter-One.xhtml"\/>/);
  });

  it('carries the shared stylesheet in the whole-book EPUB', async () => {
    const { base64 } = await harness.renderBookEpub([...PAGES], FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const styles = await zip.files['OEBPS/style.css'].async('string');

    assert.ok(
      /#markdown-content \.diagram-block[^{]*\{[^}]*margin\s*:\s*20px\s+auto/.test(styles),
      'whole-book stylesheet must carry the diagram centering rule',
    );
    assert.ok(styles.includes('@font-face'), 'whole-book stylesheet must embed fonts');
  });

  it('exports a whole-book DOCX with every chapter merged', async () => {
    const { base64, filename } = await harness.renderBookDocx([...PAGES], FIXED_PARAMS);
    assert.ok(filename.endsWith('.docx'), `filename must be a .docx (got "${filename}")`);

    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    assert.ok(zip.files['word/document.xml'], 'DOCX must contain document.xml');
    const documentXml = await zip.files['word/document.xml'].async('string');
    assert.ok(
      documentXml.includes('Chapter One') && documentXml.includes('Chapter Two'),
      'merged document must carry both chapters',
    );
    assert.ok(
      documentXml.includes('Second chapter body'),
      'merged document must carry the second chapter content',
    );
  });

  it('exports DOCX TOC structure with summary group headings', async () => {
    const { base64 } = await harness.renderBookDocx([...PAGES], {
      ...FIXED_PARAMS,
      tocEntries: GROUPED_TOC,
    });
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const documentXml = await zip.files['word/document.xml'].async('string');

    assert.match(documentXml, /Guide[\s\S]*Chapter One/, 'DOCX must include the first summary group heading before its chapter');
    assert.match(documentXml, /Reference[\s\S]*Chapter Two/, 'DOCX must include the second summary group heading before its chapter');
  });
});

/**
 * Whole-book EPUB image embedding (nested chapter directories).
 *
 * Chapters live in subdirectories (`chapters/reference/...`) and reference
 * images with `../../assets/...` relative paths. Every image must be embedded
 * into the EPUB (data: URL or packaged `images/` file) — leaving absolute
 * `file://` or `../` references produces an EPUB whose images cannot display
 * in any reader. Regression guard for the CLI book export path where page
 * hrefs were resolved without a base URL and the EPUB export never received a
 * document service, so chapter images stayed as external references.
 */
describe('whole-book EPUB image embedding (nested chapters)', () => {
  const NESTED_DIR = path.resolve('test/fixtures/book-nested');
  const NESTED_PAGES = [
    { href: 'chapters/reference/06-identity.md', title: '06 证书' },
  ] as const;

  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: path.join(NESTED_DIR, 'SUMMARY.md') });
  });

  after(async () => {
    await harness.dispose();
  });

  it('embeds every chapter image (no file:// or ../ references survive)', async () => {
    const { base64 } = await harness.renderBookEpub([...NESTED_PAGES], {
      ...FIXED_PARAMS,
      inputPath: path.join(NESTED_DIR, 'SUMMARY.md'),
    });
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const files = Object.keys(zip.files);
    const chapterNames = files
      .filter((n) => /^OEBPS\/\d+-.*\.xhtml$/.test(n))
      .sort();
    assert.ok(chapterNames.length >= 1, 'whole-book EPUB must contain the nested chapter');

    const packagedImages = files.filter((n) => /^OEBPS\/images\//.test(n));
    let imageRefCount = 0;
    let externalRefs = 0;
    let packagedRefs = 0;

    for (const name of chapterNames) {
      const chapter = await zip.files[name].async('string');
      const srcs = Array.from(chapter.matchAll(/<img\b[^>]*\bsrc=(["'])(.*?)\1/g)).map((m) => m[2]);
      for (const src of srcs) {
        imageRefCount += 1;
        if (src.startsWith('data:') || src.startsWith('images/')) {
          packagedRefs += 1;
        } else {
          externalRefs += 1;
        }
      }
    }

    assert.equal(
      externalRefs,
      0,
      `chapter images must not reference external file:// or relative paths (${externalRefs} leaked: check src attributes)`,
    );
    assert.equal(
      packagedRefs,
      imageRefCount,
      'every chapter image must be embedded as a packaged/data reference',
    );
    assert.ok(
      packagedImages.length >= 2,
      `EPUB must package the referenced images (got ${packagedImages.length}: ${packagedImages.join(', ')})`,
    );
  });

  it('embeds images whose filenames contain non-ASCII characters', async () => {
    const { base64 } = await harness.renderBookEpub([...NESTED_PAGES], {
      ...FIXED_PARAMS,
      inputPath: path.join(NESTED_DIR, 'SUMMARY.md'),
    });
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const files = Object.keys(zip.files);
    const chapterNames = files.filter((n) => /^OEBPS\/\d+-.*\.xhtml$/.test(n));

    const chapter = await zip.files[chapterNames[0]].async('string');
    const srcs = Array.from(chapter.matchAll(/<img\b[^>]*\bsrc=(["'])(.*?)\1/g)).map((m) => m[2]);
    assert.ok(srcs.length >= 2, 'nested chapter must reference its two images');
    for (const src of srcs) {
      assert.ok(
        src.startsWith('data:') || src.startsWith('images/'),
        `non-ASCII image must be embedded (got "${src.slice(0, 80)}")`,
      );
    }
    assert.ok(
      files.some((n) => /^OEBPS\/images\//.test(n)),
      'EPUB must contain packaged image files',
    );
  });
});
