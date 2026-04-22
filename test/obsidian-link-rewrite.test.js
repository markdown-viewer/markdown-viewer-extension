import { describe, it } from 'node:test';
import assert from 'node:assert';

import { rewriteObsidianLinks } from '../src/utils/obsidian-link-rewrite.ts';

describe('rewriteObsidianLinks', () => {
  it('rewrites basic wikilinks', () => {
    const input = 'See [[test]] and [[folder/note]].';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, 'See [test](./test.md) and [note](./folder/note.md).');
  });

  it('rewrites wikilinks with alias', () => {
    const input = 'Open [[test|Test File]].';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, 'Open [Test File](./test.md).');
  });

  it('rewrites heading and block fragments', () => {
    const input = '[[test#Task List]] and [[test#^abc123]]';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, '[test#Task List](./test.md#task-list) and [test#^abc123](./test.md#^abc123)');
  });

  it('rewrites local block references without showing hash syntax', () => {
    const input = 'Jump to [[#^local-block-id]].';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, 'Jump to [^local-block-id](#^local-block-id).');
  });

  it('rewrites local heading links', () => {
    const input = 'Jump to [[#Local Heading Example]].';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, 'Jump to [Local Heading Example](#local-heading-example).');
  });

  it('rewrites image embeds and strips options', () => {
    const input = '![[assets/diagram.svg|320]]';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, '![](./assets/diagram.svg)');
  });

  it('rewrites non-image embeds to links', () => {
    const input = '![[test]]';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, '[test](./test.md)');
  });

  it('does not rewrite fenced code blocks and inline code spans', () => {
    const input = '```md\n[[test]]\n![[a.svg]]\n```\n\n`[[test]]` and [[test]]';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, '```md\n[[test]]\n![[a.svg]]\n```\n\n`[[test]]` and [test](./test.md)');
  });

  it('wraps destination with spaces in angle brackets', () => {
    const input = '[[assets/my note]]';
    const output = rewriteObsidianLinks(input);

    assert.strictEqual(output, '[my note](<./assets/my note.md>)');
  });
});
