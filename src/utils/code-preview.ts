/**
 * Shared utilities for rendering plain text/code files as fenced markdown.
 * Used by both workspace mode and standalone file browsing.
 */

import hljs from 'highlight.js/lib/common';
import { renderMarkdownCodeBlockHtml } from '../core/markdown-processor';
import { EXT_LANG_MAP, CODE_PREVIEW_EXTENSIONS } from './extension-categories';

export function getCodePreviewMatchedExtension(path: string): string | null {
  const lowerPath = path.toLowerCase();
  for (const ext of CODE_PREVIEW_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return ext;
    }
  }
  return null;
}

export function toCodeFenceLanguage(extWithDot: string): string {
  const key = extWithDot.replace(/^\./, '');
  if (key in EXT_LANG_MAP) {
    return EXT_LANG_MAP[key];
  }
  return key;
}

export function getCodeFenceLanguageForPath(path: string): string | null {
  const ext = getCodePreviewMatchedExtension(path);
  return ext ? toCodeFenceLanguage(ext) : null;
}

export function toFencedCode(markdown: string, language: string): string {
  const normalized = markdown.replace(/\n+$/, '');

  // Pick a fence longer than any backtick run in content so we never close early.
  const runs = normalized.match(/`+/g);
  const longestRun = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = '`'.repeat(Math.max(3, longestRun + 1));

  return `${fence}${language}\n${normalized}\n${fence}`;
}

export interface CodeReadingRenderResult {
  markdown: string;
  codeView: true;
  language: string;
}

/**
 * Unified code-reading entrypoint.
 * Returns null when the target path should not be rendered as code-reading mode.
 */
export function buildCodeReadingRender(content: string, path: string): CodeReadingRenderResult | null {
  const language = getCodeFenceLanguageForPath(path);
  if (!language) {
    return null;
  }

  return {
    markdown: toFencedCode(content, language),
    codeView: true,
    language,
  };
}

export function applyCodeViewPresentation(enabled: boolean): void {
  if (!enabled) {
    delete document.documentElement.dataset.codeView;
    return;
  }

  document.documentElement.dataset.codeView = '1';

  const findCodeViewTarget = (): HTMLElement | null => {
    const block = document.querySelector<HTMLElement>('#markdown-content [data-block-id="mv-code-view"]');
    if (!block) {
      return null;
    }

    return block.querySelector<HTMLElement>('pre code')
      ?? block.querySelector<HTMLElement>('pre');
  };

  const applyLineNumbers = (): boolean => {
    const codeViewTarget = findCodeViewTarget();
    if (!codeViewTarget) return false;

    decorateCodeViewLines(codeViewTarget);
    return true;
  };

  if (applyLineNumbers()) {
    return;
  }

  // Add line numbers after code block is rendered with highlighting.
  const observer = new MutationObserver(() => {
    if (!applyLineNumbers()) return;
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function renderCodeViewBlock(container: HTMLElement, content: string, language: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'md-block';
  block.dataset.blockId = 'mv-code-view';
  block.dataset.line = '1';

  let pre: HTMLElement | null = null;

  if (language === 'markdown') {
    const markdownCodeHtml = renderMarkdownCodeBlockHtml(content);
    if (markdownCodeHtml) {
      const temp = document.createElement('div');
      temp.innerHTML = markdownCodeHtml;
      pre = temp.querySelector('pre');
    }
  }

  if (!pre) {
    pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = `hljs language-${language}`;

    let highlightedHtml = '';
    try {
      if (language && hljs.getLanguage(language)) {
        highlightedHtml = hljs.highlight(content, {
          language,
          ignoreIllegals: true,
        }).value;
      }
    } catch {
      highlightedHtml = '';
    }

    if (highlightedHtml) {
      code.innerHTML = highlightedHtml;
    } else {
      code.textContent = content;
    }

    pre.appendChild(code);
  }

  block.appendChild(pre);

  container.replaceChildren(block);
  return block;
}

function decorateCodeViewLines(code: HTMLElement): void {
  if (code.dataset.codeViewDecorated === '1') {
    return;
  }

  const rawText = code.textContent || '';
  const normalizedText = rawText.replace(/\n+$/, '');
  const sourceNodes = Array.from(code.childNodes);
  const lineElements: HTMLElement[] = [];

  let currentLine = createCodeViewLine(1);
  lineElements.push(currentLine);

  const appendTextSegment = (text: string, ancestors: HTMLElement[]): void => {
    if (!text) {
      return;
    }

    let target: Node = currentLine.querySelector('.mv-code-line-content') as HTMLElement;
    for (const ancestor of ancestors) {
      const clone = ancestor.cloneNode(false) as HTMLElement;
      target.appendChild(clone);
      target = clone;
    }
    target.appendChild(document.createTextNode(text));
  };

  const startNewLine = (): void => {
    currentLine = createCodeViewLine(lineElements.length + 1);
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

  sourceNodes.forEach((node) => {
    walkNode(node, []);
  });

  while (lineElements.length > 1) {
    const lastLine = lineElements[lineElements.length - 1];
    const content = lastLine.querySelector('.mv-code-line-content');
    if ((content?.textContent || '') !== '') {
      break;
    }
    lineElements.pop();
  }

  code.replaceChildren(...lineElements);
  code.dataset.codeViewDecorated = '1';
  code.dataset.rawCodeText = normalizedText;
}

function createCodeViewLine(lineNumber: number): HTMLSpanElement {
  const line = document.createElement('span');
  line.className = 'mv-code-line';
  line.dataset.lineNumber = String(lineNumber);

  const content = document.createElement('span');
  content.className = 'mv-code-line-content';
  line.appendChild(content);

  return line;
}
