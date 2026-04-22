import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  ensureRelativeDotSlash,
  isAbsoluteFilesystemPath,
  isDocumentRelativeUrl,
  isExternalUrl,
  isNetworkUrl,
  isSpecialAbsoluteUrl,
  splitPathAndFragment,
  stripLeadingDotSlash,
} from '../src/utils/document-url.ts';

describe('document-url utilities', () => {
  it('detects special absolute URLs', () => {
    assert.strictEqual(isSpecialAbsoluteUrl('https://example.com/a.png'), true);
    assert.strictEqual(isSpecialAbsoluteUrl('file:///tmp/a.svg'), true);
    assert.strictEqual(isSpecialAbsoluteUrl('data:image/png;base64,xxx'), true);
    assert.strictEqual(isSpecialAbsoluteUrl('vscode-resource://abc'), true);
    assert.strictEqual(isSpecialAbsoluteUrl('mailto:foo@example.com'), true);
    assert.strictEqual(isSpecialAbsoluteUrl('./a.png'), false);
    assert.strictEqual(isSpecialAbsoluteUrl('a.png'), false);
  });

  it('detects external navigation URLs', () => {
    assert.strictEqual(isExternalUrl('https://example.com'), true);
    assert.strictEqual(isExternalUrl('mailto:foo@example.com'), true);
    assert.strictEqual(isExternalUrl('tel:+123456'), true);

    assert.strictEqual(isExternalUrl('data:image/png;base64,xxx'), false);
    assert.strictEqual(isExternalUrl('blob:https://example.com/x'), false);
    assert.strictEqual(isExternalUrl('file:///tmp/a.md'), false);
    assert.strictEqual(isExternalUrl('vscode-resource://abc'), false);
  });

  it('detects network URLs', () => {
    assert.strictEqual(isNetworkUrl('http://example.com/a.png'), true);
    assert.strictEqual(isNetworkUrl('https://example.com/a.png'), true);
    assert.strictEqual(isNetworkUrl('//cdn.example.com/a.png'), true);

    assert.strictEqual(isNetworkUrl('file:///tmp/a.png'), false);
    assert.strictEqual(isNetworkUrl('./a.png'), false);
    assert.strictEqual(isNetworkUrl('a.png'), false);
  });

  it('detects document-relative URLs', () => {
    assert.strictEqual(isDocumentRelativeUrl('a.png'), true);
    assert.strictEqual(isDocumentRelativeUrl('./a.png'), true);
    assert.strictEqual(isDocumentRelativeUrl('../a.png'), true);
    assert.strictEqual(isDocumentRelativeUrl('/a.png'), true);

    assert.strictEqual(isDocumentRelativeUrl('#frag'), false);
    assert.strictEqual(isDocumentRelativeUrl('?q=1'), false);
    assert.strictEqual(isDocumentRelativeUrl('https://example.com/a.png'), false);
    assert.strictEqual(isDocumentRelativeUrl('data:image/png;base64,xxx'), false);
  });

  it('normalizes relative dot slash', () => {
    assert.strictEqual(ensureRelativeDotSlash('a.png'), './a.png');
    assert.strictEqual(ensureRelativeDotSlash('./a.png'), './a.png');
    assert.strictEqual(ensureRelativeDotSlash('../a.png'), '../a.png');
    assert.strictEqual(ensureRelativeDotSlash('/a.png'), '/a.png');
    assert.strictEqual(ensureRelativeDotSlash('https://example.com/a.png'), 'https://example.com/a.png');
  });

  it('strips leading dot slash', () => {
    assert.strictEqual(stripLeadingDotSlash('./a.png'), 'a.png');
    assert.strictEqual(stripLeadingDotSlash('a.png'), 'a.png');
    assert.strictEqual(stripLeadingDotSlash('../a.png'), '../a.png');
  });

  it('splits path and fragment', () => {
    assert.deepStrictEqual(splitPathAndFragment('./a.md#intro'), { path: './a.md', fragment: 'intro' });
    assert.deepStrictEqual(splitPathAndFragment('./a.md'), { path: './a.md' });
    assert.deepStrictEqual(splitPathAndFragment('#intro'), { path: '', fragment: 'intro' });
  });

  it('detects absolute filesystem paths', () => {
    assert.strictEqual(isAbsoluteFilesystemPath('/Users/me/a.md'), true);
    assert.strictEqual(isAbsoluteFilesystemPath('C:\\repo\\a.md'), true);
    assert.strictEqual(isAbsoluteFilesystemPath('file:///tmp/a.md'), true);
    assert.strictEqual(isAbsoluteFilesystemPath('./a.md'), false);
    assert.strictEqual(isAbsoluteFilesystemPath('a.md'), false);
  });
});
