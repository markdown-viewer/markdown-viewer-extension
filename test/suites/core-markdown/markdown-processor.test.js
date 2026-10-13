import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as xml from 'xml';

// Setup fibjs DOM as global document for DOM-related tests. This file owns the
// global document for the whole fibjs test/all.test.js run — sibling files in
// that aggregate must not read/replace `document` (html-plugin does, which is
// why it lives in the node `npm test` list instead).
const htmlDoc = new xml.Document('text/html');
globalThis.document = htmlDoc;

// Define Node constants for fibjs (not provided by fibjs xml module)
if (typeof globalThis.Node === 'undefined') {
  globalThis.Node = {
    ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
  };
}

import {
  normalizeMathBlocks,
  splitMarkdownIntoBlocks,
  splitMarkdownIntoBlocksWithLines,
  escapeHtml,
  processTablesForWordCompatibility,
  extractTitle,
  AsyncTaskManager,
  createMarkdownProcessor,
  isSafeUrl,
  isSafeSrcset,
  sanitizeRenderedHtml,
  extractHeadings,
} from '../../../src/core/markdown-processor.ts';
import { hashCode, generateContentHash } from '../../../src/utils/hash.ts';
import { sanitizeHtml } from '../../../src/utils/html-sanitizer.ts';
import { EXTRA_HIGHLIGHT_GRAMMARS } from '../../../src/utils/extra-highlight-grammars.ts';
import hljs from '../../../src/utils/highlight-registry.ts';
import { replacePlaceholderWithImage, convertPluginResultToHTML } from '../../../src/plugins/plugin-html-utils.ts';

// Create a container for DOM tests
const container = htmlDoc.createElement('div');
container.setAttribute('id', 'markdown-content');
htmlDoc.body.appendChild(container);

// [language, a snippet that grammar tokenises] for every grammar in
// src/utils/extra-highlight-grammars.ts, plus `bat` — which is not a grammar
// name but the alias EXT_LANG_MAP routes .bat/.cmd to (the grammar ships as
// `dos`). See there for why these live outside lowlight's `common` set.
const EXTRA_FENCE_SAMPLES = [
  ['erlang', '-module(counter).\nstart(N) -> {ok, N + 1}.'],
  ['scala', 'def add(a: Int, b: Int): Int = a + b'],
  ['dart', 'void main() { print("hi"); }'],
  ['powershell', '$items = Get-ChildItem'],
  ['bat', 'echo off'],
  ['latex', '\\documentclass{article}'],
  ['haskell', 'add :: Int -> Int -> Int'],
  ['elixir', 'defmodule Counter do'],
  ['clojure', '(defn add [a b] (+ a b))'],
  ['fsharp', 'let add a b = a + b'],
  ['graphql', 'type Query { hello: String }'],
];

describe('markdown-processor', () => {
  describe('normalizeMathBlocks', () => {
    it('should convert single-line $$ to multi-line', () => {
      const input = '$$x=1$$';
      const result = normalizeMathBlocks(input);
      assert.ok(result.includes('\n$$\nx=1\n$$\n'), 'Should expand to multi-line');
    });

    it('should not change already multi-line math blocks', () => {
      const input = '$$\nx=1\n$$';
      const result = normalizeMathBlocks(input);
      assert.strictEqual(result, input);
    });

    it('should handle multiple math blocks', () => {
      const input = '$$a+b$$\n\n$$c+d$$';
      const result = normalizeMathBlocks(input);
      assert.ok(result.includes('a+b'), 'Should contain first formula');
      assert.ok(result.includes('c+d'), 'Should contain second formula');
    });

    it('should handle math with spaces', () => {
      const input = '$$  x + y  $$';
      const result = normalizeMathBlocks(input);
      assert.ok(result.includes('x + y'), 'Should preserve formula content');
    });

    it('should not affect inline math', () => {
      const input = 'This is $x=1$ inline math';
      const result = normalizeMathBlocks(input);
      assert.strictEqual(result, input, 'Inline math should not be changed');
    });
  });

  describe('escapeHtml', () => {
    it('should escape < and >', () => {
      assert.strictEqual(escapeHtml('<div>'), '&lt;div&gt;');
    });

    it('should escape &', () => {
      assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    });

    it('should escape quotes', () => {
      assert.strictEqual(escapeHtml('"\''), '&quot;&#039;');
    });

    it('should handle empty string', () => {
      assert.strictEqual(escapeHtml(''), '');
    });

    it('should handle multiple special characters', () => {
      assert.strictEqual(escapeHtml('<a href="test">'), '&lt;a href=&quot;test&quot;&gt;');
    });

    it('should handle text without special characters', () => {
      assert.strictEqual(escapeHtml('hello world'), 'hello world');
    });
  });

  describe('processTablesForWordCompatibility', () => {
    it('should wrap tables with center div by default', () => {
      const input = '<table><tr><td>test</td></tr></table>';
      const result = processTablesForWordCompatibility(input);
      assert.ok(result.includes('<div align="center">'), 'Should have center div');
      assert.ok(result.includes('table align="center"'), 'Table should have align');
      assert.ok(result.includes('</table></div>'), 'Should close properly');
    });

    it('should handle multiple tables with center layout (default)', () => {
      const input = '<table></table><p>text</p><table></table>';
      const result = processTablesForWordCompatibility(input);
      const matches = result.match(/<div align="center">/g);
      assert.strictEqual(matches?.length, 2, 'Should wrap both tables');
    });

    it('should not wrap tables when layout is left', () => {
      const input = '<table><tr><td>test</td></tr></table>';
      const result = processTablesForWordCompatibility(input, 'left');
      assert.strictEqual(result, input, 'Should not modify table');
    });

    it('should wrap tables when layout is explicitly center', () => {
      const input = '<table><tr><td>test</td></tr></table>';
      const result = processTablesForWordCompatibility(input, 'center');
      assert.ok(result.includes('<div align="center">'), 'Should have center div');
    });

    it('should not affect non-table content', () => {
      const input = '<p>no table here</p>';
      const result = processTablesForWordCompatibility(input);
      assert.strictEqual(result, input);
    });
  });

  describe('extractTitle', () => {
    it('should extract h1 title', () => {
      assert.strictEqual(extractTitle('# Hello World'), 'Hello World');
    });

    it('should extract first h1 from multi-line', () => {
      assert.strictEqual(extractTitle('Some text\n# Title\nMore text'), 'Title');
    });

    it('should return null if no title', () => {
      assert.strictEqual(extractTitle('No heading here'), null);
    });

    it('should trim whitespace', () => {
      assert.strictEqual(extractTitle('#   Spaced Title   '), 'Spaced Title');
    });

    it('should not match ## as h1', () => {
      assert.strictEqual(extractTitle('## Not H1'), null);
    });

    it('should handle empty input', () => {
      assert.strictEqual(extractTitle(''), null);
    });

    it('should extract first h1 when multiple exist', () => {
      assert.strictEqual(extractTitle('# First\n# Second'), 'First');
    });
  });

  describe('markdown code highlighting', () => {
    it('should render markdown code blocks with shiki output', async () => {
      const processor = createMarkdownProcessor(
        { render: async () => null },
        new AsyncTaskManager(),
      );

      const input = [
        '```markdown',
        '# Title',
        '',
        '- [x] item with **strong** and *em*',
        '[link](target.md)',
        '| col | value |',
        '| --- | ---: |',
        '```js',
        '# not heading',
        '```',
        '```',
      ].join('\n');

      const output = String(await processor.process(input));

      assert.ok(output.includes('class="shiki vitesse-light"'), 'Should replace markdown code blocks with Shiki pre output');
      assert.ok(output.includes('class="line"'), 'Should preserve Shiki line wrappers');
      assert.ok(output.includes('Title'), 'Should highlight markdown heading content');
      assert.ok(output.includes('item with'), 'Should highlight markdown list content');
      assert.ok(output.includes('target.md'), 'Should highlight markdown links');
      // Shiki tokenizes the fence markers and the info string separately, so
      // "```js" is emitted as two adjacent spans (`<span>```</span><span>js</span>`);
      // assert the sequence allowing an intervening token span instead of a
      // contiguous substring (fails whenever Shiki actually renders).
      assert.ok(
        /```(?:<\/span><span[^>]*>)?js/.test(output),
        'Should preserve fenced code info string content',
      );
      assert.ok(output.includes('# not heading'), 'Should preserve fenced code content');
      assert.ok(!output.includes('hljs-bullet'), 'Should no longer use the fallback highlight.js markdown tokenizer');
    });

    it('should leave the code background to the theme, not Shiki', async () => {
      const processor = createMarkdownProcessor(
        { render: async () => null },
        new AsyncTaskManager(),
      );

      const output = String(await processor.process('```markdown\n# Title\n```\n'));
      const preTag = output.match(/<pre[^>]*>/)?.[0] ?? '';

      assert.ok(preTag.includes('class="shiki vitesse-light"'), 'Should render the Shiki pre');
      // #markdown-content pre carries the theme's code background; Shiki's
      // inline background (vitesse white) used to win over it, so the fence
      // lost the document's code surface.
      assert.ok(!/background/i.test(preTag), 'Shiki must not inline a code background');
      assert.ok(preTag.includes('color:'), 'Should keep the Shiki foreground on the pre');
      assert.ok(/<span[^>]*style="[^"]*color:/.test(output), 'Should keep inline token colours');
    });

    // `rehype-highlight` defaults to lowlight's `common` grammar set, which has
    // no Erlang. The `languages` option REPLACES that default rather than
    // extending it, so the regression this guards is two-sided: the extra
    // grammars must gain token spans AND the pre-existing common languages must
    // keep theirs.
    const tokenSpanCount = (html, language) => {
      const block = html.match(new RegExp(`language-${language}[\\s\\S]*?</code>`));
      if (!block) return -1;
      return (block[0].match(/<span class="hljs-[a-z0-9_-]+"/g) ?? []).length;
    };

    it('should highlight erlang fences (grammar is outside lowlight common)', async () => {
      const processor = createMarkdownProcessor(
        { render: async () => null },
        new AsyncTaskManager(),
      );

      const input = ['```erlang', '-module(counter).', 'start(N) ->', '    {ok, N + 1}.', '```'].join('\n');
      const output = String(await processor.process(input));

      assert.ok(output.includes('class="hljs language-erlang"'), 'Should tag the code element as erlang');
      assert.ok(tokenSpanCount(output, 'erlang') > 0, 'Should emit highlight.js token spans for erlang');
      assert.ok(output.includes('hljs-keyword'), 'Should tokenise erlang keywords');
    });

    it('should highlight fences for every extra grammar and the bat alias', async () => {
      const processor = createMarkdownProcessor(
        { render: async () => null },
        new AsyncTaskManager(),
      );

      // Every registered grammar must be exercised here — a new entry in
      // extra-highlight-grammars.ts that skips this table would go untested.
      // Some entries are reachable through a fence alias rather than their
      // registered name (`dos` → `bat`, `erlang` → `erl`), so match either.
      const coveredNames = new Set(EXTRA_FENCE_SAMPLES.map(([language]) => language));
      const uncovered = Object.keys(EXTRA_HIGHLIGHT_GRAMMARS).filter((registered) => {
        if (coveredNames.has(registered)) return false;
        const aliases = hljs.getLanguage(registered)?.aliases ?? [];
        return !aliases.some((alias) => coveredNames.has(alias));
      });
      assert.deepStrictEqual(uncovered, [], `EXTRA_FENCE_SAMPLES is missing: ${uncovered.join(', ')}`);

      for (const [language, sample] of EXTRA_FENCE_SAMPLES) {
        const output = String(await processor.process(['```' + language, sample, '```'].join('\n')));

        assert.ok(
          tokenSpanCount(output, language) > 0,
          `${language} should emit highlight.js token spans`,
        );
      }
    });

    it('should not drop the default common languages when adding the extra grammars', async () => {
      const processor = createMarkdownProcessor(
        { render: async () => null },
        new AsyncTaskManager(),
      );

      const input = [
        '```erlang',
        '-module(counter).',
        '```',
        '',
        '```bash',
        'echo hello',
        '```',
        '',
        '```python',
        'def add(a, b): pass',
        '```',
        '',
      ].join('\n');
      const output = String(await processor.process(input));

      // Passing `{ languages: EXTRA_HIGHLIGHT_GRAMMARS }` instead of spreading
      // `common` would zero these out while still satisfying the assertions above.
      assert.ok(tokenSpanCount(output, 'erlang') > 0, 'erlang should be highlighted');
      assert.ok(tokenSpanCount(output, 'bash') > 0, 'bash should still be highlighted');
      assert.ok(tokenSpanCount(output, 'python') > 0, 'python should still be highlighted');
    });
  });

  describe('hashCode', () => {
    it('should return consistent hash', () => {
      const hash1 = hashCode('test');
      const hash2 = hashCode('test');
      assert.strictEqual(hash1, hash2);
    });

    it('should return different hash for different content', () => {
      const hash1 = hashCode('test1');
      const hash2 = hashCode('test2');
      assert.notStrictEqual(hash1, hash2);
    });

    it('should return hex string', () => {
      const hash = hashCode('test');
      assert.ok(/^[0-9a-f]+$/.test(hash), 'Hash should be hex string');
    });

    it('should handle empty string', () => {
      const hash = hashCode('');
      assert.ok(hash.length > 0, 'Should return non-empty hash');
    });

    it('should handle unicode', () => {
      const hash1 = hashCode('你好');
      const hash2 = hashCode('你好');
      assert.strictEqual(hash1, hash2);
    });
  });

  describe('AsyncTaskManager', () => {
    it('should generate unique IDs', () => {
      const manager = new AsyncTaskManager();
      const id1 = manager.generateId();
      const id2 = manager.generateId();
      assert.notStrictEqual(id1, id2);
      assert.ok(id1.startsWith('async-placeholder-'));
      assert.ok(id2.startsWith('async-placeholder-'));
    });

    it('should start with pending count 0', () => {
      const manager = new AsyncTaskManager();
      assert.strictEqual(manager.pendingCount, 0);
    });

    it('should not be aborted initially', () => {
      const manager = new AsyncTaskManager();
      assert.strictEqual(manager.isAborted(), false);
    });

    it('should set aborted flag on abort', () => {
      const manager = new AsyncTaskManager();
      manager.abort();
      assert.strictEqual(manager.isAborted(), true);
    });

    it('should reset state on reset', () => {
      const manager = new AsyncTaskManager();
      manager.generateId();
      manager.abort();
      manager.reset();
      assert.strictEqual(manager.isAborted(), false);
      // IDs should restart
      const newId = manager.generateId();
      assert.strictEqual(newId, 'async-placeholder-1');
    });

    it('should create tasks with placeholder', () => {
      const manager = new AsyncTaskManager();
      const { task, placeholder } = manager.createTask(
        async () => {},
        { code: 'test' },
        null,
        'ready'
      );
      assert.ok(task.id.startsWith('async-placeholder-'));
      assert.strictEqual(placeholder.type, 'html');
      assert.ok(placeholder.value.includes(task.id));
      assert.strictEqual(manager.pendingCount, 1);
    });

    it('should handle translate function', () => {
      const translate = (key) => `translated:${key}`;
      const manager = new AsyncTaskManager(translate);
      const { placeholder } = manager.createTask(async () => {}, {}, null, 'ready');
      // Placeholder should use translation
      assert.ok(placeholder.value.length > 0);
    });

    it('should process empty queue', async () => {
      const manager = new AsyncTaskManager();
      const result = await manager.processAll();
      assert.strictEqual(result, true);
    });

    it('should track task context for cancellation', () => {
      const manager = new AsyncTaskManager();
      const context1 = manager.getContext();
      assert.strictEqual(context1.cancelled, false);

      manager.abort();
      assert.strictEqual(context1.cancelled, true);

      manager.reset();
      const context2 = manager.getContext();
      assert.strictEqual(context2.cancelled, false);
      // Old context should still be cancelled
      assert.strictEqual(context1.cancelled, true);
    });

    it('should include sourceHash in task.data', () => {
      const manager = new AsyncTaskManager();
      const mockPlugin = { type: 'mermaid', isInline: () => false };
      
      const { task } = manager.createTask(
        async () => {},
        { code: 'graph A-->B' },
        mockPlugin,
        'ready'
      );
      
      // task.data must contain sourceHash
      assert.ok(task.data.sourceHash, 'task.data should have sourceHash');
      assert.strictEqual(typeof task.data.sourceHash, 'string', 'sourceHash should be string');
      assert.ok(task.data.sourceHash.length > 0, 'sourceHash should not be empty');
    });

    it('should generate consistent sourceHash for same content', () => {
      const manager = new AsyncTaskManager();
      const mockPlugin = { type: 'mermaid', isInline: () => false };
      
      const { task: task1 } = manager.createTask(
        async () => {},
        { code: 'graph A-->B' },
        mockPlugin,
        'ready'
      );
      
      manager.reset();
      
      const { task: task2 } = manager.createTask(
        async () => {},
        { code: 'graph A-->B' },
        mockPlugin,
        'ready'
      );
      
      assert.strictEqual(task1.data.sourceHash, task2.data.sourceHash, 
        'Same content should produce same sourceHash');
    });

    it('should generate different sourceHash for different content', () => {
      const manager = new AsyncTaskManager();
      const mockPlugin = { type: 'mermaid', isInline: () => false };
      
      const { task: task1 } = manager.createTask(
        async () => {},
        { code: 'graph A-->B' },
        mockPlugin,
        'ready'
      );
      
      const { task: task2 } = manager.createTask(
        async () => {},
        { code: 'graph X-->Y' },
        mockPlugin,
        'ready'
      );
      
      assert.notStrictEqual(task1.data.sourceHash, task2.data.sourceHash, 
        'Different content should produce different sourceHash');
    });

    it('should generate different sourceHash for same code but different plugin type', () => {
      const manager = new AsyncTaskManager();
      
      const { task: task1 } = manager.createTask(
        async () => {},
        { code: 'same code' },
        { type: 'mermaid', isInline: () => false },
        'ready'
      );
      
      const { task: task2 } = manager.createTask(
        async () => {},
        { code: 'same code' },
        { type: 'vega', isInline: () => false },
        'ready'
      );
      
      assert.notStrictEqual(task1.data.sourceHash, task2.data.sourceHash, 
        'Same code with different plugin type should produce different sourceHash');
    });

    it('should have matching sourceHash in placeholder HTML and task.data', () => {
      const manager = new AsyncTaskManager();
      const mockPlugin = { type: 'mermaid', isInline: () => false };
      
      const { task, placeholder } = manager.createTask(
        async () => {},
        { code: 'graph A-->B' },
        mockPlugin,
        'ready'
      );
      
      // Extract sourceHash from placeholder HTML
      const match = placeholder.value.match(/data-source-hash="([^"]+)"/);
      assert.ok(match, 'Placeholder should contain data-source-hash attribute');
      
      const placeholderHash = match[1];
      assert.strictEqual(placeholderHash, task.data.sourceHash, 
        'Placeholder data-source-hash should match task.data.sourceHash');
    });
  });

  describe('Block Hash Consistency', () => {
    it('should produce same hash for identical blocks', () => {
      const block = '# Title\n\nSome content here.';
      const hash1 = hashCode(block);
      const hash2 = hashCode(block);
      assert.strictEqual(hash1, hash2);
    });

    it('should produce different hash for different blocks', () => {
      const block1 = '# Title';
      const block2 = '# Different Title';
      const hash1 = hashCode(block1);
      const hash2 = hashCode(block2);
      assert.notStrictEqual(hash1, hash2);
    });

    it('should detect whitespace differences', () => {
      const block1 = '# Title';
      const block2 = '#  Title';
      const hash1 = hashCode(block1);
      const hash2 = hashCode(block2);
      assert.notStrictEqual(hash1, hash2);
    });
  });

  describe('Incremental Update Simulation', () => {
    // Simulate the block-based diff logic without DOM
    function simulateBlockDiff(oldMd, newMd) {
      const oldBlocks = splitMarkdownIntoBlocksWithLines(normalizeMathBlocks(oldMd));
      const newBlocks = splitMarkdownIntoBlocksWithLines(normalizeMathBlocks(newMd));

      const oldHashes = oldBlocks.map((b) => hashCode(b.content));
      const newHashes = newBlocks.map((b) => hashCode(b.content));

      const changes = {
        unchanged: 0,
        added: 0,
        removed: 0,
        modified: 0,
      };

      // Simple diff: count matches
      const oldSet = new Set(oldHashes);
      const newSet = new Set(newHashes);

      for (const hash of newHashes) {
        if (oldSet.has(hash)) {
          changes.unchanged++;
        } else {
          changes.added++;
        }
      }

      for (const hash of oldHashes) {
        if (!newSet.has(hash)) {
          changes.removed++;
        }
      }

      return changes;
    }

    it('should detect no changes for identical content', () => {
      const md = '# Title\n\nParagraph';
      const changes = simulateBlockDiff(md, md);
      assert.strictEqual(changes.added, 0);
      assert.strictEqual(changes.removed, 0);
      assert.ok(changes.unchanged > 0);
    });

    it('should detect added blocks', () => {
      const oldMd = '# Title';
      const newMd = '# Title\n\nNew paragraph';
      const changes = simulateBlockDiff(oldMd, newMd);
      assert.ok(changes.added > 0, 'Should have added blocks');
    });

    it('should detect removed blocks', () => {
      const oldMd = '# Title\n\nParagraph';
      const newMd = '# Title';
      const changes = simulateBlockDiff(oldMd, newMd);
      assert.ok(changes.removed > 0, 'Should have removed blocks');
    });

    it('should handle complex edits', () => {
      const oldMd = `# Title

Paragraph 1

Paragraph 2

Paragraph 3`;
      const newMd = `# Title

Paragraph 1

Modified paragraph

Paragraph 3`;
      const changes = simulateBlockDiff(oldMd, newMd);
      // Title, Para 1, and Para 3 unchanged; Para 2 removed; Modified added
      assert.strictEqual(changes.unchanged, 3);
      assert.strictEqual(changes.added, 1);
      assert.strictEqual(changes.removed, 1);
    });

    it('should preserve block boundaries after edit', () => {
      const md1 = '# Title\n\n```js\ncode\n```\n\nText';
      const md2 = '# Title\n\n```js\ncode modified\n```\n\nText';

      const blocks1 = splitMarkdownIntoBlocksWithLines(md1);
      const blocks2 = splitMarkdownIntoBlocksWithLines(md2);

      assert.strictEqual(blocks1.length, blocks2.length, 'Block count should be same');
      assert.strictEqual(blocks1[0].content, blocks2[0].content, 'Title unchanged');
      assert.notStrictEqual(blocks1[1].content, blocks2[1].content, 'Code block changed');
      assert.strictEqual(blocks1[2].content, blocks2[2].content, 'Text unchanged');
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long lines', () => {
      const longLine = 'x'.repeat(10000);
      const result = splitMarkdownIntoBlocks(longLine);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].length, 10000);
    });

    it('should handle many small blocks', () => {
      const blocks = [];
      for (let i = 0; i < 1000; i++) {
        blocks.push(`Block ${i}`);
      }
      const md = blocks.join('\n\n');
      const result = splitMarkdownIntoBlocks(md);
      assert.strictEqual(result.length, 1000);
    });

    it('should handle unicode content', () => {
      const md = '# 标题\n\n你好世界\n\n日本語テスト';
      const result = splitMarkdownIntoBlocks(md);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0], '# 标题');
    });

    it('should handle mixed line endings', () => {
      const md = '# Title\r\n\r\nParagraph\n\nMore';
      const result = splitMarkdownIntoBlocks(md);
      assert.ok(result.length >= 2);
    });

    it('should handle nested structures', () => {
      const md = `> Blockquote
> with multiple lines
>
> > Nested quote`;
      const result = splitMarkdownIntoBlocks(md);
      assert.strictEqual(result.length, 1, 'Nested blockquote should be one block');
    });
  });

  // ==========================================================================
  // DOM-related Tests (requires fibjs xml module)
  // ==========================================================================

  describe('replacePlaceholderWithImage', () => {
    // Helper to create placeholder HTML
    function createPlaceholderHtml(id, pluginType, sourceHash) {
      return `<div id="${id}" class="async-placeholder ${pluginType}-placeholder" data-source-hash="${sourceHash}" data-plugin-type="${pluginType}">Loading...</div>`;
    }

    // Helper to create render result
    function createRenderResult(code) {
      return {
        base64: Buffer.from(`rendered:${code}`).toString('base64'),
        width: 400,
        height: 200
      };
    }

    it('should replace placeholder with rendered image', () => {
      const id = 'test-placeholder-1';
      const sourceHash = generateContentHash('mermaid', 'graph A-->B');
      
      container.innerHTML = createPlaceholderHtml(id, 'mermaid', sourceHash);
      
      const result = createRenderResult('graph A-->B');
      replacePlaceholderWithImage(id, result, 'mermaid', false, sourceHash);
      
      // Placeholder should be replaced
      assert.strictEqual(htmlDoc.getElementById(id), null, 'Placeholder should be gone');
      
      // Image should exist
      const img = container.querySelector('img');
      assert.ok(img !== null, 'Image should exist');
      assert.ok(img.getAttribute('src').includes('base64'), 'Should have base64 src');
    });

    it('should preserve source hash in rendered element', () => {
      const id = 'test-placeholder-2';
      const sourceHash = generateContentHash('mermaid', 'graph X-->Y');
      
      container.innerHTML = createPlaceholderHtml(id, 'mermaid', sourceHash);
      
      const result = createRenderResult('graph X-->Y');
      replacePlaceholderWithImage(id, result, 'mermaid', false, sourceHash);
      
      const rendered = container.querySelector('[data-plugin-rendered="true"]');
      assert.ok(rendered !== null, 'Rendered element should exist');
      assert.strictEqual(rendered.getAttribute('data-source-hash'), sourceHash, 'Source hash should be preserved');
    });

    it('should handle inline rendering', () => {
      const id = 'test-placeholder-3';
      const sourceHash = generateContentHash('mermaid', 'inline');
      
      container.innerHTML = createPlaceholderHtml(id, 'mermaid', sourceHash);
      
      const result = createRenderResult('inline');
      replacePlaceholderWithImage(id, result, 'mermaid', true, sourceHash);
      
      const rendered = container.querySelector('.diagram-inline');
      assert.ok(rendered !== null, 'Inline diagram should have correct class');
    });

    it('should handle block rendering', () => {
      const id = 'test-placeholder-4';
      const sourceHash = generateContentHash('mermaid', 'block');
      
      container.innerHTML = createPlaceholderHtml(id, 'mermaid', sourceHash);
      
      const result = createRenderResult('block');
      replacePlaceholderWithImage(id, result, 'mermaid', false, sourceHash);
      
      const rendered = container.querySelector('.diagram-block');
      assert.ok(rendered !== null, 'Block diagram should have correct class');
    });

    it('should do nothing if placeholder not found', () => {
      container.innerHTML = '<div>Other content</div>';
      
      const result = createRenderResult('test');
      const sourceHash = generateContentHash('mermaid', 'test');
      // Should not throw
      replacePlaceholderWithImage('non-existent-id', result, 'mermaid', false, sourceHash);
      
      assert.strictEqual(container.innerHTML, '<div>Other content</div>', 'Content should be unchanged');
    });
  });

  describe('Race Condition Prevention', () => {
    // Helper to create placeholder HTML
    function createPlaceholderHtml(id, pluginType, sourceHash) {
      return `<div id="${id}" class="async-placeholder ${pluginType}-placeholder" data-source-hash="${sourceHash}" data-plugin-type="${pluginType}">Loading...</div>`;
    }

    // Helper to create render result
    function createRenderResult(code) {
      return {
        base64: Buffer.from(`RESULT_FOR_${code}`).toString('base64'),
        width: 400,
        height: 200
      };
    }

    it('should apply render result to correct placeholder by hash', () => {
      const code1 = 'graph A-->B';
      const code2 = 'graph X-->Y';
      const hash1 = generateContentHash('mermaid', code1);
      const hash2 = generateContentHash('mermaid', code2);
      
      // Setup: two placeholders with different hashes
      container.innerHTML = `
        <div data-block-id="block-1">${createPlaceholderHtml('placeholder-1', 'mermaid', hash1)}</div>
        <div data-block-id="block-2">${createPlaceholderHtml('placeholder-2', 'mermaid', hash2)}</div>
      `;
      
      // Apply results in order
      replacePlaceholderWithImage('placeholder-1', createRenderResult(code1), 'mermaid', false, hash1);
      replacePlaceholderWithImage('placeholder-2', createRenderResult(code2), 'mermaid', false, hash2);
      
      // Check results
      const block1Img = container.querySelector('[data-block-id="block-1"] img');
      const block2Img = container.querySelector('[data-block-id="block-2"] img');
      
      assert.ok(block1Img !== null, 'Block 1 should have image');
      assert.ok(block2Img !== null, 'Block 2 should have image');
      
      const block1Content = Buffer.from(block1Img.getAttribute('src').replace('data:image/png;base64,', ''), 'base64').toString();
      const block2Content = Buffer.from(block2Img.getAttribute('src').replace('data:image/png;base64,', ''), 'base64').toString();
      
      assert.ok(block1Content.includes('graph A-->B'), 'Block 1 should have result for code1');
      assert.ok(block2Content.includes('graph X-->Y'), 'Block 2 should have result for code2');
    });

    it('should reject render result when hash mismatches (race condition scenario)', () => {
      const code1 = 'graph A-->B';
      const code2 = 'graph X-->Y';
      const hash1 = generateContentHash('mermaid', code1);
      const hash2 = generateContentHash('mermaid', code2);
      
      // Setup: placeholder has hash2 but we try to apply result for hash1
      // This simulates the race condition where placeholder was updated during async render
      container.innerHTML = `
        <div data-block-id="block-1">${createPlaceholderHtml('placeholder-1', 'mermaid', hash2)}</div>
      `;
      
      // Try to apply result for hash1 to placeholder with hash2
      replacePlaceholderWithImage('placeholder-1', createRenderResult(code1), 'mermaid', false, hash1);
      
      // Placeholder should still exist (not replaced) because hash mismatch
      const placeholder = htmlDoc.getElementById('placeholder-1');
      assert.ok(placeholder !== null, 'Placeholder should still exist due to hash mismatch');
      assert.strictEqual(placeholder.getAttribute('data-source-hash'), hash2, 'Placeholder hash should be unchanged');
    });

    it('should handle swapped placeholders during incremental update', () => {
      const code1 = 'graph A-->B';
      const code2 = 'graph X-->Y';
      const hash1 = generateContentHash('mermaid', code1);
      const hash2 = generateContentHash('mermaid', code2);
      
      // Initial setup
      container.innerHTML = `
        <div data-block-id="block-1">${createPlaceholderHtml('placeholder-1', 'mermaid', hash1)}</div>
        <div data-block-id="block-2">${createPlaceholderHtml('placeholder-2', 'mermaid', hash2)}</div>
      `;
      
      // Simulate incremental update that swaps hashes (content modification)
      const block1 = container.querySelector('[data-block-id="block-1"]');
      const block2 = container.querySelector('[data-block-id="block-2"]');
      block1.innerHTML = createPlaceholderHtml('placeholder-1', 'mermaid', hash2);
      block2.innerHTML = createPlaceholderHtml('placeholder-2', 'mermaid', hash1);
      
      // Now render results come back with original hashes
      const result1 = createRenderResult(code1); // For hash1
      const result2 = createRenderResult(code2); // For hash2
      
      // Apply results with expected hashes - should be rejected due to mismatch
      replacePlaceholderWithImage('placeholder-1', result1, 'mermaid', false, hash1);
      replacePlaceholderWithImage('placeholder-2', result2, 'mermaid', false, hash2);
      
      // Both placeholders should still exist (hash mismatch protection)
      const p1 = htmlDoc.getElementById('placeholder-1');
      const p2 = htmlDoc.getElementById('placeholder-2');
      
      assert.ok(p1 !== null, 'placeholder-1 should still exist (hash mismatch)');
      assert.ok(p2 !== null, 'placeholder-2 should still exist (hash mismatch)');
    });
  });

  describe('AsyncTaskManager with DOM', () => {
    it('should create placeholder that can be inserted into DOM', () => {
      const manager = new AsyncTaskManager();
      const { task, placeholder } = manager.createTask(
        async () => {},
        { code: 'test code' },
        null,
        'ready'
      );
      
      container.innerHTML = placeholder.value;
      
      const placeholderEl = htmlDoc.getElementById(task.id);
      assert.ok(placeholderEl !== null, 'Placeholder element should be in DOM');
      assert.ok(placeholderEl.getAttribute('data-source-hash'), 'Should have source hash');
    });

    it('should pass correct sourceHash to task callback', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      const mockPlugin = { type: 'mermaid', isInline: () => false };
      let receivedSourceHash = null;
      
      const { task, placeholder } = manager.createTask(
        async (data) => {
          receivedSourceHash = data.sourceHash;
        },
        { code: 'graph A-->B' },
        mockPlugin,
        'ready'
      );
      
      container.innerHTML = placeholder.value;
      await manager.processAll();
      
      assert.ok(receivedSourceHash !== null, 'Callback should receive sourceHash');
      assert.strictEqual(receivedSourceHash, task.data.sourceHash, 
        'Callback sourceHash should match task.data.sourceHash');
    });

    it('should degrade a failed fetch to a plain <img> when a fallback URL exists', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      // SVG image node: inline, and its URL can be loaded by the browser even
      // when the platform refuses to read the file for us.
      const mockPlugin = { type: 'svg', isInline: () => true };
      const { task, placeholder } = manager.createTask(
        async () => {},
        { code: './assets/logo.svg', fetchFallbackUrl: './assets/logo.svg' },
        mockPlugin,
        'fetching'
      );

      container.innerHTML = `<div class="block" data-block-id="b1">${placeholder.value}</div>`;

      // Emulate plugin.fetchContent() rejecting (e.g. Firefox refuses to read
      // file:// from a content script): the task manager renders the task in
      // its error state.
      task.setError(new Error('Cannot load SVG file: ./assets/logo.svg - NetworkError'));

      await manager.processAll();

      assert.strictEqual(htmlDoc.getElementById(task.id), null, 'Placeholder should be replaced');
      const fallback = container.querySelector('img');
      assert.ok(fallback !== null, 'Fallback should be rendered as a plain <img>');
      assert.ok(fallback.getAttribute('data-plugin-rendered') === 'true',
        'Fallback should keep the placeholder source hash for DOM diff matching');
      assert.strictEqual(fallback.getAttribute('src'), './assets/logo.svg',
        'Fallback <img> should point at the original URL');
      assert.strictEqual(container.querySelector('pre'), null, 'No error block when the fallback applies');
    });

    it('should still report an error when no fetch fallback is available', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      const { task, placeholder } = manager.createTask(
        async () => {},
        { code: 'broken content' },
        { type: 'svg', isInline: () => false },
        'fetching'
      );

      container.innerHTML = `<div class="block" data-block-id="b2">${placeholder.value}</div>`;
      task.setError(new Error('Cannot load SVG file: broken content'));

      await manager.processAll();

      assert.strictEqual(htmlDoc.getElementById(task.id), null, 'Placeholder should be replaced');
      assert.ok(container.querySelector('pre') !== null, 'Error block should be rendered');
    });

    it('should have sourceHash available for replacePlaceholderWithImage in callback', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      const mockPlugin = { type: 'mermaid', isInline: () => false };
      const code = 'graph A-->B';
      
      const { task, placeholder } = manager.createTask(
        async (data) => {
          const result = {
            base64: Buffer.from(`rendered:${data.code}`).toString('base64'),
            width: 400,
            height: 200
          };
          // This is what the real code does - use sourceHash from data
          replacePlaceholderWithImage(data.id, result, 'mermaid', false, data.sourceHash);
        },
        { code },
        mockPlugin,
        'ready'
      );
      
      container.innerHTML = placeholder.value;
      
      // Verify placeholder has correct sourceHash before processing
      const placeholderEl = htmlDoc.getElementById(task.id);
      const placeholderHash = placeholderEl.getAttribute('data-source-hash');
      assert.strictEqual(placeholderHash, task.data.sourceHash, 
        'Placeholder hash should match task.data.sourceHash before processing');
      
      await manager.processAll();
      
      // Placeholder should be replaced
      assert.strictEqual(htmlDoc.getElementById(task.id), null, 'Placeholder should be replaced');
      
      // Rendered content should exist
      const rendered = container.querySelector('[data-plugin-rendered="true"]');
      assert.ok(rendered !== null, 'Rendered content should exist');
    });

    it('should process task that manipulates DOM', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      
      const { task, placeholder } = manager.createTask(
        async (data) => {
          const el = htmlDoc.getElementById(data.id);
          if (el) {
            el.outerHTML = `<div class="rendered" data-task-id="${data.id}">Done</div>`;
          }
        },
        { code: 'test' },
        null,
        'ready'
      );
      
      container.innerHTML = placeholder.value;
      await manager.processAll();
      
      const rendered = container.querySelector('.rendered');
      assert.ok(rendered !== null, 'Rendered content should exist');
      assert.strictEqual(htmlDoc.getElementById(task.id), null, 'Placeholder should be gone');
    });

    it('should handle concurrent tasks with different completion times', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      const executionOrder = [];
      
      // Create slow task
      const task1 = manager.createTask(
        async (data) => {
          await new Promise(r => setTimeout(r, 50));
          executionOrder.push('task1');
          const el = htmlDoc.getElementById(data.id);
          if (el) {
            el.outerHTML = `<div class="result" data-task="1">Result 1</div>`;
          }
        },
        { code: 'slow' },
        null,
        'ready'
      );
      
      // Create fast task
      const task2 = manager.createTask(
        async (data) => {
          await new Promise(r => setTimeout(r, 10));
          executionOrder.push('task2');
          const el = htmlDoc.getElementById(data.id);
          if (el) {
            el.outerHTML = `<div class="result" data-task="2">Result 2</div>`;
          }
        },
        { code: 'fast' },
        null,
        'ready'
      );
      
      container.innerHTML = `
        <div class="block" data-block-id="b1">${task1.placeholder.value}</div>
        <div class="block" data-block-id="b2">${task2.placeholder.value}</div>
      `;
      
      await manager.processAll();
      
      // Task 2 should complete first
      assert.strictEqual(executionOrder[0], 'task2', 'Fast task should complete first');
      assert.strictEqual(executionOrder[1], 'task1', 'Slow task should complete second');
      
      // But results should be in correct positions
      const block1Result = container.querySelector('[data-block-id="b1"] [data-task="1"]');
      const block2Result = container.querySelector('[data-block-id="b2"] [data-task="2"]');
      
      assert.ok(block1Result !== null, 'Block 1 should have result 1');
      assert.ok(block2Result !== null, 'Block 2 should have result 2');
    });

    it('should handle placeholder removal during async processing', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      let taskReachedDOM = false;
      
      const { task, placeholder } = manager.createTask(
        async (data) => {
          await new Promise(r => setTimeout(r, 30));
          const el = htmlDoc.getElementById(data.id);
          taskReachedDOM = el !== null;
          if (el) {
            el.outerHTML = '<div class="rendered">Done</div>';
          }
        },
        { code: 'test' },
        null,
        'ready'
      );
      
      container.innerHTML = placeholder.value;
      
      // Start processing
      const processPromise = manager.processAll();
      
      // Remove placeholder during processing
      await new Promise(r => setTimeout(r, 10));
      container.innerHTML = '';
      
      await processPromise;
      
      // Task ran but couldn't find placeholder
      assert.strictEqual(taskReachedDOM, false, 'Task should not find placeholder');
      assert.strictEqual(container.querySelector('.rendered'), null, 'Should not render');
    });

    it('should abort pending tasks', async () => {
      container.innerHTML = '';
      const manager = new AsyncTaskManager();
      let taskCompleted = false;
      
      const { task, placeholder } = manager.createTask(
        async (data, context) => {
          await new Promise(r => setTimeout(r, 100));
          if (!context.cancelled) {
            taskCompleted = true;
          }
        },
        { code: 'test' },
        null,
        'ready'
      );
      
      container.innerHTML = placeholder.value;
      
      // Start and immediately abort
      setTimeout(() => manager.abort(), 5);
      await manager.processAll();
      
      // Task ran but context should be cancelled
      assert.strictEqual(manager.isAborted(), true, 'Manager should be aborted');
    });
  });

  describe('convertPluginResultToHTML', () => {
    it('should generate block diagram HTML', () => {
      const result = {
        type: 'image',
        content: { base64: 'abc123', width: 400, height: 200 },
        display: { inline: false, alignment: 'center' }
      };
      
      const html = convertPluginResultToHTML('test-id', result, 'mermaid', 'hash123');
      
      assert.ok(html.includes('diagram-block'), 'Should have block class');
      assert.ok(html.includes('data-source-hash="hash123"'), 'Should have source hash');
      assert.ok(html.includes('data-plugin-rendered="true"'), 'Should be marked as rendered');
      assert.ok(html.includes('src="data:image/png;base64,abc123"'), 'Should have base64 image');
    });

    it('should generate inline diagram HTML', () => {
      const result = {
        type: 'image',
        content: { base64: 'xyz789', width: 100, height: 50 },
        display: { inline: true, alignment: 'left' }
      };
      
      const html = convertPluginResultToHTML('test-id', result, 'vega', 'hash456');
      
      assert.ok(html.includes('diagram-inline'), 'Should have inline class');
      assert.ok(html.includes('data-source-hash="hash456"'), 'Should have source hash');
    });

    it('should return empty string for empty result', () => {
      const result = { type: 'empty' };
      const html = convertPluginResultToHTML('test-id', result, 'mermaid');
      assert.strictEqual(html, '', 'Should return empty string');
    });

    it('should generate error HTML for error result', () => {
      const result = {
        type: 'error',
        content: { text: 'Parse error at line 1' }
      };
      
      const html = convertPluginResultToHTML('test-id', result, 'mermaid');
      
      assert.ok(html.includes('Parse error at line 1'), 'Should contain error message');
      assert.ok(html.includes('<pre'), 'Should be in pre tag');
    });
  });

  // ==========================================================================
  // URL Security Tests
  // ==========================================================================

  describe('isSafeUrl', () => {
    it('should allow null/undefined/empty', () => {
      assert.strictEqual(isSafeUrl(null), true);
      assert.strictEqual(isSafeUrl(undefined), true);
      assert.strictEqual(isSafeUrl(''), true);
    });

    it('should allow hash anchors', () => {
      assert.strictEqual(isSafeUrl('#section'), true);
      assert.strictEqual(isSafeUrl('#'), true);
    });

    it('should block javascript: protocol', () => {
      assert.strictEqual(isSafeUrl('javascript:alert(1)'), false);
      assert.strictEqual(isSafeUrl('JAVASCRIPT:alert(1)'), false);
      assert.strictEqual(isSafeUrl('  javascript:alert(1)'), false);
    });

    it('should block vbscript: protocol', () => {
      assert.strictEqual(isSafeUrl('vbscript:msgbox(1)'), false);
    });

    it('should block data:text/javascript', () => {
      assert.strictEqual(isSafeUrl('data:text/javascript,alert(1)'), false);
    });

    it('should allow data:image/', () => {
      assert.strictEqual(isSafeUrl('data:image/png;base64,abc'), true);
      assert.strictEqual(isSafeUrl('data:image/svg+xml,<svg></svg>'), true);
    });

    it('should allow data:application/pdf', () => {
      assert.strictEqual(isSafeUrl('data:application/pdf;base64,abc'), true);
    });

    it('should allow relative paths', () => {
      assert.strictEqual(isSafeUrl('./image.png'), true);
      assert.strictEqual(isSafeUrl('../folder/file.md'), true);
      assert.strictEqual(isSafeUrl('/absolute/path.html'), true);
      assert.strictEqual(isSafeUrl('relative/path.txt'), true);
    });

    it('should allow http/https URLs', () => {
      assert.strictEqual(isSafeUrl('http://example.com'), true);
      assert.strictEqual(isSafeUrl('https://example.com/path'), true);
    });

    it('should allow mailto and tel', () => {
      assert.strictEqual(isSafeUrl('mailto:test@example.com'), true);
      assert.strictEqual(isSafeUrl('tel:+1234567890'), true);
    });

    it('should allow file: protocol', () => {
      assert.strictEqual(isSafeUrl('file:///path/to/file'), true);
    });
  });

  describe('isSafeSrcset', () => {
    it('should allow null/undefined/empty', () => {
      assert.strictEqual(isSafeSrcset(null), true);
      assert.strictEqual(isSafeSrcset(undefined), true);
      assert.strictEqual(isSafeSrcset(''), true);
    });

    it('should allow safe srcset', () => {
      assert.strictEqual(isSafeSrcset('image.png 1x, image@2x.png 2x'), true);
      assert.strictEqual(isSafeSrcset('small.jpg 320w, medium.jpg 640w'), true);
    });

    it('should block srcset with javascript', () => {
      assert.strictEqual(isSafeSrcset('javascript:alert(1) 1x'), false);
      assert.strictEqual(isSafeSrcset('image.png 1x, javascript:alert(1) 2x'), false);
    });
  });

  // ==========================================================================
  // HTML Sanitization Tests
  // ==========================================================================

  describe('sanitizeRenderedHtml', () => {
    it('should remove script tags', () => {
      const html = '<div>Hello</div><script>alert(1)</script>';
      const result = sanitizeRenderedHtml(html);
      assert.ok(!result.includes('<script'), 'Should not contain script tag');
      assert.ok(result.includes('blocked-html-warning'), 'Should have warning');
    });

    it('should remove iframe tags', () => {
      const html = '<p>Text</p><iframe src="evil.html"></iframe>';
      const result = sanitizeRenderedHtml(html);
      assert.ok(!result.includes('<iframe'), 'Should not contain iframe tag');
    });

    it('should remove event handlers', () => {
      const html = '<div onclick="alert(1)">Click me</div>';
      const result = sanitizeRenderedHtml(html);
      assert.ok(!result.includes('onclick'), 'Should not contain onclick');
    });

    it('should remove onerror handlers', () => {
      const html = '<img src="x" onerror="alert(1)">';
      const result = sanitizeRenderedHtml(html);
      assert.ok(!result.includes('onerror'), 'Should not contain onerror');
    });

    it('should remove javascript: URLs from href', () => {
      const html = '<a href="javascript:alert(1)">Link</a>';
      const result = sanitizeRenderedHtml(html);
      assert.ok(!result.includes('javascript:'), 'Should not contain javascript:');
    });

    it('should preserve safe content', () => {
      const html = '<p>Hello <strong>World</strong></p>';
      const result = sanitizeRenderedHtml(html);
      assert.strictEqual(result, html, 'Safe content should be unchanged');
    });

    it('should handle nested dangerous elements', () => {
      const html = '<div><div><script>evil()</script></div></div>';
      const result = sanitizeRenderedHtml(html);
      assert.ok(!result.includes('<script'), 'Should remove nested script');
    });

    it('should remove HTML comments', () => {
      const html = '<p>Text</p><!-- comment -->';
      const result = sanitizeRenderedHtml(html);
      assert.ok(!result.includes('<!--'), 'Should not contain comments');
    });

    it('should drop attributes that are active regardless of their value', () => {
      const html = '<div srcdoc="<script>evil()</script>" formaction="javascript:evil()" ping="https://evil" autofocus>x</div>';
      const result = sanitizeRenderedHtml(html);

      for (const attribute of ['srcdoc', 'formaction', 'ping', 'autofocus']) {
        assert.ok(!result.includes(attribute), `${attribute} must be removed`);
      }
      assert.ok(result.includes('x'), 'the element itself is kept');
    });

    it('should drop URL attributes that fail the URL policy', () => {
      const html = [
        '<img src="javascript:evil()">',
        '<a href="data:text/html,<script>evil()</script>">link</a>',
        '<img srcset="image.png 1x, javascript:evil() 2x">',
      ].join('');
      const result = sanitizeRenderedHtml(html);

      assert.ok(!result.includes('javascript:'), 'javascript: URLs are gone');
      assert.ok(!result.includes('srcset'), 'a srcset whose candidates are unsafe is removed');
      assert.ok(!result.includes('data:text/html'), 'html data URLs are gone');
    });

    it('should not let <template> or <noscript> hide markup from the walker', () => {
      // Their contents are parsed outside the tree a walker sees, which is the
      // classic sanitizer bypass — so the elements go away entirely. (The
      // removal notice quotes the markup as escaped text, so assert on real
      // markup, not on the payload substring.)
      const html = '<template><img src="x" onerror="evil()"></template><noscript><img src="x" onerror="evil()"></noscript>';
      const result = sanitizeRenderedHtml(html);

      assert.ok(!/<\s*(?:template|noscript|img)\b/i.test(result), 'no markup from inside them survives');
      assert.ok(result.includes('blocked-html-warning'), 'the removal is reported in place');
    });

    it('should neutralize executable CSS but keep styling', () => {
      const html = '<div style="width: 10px; background: url(javascript:evil()); behavior: expression(evil())">x</div>';
      const result = sanitizeRenderedHtml(html);

      assert.ok(!result.includes('javascript:'), 'javascript: is gone from the style value');
      assert.ok(!result.includes('expression('), 'expression() is gone from the style value');
      assert.ok(result.includes('width: 10px'), 'ordinary styling survives');
    });

    it('should keep <style> (documented scoped-CSS blocks) but neutralize what it can reach', () => {
      const block = sanitizeHtml('<div><style scoped>.de-container{border:2px solid red}</style><div class="de-container">text</div></div>');
      assert.ok(block.includes('<style'), 'an HTML block may style itself (html-demo.md documents this)');
      assert.ok(block.includes('border:2px solid red'), 'and keeps its rules');
      assert.ok(block.includes('text'), 'and its content');

      const remote = sanitizeHtml('<div><style>@import url(https://evil.example/x.css);.a{color:red}</style><div class="a">x</div></div>');
      assert.ok(!remote.includes('@import'), 'a document cannot pull remote CSS in through a style block');

      const rendered = sanitizeRenderedHtml('<svg><style>.a{fill:red}</style><rect class="a"/></svg>');
      assert.ok(rendered.includes('<style'), 'rendered documents keep SVG styles');
    });

    it('should keep form controls but drop the form itself', () => {
      // Inert without a <form> and with action/formaction/autofocus/on* gone;
      // html-demo.md renders a button gallery and GFM task lists render
      // <input type="checkbox">, so blocking the controls would silently drop
      // documented output.
      const buttons = sanitizeHtml('<div><button style="background: #3b82f6">主要按钮</button></div>');
      assert.ok(buttons.includes('<button'), 'a styled button block survives');

      const taskList = sanitizeRenderedHtml('<ul><li class="task-list-item"><input type="checkbox" disabled checked> done</li></ul>');
      assert.ok(taskList.includes('<input'), 'GFM checkboxes survive');

      const form = sanitizeHtml('<form action="https://evil.example/steal" method="post"><input type="text"></form>');
      assert.ok(!form.includes('<form'), 'a document HTML block cannot render a form');
      assert.ok(!form.includes('action='), 'and the submission target is gone with it');
    });
  });

  // ==========================================================================
  // extractHeadings Tests
  // ==========================================================================

  describe('extractHeadings', () => {
    it('should extract all heading levels', () => {
      container.innerHTML = '<h1>Title</h1><h2>Section</h2><h3>Subsection</h3>';
      const headings = extractHeadings(container);
      
      assert.strictEqual(headings.length, 3);
      assert.strictEqual(headings[0].level, 1);
      assert.strictEqual(headings[0].text, 'Title');
      assert.strictEqual(headings[1].level, 2);
      assert.strictEqual(headings[2].level, 3);
    });

    it('should use existing heading id', () => {
      container.innerHTML = '<h1 id="custom-id">Title</h1>';
      const headings = extractHeadings(container);
      
      assert.strictEqual(headings[0].id, 'custom-id');
    });

    it('should generate id for heading without id', () => {
      container.innerHTML = '<h1>No ID</h1>';
      const headings = extractHeadings(container);
      
      assert.ok(headings[0].id.startsWith('heading-'), 'Should generate id');
      // Should also set the id on the element
      const h1 = container.querySelector('h1');
      assert.ok(h1.id, 'Element should have id set');
    });

    it('should handle empty container', () => {
      container.innerHTML = '';
      const headings = extractHeadings(container);
      assert.strictEqual(headings.length, 0);
    });

    it('should extract heading text content', () => {
      container.innerHTML = '<h2>Text with <em>emphasis</em> inside</h2>';
      const headings = extractHeadings(container);
      
      assert.strictEqual(headings[0].text, 'Text with emphasis inside');
    });
  });
});
