import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import { createBrowserRenderHarness, type BrowserRenderHarness } from '../../helpers/browser-render-harness.ts';

const IMAGE_FIXTURE = path.resolve('test/fixtures/layout/image-center.md');
const DIAGRAM_FIXTURE = path.resolve('test/fixtures/layout/diagram-center.md');
const BLOCKQUOTE_FIXTURE = path.resolve('test/fixtures/layout/blockquote-body.md');
const TABLE_FIXTURE = path.resolve('test/fixtures/layout/table-center.md');

describe('Browser render harness', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: IMAGE_FIXTURE });
  });

  after(async () => {
    await harness.dispose();
  });

  it('renders the shared content root for the image-center fixture', async () => {
    const snapshot = await harness.snapshotDom(IMAGE_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableLayout: 'center',
      tableMergeEmpty: false,
      timeoutMs: 120_000,
    });

    assert.match(snapshot.pageHtml, /id="markdown-page"/);
    assert.match(snapshot.pageHtml, /id="markdown-content"/);
    assert.match(snapshot.contentClassName, /table-layout-center/);
    assert.equal(snapshot.imageCount, 1, 'Expected one image in the image fixture');
    assert.equal(snapshot.diagramBlockCount, 0, 'Expected no diagram blocks in the image fixture');
    assert.equal(snapshot.blockquoteCount, 0, 'Expected no blockquotes in the image fixture');
    assert.equal(snapshot.tableCount, 0, 'Expected no tables in the image fixture');
  });

  it('renders the dedicated diagram fixture with one diagram block', async () => {
    const snapshot = await harness.snapshotDom(DIAGRAM_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableLayout: 'center',
      tableMergeEmpty: false,
      timeoutMs: 120_000,
    });

    assert.ok(snapshot.diagramBlockCount > 0, 'Expected at least one diagram block in the diagram fixture');
    assert.equal(snapshot.imageCount, snapshot.diagramBlockCount, 'Expected diagram blocks to be backed by rendered image nodes');
  });

  it('renders the dedicated blockquote fixture with blockquotes only', async () => {
    const snapshot = await harness.snapshotDom(BLOCKQUOTE_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableLayout: 'center',
      tableMergeEmpty: false,
      timeoutMs: 120_000,
    });

    assert.ok(snapshot.blockquoteCount > 0, 'Expected at least one blockquote in the blockquote fixture');
    assert.equal(snapshot.imageCount, 0, 'Expected no images in the blockquote fixture');
    assert.equal(snapshot.tableCount, 0, 'Expected no tables in the blockquote fixture');
  });

  it('renders the dedicated table fixture with one table', async () => {
    const snapshot = await harness.snapshotDom(TABLE_FIXTURE, {
      theme: 'default',
      language: 'en',
      frontmatterDisplay: 'hide',
      tableLayout: 'center',
      tableMergeEmpty: false,
      timeoutMs: 120_000,
    });

    assert.ok(snapshot.tableCount > 0, 'Expected at least one table in the table fixture');
    assert.equal(snapshot.imageCount, 0, 'Expected no images in the table fixture');
    assert.equal(snapshot.blockquoteCount, 0, 'Expected no blockquotes in the table fixture');
  });
});