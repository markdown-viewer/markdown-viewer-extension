import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { getCurrentDocumentUrl, toMarkdownFilename } from '../src/core/document-utils.ts';

function createDocumentStub() {
  return {
    documentElement: {
      dataset: {},
    },
    location: {
      href: 'https://example.com/viewer.html#section',
    },
  };
}

describe('document-utils', () => {
  beforeEach(() => {
    globalThis.document = createDocumentStub();
  });

  it('should prefer embedded workspace file path over filename-only URL', () => {
    document.documentElement.dataset.viewerFilename = 'demo.slides.md';
    document.documentElement.dataset.viewerFilePath = 'demo/demo.slides.md';

    assert.strictEqual(getCurrentDocumentUrl(), 'file:///demo/demo.slides.md');
  });

  it('should fall back to embedded filename when full path is unavailable', () => {
    document.documentElement.dataset.viewerFilename = 'demo.slides.md';

    assert.strictEqual(getCurrentDocumentUrl(), 'file:///demo.slides.md');
  });

  it('should strip hash from real document location', () => {
    assert.strictEqual(getCurrentDocumentUrl(), 'https://example.com/viewer.html');
  });
});

describe('toMarkdownFilename', () => {
  it('should keep .md and .slides.md extensions', () => {
    assert.strictEqual(toMarkdownFilename('readme.md'), 'readme.md');
    assert.strictEqual(toMarkdownFilename('deck.slides.md'), 'deck.slides.md');
  });

  it('should normalize .markdown to .md', () => {
    assert.strictEqual(toMarkdownFilename('notes.markdown'), 'notes.md');
  });

  it('should replace non-markdown extensions with .md', () => {
    assert.strictEqual(toMarkdownFilename('page.html'), 'page.md');
    assert.strictEqual(toMarkdownFilename('notes.txt'), 'notes.md');
  });

  it('should append .md when filename has no extension', () => {
    assert.strictEqual(toMarkdownFilename('article'), 'article.md');
    assert.strictEqual(toMarkdownFilename(''), 'document.md');
  });
});