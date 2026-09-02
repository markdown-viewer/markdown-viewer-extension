import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  splitMarkdownIntoBlocks,
  splitMarkdownIntoBlocksWithLines,
} from '../../../src/core/markdown-block-splitter.ts';

describe('markdown-block-splitter', () => {
  describe('Basic Elements', () => {
    it('should handle simple paragraph', () => {
      const result = splitMarkdownIntoBlocks('Hello world');
      assert.deepStrictEqual(result, ['Hello world']);
    });

    it('should handle heading', () => {
      const result = splitMarkdownIntoBlocks('# Title');
      assert.deepStrictEqual(result, ['# Title']);
    });

    it('should handle heading with paragraph', () => {
      const result = splitMarkdownIntoBlocks('# Title\n\nSome text');
      assert.deepStrictEqual(result, ['# Title', 'Some text']);
    });

    it('should handle multiple headings', () => {
      const result = splitMarkdownIntoBlocks('# H1\n\n## H2\n\n### H3');
      assert.deepStrictEqual(result, ['# H1', '## H2', '### H3']);
    });

    it('should handle empty input', () => {
      const result = splitMarkdownIntoBlocks('');
      assert.deepStrictEqual(result, []);
    });

    it('should handle only whitespace lines', () => {
      const result = splitMarkdownIntoBlocks('\n\n\n');
      assert.deepStrictEqual(result, []);
    });
  });

  describe('Code Blocks', () => {
    it('should handle fenced code block with backticks', () => {
      const result = splitMarkdownIntoBlocks('```js\ncode\n```');
      assert.deepStrictEqual(result, ['```js\ncode\n```']);
    });

    it('should handle fenced code block with tildes', () => {
      const result = splitMarkdownIntoBlocks('~~~python\nprint("hi")\n~~~');
      assert.deepStrictEqual(result, ['~~~python\nprint("hi")\n~~~']);
    });

    it('should handle code block with more backticks', () => {
      const result = splitMarkdownIntoBlocks('````\n```\ncode\n```\n````');
      assert.deepStrictEqual(result, ['````\n```\ncode\n```\n````']);
    });

    it('should handle indented code', () => {
      const result = splitMarkdownIntoBlocks('    code line 1\n    code line 2');
      assert.deepStrictEqual(result, ['    code line 1\n    code line 2']);
    });

    it('should handle code block between paragraphs', () => {
      const result = splitMarkdownIntoBlocks('Text\n\n```js\ncode\n```\n\nMore text');
      assert.deepStrictEqual(result, ['Text', '```js\ncode\n```', 'More text']);
    });
  });

  describe('Math Blocks', () => {
    it('should handle math block', () => {
      const result = splitMarkdownIntoBlocks('$$\nx=1\n$$');
      assert.deepStrictEqual(result, ['$$\nx=1\n$$']);
    });

    it('should handle multi-line math', () => {
      const result = splitMarkdownIntoBlocks('$$\na + b\n= c\n$$');
      assert.deepStrictEqual(result, ['$$\na + b\n= c\n$$']);
    });
  });

  describe('Tables', () => {
    it('should handle simple table', () => {
      const result = splitMarkdownIntoBlocks('| a | b |\n|---|---|\n| 1 | 2 |');
      assert.deepStrictEqual(result, ['| a | b |\n|---|---|\n| 1 | 2 |']);
    });

    it('should handle table with text after', () => {
      const result = splitMarkdownIntoBlocks('| a | b |\n|---|---|\n| 1 | 2 |\n\nParagraph');
      assert.deepStrictEqual(result, ['| a | b |\n|---|---|\n| 1 | 2 |', 'Paragraph']);
    });
  });

  describe('Blockquotes', () => {
    it('should handle single blockquote', () => {
      const result = splitMarkdownIntoBlocks('> quote');
      assert.deepStrictEqual(result, ['> quote']);
    });

    it('should handle multi-line blockquote', () => {
      const result = splitMarkdownIntoBlocks('> quote\n> more');
      assert.deepStrictEqual(result, ['> quote\n> more']);
    });

    it('should handle blockquote with text after', () => {
      const result = splitMarkdownIntoBlocks('> quote\n\nParagraph');
      assert.deepStrictEqual(result, ['> quote', 'Paragraph']);
    });
  });

  describe('Lists', () => {
    it('should handle unordered list with dash', () => {
      const result = splitMarkdownIntoBlocks('- item1\n- item2');
      assert.deepStrictEqual(result, ['- item1\n- item2']);
    });

    it('should handle ordered list', () => {
      const result = splitMarkdownIntoBlocks('1. first\n2. second');
      assert.deepStrictEqual(result, ['1. first\n2. second']);
    });

    it('should handle unordered list with asterisks', () => {
      const result = splitMarkdownIntoBlocks('* item1\n* item2');
      assert.deepStrictEqual(result, ['* item1\n* item2']);
    });

    it('should handle unordered list with plus', () => {
      const result = splitMarkdownIntoBlocks('+ item1\n+ item2');
      assert.deepStrictEqual(result, ['+ item1\n+ item2']);
    });

    it('should handle nested list', () => {
      const result = splitMarkdownIntoBlocks('- item1\n  - nested\n- item2');
      assert.deepStrictEqual(result, ['- item1\n  - nested\n- item2']);
    });

    it('should handle list then code', () => {
      const result = splitMarkdownIntoBlocks('- item1\n- item2\n\n```\ncode\n```');
      assert.deepStrictEqual(result, ['- item1\n- item2', '```\ncode\n```']);
    });

    it('should handle Unicode bullet •', () => {
      const result = splitMarkdownIntoBlocks('\t•\tItem one\n\t•\tItem two\n\t•\tItem three');
      assert.deepStrictEqual(result, ['\t•\tItem one\n\t•\tItem two\n\t•\tItem three']);
    });

    it('should handle mixed standard and Unicode bullets', () => {
      const result = splitMarkdownIntoBlocks('- Standard item\n\t•\tUnicode item\n- Another standard');
      assert.deepStrictEqual(result, ['- Standard item\n\t•\tUnicode item\n- Another standard']);
    });

    it('should handle loose list with description lines', () => {
      const result = splitMarkdownIntoBlocks('\t•\t标题一\n这是描述内容\n\t•\t标题二\n这是另一个描述');
      assert.deepStrictEqual(result, ['\t•\t标题一\n这是描述内容\n\t•\t标题二\n这是另一个描述']);
    });

    it('should handle loose list followed by heading', () => {
      const result = splitMarkdownIntoBlocks('\t•\tItem one\nDescription\n\t•\tItem two\n\n## Heading');
      assert.deepStrictEqual(result, ['\t•\tItem one\nDescription\n\t•\tItem two', '## Heading']);
    });

    it('should handle other Unicode bullets ◦ ▪ ○ ●', () => {
      const result = splitMarkdownIntoBlocks('\t◦\tItem A\n\t▪\tItem B\n\t○\tItem C\n\t●\tItem D');
      assert.deepStrictEqual(result, ['\t◦\tItem A\n\t▪\tItem B\n\t○\tItem C\n\t●\tItem D']);
    });
  });

  describe('HTML Blocks', () => {
    it('should handle simple div', () => {
      const result = splitMarkdownIntoBlocks('<div>\nHello\n</div>\n');
      assert.deepStrictEqual(result, ['<div>\nHello\n</div>\n']);
    });

    it('should keep contiguous html tags in a single block', () => {
      const markdown = [
        '<style>',
        '.kb-wireframe {',
        '  color: #333;',
        '  background: linear-gradient(',
        '    180deg,',
        '    #fff,',
        '    #eee',
        '  );',
        '}',
        '</style>',
        '<div class="kb-wireframe">',
        '  <div>Hello</div>',
        '</div>',
      ].join('\n');

      const result = splitMarkdownIntoBlocksWithLines(markdown);

      assert.deepStrictEqual(result, [
        {
          content: [
            '<style>',
            '.kb-wireframe {',
            '  color: #333;',
            '  background: linear-gradient(',
            '    180deg,',
            '    #fff,',
            '    #eee',
            '  );',
            '}',
            '</style>',
            '<div class="kb-wireframe">',
            '  <div>Hello</div>',
            '</div>'
          ].join('\n'),
          startLine: 0,
        }
      ]);
    });

    it('should stop html block at a blank line before following markdown', () => {
      const markdown = [
        '<style>',
        '.kb-wireframe { color: #333; }',
        '</style>',
        '',
        'Paragraph after a blank line.'
      ].join('\n');

      const result = splitMarkdownIntoBlocksWithLines(markdown);

      assert.deepStrictEqual(result, [
        {
          content: [
            '<style>',
            '.kb-wireframe { color: #333; }',
            '</style>',
            ''
          ].join('\n'),
          startLine: 0,
        },
        {
          content: 'Paragraph after a blank line.',
          startLine: 4,
        }
      ]);
    });

    it('should stop html block at a blank line before following html block', () => {
      const markdown = [
        '<style>',
        '.kb-wireframe { color: #333; }',
        '</style>',
        '',
        '<div>Hello</div>'
      ].join('\n');

      const result = splitMarkdownIntoBlocksWithLines(markdown);

      assert.deepStrictEqual(result, [
        {
          content: [
            '<style>',
            '.kb-wireframe { color: #333; }',
            '</style>',
            ''
          ].join('\n'),
          startLine: 0,
        },
        {
          content: '<div>Hello</div>',
          startLine: 4,
        }
      ]);
    });

    it('should not absorb non-html markdown lines into a contiguous html block', () => {
      const markdown = [
        '<style>',
        '.kb-wireframe { color: #333; }',
        '</style>',
        'Plain markdown text without a blank line first.'
      ].join('\n');

      const result = splitMarkdownIntoBlocksWithLines(markdown);

      assert.deepStrictEqual(result, [
        {
          content: [
            '<style>',
            '.kb-wireframe { color: #333; }',
            '</style>'
          ].join('\n'),
          startLine: 0,
        },
        {
          content: 'Plain markdown text without a blank line first.',
          startLine: 3,
        }
      ]);
    });

    it('should not absorb a heading immediately after html closes', () => {
      const markdown = [
        '<style>',
        '.kb-wireframe { color: #333; }',
        '</style>',
        '## Heading'
      ].join('\n');

      const result = splitMarkdownIntoBlocksWithLines(markdown);

      assert.deepStrictEqual(result, [
        {
          content: [
            '<style>',
            '.kb-wireframe { color: #333; }',
            '</style>'
          ].join('\n'),
          startLine: 0,
        },
        {
          content: '## Heading',
          startLine: 3,
        }
      ]);
    });

    it('should handle html comment', () => {
      const result = splitMarkdownIntoBlocks('<!-- comment -->\n');
      assert.deepStrictEqual(result, ['<!-- comment -->\n']);
    });

    it('should handle nested html', () => {
      const result = splitMarkdownIntoBlocks('<div>\n  <div>\n    Text\n  </div>\n</div>\n');
      assert.deepStrictEqual(result, ['<div>\n  <div>\n    Text\n  </div>\n</div>\n']);
    });

    it('should handle html without trailing newline', () => {
      const result = splitMarkdownIntoBlocks('<div>\ncontent\n</div>');
      assert.deepStrictEqual(result, ['<div>\ncontent\n</div>']);
    });

    it('should handle heading then html', () => {
      const result = splitMarkdownIntoBlocks('#### Title\n\n<div>\n  Text\n</div>\n');
      assert.deepStrictEqual(result, ['#### Title', '<div>\n  Text\n</div>\n']);
    });
  });

  describe('Front Matter', () => {
    it('should handle front matter', () => {
      const result = splitMarkdownIntoBlocks('---\ntitle: Test\n---\n\nContent');
      assert.deepStrictEqual(result, ['---\ntitle: Test\n---', 'Content']);
    });

    it('should handle front matter with yaml', () => {
      const result = splitMarkdownIntoBlocks('---\ntitle: Test\nauthor: Me\n---\n\n# Heading');
      assert.deepStrictEqual(result, ['---\ntitle: Test\nauthor: Me\n---', '# Heading']);
    });
  });

  describe('Mixed Content', () => {
    it('should handle heading and paragraph', () => {
      const result = splitMarkdownIntoBlocks('# Heading\n\nParagraph');
      assert.deepStrictEqual(result, ['# Heading', 'Paragraph']);
    });

    it('should handle complex mixed content', () => {
      const result = splitMarkdownIntoBlocks('# Heading\n\nParagraph\n\n```js\ncode\n```\n\n> quote');
      assert.deepStrictEqual(result, ['# Heading', 'Paragraph', '```js\ncode\n```', '> quote']);
    });

    it('should handle horizontal rule', () => {
      const result = splitMarkdownIntoBlocks('---');
      assert.deepStrictEqual(result, ['---']);
    });

    it('should handle horizontal rule between text', () => {
      const result = splitMarkdownIntoBlocks('Text\n\n---\n\nMore');
      assert.deepStrictEqual(result, ['Text', '---', 'More']);
    });
  });

  describe('Line Numbers', () => {
    it('should return correct line numbers', () => {
      const result = splitMarkdownIntoBlocksWithLines('# Title\n\nParagraph\n\n```js\ncode\n```');
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].startLine, 0);
      assert.strictEqual(result[0].content, '# Title');
      assert.strictEqual(result[1].startLine, 2);
      assert.strictEqual(result[1].content, 'Paragraph');
      assert.strictEqual(result[2].startLine, 4);
      assert.strictEqual(result[2].content, '```js\ncode\n```');
    });

    it('should handle front matter line numbers', () => {
      const result = splitMarkdownIntoBlocksWithLines('---\ntitle: Test\n---\n\n# Heading');
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].startLine, 0);
      assert.strictEqual(result[1].startLine, 4);
    });
  });
});
