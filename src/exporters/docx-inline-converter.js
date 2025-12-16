// Inline node conversion for DOCX export

import {
  TextRun,
  ImageRun,
  ExternalHyperlink,
} from 'docx';
import { convertLatex2Math } from './docx-math-converter.js';
import {
  calculateImageDimensions,
  getImageDimensions,
  determineImageType
} from './docx-image-utils.js';

/**
 * Create an inline node converter
 * @param {Object} options - Configuration options
 * @param {Object} options.themeStyles - Theme styles
 * @param {Function} options.fetchImageAsBuffer - Function to fetch image as buffer
 * @param {Function} options.reportResourceProgress - Function to report progress
 * @param {Map} options.linkDefinitions - Link definitions map
 * @returns {Object} Inline node converter
 */
export function createInlineConverter({ 
  themeStyles, 
  fetchImageAsBuffer, 
  reportResourceProgress,
  linkDefinitions
}) {
  /**
   * Convert inline nodes (text, emphasis, strong, etc.)
   * @param {Array} nodes - Array of inline AST nodes
   * @param {Object} parentStyle - Parent style to inherit
   * @returns {Promise<TextRun[]>} Array of DOCX TextRuns
   */
  async function convertInlineNodes(nodes, parentStyle = {}) {
    const runs = [];
    const bodyFont = themeStyles.default.run.font;
    const bodySize = themeStyles.default.run.size;

    const defaultStyle = {
      font: bodyFont,
      size: bodySize,
      ...parentStyle,
    };

    for (const node of nodes) {
      const converted = await convertInlineNode(node, defaultStyle);
      if (converted) {
        if (Array.isArray(converted)) {
          runs.push(...converted);
        } else {
          runs.push(converted);
        }
      }
    }

    return runs;
  }

  /**
   * Convert single inline node
   * @param {Object} node - Inline AST node
   * @param {Object} parentStyle - Parent style to inherit
   * @returns {Promise<TextRun|TextRun[]|null>} DOCX TextRun(s) or null
   */
  async function convertInlineNode(node, parentStyle = {}) {
    switch (node.type) {
      case 'text':
        return new TextRun({ text: node.value, ...parentStyle });

      case 'strong':
        return await convertInlineNodes(node.children, { ...parentStyle, bold: true });

      case 'emphasis':
        return await convertInlineNodes(node.children, { ...parentStyle, italics: true });

      case 'delete':
        return await convertInlineNodes(node.children, { ...parentStyle, strike: true });

      case 'inlineCode':
        const codeStyle = themeStyles.characterStyles.code;
        return new TextRun({
          ...parentStyle,
          text: node.value,
          font: codeStyle.font,
          size: codeStyle.size,
          shading: { fill: codeStyle.background },
        });

      case 'link':
        return await convertLink(node, parentStyle);

      case 'linkReference':
        return await convertLinkReference(node, parentStyle);

      case 'image':
        return await convertImage(node);

      case 'inlineMath':
        return await convertInlineMath(node, parentStyle);

      case 'break':
        return new TextRun({ text: '', break: 1 });

      case 'html':
        const htmlValue = node.value?.trim() || '';
        if (/^<br\s*\/?>$/i.test(htmlValue)) {
          return new TextRun({ text: '', break: 1 });
        }
        return new TextRun({
          text: htmlValue.replace(/<[^>]+>/g, ''),
          ...parentStyle,
        });

      default:
        return null;
    }
  }

  /**
   * Convert link node
   * @param {Object} node - Link AST node
   * @param {Object} parentStyle - Parent style
   * @returns {Promise<ExternalHyperlink>} DOCX ExternalHyperlink
   */
  async function convertLink(node, parentStyle) {
    const text = extractText(node);
    const url = node.url || '#';

    return new ExternalHyperlink({
      children: [
        new TextRun({
          text: text,
          style: 'Hyperlink',
          color: '0366D6',
          underline: { type: 'single', color: '0366D6' },
          ...parentStyle,
        }),
      ],
      link: url,
    });
  }

  /**
   * Convert link reference node
   * @param {Object} node - LinkReference AST node
   * @param {Object} parentStyle - Parent style
   * @returns {Promise<ExternalHyperlink>} DOCX ExternalHyperlink
   */
  async function convertLinkReference(node, parentStyle) {
    const text = extractText(node);
    const identifier = node.identifier.toLowerCase();
    const definition = linkDefinitions?.get(identifier);
    const url = definition?.url || '#';

    return new ExternalHyperlink({
      children: [
        new TextRun({
          text: text,
          style: 'Hyperlink',
          color: '0366D6',
          underline: { type: 'single', color: '0366D6' },
          ...parentStyle,
        }),
      ],
      link: url,
    });
  }

  /**
   * Convert image node
   * @param {Object} node - Image AST node
   * @returns {Promise<ImageRun|TextRun>} DOCX ImageRun or error TextRun
   */
  async function convertImage(node) {
    try {
      const { buffer, contentType } = await fetchImageAsBuffer(node.url);
      const { width: originalWidth, height: originalHeight } = await getImageDimensions(buffer, contentType);
      const { width: widthPx, height: heightPx } = calculateImageDimensions(originalWidth, originalHeight);
      const imageType = determineImageType(contentType, node.url);

      reportResourceProgress();

      return new ImageRun({
        data: buffer,
        transformation: { width: widthPx, height: heightPx },
        type: imageType,
        altText: {
          title: node.alt || 'Image',
          description: node.alt || '',
          name: node.alt || 'image',
        },
      });
    } catch (error) {
      console.warn('Failed to load image:', node.url, error);
      reportResourceProgress();

      return new TextRun({
        text: `[图片加载失败: ${node.alt || node.url}]`,
        italics: true,
        color: 'DC2626',
        bold: true,
      });
    }
  }

  /**
   * Convert inline math node
   * @param {Object} node - InlineMath AST node
   * @param {Object} parentStyle - Parent style
   * @returns {Promise<Math|TextRun>} DOCX Math or fallback TextRun
   */
  async function convertInlineMath(node, parentStyle) {
    try {
      return convertLatex2Math(node.value);
    } catch (error) {
      console.warn('Inline math conversion error:', error);
      const codeStyle = themeStyles.characterStyles.code;
      return new TextRun({
        text: node.value,
        font: codeStyle.font,
        size: codeStyle.size,
        ...parentStyle,
      });
    }
  }

  /**
   * Extract plain text from node and its children
   * @param {Object} node - AST node
   * @returns {string} Plain text content
   */
  function extractText(node) {
    let text = '';
    if (node.value) {
      return node.value;
    }
    if (node.children) {
      for (const child of node.children) {
        text += extractText(child);
      }
    }
    return text;
  }

  return { 
    convertInlineNodes, 
    convertInlineNode,
    convertImage,
    extractText
  };
}
