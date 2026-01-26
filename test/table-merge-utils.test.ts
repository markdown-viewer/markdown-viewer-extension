/**
 * Tests for table-merge-utils.ts
 * Tests colspan support for group header rows
 */

import assert from 'assert';
import test from 'test';

import { 
  calculateMergeInfoFromStringsWithAnalysis,
  calculateMergeInfoFromStrings
} from '../src/utils/table-merge-utils';

test.describe('Table Merge Utils', () => {
  
  test.describe('colspan for group headers', () => {
    
    test.it('should apply colspan to single group header', () => {
      const rows = [
        ['【分类】', '',     '',     ''],
        ['A',       'A1',   'Item1', '10'],
        ['',        '',     'Item2', '20'],
      ];
      
      const { mergeInfo, analysis } = calculateMergeInfoFromStringsWithAnalysis(rows);
      
      // Row 0 is group header
      assert.ok(analysis?.groupHeaders.rows.includes(0));
      
      // First cell should have colspan = 4
      assert.strictEqual(mergeInfo[0][0].colspan, 4);
      assert.strictEqual(mergeInfo[0][0].shouldRender, true);
      
      // Other cells should not render
      assert.strictEqual(mergeInfo[0][1].shouldRender, false);
      assert.strictEqual(mergeInfo[0][2].shouldRender, false);
      assert.strictEqual(mergeInfo[0][3].shouldRender, false);
    });
    
    test.it('should apply colspan to multiple group headers', () => {
      const rows = [
        ['【水果】', '',     '',       ''],
        ['热带',    '芒果', '大芒果', '10'],
        ['',        '',     '小芒果', '20'],
        ['【蔬菜】', '',     '',       ''],
        ['叶菜',    '白菜', '大白菜', '30'],
      ];
      
      const { mergeInfo, analysis } = calculateMergeInfoFromStringsWithAnalysis(rows);
      
      // Both group headers detected
      assert.ok(analysis?.groupHeaders.rows.includes(0));
      assert.ok(analysis?.groupHeaders.rows.includes(3));
      
      // Both should have colspan = 4
      assert.strictEqual(mergeInfo[0][0].colspan, 4);
      assert.strictEqual(mergeInfo[3][0].colspan, 4);
    });
    
    test.it('should handle two-column group header', () => {
      // Group header with text in first two columns
      // The second filled cell should get colspan for trailing empty cells
      const rows = [
        ['类别A', '小类',  '',       ''],   // group header: 2 cols filled, trailing empty
        ['水果',  '苹果',  '红富士', '10'],
        ['',      '',      '青苹果', '5'],
        ['类别B', '其他',  '',       ''],   // group header: 2 cols filled
        ['蔬菜',  '白菜',  '大白菜', '8'],
      ];
      
      const { mergeInfo, analysis } = calculateMergeInfoFromStringsWithAnalysis(rows);
      
      // Rows 0 and 3 should be detected as group headers
      assert.ok(analysis?.groupHeaders.rows.includes(0));
      assert.ok(analysis?.groupHeaders.rows.includes(3));
      
      // For two-column header: first cell stays normal, second cell gets colspan for trailing empty
      // Row 0: col 0 = "类别A" (colspan=1), col 1 = "小类" (colspan=3 for cols 1,2,3)
      assert.strictEqual(mergeInfo[0][0].colspan, 1);
      assert.strictEqual(mergeInfo[0][1].colspan, 3);
      assert.strictEqual(mergeInfo[0][2].shouldRender, false);
      assert.strictEqual(mergeInfo[0][3].shouldRender, false);
      
      // Same for row 3
      assert.strictEqual(mergeInfo[3][0].colspan, 1);
      assert.strictEqual(mergeInfo[3][1].colspan, 3);
    });
    
    test.it('should not affect non-group-header rows', () => {
      const rows = [
        ['A', 'A1', 'Item1', '10'],
        ['',  '',   'Item2', '20'],
        ['B', 'B1', 'Item3', '30'],
      ];
      
      const { mergeInfo } = calculateMergeInfoFromStringsWithAnalysis(rows);
      
      // No row should have colspan > 1
      for (const row of mergeInfo) {
        for (const cell of row) {
          assert.strictEqual(cell.colspan, 1);
        }
      }
    });
    
    test.it('should combine rowspan and colspan correctly', () => {
      const rows = [
        ['【组1】', '',     '',     ''],   // group header, colspan=4
        ['A',       'A1',   'X',    '1'],  // tree start, rowspan in col 0,1
        ['',        '',     'Y',    '2'],  // merged
        ['【组2】', '',     '',     ''],   // group header, colspan=4
        ['B',       'B1',   'Z',    '3'],  // new tree start
      ];
      
      const { mergeInfo, analysis } = calculateMergeInfoFromStringsWithAnalysis(rows);
      
      // Group headers have colspan
      assert.strictEqual(mergeInfo[0][0].colspan, 4);
      assert.strictEqual(mergeInfo[3][0].colspan, 4);
      
      // Tree cells have rowspan
      assert.strictEqual(mergeInfo[1][0].rowspan, 2);
      assert.strictEqual(mergeInfo[1][1].rowspan, 2);
      
      // Merged cells don't render
      assert.strictEqual(mergeInfo[2][0].shouldRender, false);
      assert.strictEqual(mergeInfo[2][1].shouldRender, false);
    });
    
  });
  
  test.describe('calculateMergeInfoFromStrings', () => {
    
    test.it('should return default merge info for non-tree table', () => {
      const rows = [
        ['A', 'B', 'C'],
        ['D', 'E', 'F'],
        ['G', 'H', 'I'],
      ];
      
      const mergeInfo = calculateMergeInfoFromStrings(rows);
      
      // All cells should have default values
      for (const row of mergeInfo) {
        for (const cell of row) {
          assert.strictEqual(cell.rowspan, 1);
          assert.strictEqual(cell.colspan, 1);
          assert.strictEqual(cell.shouldRender, true);
        }
      }
    });
    
  });
  
});
