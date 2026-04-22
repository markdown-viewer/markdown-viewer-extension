import { describe, it } from 'node:test';
import assert from 'node:assert';

import { rewriteObsidianSvgEmbeds } from '../obsidian/src/host/obsidian-svg-embed-rewrite.ts';

describe('rewriteObsidianSvgEmbeds', () => {
  it('rewrites relative svg embeds into markdown images', () => {
    const input = '![[assets/diagram.svg]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/spec.md', () => 'notes/assets/diagram.svg');

    assert.strictEqual(output, '![](assets/diagram.svg)');
  });

  it('rewrites resolved vault links to a relative markdown path', () => {
    const input = '![[diagram.svg]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/specs/doc.md', () => 'assets/diagram.svg');

    assert.strictEqual(output, '![](../../assets/diagram.svg)');
  });

  it('ignores resolved targets when resolver returns non-svg file', () => {
    const input = '![[test.svg]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/spec.md', () => 'notes/test.md');

    assert.strictEqual(output, '![](test.svg)');
  });

  it('strips obsidian embed options before rewriting', () => {
    const input = '![[assets/diagram.svg|320]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/spec.md', () => 'notes/assets/diagram.svg');

    assert.strictEqual(output, '![](assets/diagram.svg)');
  });

  it('leaves non-svg embeds unchanged', () => {
    const input = '![[assets/diagram.png]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/spec.md', () => 'notes/assets/diagram.png');

    assert.strictEqual(output, input);
  });

  it('does not rewrite fenced code blocks', () => {
    const input = '```md\n![[assets/diagram.svg]]\n```\n\n![[assets/diagram.svg]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/spec.md', () => 'notes/assets/diagram.svg');

    assert.strictEqual(output, '```md\n![[assets/diagram.svg]]\n```\n\n![](assets/diagram.svg)');
  });

  it('does not rewrite inline code spans', () => {
    const input = '`![[assets/diagram.svg]]` and ![[assets/diagram.svg]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/spec.md', () => 'notes/assets/diagram.svg');

    assert.strictEqual(output, '`![[assets/diagram.svg]]` and ![](assets/diagram.svg)');
  });

  it('wraps destinations with spaces in angle brackets', () => {
    const input = '![[assets/architecture diagram.svg]]';
    const output = rewriteObsidianSvgEmbeds(input, 'notes/spec.md', () => 'notes/assets/architecture diagram.svg');

    assert.strictEqual(output, '![](<assets/architecture diagram.svg>)');
  });
});
