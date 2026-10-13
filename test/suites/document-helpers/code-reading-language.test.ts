/**
 * Code-reading language routing for Erlang files.
 *
 * Issue context: PR #135 registered the erlang grammar, which lit up
 * ````erlang` fences and DOCX export — but opening an `.erl` file still rendered
 * flat, because the file path resolves its language through EXT_LANG_MAP and
 * `erl` was never in the map. The grammar fix was unreachable from the path
 * users actually take. These tests pin that routing end to end.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCodeReadingRender, getCodeFenceLanguageForPath } from '../../../src/utils/code-preview.ts';
import hljs from '../../../src/utils/highlight-registry.ts';

describe('code-reading language routing', () => {
  it('routes erlang file extensions to the erlang grammar', () => {
    assert.strictEqual(getCodeFenceLanguageForPath('/tmp/counter.erl'), 'erl');
    assert.strictEqual(getCodeFenceLanguageForPath('/tmp/counter.hrl'), 'erl');
    assert.strictEqual(getCodeFenceLanguageForPath('/tmp/counter.escript'), 'erl');
    // Remote URLs keep their query string after the extension.
    assert.strictEqual(getCodeFenceLanguageForPath('https://example.com/a/counter.erl?raw=1'), 'erl');
  });

  it('builds an erlang code-reading document for a .erl path', () => {
    const result = buildCodeReadingRender('-module(counter).', '/tmp/counter.erl');

    assert.ok(result, 'expected a code-reading render result');
    assert.strictEqual(result.codeView, true);
    assert.strictEqual(result.language, 'erl');
    assert.ok(result.markdown.startsWith('```erl\n'), `unexpected fence: ${result.markdown}`);
  });

  it('tokenises the erlang identifier the code-reading path produces', () => {
    // `renderCodeViewBlock` guards on `hljs.getLanguage(language)` before
    // highlighting, so a language that fails this check renders flat.
    const language = getCodeFenceLanguageForPath('/tmp/counter.erl');
    assert.ok(language);
    assert.ok(hljs.getLanguage(language), `${language} must be registered`);

    const result = hljs.highlight('-module(counter).', { language, ignoreIllegals: true });
    assert.ok(result.value.includes('hljs-keyword'), 'erlang keywords should be tokenised');
  });
});
