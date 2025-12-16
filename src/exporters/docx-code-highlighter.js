// DOCX Code Highlighter
// Functions for syntax highlighting in DOCX export

import { TextRun } from 'docx';
import hljs from 'highlight.js/lib/common';

/**
 * Create a code highlighter for DOCX export
 * @param {Object} themeStyles - Theme configuration with code colors
 * @returns {Object} Highlighter instance with methods
 */
export function createCodeHighlighter(themeStyles) {
  /**
   * Get highlight color from CSS class list
   * @param {string|Array|DOMTokenList} classList - CSS classes
   * @returns {string|null} Hex color without # or null
   */
  function getHighlightColor(classList) {
    if (!classList) {
      return null;
    }

    const tokens = Array.isArray(classList)
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
      const themeColor = themeStyles.codeColors.colors[normalized];
      if (themeColor) {
        return themeColor.replace('#', '');
      }
    }

    return null;
  }

  /**
   * Append code text runs with proper formatting
   * @param {string} text - Text content
   * @param {Array} runs - Array to append runs to
   * @param {string} color - Hex color
   */
  function appendCodeTextRuns(text, runs, color) {
    if (text === '') {
      return;
    }

    const segments = text.split('\n');
    const lastIndex = segments.length - 1;
    const defaultColor = themeStyles.codeColors.foreground;
    const appliedColor = color || defaultColor;

    // Use theme code font and size (already converted to half-points in theme-to-docx.js)
    const codeStyle = themeStyles.characterStyles.code;
    const codeFont = codeStyle.font;
    const codeSize = codeStyle.size;

    segments.forEach((segment, index) => {
      if (segment.length > 0) {
        runs.push(new TextRun({
          text: segment,
          font: codeFont,
          size: codeSize,
          preserve: true,
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
   * @param {Node} node - DOM node
   * @param {Array} runs - Array to append runs to
   * @param {string} inheritedColor - Inherited color from parent
   */
  function collectHighlightedRuns(node, runs, inheritedColor = null) {
    if (inheritedColor === null) {
      inheritedColor = themeStyles.codeColors.foreground;
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

    const elementColor = getHighlightColor(node.classList) || inheritedColor;
    const nextColor = elementColor || inheritedColor;

    node.childNodes.forEach((child) => {
      collectHighlightedRuns(child, runs, nextColor);
    });
  }

  /**
   * Get highlighted TextRuns for code
   * @param {string} code - Code content
   * @param {string} language - Programming language
   * @returns {Array<TextRun>} Array of TextRun elements
   */
  function getHighlightedRunsForCode(code, language) {
    const runs = [];

    if (!code) {
      // Use theme code font and size (already converted to half-points in theme-to-docx.js)
      const codeStyle = themeStyles.characterStyles.code;
      const codeFont = codeStyle.font;
      const codeSize = codeStyle.size;
      const defaultColor = themeStyles.codeColors.foreground;

      runs.push(new TextRun({
        text: '',
        font: codeFont,
        size: codeSize,
        preserve: true,
        color: defaultColor,
      }));
      return runs;
    }

    let highlightResult = null;

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

    const defaultColor = themeStyles.codeColors.foreground;

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
