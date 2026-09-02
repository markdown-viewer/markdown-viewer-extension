import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BookExportProgressModel } from '../../../chrome/src/webview/ui/book-export-progress.ts';

describe('BookExportProgressModel', () => {
  it('simulates the back half of a stage from the first-half average time', () => {
    const model = new BookExportProgressModel('docx');
    const halfway = model.onPhaseProgress('fetch', 50, 100, 1_000);

    assert.equal(halfway, 0.2025);
    assert.equal(model.tick(2_000), 0.45);
  });

  it('advances to the second EPUB render stage without regressing progress', () => {
    const model = new BookExportProgressModel('epub');
    const firstHalf = model.onPhaseProgress('render', 130, 260, 1_000);
    const firstStageTail = model.tick(2_000);
    const firstStageDone = model.onPhaseProgress('render', 260, 260, 2_100);
    const secondStageStart = model.onPhaseProgress('render', 1, 260, 2_200);

    assert.equal(firstHalf, 0.225);
    assert.ok(firstStageTail > firstHalf, 'tail simulation should continue progressing inside the first render stage');
    assert.ok(firstStageDone >= firstStageTail, 'completing the first render stage must not move backward');
    assert.ok(secondStageStart >= 0.5, 'the second render pass must start at or after the second segment start');
  });

  it('completes at 100 percent when the export finishes', () => {
    const model = new BookExportProgressModel('epub');
    model.onPhaseProgress('render', 130, 260, 1_000);

    assert.equal(model.complete(), 1);
    assert.equal(model.tick(10_000), 1);
  });
});