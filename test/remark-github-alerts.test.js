import { describe, it } from 'node:test';
import assert from 'node:assert';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import remarkGithubAlerts from '../src/plugins/remark-github-alerts.ts';

/**
 * Render markdown to HTML through the alert plugin + remark-rehype so the
 * assertions cover both the AST transform and the resulting HTML attributes.
 */
function toHtml(input) {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkGithubAlerts)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify, { allowDangerousHtml: true })
      .processSync(input)
  );
}

/** Collect the alert kind (note/tip/…) from any alert blockquote in the tree. */
function alertKinds(tree) {
  const kinds = [];
  visit(tree, 'blockquote', (node) => {
    const className = node?.data?.hProperties?.className;
    if (Array.isArray(className)) {
      const kindClass = className.find((c) => c.startsWith('markdown-alert-') && c !== 'markdown-alert');
      if (kindClass) kinds.push(kindClass.replace('markdown-alert-', ''));
    }
  });
  return kinds;
}

function parseToAst(input) {
  const processor = unified().use(remarkParse).use(remarkGithubAlerts);
  return processor.runSync(processor.parse(input));
}

describe('remark-github-alerts', () => {
  const kinds = ['note', 'tip', 'important', 'warning', 'caution'];

  for (const kind of kinds) {
    it(`should render a ${kind} alert with marker stripped and title added`, () => {
      const input = `> [!${kind.toUpperCase()}]\n> This is the body text.`;
      const html = toHtml(input);

      assert.match(html, new RegExp(`class="markdown-alert markdown-alert-${kind}"`), `should carry the ${kind} alert class`);
      assert.ok(html.includes('class="markdown-alert-title"'), 'should add a title paragraph');
      assert.ok(html.includes('This is the body text.'), 'should keep the body text');
      assert.ok(!html.includes(`[!${kind.toUpperCase()}]`), 'should strip the marker from the output');
    });
  }

  it('should use a human-readable title for each kind', () => {
    const cases = {
      note: 'Note',
      tip: 'Tip',
      important: 'Important',
      warning: 'Warning',
      caution: 'Caution',
    };

    for (const [kind, title] of Object.entries(cases)) {
      const html = toHtml(`> [!${kind.toUpperCase()}]\n> body`);
      assert.ok(html.includes(`<p class="markdown-alert-title">${title}</p>`), `title for ${kind} should be "${title}"`);
    }
  });

  it('should keep multiple paragraphs in the alert body', () => {
    const input = [
      '> [!WARNING]',
      '> First paragraph.',
      '>',
      '> Second paragraph.',
    ].join('\n');
    const html = toHtml(input);

    assert.ok(html.includes('class="markdown-alert markdown-alert-warning"'));
    assert.ok(html.includes('First paragraph.'));
    assert.ok(html.includes('Second paragraph.'));
  });

  it('should render an alert with no body content (marker only)', () => {
    const html = toHtml('> [!NOTE]');

    assert.match(html, /class="markdown-alert markdown-alert-note"/);
    assert.ok(html.includes('<p class="markdown-alert-title">Note</p>'));
    // No stray marker text remains.
    assert.ok(!html.includes('[!NOTE]'));
  });

  it('should preserve inline formatting that follows the marker', () => {
    const input = '> [!TIP]\n> Use **bold** and *italic* here.';
    const html = toHtml(input);

    assert.ok(html.includes('markdown-alert-tip'));
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<em>italic</em>'));
    assert.ok(!html.includes('[!TIP]'));
  });

  it('should NOT treat marker + prose on the same line as an alert', () => {
    const input = '> [!NOTE] not on its own line';
    const ast = parseToAst(input);
    const kinds = alertKinds(ast);

    assert.strictEqual(kinds.length, 0, 'should not be recognised as an alert');
    const html = toHtml(input);
    assert.ok(!html.includes('markdown-alert'), 'should render as a plain blockquote');
    assert.ok(html.includes('[!NOTE]'), 'should keep the literal text');
  });

  it('should leave normal blockquotes untouched', () => {
    const input = '> Just a regular blockquote.';
    const ast = parseToAst(input);
    assert.strictEqual(alertKinds(ast).length, 0);
    const html = toHtml(input);
    assert.ok(!html.includes('markdown-alert'));
    assert.ok(html.includes('Just a regular blockquote.'));
  });

  it('should match alert kinds case-insensitively', () => {
    const html = toHtml('> [!note]\n> lower-case marker');
    assert.match(html, /class="markdown-alert markdown-alert-note"/);
  });

  it('should handle nested alert blockquotes', () => {
    const input = '> > [!NOTE]\n> > nested body';
    const ast = parseToAst(input);
    assert.strictEqual(alertKinds(ast).length, 1);
    assert.strictEqual(alertKinds(ast)[0], 'note');
  });

  it('should ignore an unknown marker kind', () => {
    const input = '> [!HIGHLIGHT]\n> not a real alert';
    const ast = parseToAst(input);
    assert.strictEqual(alertKinds(ast).length, 0);
    const html = toHtml(input);
    assert.ok(!html.includes('markdown-alert'));
    assert.ok(html.includes('[!HIGHLIGHT]'));
  });
});
