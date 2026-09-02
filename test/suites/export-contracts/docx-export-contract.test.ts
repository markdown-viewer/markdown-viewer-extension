/**
 * DOCX export contract tests — the REAL DOCX pipeline through the CLI:
 * unpack the produced .docx (a zip) and assert the core document parts.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import JSZip from 'jszip';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
} from '../../helpers/browser-render-harness.ts';

const BODY_TEXT = path.resolve('test/fixtures/layout/body-text.md');

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
  timeoutMs: 240_000,
} as const;

describe('DOCX export contract (real pipeline)', () => {
  let harness: BrowserRenderHarness;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: BODY_TEXT });
  });

  after(async () => {
    await harness.dispose();
  });

  it('produces a valid DOCX with the document body', async () => {
    const { base64, filename } = await harness.renderDocx(BODY_TEXT, FIXED_PARAMS);
    assert.ok(filename.endsWith('.docx'), `filename must be a .docx (got "${filename}")`);

    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    for (const required of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml']) {
      assert.ok(zip.files[required], `DOCX must contain ${required}`);
    }
    const documentXml = await zip.files['word/document.xml'].async('string');
    assert.ok(
      documentXml.includes('Body Text Fixture'),
      'document.xml must carry the rendered markdown text',
    );
    assert.ok(
      documentXml.includes('first paragraph'),
      'document.xml must carry the paragraph content',
    );
  });

  it('applies the theme settings to the document', async () => {
    const { base64 } = await harness.renderDocx(BODY_TEXT, FIXED_PARAMS);
    const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
    const styles = await zip.files['word/styles.xml'].async('string');
    assert.ok(styles.includes('Normal'), 'styles.xml must define the Normal style');
  });

  it('reports plugin failures in DOCX export as one concise warning with the source line', async () => {
    const invalidMermaid = path.resolve('test/fixtures/layout/invalid-mermaid.md');
    const before = harness.consoleMessages().length;
    await harness.renderDocx(invalidMermaid, FIXED_PARAMS);
    const messages = harness.consoleMessages().slice(before);
    const pluginWarnings = messages.filter((m) => m.text.includes('PluginTask'));
    assert.equal(
      pluginWarnings.length,
      1,
      'exactly one concise warning — no duplicate dumps, no stack traces',
    );
    const [warning] = pluginWarnings;
    assert.equal(warning.type, 'warning', 'plugin render failures must be warnings, not errors');
    assert.match(warning.text, /mermaid/, 'the warning must name the diagram type');
    assert.match(warning.text, /line 3/, 'the warning must name the real document line');
    assert.ok(!/at [A-Za-z]/.test(warning.text), 'the warning must not include a stack trace');
  });
});
