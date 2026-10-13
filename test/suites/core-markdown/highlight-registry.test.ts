import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import hljs from '../../../src/utils/highlight-registry.ts';
import { EXTRA_HIGHLIGHT_GRAMMARS } from '../../../src/utils/extra-highlight-grammars.ts';
import { EXT_LANG_MAP } from '../../../src/utils/extension-categories.ts';

/**
 * The shared highlight.js registry.
 *
 * `highlight.js/lib/common` ships a 36-language subset, so a grammar that only
 * exists in the full distribution (Erlang, for one) renders flat. The registry
 * registers the `EXTRA_HIGHLIGHT_GRAMMARS` on the shared `common` singleton,
 * which is what the two direct `hljs` consumers — code preview and DOCX export
 * — import.
 *
 * These tests guard the same two-sided contract as the rehype-highlight tests in
 * `markdown-processor.test.js`: the extra grammars must be present, and the
 * common set must survive the registration. A registration that replaced the
 * common set would satisfy the first assertion while silently dropping every
 * other language.
 */
describe('highlight-registry', () => {
  it('registers the extra grammars alongside the common set', () => {
    for (const name of Object.keys(EXTRA_HIGHLIGHT_GRAMMARS)) {
      assert.ok(hljs.getLanguage(name), `${name} should be registered`);
    }
    assert.ok(hljs.getLanguage('bash'), 'bash must still be registered');
    assert.ok(hljs.getLanguage('python'), 'python must still be registered');
    assert.ok(hljs.getLanguage('diff'), 'diff must still be registered');
    assert.ok(hljs.getLanguage('xml'), 'xml must still be registered');
  });

  it('covers every highlight.js language EXT_LANG_MAP routes a file extension to', () => {
    // Opening a file (`app.erl`, `build.ps1`, `doc.tex`, …) goes through
    // `getCodeFenceLanguageForPath` → EXT_LANG_MAP → `hljs.getLanguage`.
    // A mapped language that is not registered silently renders flat, which is
    // exactly how `.erl` escaped the fence fix.
    //
    // Five map values have no grammar in highlight.js at *any* distribution
    // size — vue, svelte, zig, fish and csv. Those files fall back to a
    // `.hljs language-*` class with no tokens; registering a grammar is not an
    // option, so they are excluded here. Everything else must resolve.
    const PHANTOM_LANGUAGES = new Set(['vue', 'svelte', 'zig', 'fish', 'csv']);

    const languages = [...new Set(Object.values(EXT_LANG_MAP))]
      .filter((language) => !PHANTOM_LANGUAGES.has(language));
    const unregistered = languages.filter((language) => !hljs.getLanguage(language));

    assert.deepStrictEqual(
      unregistered,
      [],
      `EXT_LANG_MAP languages missing from the registry: ${unregistered.join(', ')}`,
    );
  });

  it('resolves declared aliases through the shared registry', () => {
    // highlight.js core's `registerLanguage` registers a grammar's declared
    // aliases itself — no explicit alias call is needed anywhere in this
    // repository.
    assert.ok(hljs.getLanguage('erl'), 'the erl alias should resolve to erlang');
    // The Windows batch grammar ships as `dos`, aliased to bat/batch/cmd.
    assert.ok(hljs.getLanguage('bat'), 'the bat alias should resolve to dos');
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
