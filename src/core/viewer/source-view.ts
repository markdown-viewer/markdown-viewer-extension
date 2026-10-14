/**
 * Independent source surface — the viewer's "show the raw file" face.
 *
 * Source is not a markdown code block: it never enters the remark/rehype
 * pipeline, it keeps its own container next to the rendered surface, and it is
 * what the browser/workspace viewer shows for source and code-reading modes
 * (see plans/code-preview-toggle-plan.md).
 *
 * Two structural facts matter:
 *
 *   1. `#mv-source-view` is a sibling of `#markdown-content`, i.e. *outside*
 *      `#markdown-page`. Exporters serialise the content root, so a document
 *      exported while the user is reading its source still exports the
 *      rendered document.
 *   2. Switching to source never clears the rendered surface — it is hidden by
 *      `html[data-source-view]` and stays mounted, which is what makes point 1
 *      true.
 *
 * Panel hosts (VS Code / Obsidian / iframe embeds) deliberately do not use this
 * module: their source view is the host's own editor.
 */

import hljs from '../../utils/highlight-registry';

export const SOURCE_VIEW_ID = 'mv-source-view';
export const SOURCE_VIEW_LINE_CLASS = 'mv-source-line';
export const SOURCE_VIEW_LINE_CONTENT_CLASS = 'mv-source-line-content';

export interface SourceViewInput {
  content: string;
  /** highlight.js language identifier; unknown identifiers fall back to plain text. */
  language: string;
}

/**
 * The source surface container, created on first use as the last child of
 * `#markdown-wrapper` (sibling of the content root — see the module note).
 */
export function getSourceViewContainer(create = false): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const existing = document.getElementById(SOURCE_VIEW_ID);
  if (existing || !create) {
    return existing;
  }

  const host = document.getElementById('markdown-wrapper') ?? document.body;
  const container = document.createElement('div');
  container.id = SOURCE_VIEW_ID;
  container.hidden = true;
  host.appendChild(container);
  return container;
}

export function isSourceViewActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.sourceView === '1';
}

/**
 * Show or hide the source surface. Hiding only flips the flag and `hidden`;
 * the rendered surface is never touched here.
 */
export function setSourceViewActive(active: boolean): void {
  if (typeof document === 'undefined') {
    return;
  }

  if (!active) {
    delete document.documentElement.dataset.sourceView;
    const container = getSourceViewContainer();
    if (container) {
      container.hidden = true;
      // Nothing stale may survive in the DOM: the surface is re-rendered from
      // the model whenever the mode comes back.
      container.replaceChildren();
    }
    return;
  }

  document.documentElement.dataset.sourceView = '1';
  const container = getSourceViewContainer(true);
  if (container) {
    container.hidden = false;
  }
}

/** Drop the rendered source (document unloaded / surface torn down). */
export function clearSourceView(): void {
  getSourceViewContainer()?.replaceChildren();
}

/**
 * Render `content` into the source surface, replacing whatever it showed
 * before. Returns false when there is no document to render into.
 */
export function renderSourceView(input: SourceViewInput): boolean {
  const container = getSourceViewContainer(true);
  if (!container) {
    return false;
  }

  const { content, language } = input;
  const normalized = content.replace(/\n+$/, '');
  const lines = buildSourceLines(normalized, language);

  const surface = document.createElement('div');
  // `markdown-viewer-content` is the theme's alternate content root: it is what
  // makes the generated code/syntax rules reach the surface (see
  // expandCssContentRoots in utils/theme-to-css.ts).
  surface.className = 'markdown-viewer-content mv-source';
  surface.dataset.language = language;

  const pre = document.createElement('pre');
  pre.className = 'mv-source-pre';

  const code = document.createElement('code');
  code.className = `hljs${language ? ` language-${language}` : ''}`;
  // Readiness signal for hosts/e2e: the surface is only line-wrapped when the
  // decoration below ran to completion.
  code.dataset.sourceViewDecorated = '1';
  code.dataset.rawSourceText = normalized;
  code.append(...lines);

  pre.appendChild(code);
  surface.appendChild(pre);
  container.replaceChildren(surface);
  return true;
}

/**
 * Highlight `content`, returning null when the grammar is unknown or throws —
 * the caller then renders readable plain text instead.
 */
function highlightSource(content: string, language: string): string | null {
  if (!language || !hljs.getLanguage(language)) {
    return null;
  }

  try {
    return hljs.highlight(content, { language, ignoreIllegals: true }).value;
  } catch (error) {
    // Not fatal (plain text is the documented fallback), but never silent:
    // a grammar that keeps throwing would otherwise degrade with no trace.
    console.warn(`[source-view] highlight failed for "${language}", rendering plain text`, error);
    return null;
  }
}

/**
 * Split highlighted content into one element per source line. Wrapping is done
 * on the *highlighted* DOM: text is cut at newlines while every `hljs-*`
 * ancestor is cloned per line, so colors survive the split.
 */
function buildSourceLines(content: string, language: string): HTMLElement[] {
  const source = document.createElement('code');
  const highlighted = highlightSource(content, language);
  if (highlighted === null) {
    source.textContent = content;
  } else {
    source.innerHTML = highlighted;
  }

  const lineElements: HTMLElement[] = [];
  let currentLine = createSourceLine(1);
  lineElements.push(currentLine);

  const appendTextSegment = (text: string, ancestors: HTMLElement[]): void => {
    if (!text) {
      return;
    }

    let target: Node = currentLine.querySelector(`.${SOURCE_VIEW_LINE_CONTENT_CLASS}`) as HTMLElement;
    for (const ancestor of ancestors) {
      const clone = ancestor.cloneNode(false) as HTMLElement;
      target.appendChild(clone);
      target = clone;
    }
    target.appendChild(document.createTextNode(text));
  };

  const startNewLine = (): void => {
    currentLine = createSourceLine(lineElements.length + 1);
    lineElements.push(currentLine);
  };

  const walkNode = (node: ChildNode, ancestors: HTMLElement[]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent || '').split('\n');
      parts.forEach((part, index) => {
        appendTextSegment(part, ancestors);
        if (index < parts.length - 1) {
          startNewLine();
        }
      });
      return;
    }

    if (!(node instanceof HTMLElement)) {
      return;
    }

    const nextAncestors = [...ancestors, node];
    Array.from(node.childNodes).forEach((child) => {
      walkNode(child, nextAncestors);
    });
  };

  Array.from(source.childNodes).forEach((node) => {
    walkNode(node, []);
  });

  // Trailing newlines at EOF are not lines the user should scroll to.
  while (lineElements.length > 1) {
    const lastLine = lineElements[lineElements.length - 1];
    const contentEl = lastLine.querySelector(`.${SOURCE_VIEW_LINE_CONTENT_CLASS}`);
    if ((contentEl?.textContent || '') !== '') {
      break;
    }
    lineElements.pop();
  }

  return lineElements;
}

function createSourceLine(lineNumber: number): HTMLSpanElement {
  const line = document.createElement('span');
  line.className = SOURCE_VIEW_LINE_CLASS;
  line.dataset.lineNumber = String(lineNumber);

  const content = document.createElement('span');
  content.className = SOURCE_VIEW_LINE_CONTENT_CLASS;
  line.appendChild(content);

  return line;
}
