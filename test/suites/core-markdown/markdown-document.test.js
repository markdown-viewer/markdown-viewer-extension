import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  MarkdownDocument,
  normalizeMathBlocks,
  extractTitle,
  extractHeadingsFromBlocks,
} from '../../../src/core/markdown-document.ts';

describe('markdown-document', () => {
  describe('MarkdownDocument', () => {
    describe('Basic Operations', () => {
      it('should create empty document', () => {
        const doc = new MarkdownDocument();
        assert.strictEqual(doc.blockCount, 0);
        assert.strictEqual(doc.getRawContent(), '');
      });

      it('should create document with initial content', () => {
        const doc = new MarkdownDocument('# Title\n\nParagraph');
        assert.strictEqual(doc.blockCount, 2);
        assert.strictEqual(doc.getBlock(0)?.content, '# Title');
        assert.strictEqual(doc.getBlock(1)?.content, 'Paragraph');
      });

      it('should track line numbers', () => {
        const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
        const blocks = doc.getBlocks();
        assert.strictEqual(blocks[0].startLine, 0);
        assert.strictEqual(blocks[1].startLine, 2);
        assert.strictEqual(blocks[2].startLine, 4);
      });

      it('should generate consistent hashes', () => {
        const doc1 = new MarkdownDocument('# Title');
        const doc2 = new MarkdownDocument('# Title');
        assert.strictEqual(doc1.getBlock(0)?.hash, doc2.getBlock(0)?.hash);
      });

      it('should generate different hashes for different content', () => {
        const doc = new MarkdownDocument('# Title\n\n# Different');
        assert.notStrictEqual(doc.getBlock(0)?.hash, doc.getBlock(1)?.hash);
      });
    });

    describe('Update and Diff', () => {
      it('should detect no changes for identical content', () => {
        const doc = new MarkdownDocument('# Title\n\nParagraph');
        const diff = doc.update('# Title\n\nParagraph');
        assert.strictEqual(diff.stats.kept, 2);
        assert.strictEqual(diff.stats.inserted, 0);
        assert.strictEqual(diff.stats.removed, 0);
      });

      it('should detect added blocks', () => {
        const doc = new MarkdownDocument('# Title');
        const diff = doc.update('# Title\n\nNew paragraph');
        assert.strictEqual(diff.stats.kept, 1);
        assert.strictEqual(diff.stats.inserted, 1);
        assert.strictEqual(diff.stats.removed, 0);
      });

      it('should detect removed blocks', () => {
        const doc = new MarkdownDocument('# Title\n\nParagraph');
        const diff = doc.update('# Title');
        assert.strictEqual(diff.stats.kept, 1);
        assert.strictEqual(diff.stats.removed, 1);
      });

      it('should detect modified blocks', () => {
        const doc = new MarkdownDocument('# Title\n\nOld text');
        const diff = doc.update('# Title\n\nNew text');
        // Title kept, old text removed, new text inserted
        assert.strictEqual(diff.stats.kept, 1);
        assert.strictEqual(diff.stats.inserted, 1);
        assert.strictEqual(diff.stats.removed, 1);
      });

      it('should handle complex edits', () => {
        const doc = new MarkdownDocument(`# Title

Para 1

Para 2

Para 3`);
        const diff = doc.update(`# Title

Para 1

Modified

Para 3`);
        // Title, Para 1, Para 3 kept; Para 2 removed; Modified inserted
        assert.strictEqual(diff.stats.kept, 3);
        assert.strictEqual(diff.stats.inserted, 1);
        assert.strictEqual(diff.stats.removed, 1);
      });

      it('should handle reordering', () => {
        const doc = new MarkdownDocument('Block A\n\nBlock B\n\nBlock C');
        const diff = doc.update('Block C\n\nBlock B\n\nBlock A');
        // A->C, B->B, C->A: B stays, A and C need to be moved
        // Moved blocks are removed and re-inserted to ensure correct DOM order
        assert.strictEqual(diff.stats.kept, 1); // Only B stays in place
        assert.strictEqual(diff.stats.removed, 2); // A and C moved
        assert.strictEqual(diff.stats.inserted, 2); // A and C re-inserted
      });
    });

    describe('HTML Cache', () => {
      it('should store and retrieve block HTML', () => {
        const doc = new MarkdownDocument('# Title\n\nParagraph');
        doc.setBlockHtml(0, '<h1>Title</h1>');
        assert.strictEqual(doc.getBlock(0)?.html, '<h1>Title</h1>');
      });

      it('should preserve HTML cache for unchanged blocks', () => {
        const doc = new MarkdownDocument('# Title\n\nParagraph');
        doc.setBlockHtml(0, '<h1>Title</h1>');
        doc.setBlockHtml(1, '<p>Paragraph</p>');
        
        // Add new block, title should keep its cache
        doc.update('# Title\n\nParagraph\n\nNew block');
        assert.strictEqual(doc.getBlock(0)?.html, '<h1>Title</h1>');
        assert.strictEqual(doc.getBlock(1)?.html, '<p>Paragraph</p>');
        assert.strictEqual(doc.getBlock(2)?.html, undefined);
      });

      it('should invalidate HTML cache when block content changes', () => {
        const doc = new MarkdownDocument('# Title\n\nOld text');
        doc.setBlockHtml(1, '<p>Old text</p>');
        
        doc.update('# Title\n\nNew text');
        assert.strictEqual(doc.getBlock(0)?.html, undefined); // Title hash same but new block object
        assert.strictEqual(doc.getBlock(1)?.html, undefined); // Content changed
      });

      it('should report blocks needing render', () => {
        const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
        doc.setBlockHtml(0, '<h1>Title</h1>');
        
        const needRender = doc.getBlocksNeedingRender();
        assert.strictEqual(needRender.length, 2);
        assert.strictEqual(needRender[0].index, 1);
        assert.strictEqual(needRender[1].index, 2);
      });

      it('should clear HTML cache', () => {
        const doc = new MarkdownDocument('# Title');
        doc.setBlockHtml(0, '<h1>Title</h1>');
        doc.clearHtmlCache();
        assert.strictEqual(doc.getBlock(0)?.html, undefined);
      });
    });

    describe('Line Lookup', () => {
      it('should find block by line number', () => {
        const doc = new MarkdownDocument('# Title\n\nParagraph\n\n```js\ncode\n```');
        
        const result0 = doc.findBlockByLine(0);
        assert.strictEqual(result0?.block.content, '# Title');
        
        const result2 = doc.findBlockByLine(2);
        assert.strictEqual(result2?.block.content, 'Paragraph');
        
        const result5 = doc.findBlockByLine(5);
        assert.ok(result5?.block.content.includes('```js'));
      });

      it('should return null for out-of-range line', () => {
        const doc = new MarkdownDocument('# Title');
        const result = doc.findBlockByLine(100);
        assert.strictEqual(result, null);
      });
    });

    describe('Serialization', () => {
      it('should serialize to JSON', () => {
        const doc = new MarkdownDocument('# Title\n\nParagraph');
        doc.setBlockHtml(0, '<h1>Title</h1>');
        
        const json = doc.toJSON();
        assert.strictEqual(json.rawContent, '# Title\n\nParagraph');
        assert.strictEqual(json.blocks.length, 2);
        // HTML should not be serialized
        assert.strictEqual(json.blocks[0].html, undefined);
      });

      it('should deserialize from JSON', () => {
        const doc1 = new MarkdownDocument('# Title\n\nParagraph');
        const json = doc1.toJSON();
        
        const doc2 = MarkdownDocument.fromJSON(json);
        assert.strictEqual(doc2.blockCount, 2);
        assert.strictEqual(doc2.getBlock(0)?.content, '# Title');
      });
    });
  });

  describe('normalizeMathBlocks', () => {
    it('should convert single-line $$ to multi-line', () => {
      const input = '$$x=1$$';
      const result = normalizeMathBlocks(input);
      assert.ok(result.includes('\n$$\nx=1\n$$\n'));
    });

    it('should not change multi-line math blocks', () => {
      const input = '$$\nx=1\n$$';
      const result = normalizeMathBlocks(input);
      assert.strictEqual(result, input);
    });

    it('should not affect inline math', () => {
      const input = 'This is $x=1$ inline';
      const result = normalizeMathBlocks(input);
      assert.strictEqual(result, input);
    });
  });

  describe('extractTitle', () => {
    it('should extract h1 title', () => {
      assert.strictEqual(extractTitle('# Hello World'), 'Hello World');
    });

    it('should return null if no title', () => {
      assert.strictEqual(extractTitle('No heading'), null);
    });

    it('should extract first h1', () => {
      assert.strictEqual(extractTitle('text\n# First\n# Second'), 'First');
    });
  });

  describe('extractHeadingsFromBlocks', () => {
    it('should extract headings from blocks', () => {
      const doc = new MarkdownDocument('# Title\n\nText\n\n## Section\n\n### Sub');
      const headings = extractHeadingsFromBlocks(doc.getBlocks());
      
      assert.strictEqual(headings.length, 3);
      assert.strictEqual(headings[0].level, 1);
      assert.strictEqual(headings[0].text, 'Title');
      assert.strictEqual(headings[1].level, 2);
      assert.strictEqual(headings[1].text, 'Section');
      assert.strictEqual(headings[2].level, 3);
      assert.strictEqual(headings[2].text, 'Sub');
    });

    it('should generate unique IDs for duplicate headings', () => {
      const doc = new MarkdownDocument('# Title\n\n## Section\n\n## Section\n\n## Section');
      const headings = extractHeadingsFromBlocks(doc.getBlocks());
      
      const ids = headings.map(h => h.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(ids.length, uniqueIds.size, 'All IDs should be unique');
    });

    it('should include line numbers', () => {
      const doc = new MarkdownDocument('# Title\n\nPara\n\n## Section');
      const headings = extractHeadingsFromBlocks(doc.getBlocks());
      
      assert.strictEqual(headings[0].line, 0);
      assert.strictEqual(headings[1].line, 4);
    });
  });

  describe('Line Position Mapping', () => {
    it('should get total line count', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      assert.strictEqual(doc.getTotalLineCount(), 5);
    });

    it('should get line position at block start', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      
      const pos0 = doc.getLinePosition(0);
      assert.strictEqual(pos0?.index, 0);
      assert.strictEqual(pos0?.progress, 0);
      
      const pos2 = doc.getLinePosition(2);
      assert.strictEqual(pos2?.index, 1);
      assert.strictEqual(pos2?.progress, 0);
      
      const pos4 = doc.getLinePosition(4);
      assert.strictEqual(pos4?.index, 2);
      assert.strictEqual(pos4?.progress, 0);
    });

    it('should get line position within block', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      // Title block has lineCount=1 (only line 0)
      // Line 1 (empty) is between blocks, maps to next block (Para 1)
      const pos1 = doc.getLinePosition(1);
      assert.strictEqual(pos1?.index, 1);  // Maps to block 1
      assert.strictEqual(pos1?.progress, 0); // At start of block 1
    });

    it('should handle fractional line numbers', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      // Para 1 at line 2, lineCount=1 (only actual content line)
      const pos = doc.getLinePosition(2.5);
      assert.strictEqual(pos?.index, 1);
      assert.ok(Math.abs(pos?.progress - 0.5) < 0.01); // 0.5/1 = 0.5
    });

    it('should convert position back to line (roundtrip)', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2\n\nPara 3');
      
      // Test lines that are at block starts (roundtrip is exact)
      for (const testLine of [0, 2, 4, 6]) {
        const pos = doc.getLinePosition(testLine);
        assert.ok(pos, `Should find position for line ${testLine}`);
        const recovered = doc.getLineFromPosition(pos.index, pos.progress);
        assert.ok(Math.abs(recovered - testLine) < 0.01, `Roundtrip failed for line ${testLine}`);
      }
    });

    it('should update line positions after insert', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      
      // Before: Para 2 at line 4
      let pos = doc.getLinePosition(4);
      assert.strictEqual(pos?.block.content, 'Para 2');
      
      // Insert New Para
      doc.update('# Title\n\nPara 1\n\nNew Para\n\nPara 2');
      
      // After: Para 2 should be at line 6, New Para at line 4
      pos = doc.getLinePosition(4);
      assert.strictEqual(pos?.block.content, 'New Para');
      
      pos = doc.getLinePosition(6);
      assert.strictEqual(pos?.block.content, 'Para 2');
    });

    it('should update line positions after delete', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2\n\nPara 3');
      
      // Before: Para 3 at line 6
      let pos = doc.getLinePosition(6);
      assert.strictEqual(pos?.block.content, 'Para 3');
      
      // Delete Para 2
      doc.update('# Title\n\nPara 1\n\nPara 3');
      
      // After: Para 3 should be at line 4
      pos = doc.getLinePosition(4);
      assert.strictEqual(pos?.block.content, 'Para 3');
    });

    it('should get surrounding blocks', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      
      const s0 = doc.getSurroundingBlocks(0);
      assert.strictEqual(s0.previous?.block.content, '# Title');
      assert.strictEqual(s0.next?.block.content, 'Para 1');
      
      const s3 = doc.getSurroundingBlocks(3);
      assert.strictEqual(s3.previous?.block.content, 'Para 1');
      assert.strictEqual(s3.next?.block.content, 'Para 2');
      
      const s10 = doc.getSurroundingBlocks(10);
      assert.strictEqual(s10.previous?.block.content, 'Para 2');
      assert.strictEqual(s10.next, undefined);
    });

    it('should handle empty document', () => {
      const doc = new MarkdownDocument();
      
      assert.strictEqual(doc.getTotalLineCount(), 0);
      assert.strictEqual(doc.getLinePosition(0), null);
      assert.deepStrictEqual(doc.getSurroundingBlocks(0), {});
    });

    it('should convert blockId + progress to line number', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      const blocks = doc.getBlocks();
      
      // Block 0 (Title): startLine=0, lineCount=1 (only actual content line)
      assert.strictEqual(doc.getLineFromBlockId(blocks[0].id, 0), 0);
      assert.strictEqual(doc.getLineFromBlockId(blocks[0].id, 0.5), 0.5);
      assert.strictEqual(doc.getLineFromBlockId(blocks[0].id, 1), 1);
      
      // Block 1 (Para 1): startLine=2, lineCount=1
      assert.strictEqual(doc.getLineFromBlockId(blocks[1].id, 0), 2);
      assert.strictEqual(doc.getLineFromBlockId(blocks[1].id, 0.5), 2.5);
      
      // Block 2 (Para 2): startLine=4, lineCount=1
      assert.strictEqual(doc.getLineFromBlockId(blocks[2].id, 0), 4);
      
      // Non-existent block
      assert.strictEqual(doc.getLineFromBlockId('non-existent', 0), null);
    });

    it('should convert line number to blockId + progress', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      const blocks = doc.getBlocks();
      
      // Line 0 -> block 0, progress 0
      let pos = doc.getBlockPositionFromLine(0);
      assert.strictEqual(pos?.blockId, blocks[0].id);
      assert.strictEqual(pos?.progress, 0);
      
      // Line 1 -> block 1, progress 0 (empty line maps to next block)
      pos = doc.getBlockPositionFromLine(1);
      assert.strictEqual(pos?.blockId, blocks[1].id);
      assert.strictEqual(pos?.progress, 0);
      
      // Line 2 -> block 1, progress 0
      pos = doc.getBlockPositionFromLine(2);
      assert.strictEqual(pos?.blockId, blocks[1].id);
      assert.strictEqual(pos?.progress, 0);
      
      // Line 4 -> block 2, progress 0
      pos = doc.getBlockPositionFromLine(4);
      assert.strictEqual(pos?.blockId, blocks[2].id);
      assert.strictEqual(pos?.progress, 0);
    });

    it('should maintain blockId mapping after incremental update', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      const initialBlocks = doc.getBlocks();
      const para2Id = initialBlocks[2].id;
      
      // Initially Para 2 is at line 4
      assert.strictEqual(doc.getLineFromBlockId(para2Id, 0), 4);
      
      // Insert a new paragraph
      doc.update('# Title\n\nPara 1\n\nNew Para\n\nPara 2');
      
      // Para 2 keeps the same ID but now at line 6
      assert.strictEqual(doc.getLineFromBlockId(para2Id, 0), 6);
      
      // Verify roundtrip: line 6 -> para2Id
      const pos = doc.getBlockPositionFromLine(6);
      assert.strictEqual(pos?.blockId, para2Id);
      assert.strictEqual(pos?.progress, 0);
    });

    it('should roundtrip blockId + progress <-> line', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2\n\nPara 3');
      
      // Test block start lines (roundtrip is exact for these)
      for (const testLine of [0, 2, 4, 6]) {
        const pos = doc.getBlockPositionFromLine(testLine);
        assert.ok(pos, `Should find position for line ${testLine}`);
        const recovered = doc.getLineFromBlockId(pos.blockId, pos.progress);
        assert.ok(Math.abs(recovered - testLine) < 0.01, `Roundtrip failed for line ${testLine}`);
      }
    });

    it('should handle fractional line numbers in both directions', () => {
      const doc = new MarkdownDocument('# Title\n\nPara 1\n\nPara 2');
      const blocks = doc.getBlocks();
      
      // Test fractional progress -> fractional line
      // Block 0 has lineCount=1, so progress 0.25 = line 0.25
      const line1 = doc.getLineFromBlockId(blocks[0].id, 0.25);
      assert.ok(Math.abs(line1 - 0.25) < 0.01, 'progress 0.25 should give line 0.25');
      
      // Block 1 has startLine=2, lineCount=1, so progress 0.75 = line 2.75
      const line2 = doc.getLineFromBlockId(blocks[1].id, 0.75);
      assert.ok(Math.abs(line2 - 2.75) < 0.01, 'progress 0.75 should give line 2.75');
      
      // Test fractional line -> fractional progress
      // Line 0.5 is in block 0 (lines 0-1), progress = 0.5/1 = 0.5
      const pos1 = doc.getBlockPositionFromLine(0.5);
      assert.strictEqual(pos1?.blockId, blocks[0].id);
      assert.ok(Math.abs(pos1?.progress - 0.5) < 0.01, 'line 0.5 should give progress 0.5');
      
      // Line 2.25 is in block 1 (lines 2-3), progress = 0.25/1 = 0.25
      const pos2 = doc.getBlockPositionFromLine(2.25);
      assert.strictEqual(pos2?.blockId, blocks[1].id);
      assert.ok(Math.abs(pos2?.progress - 0.25) < 0.01, 'line 2.25 should give progress 0.25');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty document update', () => {
      const doc = new MarkdownDocument('# Title');
      const diff = doc.update('');
      assert.strictEqual(diff.stats.removed, 1);
      assert.strictEqual(doc.blockCount, 0);
    });

    it('should handle very large documents', () => {
      const lines = [];
      for (let i = 0; i < 10000; i++) {
        lines.push(`Block ${i}`);
        lines.push('');
      }
      const doc = new MarkdownDocument(lines.join('\n'));
      assert.strictEqual(doc.blockCount, 10000);
    });

    it('should handle unicode content', () => {
      const doc = new MarkdownDocument('# 标题\n\n你好世界\n\n日本語');
      assert.strictEqual(doc.blockCount, 3);
      assert.strictEqual(doc.getBlock(0)?.content, '# 标题');
    });

    it('should handle code blocks with special content', () => {
      const doc = new MarkdownDocument('```js\nconst x = "# Not a heading";\n```');
      assert.strictEqual(doc.blockCount, 1);
    });

    it('should handle rapid consecutive updates', () => {
      const doc = new MarkdownDocument('Initial');
      for (let i = 0; i < 100; i++) {
        doc.update(`Update ${i}`);
      }
      assert.strictEqual(doc.getBlock(0)?.content, 'Update 99');
    });
  });

  describe('DOM Commands', () => {
    it('should return clear command on first render', () => {
      const doc = new MarkdownDocument();
      const result = doc.update('# Title\n\nParagraph');
      
      assert.ok(result.commands.some(cmd => cmd.type === 'clear'));
      assert.strictEqual(result.stats.inserted, 2);
    });

    it('should generate remove commands for deleted blocks', () => {
      const doc = new MarkdownDocument('# Title\n\nParagraph');
      const result = doc.update('# Title');
      
      const removeCommands = result.commands.filter(cmd => cmd.type === 'remove');
      assert.strictEqual(removeCommands.length, 1);
    });

    it('should generate append commands for new blocks at end', () => {
      const doc = new MarkdownDocument('# Title');
      const result = doc.update('# Title\n\nNew paragraph');
      
      const appendCommands = result.commands.filter(cmd => cmd.type === 'append');
      assert.strictEqual(appendCommands.length, 1);
      assert.strictEqual(appendCommands[0].blockId, doc.getBlock(1)?.id);
    });

    it('should generate insertBefore commands for new blocks in middle', () => {
      const doc = new MarkdownDocument('# Title\n\nParagraph');
      const titleId = doc.getBlock(0)?.id;
      const paraId = doc.getBlock(1)?.id;
      
      const result = doc.update('# Title\n\nNew middle\n\nParagraph');
      
      // New middle should be inserted before Paragraph
      const insertCommands = result.commands.filter(cmd => cmd.type === 'insertBefore');
      assert.strictEqual(insertCommands.length, 1);
      assert.strictEqual(insertCommands[0].refId, paraId);
    });

    it('should preserve block IDs for unchanged blocks', () => {
      const doc = new MarkdownDocument('# Title\n\nParagraph');
      const titleId = doc.getBlock(0)?.id;
      const paraId = doc.getBlock(1)?.id;
      
      doc.update('# Title\n\nParagraph\n\nNew');
      
      // Title and Paragraph should keep their IDs
      assert.strictEqual(doc.getBlock(0)?.id, titleId);
      assert.strictEqual(doc.getBlock(1)?.id, paraId);
    });

    it('should generate updateAttrs when line numbers change', () => {
      const doc = new MarkdownDocument('# Title\n\nParagraph');
      const result = doc.update('New intro\n\n# Title\n\nParagraph');
      
      // Title and Paragraph moved, their line attrs should update
      const updateCommands = result.commands.filter(cmd => cmd.type === 'updateAttrs');
      assert.ok(updateCommands.length >= 1);
    });

    it('should include block attributes in commands', () => {
      const doc = new MarkdownDocument();
      const result = doc.update('# Title');
      
      // Skip clear command, check append command
      const appendCmd = result.commands.find(cmd => cmd.type === 'append');
      if (appendCmd && appendCmd.type === 'append') {
        assert.ok(appendCmd.attrs['data-block-id']);
        assert.ok(appendCmd.attrs['data-block-hash']);
        assert.strictEqual(appendCmd.attrs['data-line'], 0);
      }
    });

    it('should generate new IDs for truly new blocks', () => {
      const doc = new MarkdownDocument('# Title');
      const existingIds = new Set([doc.getBlock(0)?.id]);
      
      doc.update('# Title\n\nNew block 1\n\nNew block 2');
      
      // New blocks should have new IDs
      assert.ok(!existingIds.has(doc.getBlock(1)?.id));
      assert.ok(!existingIds.has(doc.getBlock(2)?.id));
    });

    it('should handle block ID lookup', () => {
      const doc = new MarkdownDocument('# Title\n\nParagraph');
      const titleId = doc.getBlock(0)?.id;
      
      const found = doc.getBlockById(titleId);
      assert.strictEqual(found?.content, '# Title');
    });

    it('should return all block IDs in order', () => {
      const doc = new MarkdownDocument('Block A\n\nBlock B\n\nBlock C');
      const ids = doc.getBlockIds();
      
      assert.strictEqual(ids.length, 3);
      assert.strictEqual(ids[0], doc.getBlock(0)?.id);
      assert.strictEqual(ids[1], doc.getBlock(1)?.id);
      assert.strictEqual(ids[2], doc.getBlock(2)?.id);
    });

    it('should set HTML by block ID', () => {
      const doc = new MarkdownDocument('# Title');
      const id = doc.getBlock(0)?.id;
      
      doc.setBlockHtmlById(id, '<h1>Title</h1>');
      assert.strictEqual(doc.getBlock(0)?.html, '<h1>Title</h1>');
    });
  });

  describe('Incremental Update Scenarios', () => {
    it('should efficiently handle typing at end', () => {
      const doc = new MarkdownDocument('# Title\n\nExisting paragraph');
      
      // Simulate typing a new paragraph
      const diff = doc.update('# Title\n\nExisting paragraph\n\nNew para');
      
      assert.strictEqual(diff.stats.kept, 2); // Title and existing para
      assert.strictEqual(diff.stats.inserted, 1); // New para
      assert.strictEqual(diff.stats.removed, 0);
    });

    it('should efficiently handle editing in middle', () => {
      const doc = new MarkdownDocument(`# Title

Para 1

Para 2

Para 3

Para 4`);
      
      // Edit middle paragraph
      const diff = doc.update(`# Title

Para 1

Edited Para 2

Para 3

Para 4`);
      
      assert.strictEqual(diff.stats.kept, 4); // Title, Para 1, 3, 4
      assert.strictEqual(diff.stats.inserted, 1); // Edited
      assert.strictEqual(diff.stats.removed, 1); // Old Para 2
    });

    it('should handle inserting at beginning', () => {
      const doc = new MarkdownDocument('# Title\n\nContent');
      
      const diff = doc.update('New intro\n\n# Title\n\nContent');
      
      assert.strictEqual(diff.stats.kept, 2); // Title and Content
      assert.strictEqual(diff.stats.inserted, 1); // New intro
    });

    it('should correctly handle block reordering with insertions', () => {
      // Bug: when kept blocks change order AND new blocks are inserted,
      // the generated commands may produce incorrect DOM order
      
      const initialContent = `# Block A

# Block B

# Block C

# Block D

# Block E`;

      const doc = new MarkdownDocument(initialContent);
      const initialIds = doc.getBlocks().map(b => ({ id: b.id, content: b.content }));
      
      // blockA=1, blockB=2, blockC=3, blockD=4, blockE=5
      
      // Update: Reorder to A, D, X(new), B, E (C deleted, D moved before B)
      const result = doc.update(`# Block A

# Block D

# New Block X

# Block B

# Block E`);
      
      // Expected order after update: A(1), D(4), X(new), B(2), E(5)
      const newBlocks = doc.getBlocks();
      assert.strictEqual(newBlocks.length, 5);
      assert.strictEqual(newBlocks[0].content, '# Block A');
      assert.strictEqual(newBlocks[1].content, '# Block D');
      assert.strictEqual(newBlocks[2].content, '# New Block X');
      assert.strictEqual(newBlocks[3].content, '# Block B');
      assert.strictEqual(newBlocks[4].content, '# Block E');
      
      // Verify IDs are preserved for kept blocks
      assert.strictEqual(newBlocks[0].id, initialIds[0].id); // A kept
      assert.strictEqual(newBlocks[1].id, initialIds[3].id); // D kept (was at index 3)
      assert.strictEqual(newBlocks[3].id, initialIds[1].id); // B kept (was at index 1)
      assert.strictEqual(newBlocks[4].id, initialIds[4].id); // E kept (was at index 4)
      
      // Verify stats
      // A, D, E stay in relative order; B needs to move (was before D, now after D)
      assert.strictEqual(result.stats.kept, 3); // A, D, E (B moved)
      assert.strictEqual(result.stats.removed, 2); // C deleted + B moved
      assert.strictEqual(result.stats.inserted, 2); // X new + B re-inserted
      
      // Key verification: commands should produce correct order when applied
      // Since B also needs to move (it was before D originally, now after D),
      // X's refId will be E (the next stable block that doesn't need moving)
      const insertCommands = result.commands.filter(c => c.type === 'insertBefore');
      if (insertCommands.length > 0) {
        const xInsert = insertCommands.find(c => c.blockId === newBlocks[2].id);
        if (xInsert && xInsert.type === 'insertBefore') {
          // X should be inserted before E (newBlocks[4]) since B also moves
          assert.strictEqual(xInsert.refId, newBlocks[4].id, 
            'New block X should be inserted before block E (next stable block)');
        }
      }
    });

    it('should preserve rendered HTML (not placeholder) when block moves', () => {
      // Scenario: Async rendering completes, then user edits cause block reorder
      // The moved block should use rendered HTML, not stale placeholder
      const initialContent = `# Title

Block A

\`\`\`mermaid
graph TD
A --> B
\`\`\`

Block B`;

      const doc = new MarkdownDocument(initialContent);
      
      // Simulate initial render with placeholder
      doc.setBlockHtml(0, '<h1>Title</h1>');
      doc.setBlockHtml(1, '<p>Block A</p>');
      doc.setBlockHtml(2, '<div class="async-placeholder" id="p1">Loading...</div>');
      doc.setBlockHtml(3, '<p>Block B</p>');
      
      // Verify placeholder state
      assert.strictEqual(doc.getBlock(2)?.hasPlaceholder, true);
      
      // Simulate async render completion - sync rendered HTML back to memory
      const mermaidBlock = doc.getBlocks().find(b => b.content.includes('mermaid'));
      const renderedHtml = '<div class="diagram-block" data-plugin-rendered="true"><img src="data:image/png;base64,xxx"/></div>';
      doc.setBlockHtmlById(mermaidBlock.id, renderedHtml);
      
      // Verify placeholder state cleared
      assert.strictEqual(doc.getBlockById(mermaidBlock.id)?.hasPlaceholder, false);
      
      // User edit: swap Block A and Block B
      const newContent = `# Title

Block B

\`\`\`mermaid
graph TD
A --> B
\`\`\`

Block A`;

      const diff = doc.update(newContent);
      
      // Find the command for mermaid block
      const mermaidMoveCmd = diff.commands.find(cmd => 
        cmd.blockId === mermaidBlock.id && 
        (cmd.type === 'insertBefore' || cmd.type === 'append')
      );
      
      // Key assertion: moved block should use rendered HTML, not placeholder
      if (mermaidMoveCmd) {
        assert.ok(
          mermaidMoveCmd.html.includes('data-plugin-rendered'),
          'Moved block should use rendered HTML, not placeholder'
        );
        assert.ok(
          !mermaidMoveCmd.html.includes('async-placeholder'),
          'Moved block should not contain placeholder'
        );
      }
      
      // Also verify the block still has correct HTML in memory
      const updatedMermaidBlock = doc.getBlocks().find(b => b.content.includes('mermaid'));
      assert.strictEqual(updatedMermaidBlock?.html, renderedHtml);
      assert.strictEqual(updatedMermaidBlock?.hasPlaceholder, false);
    });
  });
});
