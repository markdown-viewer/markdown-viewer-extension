/**
 * EPUB exporter unit tests — pure helpers (no DOM required).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { toEpubFilename } from '../../../src/exporters/epub-utils.ts';

describe('toEpubFilename', () => {
  it('appends the .epub extension when missing', () => {
    assert.strictEqual(toEpubFilename('My Book'), 'My Book.epub');
    assert.strictEqual(toEpubFilename('book'), 'book.epub');
    assert.strictEqual(toEpubFilename(''), 'book.epub');
  });

  it('keeps an existing .epub extension (case-insensitive)', () => {
    assert.strictEqual(toEpubFilename('My Book.epub'), 'My Book.epub');
    assert.strictEqual(toEpubFilename('My Book.EPUB'), 'My Book.EPUB');
  });

  it('keeps other extensions and appends .epub', () => {
    assert.strictEqual(toEpubFilename('book.md'), 'book.md.epub');
  });
});
