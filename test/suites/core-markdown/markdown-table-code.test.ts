import assert from 'node:assert';
import { describe, it } from 'node:test';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';

import { escapePipesInTableCodeSpans } from '../../../src/utils/markdown-table-code.ts';

describe('escapePipesInTableCodeSpans', () => {
  it('escapes inline-code pipes in multi-column GFM tables', () => {
    const markdown = [
      '| Current condition | Duration | Longest interval |',
      '|---|---:|---:|',
      '| `|I| > 2 A` | 104.0 ms | 5.6 ms |',
    ].join('\n');

    assert.strictEqual(
      escapePipesInTableCodeSpans(markdown),
      [
        '| Current condition | Duration | Longest interval |',
        '|---|---:|---:|',
        '| `\\|I\\| > 2 A` | 104.0 ms | 5.6 ms |',
      ].join('\n')
    );
  });

  it('produces the intended GFM table cells after parsing', () => {
    const markdown = [
      '| Current condition | Duration | Longest interval |',
      '|---|---:|---:|',
      '| `|I| > 2 A` | 104.0 ms | 5.6 ms |',
    ].join('\n');
    const processor = unified().use(remarkParse).use(remarkGfm);
    const ast = processor.runSync(processor.parse(escapePipesInTableCodeSpans(markdown))) as {
      children: Array<{
        children: Array<{
          children: Array<{ children: Array<{ type: string; value?: string }> }>;
        }>;
      }>;
    };
    const dataCells = ast.children[0].children[1].children;

    assert.strictEqual(dataCells.length, 3);
    assert.deepStrictEqual(
      dataCells.map((cell) => cell.children[0]?.value),
      ['|I| > 2 A', '104.0 ms', '5.6 ms']
    );
    assert.strictEqual(dataCells[0].children[0]?.type, 'inlineCode');
  });

  it('supports single-column tables and multi-backtick code spans', () => {
    const markdown = ['| Expression |', '|---|', '| ``a`b|c`` |'].join('\n');
    const expected = ['| Expression |', '|---|', '| ``a`b\\|c`` |'].join('\n');

    assert.strictEqual(escapePipesInTableCodeSpans(markdown), expected);
  });

  it('does not double-escape existing table pipe escapes', () => {
    const markdown = ['| Expression | Value |', '|---|---|', '| `a\\|b` | 1 |'].join('\n');

    assert.strictEqual(escapePipesInTableCodeSpans(markdown), markdown);
  });

  it('leaves inline code outside tables unchanged', () => {
    const markdown = 'Inline code outside a table: `a|b`.';

    assert.strictEqual(escapePipesInTableCodeSpans(markdown), markdown);
  });

  it('ignores table-like content inside fenced code blocks', () => {
    const markdown = ['```markdown', '| Expression |', '|---|', '| `a|b` |', '```'].join('\n');

    assert.strictEqual(escapePipesInTableCodeSpans(markdown), markdown);
  });

  it('escapes inline-code pipes in blockquoted GFM tables', () => {
    const markdown = [
      '> | Expression | Value |',
      '> |---|---|',
      '> | `a|b` | 1 |',
    ].join('\n');
    const expected = [
      '> | Expression | Value |',
      '> |---|---|',
      '> | `a\\|b` | 1 |',
    ].join('\n');

    assert.strictEqual(escapePipesInTableCodeSpans(markdown), expected);
  });

  it('preserves code pipes in blockquoted tables after parsing', () => {
    const markdown = [
      '> | Current condition | Duration |',
      '> |---|---:|',
      '> | `|I| > 2 A` | 104.0 ms |',
    ].join('\n');
    const processor = unified().use(remarkParse).use(remarkGfm);
    const ast = processor.runSync(processor.parse(escapePipesInTableCodeSpans(markdown))) as {
      children: Array<{
        children: Array<{
          children: Array<{
            children: Array<{ children: Array<{ type: string; value?: string }> }>;
          }>;
        }>;
      }>;
    };
    const table = ast.children[0].children[0];
    const dataCells = table.children[1].children;

    assert.strictEqual(dataCells.length, 2);
    assert.strictEqual(dataCells[0].children[0]?.type, 'inlineCode');
    assert.strictEqual(dataCells[0].children[0]?.value, '|I| > 2 A');
  });

  it('ignores table-like content inside blockquoted fenced code blocks', () => {
    const markdown = [
      '> ```markdown',
      '> | Expression |',
      '> |---|',
      '> | `a|b` |',
      '> ```',
    ].join('\n');

    assert.strictEqual(escapePipesInTableCodeSpans(markdown), markdown);
  });

  it('ignores table-like content inside indented code blocks', () => {
    const markdown = [
      '    | Expression |',
      '    |---|',
      '    | `a|b` |',
    ].join('\n');

    assert.strictEqual(escapePipesInTableCodeSpans(markdown), markdown);
  });
});
