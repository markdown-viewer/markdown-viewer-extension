/**
 * Book exporter unit tests — page preprocessing & merged markdown assembly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  absolutizeMarkdownUrls,
  preprocessPage,
  buildMergedMarkdown,
  buildBookDocumentMarkdown,
  findFirstHeadingLevel,
  BOOK_PAGE_BREAK_MARKER,
} from '../../../src/exporters/book-exporter.ts';
import type { BookTocEntry } from '../../../src/types/book-export.ts';

const BASE = 'https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/page.md';

describe('absolutizeMarkdownUrls', () => {
  it('rewrites relative inline links and images against the page URL', () => {
    const input = [
      '![logo](./img/logo.png)',
      '[intro](intro.md)',
      '[sub](chapter/sub.md "A title")',
    ].join('\n\n');
    const output = absolutizeMarkdownUrls(input, BASE);
    assert.ok(output.includes('![logo](https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/img/logo.png)'));
    assert.ok(output.includes('[intro](https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/intro.md)'));
    assert.ok(output.includes('[sub](https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/chapter/sub.md "A title")'));
  });

  it('keeps absolute URLs, fragments, data URIs and angle-wrapped URLs untouched', () => {
    const input = [
      '[abs](https://example.com/x.png)',
      '[rel](https://example.com/y.png)',
      '[frag](#section)',
      '[data](data:image/png;base64,AAAA)',
      '[angle](<https://example.com/z.png>)',
    ].join('\n\n');
    const output = absolutizeMarkdownUrls(input, BASE);
    assert.ok(output.includes('[abs](https://example.com/x.png)'));
    assert.ok(output.includes('[rel](https://example.com/y.png)'));
    assert.ok(output.includes('[frag](#section)'));
    assert.ok(output.includes('[data](data:image/png;base64,AAAA)'));
    assert.ok(output.includes('[angle](<https://example.com/z.png>)'));
  });

  it('rewrites reference definition URLs', () => {
    const input = 'See [ref][1].\n\n[1]: ./assets/file.pdf';
    const output = absolutizeMarkdownUrls(input, BASE);
    assert.ok(output.includes('[1]: https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/assets/file.pdf'));
  });
});

describe('preprocessPage', () => {
  it('strips YAML frontmatter', () => {
    const input = '---\ntitle: Hello\nlayout: post\n---\n\nBody text.';
    const output = preprocessPage(input, BASE);
    assert.ok(!output.includes('title: Hello'));
    assert.ok(output.includes('Body text.'));
  });

  it('shifts headings so the first heading becomes H1', () => {
    const input = '## Chapter\n\n### Section\n\n#### Sub section';
    const output = preprocessPage(input, BASE);
    assert.ok(output.startsWith('# Chapter'));
    assert.ok(output.includes('\n\n## Section'));
    assert.ok(output.includes('\n\n### Sub section'));
  });

  it('adds a chapter title H1 when the page has no heading', () => {
    const output = preprocessPage('Some body text.', BASE, { chapterTitle: 'Intro' });
    assert.ok(output.startsWith('# Intro'));
    assert.ok(output.includes('Some body text.'));
  });

  it('shifts one extra level for nested book pages', () => {
    const input = '# Chapter\n\n## Section';
    const output = preprocessPage(input, BASE, { depth: 1 });
    assert.ok(output.startsWith('## Chapter'));
    assert.ok(output.includes('\n\n### Section'));
  });

  it('does not shift when the page already starts with an H1', () => {
    const input = '# Title\n\n## Section';
    const output = preprocessPage(input, BASE);
    assert.ok(output.startsWith('# Title'));
    assert.ok(output.includes('\n\n## Section'));
  });
});

describe('buildMergedMarkdown', () => {
  const pages = [
    { title: 'Intro', href: `${BASE}#intro`, depth: 0 },
    { title: 'Chapter 1', href: `${BASE}#c1`, depth: 0 },
    { title: 'Nested', href: `${BASE}#nested`, depth: 1 },
  ];

  it('joins fetched pages in order with pagebreak markers', async () => {
    const fetchPage = async (href: string): Promise<string> => {
      if (href.endsWith('#intro')) return '## Hello';
      if (href.endsWith('#c1')) return '# Chapter One';
      return '### Deep';
    };
    const result = await buildMergedMarkdown({ pages, fetchPage });
    const lines = result.markdown.split('\n');
    assert.ok(lines.includes(BOOK_PAGE_BREAK_MARKER));
    assert.strictEqual(result.skipped.length, 0);
    assert.strictEqual(result.totalPages, 3);
    // First page heading shifted to H1
    assert.ok(result.markdown.startsWith('# Hello'));
    // Chapter One stays H1
    assert.ok(result.markdown.includes('# Chapter One'));
    // Nested page first heading aligns to H2 (depth 1)
    assert.ok(result.markdown.includes('## Deep'));
  });

  it('collects failed pages and continues', async () => {
    const fetchPage = async (href: string): Promise<string> => {
      if (href.endsWith('#c1')) throw new Error('HTTP 403');
      return 'content';
    };
    const result = await buildMergedMarkdown({ pages, fetchPage });
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].href.endsWith('#c1'), true);
    assert.strictEqual(result.skipped[0].error, 'HTTP 403');
    assert.ok(result.markdown.includes('content'));
  });

  it('reports fetch progress per page', async () => {
    const progress: Array<[string, number, number]> = [];
    const fetchPage = async (href: string): Promise<string> => 'x';
    await buildMergedMarkdown({
      pages,
      fetchPage,
      onProgress: (phase, done, total) => progress.push([phase, done, total]),
    });
    assert.deepStrictEqual(progress, [
      ['fetch', 1, 3],
      ['fetch', 2, 3],
      ['fetch', 3, 3],
    ]);
  });

  it('inserts summary group headings before grouped chapters', async () => {
    const navEntries: BookTocEntry[] = [
      { type: 'heading', title: 'Guide', depth: 0 },
      { type: 'page', title: 'Intro', href: `${BASE}#intro`, depth: 1 },
      { type: 'page', title: 'Install', href: `${BASE}#install`, depth: 1 },
      { type: 'heading', title: 'API', depth: 0 },
      { type: 'page', title: 'Reference', href: `${BASE}#reference`, depth: 1 },
    ];

    const result = await buildMergedMarkdown({
      pages: navEntries.filter((entry) => entry.type === 'page').map(({ href, title, depth }) => ({ href, title, depth })),
      navEntries,
      fetchPage: async (href: string): Promise<string> => {
        if (href.endsWith('#intro')) return '# Intro';
        if (href.endsWith('#install')) return '# Install';
        return '# Reference';
      },
    });

    assert.match(result.markdown, /# Guide\s+## Intro/);
    assert.match(result.markdown, /# API\s+## Reference/);
    assert.doesNotMatch(result.markdown, /# Guide\s+# Guide/);
  });

  it('aborts on an aborted signal', async () => {
    const fetchPage = async (href: string): Promise<string> => 'x';
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => buildMergedMarkdown({ pages, fetchPage, signal: aborted.signal }),
      (err: Error) => /abort/i.test(err.name || '') || /abort/i.test(err.message || '')
    );
  });
});

describe('buildBookDocumentMarkdown', () => {
  it('includes the title page heading when a title is available', () => {
    const md = buildBookDocumentMarkdown('My Book', 'chapter content');
    assert.ok(md.startsWith('# My Book\n\n[toc]'));
    assert.ok(md.includes(BOOK_PAGE_BREAK_MARKER));
    assert.ok(md.endsWith('chapter content'));
  });

  it('omits the title heading when there is no suitable title', () => {
    const md = buildBookDocumentMarkdown(null, 'chapter content');
    assert.ok(md.startsWith('[toc]'));
    assert.ok(!md.includes('# '));
    assert.ok(md.includes(BOOK_PAGE_BREAK_MARKER));
  });
});


describe('findFirstHeadingLevel', () => {
  it('returns 0 for documents without headings', () => {
    assert.strictEqual(findFirstHeadingLevel('plain text\nmore text'), 0);
  });

  it('returns the level of the first heading', () => {
    assert.strictEqual(findFirstHeadingLevel('text\n### Deep'), 3);
  });
});
