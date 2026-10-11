import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import hljs from '../../../src/utils/highlight-registry.ts';

/**
 * The shared highlight.js registry.
 *
 * `highlight.js/lib/common` ships a 37-language subset, so a grammar that only
 * exists in the full distribution (Erlang, for one) renders flat. The registry
 * registers those extra grammars on the shared `common` singleton, which is what
 * the two direct `hljs` consumers — code preview and DOCX export — import.
 *
 * These tests guard the same two-sided contract as the rehype-highlight tests in
 * `markdown-processor.test.js`: the extra grammar must be present, and the
 * common set must survive the registration. A registration that replaced the
 * common set would satisfy the first assertion while silently dropping every
 * other language.
 */
describe('highlight-registry', () => {
  it('registers erlang alongside the common set', () => {
    assert.ok(hljs.getLanguage('erlang'), 'erlang should be registered');
    assert.ok(hljs.getLanguage('bash'), 'bash must still be registered');
    assert.ok(hljs.getLanguage('python'), 'python must still be registered');
    assert.ok(hljs.getLanguage('diff'), 'diff must still be registered');
    assert.ok(hljs.getLanguage('xml'), 'xml must still be registered');
  });

  it('resolves the erl alias through the shared registry', () => {
    // `highlight.js/lib/languages/erlang` declares `aliases: ['erl']`, and
    // highlight.js core's `registerLanguage` registers those aliases itself —
    // no explicit alias call is needed anywhere in this repository.
    assert.ok(hljs.getLanguage('erl'), 'the erl alias should resolve to erlang');
  });

  it('tokenises erlang the way code preview and DOCX export consume it', () => {
    // Both direct consumers call `hljs.getLanguage(language)` as a guard and
    // then `hljs.highlight(code, { language, ignoreIllegals: true })`. Assert
    // the tokenisation those consumers see, without needing a DOM.
    const code = ['-module(counter).', 'start(N) ->', '    {ok, N + 1}.'].join('\n');

    assert.ok(hljs.getLanguage('erlang'), 'the guard must accept erlang');

    const result = hljs.highlight(code, { language: 'erlang', ignoreIllegals: true });
    const tokens = result.value.match(/<span class="hljs-[a-z_-]+"/g) ?? [];

    assert.ok(tokens.length > 0, 'erlang should emit highlight.js token spans');
    assert.ok(result.value.includes('hljs-keyword'), 'erlang keywords should be tokenised');
  });
});
