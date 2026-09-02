/**
 * Inline Markdown Parser Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseInlineMarkdown, hasInlineMarkdown } from '../../../src/utils/inline-markdown.ts';

describe('Inline Markdown Parser', () => {
  describe('headings', () => {
    it('should parse # H1', () => {
      const result = parseInlineMarkdown('# Heading 1');
      assert.ok(result.includes('<h1'), 'Should have h1 tag');
      assert.ok(result.includes('Heading 1'), 'Should contain heading text');
      assert.ok(result.includes('</h1>'), 'Should close h1 tag');
    });

    it('should parse ## H2', () => {
      const result = parseInlineMarkdown('## Heading 2');
      assert.ok(result.includes('<h2'), 'Should have h2 tag');
    });

    it('should parse ### H3', () => {
      const result = parseInlineMarkdown('### Heading 3');
      assert.ok(result.includes('<h3'), 'Should have h3 tag');
    });

    it('should parse ###### H6', () => {
      const result = parseInlineMarkdown('###### Heading 6');
      assert.ok(result.includes('<h6'), 'Should have h6 tag');
    });

    it('should allow inline formatting in headings', () => {
      const result = parseInlineMarkdown('# **Bold** Heading');
      assert.ok(result.includes('<strong>Bold</strong>'), 'Should have bold in heading');
    });

    it('should not parse # without space as heading', () => {
      const result = parseInlineMarkdown('#notaheading');
      assert.ok(!result.includes('<h'), 'Should not be a heading');
    });
  });

  describe('bold text', () => {
    it('should parse **bold** syntax', () => {
      const result = parseInlineMarkdown('This is **bold** text');
      assert.ok(result.includes('<strong>bold</strong>'), 'Should contain strong tags');
    });

    it('should parse __bold__ syntax', () => {
      const result = parseInlineMarkdown('This is __bold__ text');
      assert.ok(result.includes('<strong>bold</strong>'), 'Should contain strong tags');
    });
  });

  describe('italic text', () => {
    it('should parse *italic* syntax', () => {
      const result = parseInlineMarkdown('This is *italic* text');
      assert.ok(result.includes('<em>italic</em>'), 'Should contain em tags');
    });

    it('should parse _italic_ syntax', () => {
      const result = parseInlineMarkdown('This is _italic_ text');
      assert.ok(result.includes('<em>italic</em>'), 'Should contain em tags');
    });
  });

  describe('inline code', () => {
    it('should parse `code` syntax', () => {
      const result = parseInlineMarkdown('Use `console.log()` here');
      assert.ok(result.includes('<code'), 'Should contain code tags');
      assert.ok(result.includes('console.log()'), 'Should contain code content');
    });

    it('should not parse markdown inside code', () => {
      const result = parseInlineMarkdown('`**not bold**`');
      assert.ok(result.includes('**not bold**'), 'Should preserve markdown syntax inside code');
      assert.ok(!result.includes('<strong>'), 'Should not have bold tags');
    });
  });

  describe('strikethrough', () => {
    it('should parse ~~strikethrough~~ syntax', () => {
      const result = parseInlineMarkdown('This is ~~deleted~~ text');
      assert.ok(result.includes('<del>deleted</del>'), 'Should contain del tags');
    });
  });

  describe('links', () => {
    it('should parse [text](url) syntax', () => {
      const result = parseInlineMarkdown('Click [here](https://example.com)');
      assert.ok(result.includes('<a href="https://example.com"'), 'Should contain anchor with href');
      assert.ok(result.includes('>here</a>'), 'Should contain link text');
    });

    it('should handle links with special characters', () => {
      const result = parseInlineMarkdown('[Link](https://example.com/path?a=1&b=2)');
      assert.ok(result.includes('href="https://example.com/path?a=1&amp;b=2"'), 'Should escape ampersand in URL');
    });
  });

  describe('mixed formatting', () => {
    it('should handle multiple formats in one line', () => {
      const result = parseInlineMarkdown('**Bold** and *italic* and `code`');
      assert.ok(result.includes('<strong>Bold</strong>'), 'Should have bold');
      assert.ok(result.includes('<em>italic</em>'), 'Should have italic');
      assert.ok(result.includes('>code</code>'), 'Should have code');
    });
  });

  describe('newlines', () => {
    it('should preserve newlines as <br/>', () => {
      const result = parseInlineMarkdown('Line 1\nLine 2\nLine 3');
      assert.ok(result.includes('<br/>'), 'Should contain br tags');
      assert.ok(result.includes('Line 1<br/>Line 2<br/>Line 3'), 'Should have correct line breaks');
    });
  });

  describe('HTML escaping', () => {
    it('should escape HTML in plain text', () => {
      const result = parseInlineMarkdown('<script>alert(1)</script>');
      assert.ok(result.includes('&lt;script&gt;'), 'Should escape < and >');
      assert.ok(!result.includes('<script>'), 'Should not contain raw script tag');
    });

    it('should escape HTML inside formatted text', () => {
      const result = parseInlineMarkdown('**<div>test</div>**');
      assert.ok(result.includes('&lt;div&gt;'), 'Should escape HTML inside bold');
    });

    it('should escape ampersand', () => {
      const result = parseInlineMarkdown('A & B');
      assert.ok(result.includes('A &amp; B'), 'Should escape ampersand');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      const result = parseInlineMarkdown('');
      assert.strictEqual(result, '', 'Should return empty string');
    });

    it('should handle unclosed bold', () => {
      const result = parseInlineMarkdown('**unclosed');
      assert.ok(!result.includes('<strong>'), 'Should not create unclosed tags');
      assert.ok(result.includes('**unclosed'), 'Should preserve original text');
    });

    it('should handle unclosed italic', () => {
      const result = parseInlineMarkdown('*unclosed');
      assert.ok(!result.includes('<em>'), 'Should not create unclosed tags');
    });

    it('should handle adjacent formatting', () => {
      const result = parseInlineMarkdown('**bold***italic*');
      assert.ok(result.includes('<strong>bold</strong>'), 'Should handle bold');
      assert.ok(result.includes('<em>italic</em>'), 'Should handle italic');
    });
  });

  describe('hasInlineMarkdown', () => {
    it('should return true for markdown text', () => {
      assert.ok(hasInlineMarkdown('**bold**'), 'Should detect bold');
      assert.ok(hasInlineMarkdown('*italic*'), 'Should detect italic');
      assert.ok(hasInlineMarkdown('`code`'), 'Should detect code');
      assert.ok(hasInlineMarkdown('~~strike~~'), 'Should detect strikethrough');
      assert.ok(hasInlineMarkdown('[link](url)'), 'Should detect link');
      assert.ok(hasInlineMarkdown('# Heading'), 'Should detect heading');
    });

    it('should return false for plain text', () => {
      assert.ok(!hasInlineMarkdown('Plain text'), 'Should not detect markdown in plain text');
      assert.ok(!hasInlineMarkdown('Numbers 123'), 'Should not detect markdown in numbers');
    });
  });
});
