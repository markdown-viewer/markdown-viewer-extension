/**
 * Unit tests for remark-mode pure utility functions.
 *
 * Covers: truncate, formatLineRef, rangesOverlap, getBlockRange,
 *         isMediaBlock, formatExportText
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  truncate,
  formatLineRef,
  rangesOverlap,
  getBlockRange,
  isMediaBlock,
  formatExportText,
  findTrLineInBlock,
  findLiLineInBlock,
  findCodeLineInBlock,
  narrowLineInBlock,
  generateHighlightCSS,
  findSentenceBounds,
  locateOffsetInNodes,
  locateSubstringInNodes,
  BG_COLORS,
  LINE_COLORS,
  SENTENCE_END_RE,
} from '../src/ui/remark-utils.ts';

// ─── truncate ────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('short ASCII: returns unchanged', () => {
    assert.strictEqual(truncate('hello', 10), 'hello');
  });

  it('long ASCII: cuts at width boundary + ellipsis', () => {
    const input = 'a'.repeat(130);
    const result = truncate(input, 120);
    assert.ok(result.endsWith('…'));
    // 119 chars + ellipsis
    assert.strictEqual(result.length, 120);
  });

  it('exact ASCII boundary: no truncation', () => {
    const input = 'a'.repeat(120);
    assert.strictEqual(truncate(input, 120), input);
  });

  it('one over ASCII boundary: truncates', () => {
    const input = 'a'.repeat(121);
    const result = truncate(input, 120);
    assert.ok(result.endsWith('…'));
    assert.strictEqual(result.length, 120);
  });

  it('pure CJK short: returns unchanged', () => {
    assert.strictEqual(truncate('你好世界', 10), '你好世界'); // width 8 < 10
  });

  it('pure CJK long: cuts respecting double width', () => {
    const input = '中'.repeat(40); // width 80
    const result = truncate(input, 50);
    assert.ok(result.endsWith('…'));
    // Each 中 = width 2, limit = 49, so 24 chars fit (48 width) + …
    assert.strictEqual(result, '中'.repeat(24) + '…');
  });

  it('mixed CJK + ASCII', () => {
    // "Hello你好World" → H(1)e(1)l(1)l(1)o(1)你(2)好(2)W(1)o(1)r(1)l(1)d(1) = 15
    const input = 'Hello你好World';
    const result = truncate(input, 12);
    // limit = 11 width. "Hello你好" = 5+4 = 9, + "W" = 10, + "o" = 11 → fits
    // + "r" = 12 → over limit
    assert.strictEqual(result, 'Hello你好Wo…');
  });

  it('empty string: returns empty', () => {
    assert.strictEqual(truncate('', 10), '');
  });

  it('very small maxWidth: only ellipsis', () => {
    const result = truncate('abcde', 1);
    assert.strictEqual(result, '…');
  });

  it('CJK fullwidth punctuation counts as 2', () => {
    // ，、。are fullwidth punctuation in CJK range
    const input = '你好，世界。';  // width: 2+2+2+2+2+2 = 12
    const result = truncate(input, 10);
    assert.ok(result.endsWith('…'));
    // limit=9, 你(2)好(2)，(2)世(2) = 8, 界(2) would be 10 > 9
    assert.strictEqual(result, '你好，世…');
  });

  it('emoji: handled without breaking surrogate pairs', () => {
    const input = '👍hello'; // 👍 is width 1 (non-CJK), h(1)e(1)l(1)l(1)o(1) = 7
    assert.strictEqual(truncate(input, 10), '👍hello');
  });
});

// ─── formatLineRef ───────────────────────────────────────────────────────────

describe('formatLineRef', () => {
  it('single line', () => {
    assert.strictEqual(formatLineRef(5, 5), 'L5');
  });

  it('line range', () => {
    assert.strictEqual(formatLineRef(5, 10), 'L5–L10');
  });

  it('line 1', () => {
    assert.strictEqual(formatLineRef(1, 1), 'L1');
  });
});

// ─── rangesOverlap ───────────────────────────────────────────────────────────

describe('rangesOverlap', () => {
  it('b fully inside a', () => {
    assert.strictEqual(rangesOverlap(5, 10, 6, 8), true);
  });

  it('left overlap', () => {
    assert.strictEqual(rangesOverlap(5, 10, 3, 7), true);
  });

  it('right overlap', () => {
    assert.strictEqual(rangesOverlap(5, 10, 8, 12), true);
  });

  it('no overlap: b after a', () => {
    assert.strictEqual(rangesOverlap(5, 10, 11, 15), false);
  });

  it('right boundary touch', () => {
    assert.strictEqual(rangesOverlap(5, 10, 10, 15), true);
  });

  it('left boundary touch', () => {
    assert.strictEqual(rangesOverlap(5, 10, 1, 5), true);
  });

  it('off by one: no overlap', () => {
    assert.strictEqual(rangesOverlap(5, 10, 1, 4), false);
  });
});

// ─── getBlockRange ───────────────────────────────────────────────────────────

function createElementStub(attrs: Record<string, string>): HTMLElement {
  return {
    getAttribute(name: string) { return attrs[name] ?? null; },
    tagName: attrs._tagName || 'DIV',
    querySelector() { return null; },
  } as unknown as HTMLElement;
}

describe('getBlockRange', () => {
  it('reads data-line and data-line-count', () => {
    const el = createElementStub({ 'data-line': '5', 'data-line-count': '3' });
    assert.deepStrictEqual(getBlockRange(el), { start: 5, end: 7 });
  });

  it('defaults line-count to 1', () => {
    const el = createElementStub({ 'data-line': '5' });
    assert.deepStrictEqual(getBlockRange(el), { start: 5, end: 5 });
  });

  it('handles line 0', () => {
    const el = createElementStub({ 'data-line': '0', 'data-line-count': '1' });
    assert.deepStrictEqual(getBlockRange(el), { start: 0, end: 0 });
  });
});

// ─── isMediaBlock ────────────────────────────────────────────────────────────

describe('isMediaBlock', () => {
  it('IMG tag → true', () => {
    const el = createElementStub({ _tagName: 'IMG' });
    assert.strictEqual(isMediaBlock(el), true);
  });

  it('div containing img → true', () => {
    const el = {
      tagName: 'DIV',
      getAttribute() { return null; },
      querySelector(sel: string) { return sel.includes('img') ? {} : null; },
    } as unknown as HTMLElement;
    assert.strictEqual(isMediaBlock(el), true);
  });

  it('plain paragraph → false', () => {
    const el = createElementStub({ _tagName: 'P' });
    assert.strictEqual(isMediaBlock(el), false);
  });

  it('div containing figure → true', () => {
    const el = {
      tagName: 'DIV',
      getAttribute() { return null; },
      querySelector(sel: string) { return sel.includes('figure') ? {} : null; },
    } as unknown as HTMLElement;
    assert.strictEqual(isMediaBlock(el), true);
  });
});

// ─── formatExportText ────────────────────────────────────────────────────────

function makeAnn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-1',
    startLine: 5,
    endLine: 5,
    selectedText: 'hello world',
    note: '',
    color: 'yellow' as const,
    timestamp: 1000,
    ...overrides,
  };
}

describe('formatExportText', () => {
  it('empty annotations → empty string', () => {
    assert.strictEqual(formatExportText([], '/test.md'), '');
  });

  it('single annotation with note', () => {
    const result = formatExportText(
      [makeAnn({ note: 'fix this' })],
      '/path/to/file.md',
    );
    assert.ok(result.includes('I reviewed **/path/to/file.md**'));
    assert.ok(result.includes('[🟡 Suggestion] L5:'));
    assert.ok(result.includes('"hello world"'));
    assert.ok(result.includes('Note: "fix this"'));
  });

  it('cross-line annotation uses range format', () => {
    const result = formatExportText(
      [makeAnn({ startLine: 5, endLine: 10 })],
      'test.md',
    );
    assert.ok(result.includes('L5–L10'));
  });

  it('multiple annotations: numbered and sorted', () => {
    const result = formatExportText([
      makeAnn({ id: 'b', startLine: 10, endLine: 10 }),
      makeAnn({ id: 'a', startLine: 5, endLine: 5 }),
    ], 'test.md');
    const lines = result.split('\n');
    // Find numbered lines
    const numbered = lines.filter(l => /^\d+\./.test(l));
    assert.strictEqual(numbered.length, 2);
    assert.ok(numbered[0].includes('L5'));
    assert.ok(numbered[1].includes('L10'));
  });

  it('same-line group: first numbered, rest indented', () => {
    const result = formatExportText([
      makeAnn({ id: 'a', startLine: 5, endLine: 8, color: 'yellow' }),
      makeAnn({ id: 'b', startLine: 5, endLine: 8, color: 'green' }),
    ], 'test.md');
    const lines = result.split('\n');
    // First annotation in group has number
    const firstAnn = lines.find(l => l.startsWith('1.'));
    assert.ok(firstAnn, 'should have numbered item');
    // Second in group is indented, no number
    const indented = lines.find(l => l.startsWith('   [🟢'));
    assert.ok(indented, 'should have indented grouped item');
  });

  it('no note: omits Note line', () => {
    const result = formatExportText([makeAnn()], 'test.md');
    assert.ok(!result.includes('Note:'));
  });

  it('unordered input: output is sorted by startLine', () => {
    const result = formatExportText([
      makeAnn({ id: 'c', startLine: 20, endLine: 20 }),
      makeAnn({ id: 'a', startLine: 1, endLine: 1 }),
      makeAnn({ id: 'b', startLine: 10, endLine: 10 }),
    ], 'test.md');
    const numbered = result.split('\n').filter(l => /^\d+\./.test(l));
    assert.ok(numbered[0].includes('L1'));
    assert.ok(numbered[1].includes('L10'));
    assert.ok(numbered[2].includes('L20'));
  });

  it('filePath appears in header', () => {
    const result = formatExportText([makeAnn()], '/Users/kyle/AGENTS.md');
    assert.ok(result.startsWith('I reviewed **/Users/kyle/AGENTS.md**'));
  });

  it('supports custom localized labels', () => {
    const result = formatExportText(
      [makeAnn({ note: 'ajusta esto', color: 'blue' })],
      '/tmp/test.md',
      {
        intro: 'He revisado **/tmp/test.md** y tengo los siguientes comentarios:',
        noteLabel: 'Nota',
        colorLabels: {
          blue: 'Pregunta',
        },
      },
    );

    assert.ok(result.startsWith('He revisado **/tmp/test.md** y tengo los siguientes comentarios:'));
    assert.ok(result.includes('[🔵 Pregunta] L5:'));
    assert.ok(result.includes('Nota: "ajusta esto"'));
  });
});

// ─── DOM stub helpers ─────────────────────────────────────────────────────────
// Lightweight object trees that satisfy the interfaces used by the three
// sub-block narrowing helpers, without requiring jsdom or a browser.

type StubNode = {
  nodeType?: number; // 3 = TEXT_NODE
  textContent?: string | null;
  tagName?: string;
  parentElement?: StubNode | null;
  children?: StubNode[];
  childNodes?: StubNode[];
  getAttribute?: (name: string) => string | null;
  querySelectorAll?: (sel: string) => StubNode[];
  querySelector?: (sel: string) => StubNode | null;
};

/** Build a minimal block element stub (has data-line + querySelectorAll). */
function makeBlock(attrs: Record<string, string>, overrides: Partial<StubNode> = {}): StubNode {
  return {
    tagName: attrs._tagName ?? 'DIV',
    getAttribute(name: string) { return attrs[name] ?? null; },
    querySelectorAll(_sel: string) { return []; },
    querySelector(_sel: string) { return null; },
    ...overrides,
  };
}

/** Link a chain of parent elements: [child, parent, grandparent, ...] */
function linkParents(chain: StubNode[]): void {
  for (let i = 0; i < chain.length - 1; i++) {
    chain[i].parentElement = chain[i + 1] as unknown as StubNode;
  }
  chain[chain.length - 1].parentElement = null;
}

// ─── findTrLineInBlock ────────────────────────────────────────────────────────
// Markdown table layout (blockStart = 10):
//   L10  | Col A | Col B |   ← THEAD row
//   L11  |-------|-------|   ← separator (not in DOM)
//   L12  | r0c0  | r0c1  |   ← TBODY tr[0]
//   L13  | r1c0  | r1c1  |   ← TBODY tr[1]

describe('findTrLineInBlock', () => {
  it('node inside THEAD TR → blockStart', () => {
    // DOM: block > THEAD > TR > TD  (user selected text in the header cell)
    // Expected: L10 (header row maps to blockStart)
    const block = makeBlock({ 'data-line': '10' });
    const thead = { tagName: 'THEAD', parentElement: block, children: [] } as StubNode;
    const tr = { tagName: 'TR', parentElement: thead } as StubNode;
    thead.children = [tr];
    const td = { tagName: 'TD', parentElement: tr } as StubNode;

    assert.strictEqual(findTrLineInBlock(td as unknown as Node, block as unknown as Element), 10);
  });

  it('node inside TBODY TR[0] → blockStart+2', () => {
    // DOM: block > TBODY > TR[0] > TD  (user selected text in first data row)
    // Expected: L12 = blockStart(10) + 2 (header + separator skip)
    const block = makeBlock({ 'data-line': '10' });
    const tbody = { tagName: 'TBODY', parentElement: block, children: [] } as StubNode;
    const tr0 = { tagName: 'TR', parentElement: tbody } as StubNode;
    const tr1 = { tagName: 'TR', parentElement: tbody } as StubNode;
    tbody.children = [tr0, tr1];
    const td = { tagName: 'TD', parentElement: tr0 } as StubNode;

    assert.strictEqual(findTrLineInBlock(td as unknown as Node, block as unknown as Element), 12);
  });

  it('node inside TBODY TR[1] → blockStart+3', () => {
    // DOM: block > TBODY > TR[1] > SPAN  (user selected content in second data row)
    // Expected: L13 = blockStart(10) + 2 + rowIndex(1)
    const block = makeBlock({ 'data-line': '10' });
    const tbody = { tagName: 'TBODY', parentElement: block, children: [] } as StubNode;
    const tr0 = { tagName: 'TR', parentElement: tbody } as StubNode;
    const tr1 = { tagName: 'TR', parentElement: tbody } as StubNode;
    tbody.children = [tr0, tr1];
    const span = { tagName: 'SPAN', parentElement: tr1 } as StubNode;

    assert.strictEqual(findTrLineInBlock(span as unknown as Node, block as unknown as Element), 13);
  });

  it('node not inside TR → null', () => {
    // DOM: block > P > SPAN  (paragraph block, no table structure)
    // Expected: null — not a table, no narrowing possible
    const block = makeBlock({ 'data-line': '10' });
    const p = { tagName: 'P', parentElement: block } as StubNode;
    const text = { tagName: 'SPAN', parentElement: p } as StubNode;

    assert.strictEqual(findTrLineInBlock(text as unknown as Node, block as unknown as Element), null);
  });

  it('node is a text node (no tagName) → walks parentElement', () => {
    // DOM: block > THEAD > TR > TD > textNode
    // Browser selections often land on raw text nodes, not elements.
    // The function must start from parentElement when node has no tagName.
    // Expected: L5 (header row of block starting at L5)
    const block = makeBlock({ 'data-line': '5' });
    const thead = { tagName: 'THEAD', parentElement: block, children: [] } as StubNode;
    const tr = { tagName: 'TR', parentElement: thead } as StubNode;
    thead.children = [tr];
    const td = { tagName: 'TD', parentElement: tr } as StubNode;
    const textNode = { nodeType: 3, textContent: 'hello', parentElement: td } as StubNode;

    assert.strictEqual(findTrLineInBlock(textNode as unknown as Node, block as unknown as Element), 5);
  });
});

// ─── findLiLineInBlock ────────────────────────────────────────────────────────
// Markdown list layout (blockStart = 20):
//   L20  - item 0
//   L21  - item 1
//   L22  - item 2
//
// For nested lists the entire nested subtree is one block;
// querySelectorAll('li') returns items in document order:
//   L30  - outer item 0
//   L31  - outer item 1
//   L32      - nested item 0  (child of item 1)

describe('findLiLineInBlock', () => {
  function makeListBlock(liCount: number, dataLine = '20'): { block: StubNode; lis: StubNode[] } {
    const lis: StubNode[] = Array.from({ length: liCount }, () => ({
      tagName: 'LI',
      parentElement: null as unknown as StubNode,
    }));
    const ul = { tagName: 'UL', parentElement: null as unknown as StubNode, children: lis } as StubNode;
    const block = makeBlock({ 'data-line': dataLine }, {
      querySelectorAll(_sel: string) { return lis; },
    });
    ul.parentElement = block;
    lis.forEach(li => (li.parentElement = ul));
    block.children = [ul];
    return { block, lis };
  }

  it('node inside first LI → blockStart+0', () => {
    // Markdown: L20 "- item 0"  ← user selected text inside a <span> in LI[0]
    // Expected: L20 (index 0, no offset)
    const { block, lis } = makeListBlock(3);
    const span = { tagName: 'SPAN', parentElement: lis[0] } as StubNode;

    assert.strictEqual(findLiLineInBlock(span as unknown as Node, block as unknown as Element), 20);
  });

  it('node inside third LI → blockStart+2', () => {
    // Markdown: L22 "- item 2"  ← user selected text inside LI[2]
    // Expected: L22 = blockStart(20) + index(2)
    const { block, lis } = makeListBlock(3);
    const span = { tagName: 'SPAN', parentElement: lis[2] } as StubNode;

    assert.strictEqual(findLiLineInBlock(span as unknown as Node, block as unknown as Element), 22);
  });

  it('node not inside any LI → null', () => {
    // DOM: block > P  (not a list block — e.g., a paragraph)
    // Expected: null — no LI ancestor found, narrowing not applicable
    const block = makeBlock({ 'data-line': '20' });
    const p = { tagName: 'P', parentElement: block } as StubNode;

    assert.strictEqual(findLiLineInBlock(p as unknown as Node, block as unknown as Element), null);
  });

  it('nested LI: uses the innermost LI document order', () => {
    // Markdown (blockStart = 30):
    //   L30  - outer item 0        ← li0
    //   L31  - outer item 1        ← li1
    //   L32      - nested item 0   ← li2 (child of li1)
    //
    // querySelectorAll('li') returns [li0, li1, li2] in document order.
    // User selects text inside li2 (the nested item).
    // Expected: L32 = blockStart(30) + index(2)
    const li0 = { tagName: 'LI' } as StubNode;
    const li1 = { tagName: 'LI' } as StubNode;
    const li2 = { tagName: 'LI' } as StubNode;
    const ul_nested = { tagName: 'UL', parentElement: li1 } as StubNode;
    li2.parentElement = ul_nested;
    const ul_outer = { tagName: 'UL' } as StubNode;
    li0.parentElement = ul_outer;
    li1.parentElement = ul_outer;
    const block = makeBlock({ 'data-line': '30' }, {
      querySelectorAll(_sel: string) { return [li0, li1, li2]; },
    });
    ul_outer.parentElement = block;
    ul_nested.parentElement = li1;
    const span = { tagName: 'SPAN', parentElement: li2 } as StubNode;

    assert.strictEqual(findLiLineInBlock(span as unknown as Node, block as unknown as Element), 32);
  });
});

// ─── findCodeLineInBlock ──────────────────────────────────────────────────────
// Markdown code block layout (blockStart = 40):
//   L40  ```typescript          ← opening fence (not in rendered DOM text)
//   L41  const x = 1;           ← first code line → blockStart+1
//   L42  const y = 2;           ← second code line → blockStart+2
//   L43  return x + y;          ← third code line → blockStart+3
//   L44  ```                    ← closing fence
//
// The <pre> element contains text nodes produced by the syntax highlighter.
// The function counts '\n' characters in text nodes before the selection point.

describe('findCodeLineInBlock', () => {
  /** Build a text node stub with no children (leaf). */
  function makeText(text: string, parent?: StubNode): StubNode {
    const n: StubNode = {
      nodeType: 3,
      textContent: text,
      childNodes: [],
      parentElement: parent ?? null,
    };
    return n;
  }

  /**
   * Build a PRE block whose childNodes are flat text node stubs.
   * Simulates a syntax-highlighted code block where the highlighter has
   * wrapped tokens in spans but we flatten to text nodes for simplicity.
   */
  function makePre(texts: string[], dataLine = '40'): { block: StubNode; textNodes: StubNode[]; pre: StubNode } {
    const textNodes = texts.map(t => makeText(t));
    const pre: StubNode = {
      tagName: 'PRE',
      nodeType: 1,
      textContent: texts.join(''),
      childNodes: textNodes,
    };
    textNodes.forEach(t => (t.parentElement = pre));
    const block = makeBlock({ 'data-line': dataLine, _tagName: 'PRE' });
    // The block itself IS the <pre> element in this simplified setup
    Object.assign(block, { childNodes: textNodes });
    return { block, textNodes, pre };
  }

  it('block has no <pre> and is not PRE → null', () => {
    // A DIV block (not a code block) with no querySelector('pre') match.
    // findCodeLineInBlock must bail out immediately and return null.
    const block = makeBlock({ 'data-line': '40' }); // tagName defaults to DIV
    const txt = makeText('hello');

    assert.strictEqual(findCodeLineInBlock(txt as unknown as Node, 0, block as unknown as Element), null);
  });

  it('node is first text node, offset 0 → blockStart+1', () => {
    // PRE text nodes: ["first line\n", "second line"]
    // Selection: start of textNodes[0], offset 0 (cursor before any char).
    // Newlines counted before target = 0 → line = blockStart+1+0 = 41
    const { block, textNodes } = makePre(['first line\n', 'second line']);
    const target = textNodes[0];

    assert.strictEqual(findCodeLineInBlock(target as unknown as Node, 0, block as unknown as Element), 41);
  });

  it('node is first text node, offset after 1 newline → blockStart+2', () => {
    // PRE text: "line1\nline2\n" (single text node)
    // Selection: offset 6 = just after the first '\n' (i.e., cursor at start of "line2").
    // textContent.slice(0, 6) = "line1\n" → 1 newline counted in target node.
    // Total newlines before cursor = 1 → line = blockStart+1+1 = 42
    const { block, textNodes } = makePre(['line1\nline2\n', 'line3']);
    const target = textNodes[0];
    assert.strictEqual(findCodeLineInBlock(target as unknown as Node, 6, block as unknown as Element), 42);
  });

  it('node is second text node → counts newlines in first + offset', () => {
    // PRE text nodes: ["line1\nline2\n", "line3\n"]
    // textNodes[0] has 2 '\n' → those are counted as the walker passes through it.
    // Selection: start of textNodes[1], offset 0.
    // Total newlines before cursor = 2 → line = blockStart+1+2 = 43
    const { block, textNodes } = makePre(['line1\nline2\n', 'line3\n']);
    const target = textNodes[1];
    assert.strictEqual(findCodeLineInBlock(target as unknown as Node, 0, block as unknown as Element), 43);
  });

  it('node not found in tree → null', () => {
    // A text node that is not part of the PRE subtree at all.
    // The walk exhausts all nodes without finding the target → returns null.
    const { block } = makePre(['hello\nworld']);
    const stranger = makeText('stranger');

    assert.strictEqual(findCodeLineInBlock(stranger as unknown as Node, 0, block as unknown as Element), null);
  });
});

// ─── narrowLineInBlock ────────────────────────────────────────────────────────
// This is the top-level dispatcher. It tries table → list → code in order
// and returns the first successful narrowing, or null for plain blocks.

describe('narrowLineInBlock', () => {
  it('table block: returns TR line for both endpoints', () => {
    // User drags selection across two rows (TR[0] and TR[1]) in a table block at L10.
    // DOM: block > TBODY > [TR[0] > TD (start), TR[1] > TD (end)]
    // Expected: { startLine: 12, endLine: 13 }  (blockStart+2 and blockStart+3)
    const block = makeBlock({ 'data-line': '10' });
    const tbody = { tagName: 'TBODY', parentElement: block, children: [] } as StubNode;
    const tr0 = { tagName: 'TR', parentElement: tbody } as StubNode;
    const tr1 = { tagName: 'TR', parentElement: tbody } as StubNode;
    tbody.children = [tr0, tr1];
    const startNode = { tagName: 'TD', parentElement: tr0 } as StubNode;
    const endNode = { tagName: 'TD', parentElement: tr1 } as StubNode;

    const result = narrowLineInBlock(startNode as unknown as Node, 0, endNode as unknown as Node, 0, block as unknown as Element);
    assert.deepStrictEqual(result, { startLine: 12, endLine: 13 });
  });

  it('list block: returns LI lines for both endpoints', () => {
    // User drags selection from LI[0] to LI[1] in a list block at L20.
    // querySelectorAll('li') → [li0, li2] (document order, 2 items)
    // startNode is inside li0 (index 0) → L20; endNode is inside li2 (index 1) → L21
    // Expected: { startLine: 20, endLine: 21 }
    const li0 = { tagName: 'LI' } as StubNode;
    const li2 = { tagName: 'LI' } as StubNode;
    const ul = { tagName: 'UL' } as StubNode;
    li0.parentElement = ul;
    li2.parentElement = ul;
    const block = makeBlock({ 'data-line': '20' }, {
      querySelectorAll(_sel: string) { return [li0, li2]; },
    });
    ul.parentElement = block;
    const startNode = { tagName: 'SPAN', parentElement: li0 } as StubNode;
    const endNode = { tagName: 'SPAN', parentElement: li2 } as StubNode;

    const result = narrowLineInBlock(startNode as unknown as Node, 0, endNode as unknown as Node, 0, block as unknown as Element);
    assert.deepStrictEqual(result, { startLine: 20, endLine: 21 });
  });

  it('plain paragraph block → null', () => {
    // A <p> block — no table/list/code sub-structure exists.
    // All three strategies (TR, LI, code) return null.
    // Expected: null (caller falls back to full block range)
    const block = makeBlock({ 'data-line': '5' });
    const p = { tagName: 'P', parentElement: block } as StubNode;

    const result = narrowLineInBlock(p as unknown as Node, 0, p as unknown as Node, 0, block as unknown as Element);
    assert.strictEqual(result, null);
  });

  it('table block: same row → startLine === endLine', () => {
    // User selects text within a single table cell (start and end both in TR[0]).
    // Both endpoints resolve to the same row → startLine and endLine must be equal.
    // Expected: { startLine: 12, endLine: 12 }
    const block = makeBlock({ 'data-line': '10' });
    const tbody = { tagName: 'TBODY', parentElement: block, children: [] } as StubNode;
    const tr0 = { tagName: 'TR', parentElement: tbody } as StubNode;
    tbody.children = [tr0];
    const node = { tagName: 'TD', parentElement: tr0 } as StubNode;

    const result = narrowLineInBlock(node as unknown as Node, 0, node as unknown as Node, 0, block as unknown as Element);
    assert.deepStrictEqual(result, { startLine: 12, endLine: 12 });
  });

  it('heading block → null (caller uses full 1-line block range)', () => {
    // Heading blocks (## H2, # H1, etc.) are always single-line in the block
    // splitter.  narrowLineInBlock has no heading strategy and must return null,
    // so the caller falls back to { startLine: blockLine, endLine: blockLine }
    // (lineCount = 1 → startLine + 1 - 1 = startLine).
    //
    // Real-world scenario (the regression case):
    //   file line 35 (0-indexed L34): "## 发现 2：会议/沟通仅 4%——Manager 去哪了？"
    //   Block: data-line=34, data-line-count=1
    //   Expected annotation: L34 (single line), NOT L34-L36.
    //
    // DOM: block[data-line=34] > H2 > textNode
    //   The block has lineCount=1, so caller computes endLine = 34+1-1 = 34.
    const block = makeBlock({ 'data-line': '34', 'data-line-count': '1' });
    const h2 = { tagName: 'H2', parentElement: block } as StubNode;
    const textNode = { nodeType: 3, textContent: '发现 2：会议/沟通仅 4%', parentElement: h2 } as StubNode;

    const result = narrowLineInBlock(textNode as unknown as Node, 0, textNode as unknown as Node, 0, block as unknown as Element);
    assert.strictEqual(result, null);
    // Caller uses: startLine + lineCount - 1 = 34 + 1 - 1 = 34 (L34 only, not L34-L36)
  });
});

// ─── generateHighlightCSS ────────────────────────────────────────────────────

describe('generateHighlightCSS', () => {
  it('background: generates background-color rules for all 4 colors', () => {
    const css = generateHighlightCSS('background');
    assert.ok(css.includes('mark.remark-ann-yellow'));
    assert.ok(css.includes('mark.remark-ann-green'));
    assert.ok(css.includes('mark.remark-ann-blue'));
    assert.ok(css.includes('mark.remark-ann-pink'));
    assert.ok(css.includes('background-color: rgba(255, 212, 0, 0.25)'));
    assert.ok(css.includes('text-decoration: none'));
    assert.ok(css.includes('border: none'));
  });

  it('underline: uses line colors with solid underline', () => {
    const css = generateHighlightCSS('underline');
    assert.ok(css.includes('background-color: transparent'));
    assert.ok(css.includes('text-decoration: underline 2px'));
    assert.ok(css.includes('text-underline-offset: 3px'));
    assert.ok(css.includes(LINE_COLORS.yellow));
  });

  it('wavy: uses wavy underline decoration', () => {
    const css = generateHighlightCSS('wavy');
    assert.ok(css.includes('text-decoration: wavy underline'));
    assert.ok(css.includes('text-underline-offset: 2px'));
  });

  it('border: uses solid border with border-radius', () => {
    const css = generateHighlightCSS('border');
    assert.ok(css.includes('border: 1.5px solid'));
    assert.ok(css.includes('border-radius: 3px'));
    assert.ok(css.includes('padding: 0 2px'));
    assert.ok(css.includes('text-decoration: none'));
  });

  it('unknown style: returns empty string', () => {
    const css = generateHighlightCSS('invalid' as any);
    assert.strictEqual(css, '');
  });

  it('each style generates exactly 4 rules (one per color)', () => {
    for (const style of ['background', 'underline', 'wavy', 'border'] as const) {
      const css = generateHighlightCSS(style);
      const ruleCount = css.split('mark.remark-ann-').length - 1;
      assert.strictEqual(ruleCount, 4, `${style} should have 4 rules`);
    }
  });
});

// ─── findSentenceBounds ──────────────────────────────────────────────────────

describe('findSentenceBounds', () => {
  it('single sentence: returns full text range', () => {
    const text = 'Hello world';
    const { start, end } = findSentenceBounds(text, 5);
    assert.strictEqual(start, 0);
    assert.strictEqual(end, text.length);
  });

  it('period-separated: finds correct sentence', () => {
    const text = 'First sentence.Second sentence.Third.';
    const { start, end } = findSentenceBounds(text, 16);
    assert.strictEqual(start, 15);
    assert.strictEqual(end, 31);
  });

  it('Chinese punctuation: 。as sentence boundary', () => {
    const text = '第一句话。第二句话。第三句话。';
    const { start, end } = findSentenceBounds(text, 6);
    assert.strictEqual(start, 5);
    assert.strictEqual(end, 10);
  });

  it('question mark: acts as boundary', () => {
    const text = 'Really?Yes!';
    const { start, end } = findSentenceBounds(text, 8);
    assert.strictEqual(start, 7);
    assert.strictEqual(end, 11);
  });

  it('newline: acts as sentence boundary', () => {
    const text = 'Line one\nLine two\nLine three';
    const { start, end } = findSentenceBounds(text, 12);
    assert.strictEqual(start, 9);
    assert.strictEqual(end, 18);
  });

  it('offset at start of text: start is 0', () => {
    const text = 'First.Second.';
    const { start, end } = findSentenceBounds(text, 0);
    assert.strictEqual(start, 0);
    assert.strictEqual(end, 6);
  });

  it('offset at end of text: end is text.length', () => {
    const text = 'Only sentence';
    const { start, end } = findSentenceBounds(text, 12);
    assert.strictEqual(start, 0);
    assert.strictEqual(end, text.length);
  });

  it('mixed delimiters: ！as Chinese exclamation', () => {
    const text = '好的！那就这样吧。';
    const { start, end } = findSentenceBounds(text, 5);
    assert.strictEqual(start, 3);
    assert.strictEqual(end, 9);
  });

  it('offset exactly on delimiter: includes it in previous sentence', () => {
    const text = 'Hello.World';
    const { start, end } = findSentenceBounds(text, 5);
    assert.strictEqual(start, 0);
    assert.strictEqual(end, 6);
  });
});

// ─── SENTENCE_END_RE ─────────────────────────────────────────────────────────

describe('SENTENCE_END_RE', () => {
  it('matches period', () => assert.ok(SENTENCE_END_RE.test('.')));
  it('matches 。', () => assert.ok(SENTENCE_END_RE.test('。')));
  it('matches ?', () => assert.ok(SENTENCE_END_RE.test('?')));
  it('matches ？', () => assert.ok(SENTENCE_END_RE.test('？')));
  it('matches !', () => assert.ok(SENTENCE_END_RE.test('!')));
  it('matches ！', () => assert.ok(SENTENCE_END_RE.test('！')));
  it('matches newline', () => assert.ok(SENTENCE_END_RE.test('\n')));
  it('does not match comma', () => assert.ok(!SENTENCE_END_RE.test(',')));
  it('does not match semicolon', () => assert.ok(!SENTENCE_END_RE.test(';')));
  it('does not match space', () => assert.ok(!SENTENCE_END_RE.test(' ')));
});

// ─── locateOffsetInNodes ─────────────────────────────────────────────────────

describe('locateOffsetInNodes', () => {
  it('single node: offset 0 → node 0, local 0', () => {
    const result = locateOffsetInNodes([10], 0);
    assert.deepStrictEqual(result, { nodeIndex: 0, localOffset: 0 });
  });

  it('single node: offset in middle', () => {
    const result = locateOffsetInNodes([10], 5);
    assert.deepStrictEqual(result, { nodeIndex: 0, localOffset: 5 });
  });

  it('single node: offset at exact end', () => {
    const result = locateOffsetInNodes([10], 10);
    assert.deepStrictEqual(result, { nodeIndex: 0, localOffset: 10 });
  });

  it('single node: offset beyond → null', () => {
    const result = locateOffsetInNodes([10], 11);
    assert.strictEqual(result, null);
  });

  it('multiple nodes: offset in first node', () => {
    const result = locateOffsetInNodes([5, 3, 7], 3);
    assert.deepStrictEqual(result, { nodeIndex: 0, localOffset: 3 });
  });

  it('multiple nodes: offset at boundary → starts next node', () => {
    const result = locateOffsetInNodes([5, 3, 7], 5);
    assert.deepStrictEqual(result, { nodeIndex: 1, localOffset: 0 });
  });

  it('multiple nodes: offset in second node', () => {
    const result = locateOffsetInNodes([5, 3, 7], 7);
    assert.deepStrictEqual(result, { nodeIndex: 1, localOffset: 2 });
  });

  it('multiple nodes: offset in last node', () => {
    const result = locateOffsetInNodes([5, 3, 7], 10);
    assert.deepStrictEqual(result, { nodeIndex: 2, localOffset: 2 });
  });

  it('empty nodes array: returns null', () => {
    const result = locateOffsetInNodes([], 0);
    assert.strictEqual(result, null);
  });

  it('zero-length node: skips to next', () => {
    const result = locateOffsetInNodes([0, 5], 2);
    assert.deepStrictEqual(result, { nodeIndex: 1, localOffset: 2 });
  });
});

// ─── locateSubstringInNodes ──────────────────────────────────────────────────

describe('locateSubstringInNodes', () => {
  it('substring in single node: correct start and end', () => {
    // "Hello World" in one node, find "World" at index 6, len 5
    const result = locateSubstringInNodes([11], 6, 5);
    assert.deepStrictEqual(result, {
      start: { nodeIndex: 0, localOffset: 6 },
      end: { nodeIndex: 0, localOffset: 11 },
    });
  });

  it('substring spanning two nodes', () => {
    // nodes: "Hello " (6) + "World" (5) = "Hello World"
    // find "o W" at index 4, len 3
    const result = locateSubstringInNodes([6, 5], 4, 3);
    assert.deepStrictEqual(result, {
      start: { nodeIndex: 0, localOffset: 4 },
      end: { nodeIndex: 1, localOffset: 1 },
    });
  });

  it('substring entirely in second node', () => {
    const result = locateSubstringInNodes([5, 10], 7, 3);
    assert.deepStrictEqual(result, {
      start: { nodeIndex: 1, localOffset: 2 },
      end: { nodeIndex: 1, localOffset: 5 },
    });
  });

  it('out of bounds: returns null', () => {
    const result = locateSubstringInNodes([5, 5], 8, 5);
    assert.strictEqual(result, null);
  });

  it('zero-length substring: start equals end', () => {
    const result = locateSubstringInNodes([10], 5, 0);
    assert.deepStrictEqual(result, {
      start: { nodeIndex: 0, localOffset: 5 },
      end: { nodeIndex: 0, localOffset: 5 },
    });
  });
});
