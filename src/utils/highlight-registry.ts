// Shared highlight.js registry.
//
// documd ships `highlight.js/lib/common`, a 37-language subset. Languages that
// only exist in the full distribution (Erlang, for example) render flat. Extend
// the shared `common` singleton here instead of registering per call site: the
// export is a singleton, so one registration covers every direct `hljs` caller
// (code preview, DOCX export).
//
// Note: the Markdown/HTML fence pipeline does NOT go through this singleton —
// it uses `rehype-highlight` (lowlight), which builds its own registry from
// `lowlight`'s `common` grammars. That is extended separately in
// `src/core/markdown-processor.ts`.

import hljs from 'highlight.js/lib/common';
import erlang from 'highlight.js/lib/languages/erlang';

hljs.registerLanguage('erlang', erlang);

export default hljs;
