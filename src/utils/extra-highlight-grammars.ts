// Grammar declarations added on top of highlight.js' `common` subset.
//
// `highlight.js/lib/common` (36 languages) and lowlight's `common` (37 — the
// same set plus `arduino`) are deliberately small. A grammar that only exists in
// the full distribution renders flat — the fence keeps its `language-*` class
// but emits no `hljs-*` token spans.
//
// Every grammar listed here is one the product already promises: an identifier
// in docs/features/code-highlight.md, or a language EXT_LANG_MAP routes a real
// file extension to (`.scala`, `.ps1`, `.tex`, …). Keep this list and that
// promise in sync — a language in either place that is absent here silently
// degrades to monochrome.
//
// Two registries consume this map, and they are genuinely separate — do not
// collapse them into one import point:
//   - the highlight.js `common` singleton (`highlight-registry.ts`), used by the
//     code-preview view and the DOCX exporter;
//   - the lowlight instance built by `rehype-highlight`, used by the fence
//     pipeline (`markdown-processor.ts`).

import type { LanguageFn } from 'highlight.js';

import scala from 'highlight.js/lib/languages/scala';
import dart from 'highlight.js/lib/languages/dart';
import powershell from 'highlight.js/lib/languages/powershell';
// The Windows batch grammar ships as `dos`; its declared aliases are
// `bat` / `batch` / `cmd`, so registering it also resolves the `bat` identifier
// that EXT_LANG_MAP maps `.bat` / `.cmd` to.
import dos from 'highlight.js/lib/languages/dos';
import latex from 'highlight.js/lib/languages/latex';
import haskell from 'highlight.js/lib/languages/haskell';
import elixir from 'highlight.js/lib/languages/elixir';
import clojure from 'highlight.js/lib/languages/clojure';
import fsharp from 'highlight.js/lib/languages/fsharp';
import graphql from 'highlight.js/lib/languages/graphql';
import erlang from 'highlight.js/lib/languages/erlang';

export const EXTRA_HIGHLIGHT_GRAMMARS: Readonly<Record<string, LanguageFn>> = {
  scala,
  dart,
  powershell,
  dos,
  latex,
  haskell,
  elixir,
  clojure,
  fsharp,
  graphql,
  erlang,
};
