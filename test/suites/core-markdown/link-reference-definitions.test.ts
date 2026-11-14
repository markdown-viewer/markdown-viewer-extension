import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  appendDefinitionsForBlock,
  blockReferencedLabels,
  collectLinkReferenceDefinitions,
  normalizeReferenceLabel,
} from '../../../src/core/link-reference-definitions.ts';
import { splitMarkdownIntoBlocksWithLines } from '../../../src/core/markdown-block-splitter.ts';
import { MarkdownDocument, type DOMCommand } from '../../../src/core/markdown-document.ts';

// The shape from issue #136: references and their definitions sit in separate
// blocks, which is exactly the case the block-level renderer used to lose.
const ISSUE_DOC = [
  '# Test',
  '',
  '[Google][1]  ',
  '',
  '[![md] Java][o-link]  ',
  '',
  '<!-- Reusable icon and file link references -->',
  '',
  '[md]: <https://raw.githubusercontent.com/marcocrowe/coloredbadges/master/svg/dev/languages/java.svg>',
  '',
  '[o-link]: <https://www.java.com>',
  '',
  '[1]: google.com',
  '',
].join('\n');

describe('link-reference-definitions', () => {
  describe('normalizeReferenceLabel', () => {
    it('collapses whitespace, trims, and case-folds like mdast', () => {
      assert.strictEqual(normalizeReferenceLabel('  My   Label  '), 'my label');
      assert.strictEqual(normalizeReferenceLabel('my\tlabel'), 'my label');
    });

    it('matches the identifier mdast stores for `[A]: x`', () => {
      // mdast lowercases micromark's double-case-folded identifier, so a label
      // typed in any casing has to land on the same key.
      assert.strictEqual(normalizeReferenceLabel('A'), 'a');
      assert.strictEqual(normalizeReferenceLabel('a'), 'a');
    });

    it('canonicalises characters whose single case fold is lossy', () => {
      // ϴ (U+03F4) lowercases to θ (U+03B8), which uppercases to Θ (U+0398).
      assert.strictEqual(normalizeReferenceLabel('ϴ'), normalizeReferenceLabel('Θ'));
    });
  });

  describe('collectLinkReferenceDefinitions', () => {
    it('returns an empty map for a document without definitions', () => {
      assert.strictEqual(collectLinkReferenceDefinitions('# Title\n\ntext').size, 0);
    });

    it('returns an empty map for empty input', () => {
      assert.strictEqual(collectLinkReferenceDefinitions('').size, 0);
    });

    it('collects every definition of the issue #136 document', () => {
      const definitions = collectLinkReferenceDefinitions(ISSUE_DOC);

      assert.deepStrictEqual(
        [...definitions.keys()].sort(),
        ['1', 'md', 'o-link'],
        'identifiers should be normalized the way mdast stores them (lowercase)',
      );
      assert.strictEqual(definitions.get('1')?.url, 'google.com');
      assert.strictEqual(definitions.get('md')?.url,
        'https://raw.githubusercontent.com/marcocrowe/coloredbadges/master/svg/dev/languages/java.svg');
      assert.strictEqual(definitions.get('o-link')?.url, 'https://www.java.com');
    });

    it('keeps the first definition when a label repeats (CommonMark rule)', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: first\n\n[a]: second\n');
      assert.strictEqual(definitions.get('a')?.url, 'first');
    });

    it('ignores footnote definitions, which footnote-model.ts owns', () => {
      const definitions = collectLinkReferenceDefinitions('[^note]: footnote body\n');
      assert.strictEqual(definitions.size, 0);
    });

    it('ignores a definition-looking line inside a fenced code block', () => {
      const definitions = collectLinkReferenceDefinitions('```\n[a]: not-a-definition\n```\n');
      assert.strictEqual(definitions.size, 0);
    });

    it('tolerates definitions nested in blockquotes', () => {
      const definitions = collectLinkReferenceDefinitions('> [a]: https://example.com\n');
      assert.strictEqual(definitions.get('a')?.url, 'https://example.com');
    });

    it('preserves titles and relative destinations', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: ./assets/a.png "A title"\n');
      assert.strictEqual(definitions.get('a')?.url, './assets/a.png');
      assert.strictEqual(definitions.get('a')?.title, 'A title');
    });
  });

  describe('blockReferencedLabels', () => {
    it('finds a full reference', () => {
      assert.deepStrictEqual(blockReferencedLabels('[Google][1]'), ['1']);
    });

    it('finds the nested image reference and the outer link reference', () => {
      // `[![md] Java][o-link]` must yield both labels, not just the outer one.
      assert.deepStrictEqual(blockReferencedLabels('[![md] Java][o-link]'), ['md', 'o-link']);
    });

    it('deduplicates repeated labels', () => {
      assert.deepStrictEqual(blockReferencedLabels('[a][x] then [b][x]'), ['x']);
    });

    it('returns nothing for a block without brackets', () => {
      assert.deepStrictEqual(blockReferencedLabels('# Title'), []);
    });
  });

  describe('appendDefinitionsForBlock', () => {
    it('leaves a block alone when it references nothing known', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: https://example.com\n');
      assert.strictEqual(appendDefinitionsForBlock('plain text', definitions), 'plain text');
    });

    it('leaves every block alone when the document has no definitions', () => {
      const definitions = collectLinkReferenceDefinitions('# Title\n');
      assert.strictEqual(appendDefinitionsForBlock('[text][label]', definitions), '[text][label]');
    });

    it('appends only the definitions the block uses', () => {
      const definitions = collectLinkReferenceDefinitions(ISSUE_DOC);
      const result = appendDefinitionsForBlock('[Google][1]', definitions);

      assert.ok(result.startsWith('[Google][1]'), 'original content should be kept verbatim');
      assert.ok(result.includes('[1]: <google.com>'), 'used definition should be appended');
      assert.ok(!result.includes('[o-link]'), 'unused definitions should not be appended');
    });

    it('appends both labels of a nested image link', () => {
      const definitions = collectLinkReferenceDefinitions(ISSUE_DOC);
      const result = appendDefinitionsForBlock('[![md] Java][o-link]', definitions);

      assert.ok(result.includes('[md]:'), 'image definition should be appended');
      assert.ok(result.includes('[o-link]:'), 'link definition should be appended');
    });

    it('never appends to a code block, where a fence could swallow it', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: https://example.com\n');
      const unclosed = '```js\nconst a = [b][a];';
      assert.strictEqual(appendDefinitionsForBlock(unclosed, definitions), unclosed);
    });

    it('keeps the definitions out of a closed fence too', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: https://example.com\n');
      const fenced = '```js\nconst a = [b][a];\n```';
      assert.strictEqual(appendDefinitionsForBlock(fenced, definitions), fenced);
    });

    it('does not append to an indented code block', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: https://example.com\n');
      const indented = '    const a = [b][a];';
      assert.strictEqual(appendDefinitionsForBlock(indented, definitions), indented);
    });

    it('re-round-trips a destination containing angle brackets', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: <https://example.com/x>\n');
      const result = appendDefinitionsForBlock('[t][a]', definitions);
      // Re-parsing the appended definition must recover the same URL.
      const reparsed = collectLinkReferenceDefinitions(result);
      assert.strictEqual(reparsed.get('a')?.url, 'https://example.com/x');
    });

    it('re-round-trips a title containing quotes', () => {
      const definitions = collectLinkReferenceDefinitions('[a]: https://example.com "say \\"hi\\""\n');
      const result = appendDefinitionsForBlock('[t][a]', definitions);
      const reparsed = collectLinkReferenceDefinitions(result);
      assert.strictEqual(reparsed.get('a')?.title, 'say "hi"');
    });
  });

  describe('block splitting of the issue document', () => {
    it('splits references and definitions into different blocks', () => {
      const blocks = splitMarkdownIntoBlocksWithLines(ISSUE_DOC);
      const contents = blocks.map((block) => block.content);

      assert.ok(contents.some((content) => content.trim() === '[Google][1]'), 'reference block exists');
      assert.ok(
        contents.some((content) => content.startsWith('[1]:')),
        'definition block exists separately — this is what broke the render',
      );
    });

    it('gives each reference block only the definitions it needs', () => {
      const definitions = collectLinkReferenceDefinitions(ISSUE_DOC);
      const blocks = splitMarkdownIntoBlocksWithLines(ISSUE_DOC);
      const googleBlock = blocks.find((block) => block.content.trim() === '[Google][1]');

      assert.ok(googleBlock, 'Google reference block should exist');
      const resolved = appendDefinitionsForBlock(googleBlock.content, definitions);
      assert.ok(resolved.includes('[1]: <google.com>'));
      assert.ok(!resolved.includes('[md]:'));
    });
  });

  // A kept block's own text does not change when a definition it uses is
  // edited, so without the definition-aware hash the incremental renderer
  // would keep showing the stale link until the whole file was reopened.
  describe('incremental invalidation', () => {
    const hashInput = (markdown: string) => (content: string) =>
      appendDefinitionsForBlock(content, collectLinkReferenceDefinitions(markdown));

    const renderedBlocks = (doc: MarkdownDocument, commands: DOMCommand[]): string[] =>
      commands
        .filter((command) => command.type !== 'remove' && command.type !== 'updateAttrs' && command.type !== 'clear')
        .map((command) => doc.getBlockById((command as { blockId: string }).blockId)?.content ?? '');

    it('rebuilds only the blocks whose definition changed', () => {
      const doc = new MarkdownDocument();
      const before = '# T\n\n[a][x]\n\n[b][y]\n\n[x]: one\n\n[y]: two\n';
      doc.update(before, { blockHashInput: hashInput(before) });

      const after = '# T\n\n[a][x]\n\n[b][y]\n\n[x]: CHANGED\n\n[y]: two\n';
      const result = doc.update(after, { blockHashInput: hashInput(after) });
      const rebuilt = renderedBlocks(doc, result.commands);

      assert.ok(rebuilt.includes('[a][x]'), 'the block using the edited label must re-render');
      assert.ok(rebuilt.includes('[x]: CHANGED'), 'the definition block itself changed');
      assert.ok(!rebuilt.includes('[b][y]'), 'a block on an untouched label must not re-render');
      assert.ok(!rebuilt.includes('# T'), 'unrelated blocks must not re-render');
    });

    it('emits no DOM commands for an unchanged re-render', () => {
      const doc = new MarkdownDocument();
      const markdown = '# T\n\n[a][x]\n\n[x]: one\n';
      doc.update(markdown, { blockHashInput: hashInput(markdown) });

      const result = doc.update(markdown, { blockHashInput: hashInput(markdown) });
      assert.deepStrictEqual(result.commands, []);
    });

    it('rebuilds the referencing block when a definition is added later', () => {
      const doc = new MarkdownDocument();
      const before = '# T\n\n[a][x]\n';
      doc.update(before, { blockHashInput: hashInput(before) });

      const after = '# T\n\n[a][x]\n\n[x]: https://example.com\n';
      const result = doc.update(after, { blockHashInput: hashInput(after) });
      const rebuilt = renderedBlocks(doc, result.commands);

      assert.ok(rebuilt.includes('[a][x]'), 'the reference must re-render once its definition exists');
    });
  });
});
