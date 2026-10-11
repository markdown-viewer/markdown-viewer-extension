// DOCX Code Highlighter
// Functions for syntax highlighting in DOCX export

import { TextRun } from 'docx';
import hljs from '../utils/highlight-registry';
import type { DOCXThemeStyles } from '../types/docx';

export interface CodeHighlighter {
  getHighlightColor(classList: string | string[] | DOMTokenList | null): string | null;
  appendCodeTextRuns(text: string, runs: TextRun[], color: string | null): void;
  collectHighlightedRuns(node: Node, runs: TextRun[], inheritedColor?: string | null): void;
  getHighlightedRunsForCode(code: string, language: string | null | undefined): TextRun[];
}

// Default code colors
const DEFAULT_CODE_COLORS = {
  foreground: '24292E',
  colors: {} as Record<string, string>
};

/**
 * Create a code highlighter for DOCX export
 * @param themeStyles - Theme configuration with code colors
 * @returns Highlighter instance with methods
 */
export function createCodeHighlighter(themeStyles: DOCXThemeStyles | null): CodeHighlighter {
  // Get code colors with defaults
  const codeColors = themeStyles?.codeColors || DEFAULT_CODE_COLORS;
  
  /**
   * Get highlight color from CSS class list
   * @param classList - CSS classes
   * @returns Hex color without # or null
   */
  function getHighlightColor(classList: string | string[] | DOMTokenList | null): string | null {
    if (!classList) {
      return null;
    }

    const tokens: string[] = Array.isArray(classList)
      ? classList
      : typeof classList === 'string'
        ? classList.split(/\s+/)
        : Array.from(classList);

    for (const rawToken of tokens) {
      if (!rawToken) {
        continue;
      }

      const token = rawToken.startsWith('hljs-') ? rawToken.slice(5) : rawToken;
      if (!token) {
        continue;
      }

      const normalized = token.replace(/-/g, '_');

      // Use theme color
      const themeColor = codeColors.colors?.[normalized];
      if (themeColor) {
        return themeColor.replace('#', '');
      }
    }

    return null;
  }

  /**
   * Append code text runs with proper formatting
   * @param text - Text content
   * @param runs - Array to append runs to
   * @param color - Hex color
   */
  function appendCodeTextRuns(text: string, runs: TextRun[], color: string | null): void {
    if (text === '') {
      return;
    }

    const segments = text.split('\n');
    const lastIndex = segments.length - 1;
    const defaultColor = codeColors.foreground;
    const appliedColor = color || defaultColor;

    segments.forEach((segment, index) => {
      if (segment.length > 0) {
        runs.push(new TextRun({
          text: segment,
          color: appliedColor,
        }));
      }

      if (index < lastIndex) {
        runs.push(new TextRun({ text: '', break: 1 }));
      }
    });
  }

  /**
   * Recursively collect runs from highlighted HTML nodes
   * @param node - DOM node
   * @param runs - Array to append runs to
   * @param inheritedColor - Inherited color from parent
   */
  function collectHighlightedRuns(node: Node, runs: TextRun[], inheritedColor: string | null = null): void {
    if (inheritedColor === null) {
      inheritedColor = codeColors.foreground;
    }
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      appendCodeTextRuns(node.nodeValue || '', runs, inheritedColor);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as Element;
    const elementColor = getHighlightColor(element.classList) || inheritedColor;
    const nextColor = elementColor || inheritedColor;

    node.childNodes.forEach((child) => {
      collectHighlightedRuns(child, runs, nextColor);
    });
  }

  /**
   * Get highlighted TextRuns for code
   * @param code - Code content
   * @param language - Programming language
   * @returns Array of TextRun elements
   */
  function getHighlightedRunsForCode(code: string, language: string | null | undefined): TextRun[] {
    const runs: TextRun[] = [];

    if (!code) {
      const defaultColor = codeColors.foreground;

      runs.push(new TextRun({
        text: '',
        color: defaultColor,
      }));
      return runs;
    }

    let highlightResult: ReturnType<typeof hljs.highlight> | null = null;

    try {
      if (language && hljs.getLanguage(language)) {
        highlightResult = hljs.highlight(code, {
          language,
          ignoreIllegals: true,
        });
      } else {
        // No language specified - don't highlight (consistent with Web behavior)
        highlightResult = null;
      }
    } catch (error) {
      console.warn('Highlight error:', error);
    }

    const defaultColor = codeColors.foreground;

    if (highlightResult && highlightResult.value) {
      const container = document.createElement('div');
      container.innerHTML = highlightResult.value;
      collectHighlightedRuns(container, runs, defaultColor);
    }

    if (runs.length === 0) {
      appendCodeTextRuns(code, runs, defaultColor);
    }

    return runs;
  }

  return {
    getHighlightColor,
    appendCodeTextRuns,
    collectHighlightedRuns,
    getHighlightedRunsForCode
  };
}
