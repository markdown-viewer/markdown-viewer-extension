// DOCX Exporter for Markdown Viewer Extension
// Converts Markdown AST to DOCX format using docx library

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  BorderStyle,
  convertInchesToTwip,
} from 'docx';
import { mathJaxReady, convertLatex2Math } from './docx-math-converter.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';
import { loadThemeForDOCX } from './theme-to-docx.js';
import themeManager from '../utils/theme-manager.js';
import { getPluginForNode, convertNodeToDOCX } from '../plugins/index.js';

// Import refactored modules
import { createCodeHighlighter } from './docx-code-highlighter.js';
import { downloadBlob } from './docx-download.js';
import { createTableConverter } from './docx-table-converter.js';
import { createBlockquoteConverter } from './docx-blockquote-converter.js';
import { createListConverter, createNumberingLevels } from './docx-list-converter.js';
import { createInlineConverter } from './docx-inline-converter.js';

// Re-export for external use
export { convertPluginResultToDOCX } from './docx-image-utils.js';

/**
 * Main class for exporting Markdown to DOCX
 */
class DocxExporter {
  constructor(renderer = null) {
    this.renderer = renderer;
    this.imageCache = new Map();
    this.listInstanceCounter = 0;
    this.mathJaxInitialized = false;
    this.baseUrl = null;
    this.themeStyles = null;
    this.codeHighlighter = null;
    this.linkDefinitions = new Map();
    
    // Converters (initialized in exportToDocx)
    this.tableConverter = null;
    this.blockquoteConverter = null;
    this.listConverter = null;
    this.inlineConverter = null;
  }

  setBaseUrl(url) {
    this.baseUrl = url;
  }

  async initializeMathJax() {
    if (!this.mathJaxInitialized) {
      await mathJaxReady();
      this.mathJaxInitialized = true;
    }
  }

  /**
   * Initialize all converters with current context
   */
  initializeConverters() {
    // Create inline converter first (used by others)
    this.inlineConverter = createInlineConverter({
      themeStyles: this.themeStyles,
      fetchImageAsBuffer: (url) => this.fetchImageAsBuffer(url),
      reportResourceProgress: () => this.reportResourceProgress(),
      linkDefinitions: this.linkDefinitions
    });

    // Create other converters
    this.tableConverter = createTableConverter({
      themeStyles: this.themeStyles,
      convertInlineNodes: (nodes, style) => this.inlineConverter.convertInlineNodes(nodes, style)
    });

    this.blockquoteConverter = createBlockquoteConverter({
      themeStyles: this.themeStyles,
      convertInlineNodes: (nodes, style) => this.inlineConverter.convertInlineNodes(nodes, style)
    });

    this.listConverter = createListConverter({
      themeStyles: this.themeStyles,
      convertInlineNodes: (nodes, style) => this.inlineConverter.convertInlineNodes(nodes, style),
      getListInstanceCounter: () => this.listInstanceCounter,
      incrementListInstanceCounter: () => this.listInstanceCounter++
    });
  }

  async exportToDocx(markdown, filename = 'document.docx', onProgress = null) {
    try {
      this.setBaseUrl(window.location.href);

      const selectedThemeId = await themeManager.loadSelectedTheme();
      this.themeStyles = await loadThemeForDOCX(selectedThemeId);
      this.codeHighlighter = createCodeHighlighter(this.themeStyles);

      this.progressCallback = onProgress;
      this.totalResources = 0;
      this.processedResources = 0;

      await this.initializeMathJax();

      const ast = this.parseMarkdown(markdown);
      this.totalResources = this.countResources(ast);

      if (onProgress && this.totalResources > 0) {
        onProgress(0, this.totalResources);
      }

      // Initialize converters after theme is loaded
      this.initializeConverters();

      const sections = await this.convertAstToDocx(ast);

      const doc = new Document({
        creator: 'Markdown Viewer Extension',
        title: filename.replace(/\.docx$/i, ''),
        description: 'Generated from Markdown',
        lastModifiedBy: 'Markdown Viewer Extension',
        numbering: {
          config: [{
            reference: 'default-ordered-list',
            levels: createNumberingLevels(),
          }],
        },
        styles: {
          default: {
            document: this.themeStyles.default,
            heading1: this.themeStyles.paragraphStyles.heading1,
            heading2: this.themeStyles.paragraphStyles.heading2,
            heading3: this.themeStyles.paragraphStyles.heading3,
            heading4: this.themeStyles.paragraphStyles.heading4,
            heading5: this.themeStyles.paragraphStyles.heading5,
            heading6: this.themeStyles.paragraphStyles.heading6,
          },
        },
        sections: [{
          properties: {
            page: {
              margin: {
                top: convertInchesToTwip(1),
                right: convertInchesToTwip(1),
                bottom: convertInchesToTwip(1),
                left: convertInchesToTwip(1),
              },
            },
          },
          children: sections,
        }],
      });

      const blob = await Packer.toBlob(doc);
      await downloadBlob(blob, filename);

      this.progressCallback = null;
      this.totalResources = 0;
      this.processedResources = 0;

      return { success: true };
    } catch (error) {
      console.error('DOCX export error:', error);
      return { success: false, error: error.message };
    }
  }

  countResources(ast) {
    let count = 0;
    const countNode = (node) => {
      if (node.type === 'image') count++;
      if (getPluginForNode(node)) count++;
      if (node.children) node.children.forEach(countNode);
    };
    if (ast.children) ast.children.forEach(countNode);
    return count;
  }

  reportResourceProgress() {
    this.processedResources++;
    if (this.progressCallback && this.totalResources > 0) {
      this.progressCallback(this.processedResources, this.totalResources);
    }
  }

  parseMarkdown(markdown) {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkBreaks)
      .use(remarkMath);

    const ast = processor.parse(markdown);
    const transformed = processor.runSync(ast);

    this.linkDefinitions = new Map();
    visit(transformed, 'definition', (node) => {
      this.linkDefinitions.set(node.identifier.toLowerCase(), {
        url: node.url,
        title: node.title
      });
    });

    return transformed;
  }

  async convertAstToDocx(ast) {
    const elements = [];
    let lastNodeType = null;
    this.listInstanceCounter = 0;

    for (const node of ast.children) {
      if (node.type === 'thematicBreak' && lastNodeType === 'thematicBreak') {
        elements.push(new Paragraph({
          text: '',
          alignment: AlignmentType.LEFT,
          spacing: { before: 0, after: 0, line: 1, lineRule: 'exact' },
        }));
      }

      if (node.type === 'table' && lastNodeType === 'table') {
        elements.push(new Paragraph({
          text: '',
          alignment: AlignmentType.LEFT,
          spacing: { before: 120, after: 120, line: 240 },
        }));
      }

      const converted = await this.convertNode(node);
      if (converted) {
        if (Array.isArray(converted)) {
          elements.push(...converted);
        } else {
          elements.push(converted);
        }
      }
      lastNodeType = node.type;
    }

    return elements;
  }

  async convertNode(node, parentStyle = {}) {
    const docxHelpers = {
      Paragraph, TextRun, ImageRun, AlignmentType, convertInchesToTwip,
      themeStyles: this.themeStyles
    };

    const pluginResult = await convertNodeToDOCX(
      node, this.renderer, docxHelpers, () => this.reportResourceProgress()
    );
    if (pluginResult) return pluginResult;

    switch (node.type) {
      case 'heading':
        return this.convertHeading(node);
      case 'paragraph':
        return await this.convertParagraph(node, parentStyle);
      case 'list':
        return await this.listConverter.convertList(node);
      case 'code':
        return this.convertCodeBlock(node);
      case 'blockquote':
        return await this.blockquoteConverter.convertBlockquote(node);
      case 'table':
        return await this.tableConverter.convertTable(node);
      case 'thematicBreak':
        return this.convertThematicBreak();
      case 'html':
        return this.convertHtml(node);
      case 'math':
        return this.convertMathBlock(node);
      default:
        return null;
    }
  }

  convertHeading(node) {
    const levels = {
      1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4,
      5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
    };
    const text = this.inlineConverter.extractText(node);
    const headingStyle = this.themeStyles?.paragraphStyles?.[`heading${node.depth}`];

    const config = {
      text: text,
      heading: levels[node.depth] || HeadingLevel.HEADING_1,
    };

    if (headingStyle?.paragraph?.alignment === 'center') {
      config.alignment = AlignmentType.CENTER;
    }

    return new Paragraph(config);
  }

  async convertParagraph(node, parentStyle = {}) {
    const children = await this.inlineConverter.convertInlineNodes(node.children, parentStyle);
    const spacing = this.themeStyles.default.paragraph.spacing;

    return new Paragraph({
      children: children.length > 0 ? children : undefined,
      text: children.length === 0 ? '' : undefined,
      spacing: { before: spacing.before, after: spacing.after, line: spacing.line },
      alignment: AlignmentType.LEFT,
    });
  }

  convertCodeBlock(node) {
    const runs = this.codeHighlighter.getHighlightedRunsForCode(node.value ?? '', node.lang);
    const codeBackground = this.themeStyles.characterStyles.code.background;

    return new Paragraph({
      children: runs,
      wordWrap: true,
      alignment: AlignmentType.LEFT,
      spacing: { before: 200, after: 200, line: 276 },
      shading: { fill: codeBackground },
      border: {
        top: { color: 'E1E4E8', space: 10, value: BorderStyle.SINGLE, size: 6 },
        bottom: { color: 'E1E4E8', space: 10, value: BorderStyle.SINGLE, size: 6 },
        left: { color: 'E1E4E8', space: 10, value: BorderStyle.SINGLE, size: 6 },
        right: { color: 'E1E4E8', space: 10, value: BorderStyle.SINGLE, size: 6 },
      },
    });
  }

  convertHtml(node) {
    return new Paragraph({
      children: [new TextRun({ text: '[HTML Content]', italics: true, color: '666666' })],
      alignment: AlignmentType.LEFT,
      spacing: { before: 120, after: 120 },
    });
  }

  convertThematicBreak() {
    return new Paragraph({
      text: '',
      alignment: AlignmentType.LEFT,
      spacing: { before: 300, after: 300, line: 120, lineRule: 'exact' },
      border: { bottom: { color: 'E1E4E8', space: 1, style: BorderStyle.SINGLE, size: 12 } },
    });
  }

  async convertMathBlock(node) {
    try {
      const math = convertLatex2Math(node.value);
      return new Paragraph({
        children: [math],
        spacing: { before: 120, after: 120 },
        alignment: AlignmentType.CENTER,
      });
    } catch (error) {
      console.warn('Math conversion error:', error);
      const codeStyle = this.themeStyles.characterStyles.code;
      return new Paragraph({
        children: [new TextRun({ text: node.value, font: codeStyle.font, size: codeStyle.size })],
        alignment: AlignmentType.LEFT,
        spacing: { before: 120, after: 120 },
      });
    }
  }

  async fetchImageAsBuffer(url) {
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url);
    }

    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)[^,]*,(.+)$/);
      if (!match) throw new Error('Invalid data URL format');

      const contentType = match[1];
      const binaryString = atob(match[2]);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const result = { buffer: bytes, contentType };
      this.imageCache.set(url, result);
      return result;
    }

    const absoluteUrl = (url.startsWith('http://') || url.startsWith('https://'))
      ? url
      : (this.baseUrl ? new URL(url, this.baseUrl).href : url);

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'READ_LOCAL_FILE',
        filePath: absoluteUrl,
        binary: true
      }, (response) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }

        const binaryString = atob(response.content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        let contentType = response.contentType;
        if (!contentType) {
          const ext = url.split('.').pop().toLowerCase().split('?')[0];
          const map = {
            'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
            'gif': 'image/gif', 'bmp': 'image/bmp', 'webp': 'image/webp', 'svg': 'image/svg+xml'
          };
          contentType = map[ext] || 'image/png';
        }

        const result = { buffer: bytes, contentType };
        this.imageCache.set(url, result);
        resolve(result);
      });
    });
  }
}

export default DocxExporter;
