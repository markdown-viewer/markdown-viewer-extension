import { describe, it } from 'node:test';
import assert from 'node:assert';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';
import remarkSuperSub from '../src/plugins/remark-super-sub.ts';

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
      }
    }
  };

  data.toMarkdownExtensions = data.toMarkdownExtensions || [];
  data.toMarkdownExtensions.push(toMarkdownExtension);
}

function parseToAst(input) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkSuperSub);

  return processor.runSync(processor.parse(input));
}

function transform(input) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkSuperSub)
    .use(remarkCustomStringify)
    .use(remarkStringify);

  return processor.processSync(input).toString().trim();
}

describe('remark-super-sub', () => {
  it('should not parse %~ range as subscript', () => {
    const ast = parseToAst('上升 4%~5%下降3%~5%');
    const subscriptNodes = [];

    visit(ast, 'subscript', (node) => {
      subscriptNodes.push(node);
    });

    assert.strictEqual(subscriptNodes.length, 0);
    assert.strictEqual(transform('上升 4%~5%下降3%~5%'), '上升 4%~5%下降3%~5%');
  });

  it('should still parse normal subscript syntax', () => {
    const ast = parseToAst('H~2~O');
    const subscriptNodes = [];

    visit(ast, 'subscript', (node) => {
      subscriptNodes.push(node);
    });

    assert.strictEqual(subscriptNodes.length, 1);
    assert.strictEqual(transform('H~2~O'), 'H~2~O');
  });
});
