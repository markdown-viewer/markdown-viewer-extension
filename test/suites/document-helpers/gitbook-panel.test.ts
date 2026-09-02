import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGitbookSummary } from '../../../chrome/src/webview/ui/gitbook-panel.ts';

describe('GitBook summary parsing', () => {
  it('keeps section headings separate from page links', () => {
    const items = parseGitbookSummary(
      '# Summary\n\n## 开发指南\n* [fibjs 是什么？](guide/about.md)\n\n## 基础模块\n* [assert](manual/module/ifs/assert.md)\n',
      'file:///Users/lion/works/fibjs/docs/docs/SUMMARY.md',
    );

    assert.deepEqual(items, [
      { type: 'heading', title: '开发指南', depth: 0 },
      {
        type: 'page',
        title: 'fibjs 是什么？',
        href: 'file:///Users/lion/works/fibjs/docs/docs/guide/about.md',
        depth: 1,
      },
      { type: 'heading', title: '基础模块', depth: 0 },
      {
        type: 'page',
        title: 'assert',
        href: 'file:///Users/lion/works/fibjs/docs/docs/manual/module/ifs/assert.md',
        depth: 1,
      },
    ]);
  });

  it('parses plain list section headings without turning them into pages', () => {
    const items = parseGitbookSummary(
      '* Guide\n  * [Intro](intro.md)\n',
      'file:///book/SUMMARY.md',
    );

    assert.deepEqual(items, [
      { type: 'heading', title: 'Guide', depth: 0 },
      { type: 'page', title: 'Intro', href: 'file:///book/intro.md', depth: 1 },
    ]);
  });
});