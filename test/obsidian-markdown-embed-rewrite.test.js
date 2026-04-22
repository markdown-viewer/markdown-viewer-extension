import { describe, it } from 'node:test';
import assert from 'node:assert';

import { expandObsidianMarkdownEmbeds } from '../obsidian/src/host/obsidian-markdown-embed-rewrite.ts';

describe('expandObsidianMarkdownEmbeds', () => {
  it('expands full-note markdown embeds', async () => {
    const input = '# Host\n\n![[note]]\n';
    const output = await expandObsidianMarkdownEmbeds(input, 'host.md', {
      resolveLinkPath: (linkPath) => (linkPath === 'note' ? 'note.md' : null),
      readMarkdownFile: async (path) => (path === 'note.md' ? '# Note\n\nhello' : null),
    });

    assert.strictEqual(output, '# Host\n\n\n# Note\n\nhello\n\n');
  });

  it('expands heading fragment embeds', async () => {
    const input = '![[note#Section A]]';
    const output = await expandObsidianMarkdownEmbeds(input, 'host.md', {
      resolveLinkPath: () => 'note.md',
      readMarkdownFile: async () => '# Intro\n\n## Section A\n\nA1\n\n### Sub\n\nA2\n\n## Section B\n\nB1',
    });

    assert.strictEqual(output, '\n## Section A\n\nA1\n\n### Sub\n\nA2\n');
  });

  it('expands block-id embeds', async () => {
    const input = '![[note#^my-block]]';
    const output = await expandObsidianMarkdownEmbeds(input, 'host.md', {
      resolveLinkPath: () => 'note.md',
      readMarkdownFile: async () => 'para 1\nline 2 ^my-block\n\nother',
    });

    assert.strictEqual(output, '\npara 1\nline 2 ^my-block\n');
  });

  it('keeps image embeds unchanged for later pipeline stages', async () => {
    const input = '![[assets/a.svg|120]]';
    const output = await expandObsidianMarkdownEmbeds(input, 'host.md', {
      resolveLinkPath: () => null,
      readMarkdownFile: async () => null,
    });

    assert.strictEqual(output, input);
  });

  it('does not expand embeds inside code fences or inline code', async () => {
    const input = '```md\n![[note]]\n```\n\n`![[note]]` and ![[note]]';
    const output = await expandObsidianMarkdownEmbeds(input, 'host.md', {
      resolveLinkPath: () => 'note.md',
      readMarkdownFile: async () => 'hello',
    });

    assert.strictEqual(output, '```md\n![[note]]\n```\n\n`![[note]]` and \nhello\n');
  });
});
