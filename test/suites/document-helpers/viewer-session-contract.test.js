import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  resolveDefaultTocVisibility,
  resolveTocPresentation,
} from '../../../src/core/viewer/viewer-session-contract.ts';

describe('viewer container defaults', () => {
  it('uses visible TOC by default for browser mode', () => {
    assert.strictEqual(resolveDefaultTocVisibility('browser'), true);
  });

  it('uses hidden TOC by default for panel mode', () => {
    assert.strictEqual(resolveDefaultTocVisibility('panel'), false);
  });

  it('keeps embedded mode collapsed by default', () => {
    assert.strictEqual(resolveDefaultTocVisibility('embedded'), false);
  });

  it('maps browser mode to sidebar TOC presentation', () => {
    assert.strictEqual(resolveTocPresentation('browser'), 'sidebar');
  });

  it('maps panel mode to floating TOC presentation', () => {
    assert.strictEqual(resolveTocPresentation('panel'), 'floating');
  });
});