/**
 * Extension matching on query-string URLs.
 *
 * A remote document URL keeps its query string *after* the file name
 * (`.../logs/job-logs.txt?rsct=text%2Fplain&sv=…&sig=…` — Azure blob SAS
 * tokens, cache busters, tracking params). Every extension lookup therefore
 * has to match on the path alone: on the full URL the `.txt` page was not
 * recognised as a code-preview file and the whole log was handed to the
 * markdown parser (all 2632 lines collapsed into one paragraph).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCodeReadingRender, getCodePreviewMatchedExtension } from '../../../src/utils/code-preview.ts';
import { getFileType, wrapFileContent } from '../../../src/utils/file-wrapper.ts';

const SAS_URL =
  'https://acct.blob.core.windows.net/actions-results/run-1/logs/job/job-logs.txt'
  + '?rsct=text%2Fplain&sv=2025-11-05&sig=abc%3D';

describe('extension matching on query-string URLs', () => {
  it('matches the code-preview extension on the file name', () => {
    assert.strictEqual(getCodePreviewMatchedExtension(SAS_URL), '.txt');
    assert.strictEqual(getCodePreviewMatchedExtension('https://example.com/a/b.ts?raw=1'), '.ts');
    assert.strictEqual(getCodePreviewMatchedExtension('https://example.com/page.html?x=1'), '.html');
    // Markdown is deliberately absent from the code-preview map.
    assert.strictEqual(getCodePreviewMatchedExtension('file:///tmp/notes.md#intro'), null);
  });

  it('renders a .txt URL with a query string as a code-reading document', () => {
    const result = buildCodeReadingRender('line one\nline two', SAS_URL);

    assert.ok(result, 'expected a code-reading render result');
    assert.strictEqual(result.codeView, true);
    assert.strictEqual(result.language, 'plaintext');
    assert.ok(result.markdown.startsWith('```plaintext\n'), `unexpected fence: ${result.markdown}`);
  });

  it('keeps the diagram file type of a query-string URL', () => {
    assert.strictEqual(getFileType('https://example.com/demo.mermaid?sv=1'), 'mermaid');
    assert.strictEqual(getFileType('https://example.com/chart.vega?x=1#top'), 'vega');

    const wrapped = wrapFileContent('graph TD; A-->B;', 'https://example.com/demo.mermaid?sv=1');
    assert.ok(wrapped.startsWith('```mermaid\n'), `unexpected wrapper: ${wrapped}`);
  });

  it('leaves plain filesystem paths (and their literal ?) alone', () => {
    assert.strictEqual(getFileType('/Users/me/notes.md'), 'markdown');
    assert.strictEqual(getFileType('/Users/me/a.mermaid?draft'), 'markdown');
  });
});
