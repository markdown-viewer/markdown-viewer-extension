// Shared highlight.js registry.
//
// documd ships `highlight.js/lib/common`, a 36-language subset. Languages that
// only exist in the full distribution (Erlang, for example) render flat.
// `EXTRA_HIGHLIGHT_GRAMMARS` extends the shared `common` singleton here instead
// of registering per call site: this export is a singleton, so one registration
// covers every direct `hljs` caller (code preview, DOCX export).
//
// Note: the Markdown/HTML fence pipeline does NOT go through this singleton —
// it uses `rehype-highlight` (lowlight), which builds its own registry from
// lowlight's `common` grammars. That is extended separately in
// `src/core/markdown-processor.ts`. Both sides read the same grammar map.

import hljs from 'highlight.js/lib/common';
import { EXTRA_HIGHLIGHT_GRAMMARS } from './extra-highlight-grammars';

for (const [name, grammar] of Object.entries(EXTRA_HIGHLIGHT_GRAMMARS)) {
  hljs.registerLanguage(name, grammar);
}

export default hljs;
