/**
 * Tests for remark-inline-html plugin
 * 
 * Uses remark-stringify to convert AST back to Markdown for easy assertion.
 * Note: remark-stringify escapes < to \<, so unknown tags appear as \<M> in output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkInlineHtml from '../../../src/plugins/remark-inline-html.ts';

// Custom stringify handlers for superscript/subscript/delete nodes
function remarkCustomStringify() {
  const data = this.data();
  
  const toMarkdownExtension = {
    handlers: {
      superscript(node, _, state) {
        const value = state.containerPhrasing(node, { before: '^', after: '^' });
        return '^' + value + '^';
      },
      subscript(node, _, state) {
        const value = state.containerPhrasing(node, { before: '~', after: '~' });
        return '~' + value + '~';
      },
      delete(node, _, state) {
        const value = state.containerPhrasing(node, { before: '~~', after: '~~' });
        return '~~' + value + '~~';
      }
    }
  };
  
  data.toMarkdownExtensions = data.toMarkdownExtensions || [];
  data.toMarkdownExtensions.push(toMarkdownExtension);
}

/**
 * Transform markdown through remarkInlineHtml and back to markdown
 */
function transform(input) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkInlineHtml)
    .use(remarkCustomStringify)
    .use(remarkStringify);
  
  return processor.processSync(input).toString().trim();
}

/**
 * Parse and return AST for inspection
 */
function parseToAst(input) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkInlineHtml);
  
  return processor.runSync(processor.parse(input));
}

describe('remarkInlineHtml', () => {
  describe('basic formatting tags', () => {
    it('should convert <b> to strong', () => {
      assert.strictEqual(transform('Text with <b>bold</b>'), 'Text with **bold**');
    });

    it('should convert <strong> to strong', () => {
      assert.strictEqual(transform('Text with <strong>strong</strong>'), 'Text with **strong**');
    });

    it('should convert <i> to emphasis', () => {
      assert.strictEqual(transform('Text with <i>italic</i>'), 'Text with *italic*');
    });

    it('should convert <em> to emphasis', () => {
      assert.strictEqual(transform('Text with <em>emphasized</em>'), 'Text with *emphasized*');
    });

    it('should convert <s> to delete', () => {
      assert.strictEqual(transform('<s>strikethrough</s>'), '~~strikethrough~~');
    });

    it('should convert <del> to delete', () => {
      assert.strictEqual(transform('<del>deleted</del>'), '~~deleted~~');
    });

    it('should convert <code> to inlineCode', () => {
      assert.strictEqual(transform('<code>code</code>'), '`code`');
    });

    it('should convert <kbd> to inlineCode', () => {
      assert.strictEqual(transform('Press <kbd>Ctrl</kbd>+<kbd>C</kbd>'), 'Press `Ctrl`+`C`');
    });
  });

  describe('superscript and subscript', () => {
    it('should convert <sup> to superscript', () => {
      assert.strictEqual(transform('E=mc<sup>2</sup>'), 'E=mc^2^');
    });

    it('should convert <sub> to subscript', () => {
      assert.strictEqual(transform('H<sub>2</sub>O'), 'H~2~O');
    });

    it('should handle formula with superscript', () => {
      assert.strictEqual(transform('x<sup>2</sup> + y<sup>2</sup>'), 'x^2^ + y^2^');
    });
  });

  describe('unknown tags', () => {
    it('should convert unknown tags to literal text', () => {
      // remark-stringify escapes < to \<
      assert.strictEqual(transform('Text with <M> marker'), 'Text with \\<M> marker');
    });

    it('should handle the original SRD-<M> issue', () => {
      assert.strictEqual(transform('"SRD-<M>"'), '"SRD-\\<M>"');
    });

    it('should handle unpaired opening tag', () => {
      assert.strictEqual(transform('Text <b>without close'), 'Text \\<b>without close');
    });

    it('should handle unpaired closing tag', () => {
      assert.strictEqual(transform('Text </b> alone'), 'Text \\</b> alone');
    });
  });

  describe('break tag', () => {
    it('should convert <br> to break', () => {
      const ast = parseToAst('Line1<br>Line2');
      const paragraph = ast.children[0];
      const hasBreak = paragraph.children.some(n => n.type === 'break');
      assert.ok(hasBreak, 'Should have break node');
    });

    it('should convert <br/> to break', () => {
      const ast = parseToAst('Line1<br/>Line2');
      const paragraph = ast.children[0];
      const hasBreak = paragraph.children.some(n => n.type === 'break');
      assert.ok(hasBreak, 'Should have break node');
    });
  });

  describe('dangerous tags', () => {
    it('should remove <script> tags', () => {
      const result = transform('Text <script>alert("xss")</script> here');
      assert.ok(!result.includes('script'), 'Should not contain script');
      assert.ok(!result.includes('alert'), 'Should not contain script content');
    });

    it('should remove <iframe> tags', () => {
      const result = transform('Text <iframe src="evil.html"></iframe> here');
      assert.ok(!result.includes('iframe'), 'Should not contain iframe');
    });
  });

  describe('block HTML preservation', () => {
    it('should preserve block-level HTML (parent is root)', () => {
      const input = `<div>Block content</div>`;
      const ast = parseToAst(input);
      // Block HTML should remain as html node
      const htmlNode = ast.children.find(n => n.type === 'html');
      assert.ok(htmlNode, 'Block HTML should be preserved as html node');
      assert.strictEqual(htmlNode.value, '<div>Block content</div>');
    });

    it('should merge contiguous root html nodes without a blank line', () => {
      const input = [
        '<style>',
        '.kb-wireframe { color: #333; }',
        '</style>',
        '<div class="kb-wireframe">',
        '  <div>Hello</div>',
        '</div>'
      ].join('\n');

      const ast = parseToAst(input);
      assert.strictEqual(ast.children.length, 1);
      assert.strictEqual(ast.children[0].type, 'html');
      assert.strictEqual(ast.children[0].value, input);
    });

    it('should not merge root html nodes separated by a blank line', () => {
      const input = [
        '<style>',
        '.kb-wireframe { color: #333; }',
        '</style>',
        '',
        '<div class="kb-wireframe">',
        '  <div>Hello</div>',
        '</div>'
      ].join('\n');

      const ast = parseToAst(input);
      const htmlNodes = ast.children.filter(n => n.type === 'html');
      assert.strictEqual(htmlNodes.length, 2);
      assert.strictEqual(htmlNodes[0].value, '<style>\n.kb-wireframe { color: #333; }\n</style>');
      assert.strictEqual(htmlNodes[1].value, '<div class="kb-wireframe">\n  <div>Hello</div>\n</div>');
    });
  });

  describe('mixed content', () => {
    it('should handle mixed valid and unknown tags', () => {
      const result = transform('Text with <b>bold</b> and <M> marker');
      assert.ok(result.includes('**bold**'), 'Should convert <b>');
      assert.ok(result.includes('\\<M>'), 'Should keep <M> as text');
    });

    it('should handle inline HTML in list items', () => {
      const result = transform('- Item with <b>bold</b>');
      assert.ok(result.includes('**bold**'), 'Should convert inline HTML in list');
    });

    it('should handle inline HTML in headings', () => {
      const result = transform('# Heading with <i>italic</i>');
      assert.ok(result.includes('*italic*'), 'Should convert inline HTML in heading');
    });
  });

  describe('skip tags (remove tags, keep content)', () => {
    it('should skip <u> and keep content', () => {
      const result = transform('Text with <u>underlined</u> word');
      assert.ok(result.includes('underlined'), 'Should keep content');
      assert.ok(!result.includes('<u>'), 'Should remove tag');
    });

    it('should skip <ins> and keep content', () => {
      const result = transform('<ins>inserted text</ins>');
      assert.ok(result.includes('inserted text'), 'Should keep content');
    });

    it('should skip <mark> and keep content', () => {
      const result = transform('This is <mark>highlighted</mark> text');
      assert.ok(result.includes('highlighted'), 'Should keep content');
      assert.ok(!result.includes('<mark>'), 'Should remove tag');
    });

    it('should skip <small> and keep content', () => {
      const result = transform('Normal <small>small text</small> normal');
      assert.ok(result.includes('small text'), 'Should keep content');
    });

    it('should skip <span> and keep content', () => {
      const result = transform('<span style="color:red">red text</span>');
      assert.ok(result.includes('red text'), 'Should keep content');
      assert.ok(!result.includes('<span'), 'Should remove tag');
    });
  });

  describe('link and image tags', () => {
    it('should convert <a> to link', () => {
      const result = transform('Click <a href="https://example.com">here</a>');
      assert.ok(result.includes('[here](https://example.com)'), 'Should convert to markdown link');
    });

    it('should convert <a> with empty href', () => {
      const result = transform('<a href="">empty link</a>');
      assert.ok(result.includes('[empty link]()'), 'Should handle empty href');
    });

    it('should remove <a> with javascript: URL', () => {
      const result = transform('<a href="javascript:alert(1)">evil</a>');
      assert.ok(!result.includes('evil'), 'Should remove javascript link');
    });

    it('should convert <img> to image', () => {
      const result = transform('Image: <img src="test.png" alt="test image">');
      assert.ok(result.includes('![test image](test.png)'), 'Should convert to markdown image');
    });

    it('should convert <img> without alt', () => {
      const result = transform('Image: <img src="test.png">');
      assert.ok(result.includes('![](test.png)'), 'Should handle missing alt');
    });

    it('should convert self-closing <img/>', () => {
      const result = transform('Image: <img src="test.png" alt="test"/>');
      assert.ok(result.includes('![test](test.png)'), 'Should handle self-closing img');
    });
  });
});
