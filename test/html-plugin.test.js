import { describe, it } from 'node:test';
import assert from 'node:assert';

import { HtmlPlugin } from '../src/plugins/html-plugin.ts';

class FakeImageElement {
  constructor(container, originalTag) {
    this.container = container;
    this.originalTag = originalTag;
  }

  getAttribute(name) {
    const match = this.originalTag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
    return match?.[1] ?? null;
  }

  setAttribute(name, value) {
    const updatedTag = this.originalTag.replace(new RegExp(`${name}="([^"]*)"`, 'i'), `${name}="${value}"`);
    this.container.replaceTag(this.originalTag, updatedTag);
    this.originalTag = updatedTag;
  }
}

class FakeContainerElement {
  constructor() {
    this.innerHTML = '';
  }

  querySelectorAll(selector) {
    if (selector !== 'img[src]') {
      return [];
    }

    const matches = this.innerHTML.match(/<img\b[^>]*\bsrc="[^"]*"[^>]*>/gi) || [];
    return matches.map((tag) => new FakeImageElement(this, tag));
  }

  replaceTag(originalTag, updatedTag) {
    this.innerHTML = this.innerHTML.replace(originalTag, updatedTag);
  }
}

globalThis.document = {
  createElement(tagName) {
    assert.strictEqual(tagName, 'div');
    return new FakeContainerElement();
  }
};

describe('HtmlPlugin', () => {
  it('should inline local image src without rewriting html links', async () => {
    const plugin = new HtmlPlugin();
    const calls = [];

    globalThis.platform = {
      document: {
        resolvePath(input) {
          calls.push(input);
          return `file:///workspace/${input.replace(/^\.\//, '')}`;
        },
        async readFile(input) {
          assert.strictEqual(input, 'file:///workspace/images/pic.png');
          return 'ZmFrZQ==';
        }
      }
    };

    const input = '<p><a href="./note.md">Doc</a><a href="#section">Section</a><img src="images/pic.png" alt="pic"></p>';
    const output = await plugin.preprocessContent(input);

    assert.deepStrictEqual(calls, ['./images/pic.png']);
    assert.ok(output.includes('href="./note.md"'), 'document-relative href should remain unchanged');
    assert.ok(output.includes('href="#section"'), 'fragment href should remain unchanged');
    assert.ok(output.includes('src="data:image/png;base64,ZmFrZQ=="'), 'image src should be inlined');
  });
});