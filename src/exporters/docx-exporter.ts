// DOCX Exporter for Markdown Viewer Extension
// Converts Markdown AST to DOCX format using docx library

import {
  Document,
  Packer,
  Paragraph,
  FileChild,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  BorderStyle,
  convertInchesToTwip,
  TableOfContents,
  type IStylesOptions,
  type IBaseParagraphStyleOptions,
  type IDocumentDefaultsOptions,
  type IParagraphStylePropertiesOptions,
} from 'docx';
import { mathJaxReady, convertLatex2Math } from './docx-math-converter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkGemoji from 'remark-gemoji';
import remarkSuperSub from '../plugins/remark-super-sub';
import { visit } from 'unist-util-visit';
import { loadThemeForDOCX } from './theme-to-docx';
import type { FrontmatterDisplay } from '../ui/popup/settings-tab';
import themeManager from '../utils/theme-manager';
import { getPluginForNode, convertNodeToDOCX } from '../plugins/index';
import type { PluginRenderer } from '../types/plugin';
import type { DocumentService } from '../types/platform';
import type {
  DOCXThemeStyles,
  DOCXHeadingStyle,
  LinkDefinition,
  ImageBufferResult,
  DOCXASTNode,
  DOCXListNode,
  DOCXBlockquoteNode,
  DOCXTableNode,
  DOCXProgressCallback,
  DOCXExportResult,
  EmojiStyle,
} from '../types/docx';

// Import refactored modules
import { createCodeHighlighter, type CodeHighlighter } from './docx-code-highlighter';
import { downloadBlob } from './docx-download';
import { createTableConverter, type TableConverter } from './docx-table-converter';
import { createBlockquoteConverter, type BlockquoteConverter } from './docx-blockquote-converter';
import { createListConverter, createNumberingLevels, type ListConverter } from './docx-list-converter';
import { createInlineConverter, type InlineConverter, type InlineNode } from './docx-inline-converter';

// Re-export for external use
export { convertPluginResultToDOCX } from './docx-image-utils';

/**
 * DOCX helpers for plugins
 */
interface DOCXHelpers {
  [key: string]: unknown;
  Paragraph: typeof Paragraph;
  TextRun: typeof TextRun;
  ImageRun: typeof ImageRun;
  AlignmentType: typeof AlignmentType;
  convertInchesToTwip: typeof convertInchesToTwip;
  themeStyles: DOCXThemeStyles | null;
}

/**
 * Main class for exporting Markdown to DOCX
 */
class DocxExporter {
  private renderer: PluginRenderer | null;
  private imageCache: Map<string, ImageBufferResult> = new Map();
  private listInstanceCounter = 0;
  private mathJaxInitialized = false;
  private baseUrl: string | null = null;
  private themeStyles: DOCXThemeStyles | null = null;
  private codeHighlighter: CodeHighlighter | null = null;
  private linkDefinitions: Map<string, LinkDefinition> = new Map();
  private progressCallback: DOCXProgressCallback | null = null;
  private totalResources = 0;
  private processedResources = 0;

  private docxHrAsPageBreak = true;
  private docxEmojiStyle: EmojiStyle = 'windows';
  private frontmatterDisplay: FrontmatterDisplay = 'hide';
  private tableMergeEmpty = true;  // Default: enabled
  
  // Converters (initialized in exportToDocx)
  private tableConverter: TableConverter | null = null;
  private blockquoteConverter: BlockquoteConverter | null = null;
  private listConverter: ListConverter | null = null;
  private inlineConverter: InlineConverter | null = null;

  constructor(renderer: PluginRenderer | null = null) {
    this.renderer = renderer;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url;
    // Update DocumentService with document path
    const doc = this.getDocumentService();
    if (doc) {
      // Extract file path from file:// URL
      const filePath = url.startsWith('file://') ? url.replace('file://', '') : url;
      doc.setDocumentPath(filePath);
    }
  }

  /**
   * Get DocumentService from platform
   */
  private getDocumentService(): DocumentService | undefined {
    return (globalThis.platform as { document?: DocumentService } | undefined)?.document;
  }

  async initializeMathJax(): Promise<void> {
    if (!this.mathJaxInitialized) {
      await mathJaxReady();
      this.mathJaxInitialized = true;
    }
  }

  /**
   * Initialize all converters with current context
   */
  private initializeConverters(): void {
    if (!this.themeStyles) return;

    const rendererAdapter = this.renderer
      ? {
          render: async (
            type: string,
            content: string
          ): Promise<{ base64: string; width: number; height: number; format: string }> => {
            const result = await this.renderer!.render(type, content);
            if (!result) {
              throw new Error('Renderer returned empty result');
            }
            const { base64, width, height, format } = result;

            if (typeof base64 !== 'string' || base64.length === 0) {
              throw new Error('Renderer returned empty base64');
            }
            if (typeof width !== 'number' || typeof height !== 'number') {
              throw new Error('Renderer returned invalid dimensions');
            }
            if (typeof format !== 'string' || format.length === 0) {
              throw new Error('Renderer returned empty format');
            }

            return { base64, width, height, format };
          },
        }
      : null;

    // Create inline converter first (used by others)
    this.inlineConverter = createInlineConverter({
      themeStyles: this.themeStyles,
      fetchImageAsBuffer: (url: string) => this.fetchImageAsBuffer(url),
      reportResourceProgress: () => this.reportResourceProgress(),
      linkDefinitions: this.linkDefinitions,
      renderer: rendererAdapter,
      emojiStyle: this.docxEmojiStyle,
      linkColor: this.themeStyles.linkColor,
    });

    // Create other converters
    this.tableConverter = createTableConverter({
      themeStyles: this.themeStyles,
      convertInlineNodes: (nodes, style) => this.inlineConverter!.convertInlineNodes(nodes, style),
      mergeEmptyCells: this.tableMergeEmpty,
    });

    this.blockquoteConverter = createBlockquoteConverter({
      themeStyles: this.themeStyles,
      convertInlineNodes: (nodes, style) => this.inlineConverter!.convertInlineNodes(nodes, style)
    });

    // Set up the child node converter for blockquote (allows blockquotes to contain any content)
    // Pass blockquoteNestLevel to child nodes for proper right margin compensation
    this.blockquoteConverter.setConvertChildNode((node, blockquoteNestLevel) => this.convertNode(node, {}, 0, blockquoteNestLevel));

    this.listConverter = createListConverter({
      themeStyles: this.themeStyles,
      convertInlineNodes: (nodes, style) => this.inlineConverter!.convertInlineNodes(nodes, style),
      getListInstanceCounter: () => this.listInstanceCounter,
      incrementListInstanceCounter: () => this.listInstanceCounter++
    });

    // Set up the child node converter for list (allows lists to contain blockquotes and other content)
    this.listConverter.setConvertChildNode((node, listLevel) => this.convertNode(node, {}, listLevel));
  }

  async exportToDocx(
    markdown: string,
    filename = 'document.docx',
    onProgress: DOCXProgressCallback | null = null
  ): Promise<DOCXExportResult> {
    try {
      this.setBaseUrl(window.location.href);

      // Load export-related settings via platform.settings service
      try {
        const settings = globalThis.platform?.settings;
        if (settings) {
          const [hrAsPageBreak, emojiStyle, frontmatterDisplay, tableMergeEmpty] = await Promise.all([
            settings.get('docxHrAsPageBreak'),
            settings.get('docxEmojiStyle'),
            settings.get('frontmatterDisplay'),
            settings.get('tableMergeEmpty'),
          ]);
          this.docxHrAsPageBreak = hrAsPageBreak;
          this.docxEmojiStyle = emojiStyle === 'native' ? 'system' : 'system'; // Map to internal naming
          this.frontmatterDisplay = frontmatterDisplay;
          this.tableMergeEmpty = tableMergeEmpty;
        } else {
          this.docxHrAsPageBreak = true;
          this.frontmatterDisplay = 'hide';
          this.tableMergeEmpty = true;
        }
      } catch {
        this.docxHrAsPageBreak = true;
        this.frontmatterDisplay = 'hide';
        this.tableMergeEmpty = true;
      }

      const selectedThemeId = await themeManager.loadSelectedTheme();
      this.themeStyles = await loadThemeForDOCX(selectedThemeId);
      if (!this.themeStyles) {
        throw new Error('Failed to load DOCX theme');
      }
      this.codeHighlighter = createCodeHighlighter(this.themeStyles);

      this.progressCallback = onProgress;
      this.totalResources = 0;
      this.processedResources = 0;

      await this.initializeMathJax();

      const ast = this.parseMarkdown(markdown);
      this.totalResources = this.countResources(ast);

      // Report initial progress (0%)
      // Progress is split: 0-20% for rendering, 20-80% for packing, 80-100% for upload
      if (onProgress) {
        onProgress(0, 100);
      }

      // Initialize converters after theme is loaded
      this.initializeConverters();

      const tRenderStart = performance.now();
      const docChildren = await this.convertAstToDocx(ast);
      const renderTime = performance.now() - tRenderStart;

      const paragraphStyles = Object.entries(this.themeStyles.paragraphStyles).map(([id, style]) => ({
        id,
        ...this.toHeadingStyle(style),
      }));

      const styles: IStylesOptions = {
        default: {
          document: this.toDocumentDefaults(this.themeStyles.default),
        },
        paragraphStyles,
      };

      const doc = new Document({
        creator: 'Markdown Viewer Extension',
        lastModifiedBy: 'Markdown Viewer Extension',
        numbering: {
          config: [
            {
              reference: 'default-ordered-list',
              levels: createNumberingLevels(),
            },
          ],
        },
        styles,
        sections: [
          {
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
            children: docChildren,
          },
        ],
      });

      // Phase 2: Packing DOCX (30-85%)
      // Estimate toBlob time based on render time (empirically ~1.8x)
      const estimatedToBlobTime = renderTime * 1.8;
      const t0 = performance.now();
      
      // Simulate progress with timer, stop at 84% to avoid jumping backward
      let simulatedProgress = 30;
      const progressInterval = onProgress ? setInterval(() => {
        const elapsed = performance.now() - t0;
        // Calculate expected progress based on elapsed time
        const expectedProgress = Math.min(84, 30 + (elapsed / estimatedToBlobTime) * 55);
        if (expectedProgress > simulatedProgress) {
          simulatedProgress = Math.round(expectedProgress);
          onProgress!(simulatedProgress, 100);
        }
      }, 100) : null;

      const blob = await Packer.toBlob(doc);

      // Clear timer and jump to actual position
      if (progressInterval) {
        clearInterval(progressInterval);
      }

      // Phase 3: Upload (85-100%)
      if (onProgress) {
        onProgress(85, 100);
      }

      await downloadBlob(blob, filename, onProgress
        ? (uploaded: number, total: number) => {
            // Map upload progress to 85-100%
            const uploadProgress = total > 0 ? (uploaded / total) : 1;
            const overallProgress = 85 + Math.round(uploadProgress * 15);
            onProgress(overallProgress, 100);
          }
        : undefined
      );

      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : '';
      this.imageCache.clear();
      console.error('DOCX export error:', errMsg, errStack);
      return { success: false, error: errMsg };
    } finally {
      this.progressCallback = null;
      this.totalResources = 0;
      this.processedResources = 0;  
    }
  }

  private countResources(ast: DOCXASTNode): number {
    let count = 0;
    const countNode = (node: DOCXASTNode): void => {
      if (node.type === 'image') count++;
      if (getPluginForNode(node)) count++;
      if (node.children) node.children.forEach(countNode);
    };
    if (ast.children) ast.children.forEach(countNode);
    return count;
  }

  private reportResourceProgress(): void {
    this.processedResources++;
    if (this.progressCallback && this.totalResources > 0) {
      // Phase 1: Rendering resources (0-30%)
      const renderProgress = this.processedResources / this.totalResources;
      const overallProgress = Math.round(renderProgress * 30);
      this.progressCallback(overallProgress, 100);
    }
  }

  /**
   * Extract frontmatter from markdown text
   * @returns Tuple of [frontmatter content or null, markdown without frontmatter]
   */
  private extractFrontmatter(markdown: string): [string | null, string] {
    const lines = markdown.split('\n');
    if (lines.length < 2 || lines[0].trim() !== '---') {
      return [null, markdown];
    }

    // Find closing ---
    let endIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        endIndex = i;
        break;
      }
    }

    if (endIndex === -1) {
      return [null, markdown];
    }

    // Extract frontmatter content (without --- delimiters)
    const frontmatterLines = lines.slice(1, endIndex);
    const frontmatterContent = frontmatterLines.join('\n');
    
    // Return markdown without frontmatter
    const remainingMarkdown = lines.slice(endIndex + 1).join('\n');
    return [frontmatterContent, remainingMarkdown];
  }

  /**
   * Parse frontmatter YAML content (simple key: value parsing)
   */
  private parseFrontmatterData(content: string): Record<string, string> {
    const lines = content.split('\n');
    const result: Record<string, string> = {};
    
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (key) {
          result[key] = value;
        }
      }
    }
    
    return result;
  }

  // Store frontmatter for later use
  private frontmatterContent: string | null = null;

  private parseMarkdown(markdown: string): DOCXASTNode {
    // Extract frontmatter if present
    const [frontmatter, cleanMarkdown] = this.extractFrontmatter(markdown);
    this.frontmatterContent = frontmatter;

    const processor = unified()
      .use(remarkParse)
      .use(remarkCjkFriendly)
      .use(remarkGfm, { singleTilde: false })
      .use(remarkMath)
      .use(remarkGemoji)
      .use(remarkSuperSub);

    const ast = processor.parse(cleanMarkdown);
    const transformed = processor.runSync(ast);

    this.linkDefinitions = new Map();
    visit(transformed, 'definition', (node) => {
      const defNode = node as { identifier?: string; url?: string; title?: string };
      if (defNode.identifier) {
        this.linkDefinitions.set(defNode.identifier.toLowerCase(), {
          url: defNode.url || '',
          title: defNode.title ?? null
        });
      }
    });

    return transformed as DOCXASTNode;
  }

  /**
   * Check if a node is a [toc] marker
   * Detects paragraphs containing only [toc] or [TOC]
   */
  private isTocMarker(node: DOCXASTNode): boolean {
    if (node.type !== 'paragraph') return false;
    if (!node.children || node.children.length !== 1) return false;
    
    const child = node.children[0];
    if (child.type !== 'text') return false;
    
    const text = (child.value || '').trim();
    return /^\[toc\]$/i.test(text);
  }

  /**
   * Convert frontmatter to DOCX elements based on display mode
   */
  private async convertFrontmatterToDocx(): Promise<FileChild[]> {
    if (!this.frontmatterContent || this.frontmatterDisplay === 'hide') {
      return [];
    }

    const elements: FileChild[] = [];
    const spacing = this.themeStyles?.default?.paragraph?.spacing || { before: 0, after: 200, line: 276 };

    if (this.frontmatterDisplay === 'table') {
      // Render as table with key-value pairs using tableConverter
      const data = this.parseFrontmatterData(this.frontmatterContent);
      const entries = Object.entries(data);
      
      if (entries.length > 0 && this.tableConverter) {
        // Create a fake table AST node for the converter
        const tableNode = {
          type: 'table',
          align: ['left', 'left'],
          children: [
            // Header row
            {
              type: 'tableRow',
              children: [
                { type: 'tableCell', children: [{ type: 'text', value: 'Property' }] },
                { type: 'tableCell', children: [{ type: 'text', value: 'Value' }] },
              ],
            },
            // Data rows
            ...entries.map(([key, value]) => ({
              type: 'tableRow',
              children: [
                { type: 'tableCell', children: [{ type: 'text', value: key }] },
                { type: 'tableCell', children: [{ type: 'text', value: value }] },
              ],
            })),
          ],
        };

        const table = await this.tableConverter.convertTable(tableNode as any);
        elements.push(table);

        // Add spacing after table
        elements.push(new Paragraph({
          text: '',
          spacing: { before: spacing.before, after: spacing.after },
        }));
      }
    } else if (this.frontmatterDisplay === 'raw') {
      // Render as raw text using code block style (reuse codeHighlighter styles)
      const codeStyle = this.themeStyles?.characterStyles?.code || { font: 'Consolas', size: 20 };
      const codeBackground = this.themeStyles?.characterStyles?.code?.background || 'F6F8FA';
      const foregroundColor = this.themeStyles?.codeColors?.foreground || '24292E';

      const runs: TextRun[] = [];
      const lines = this.frontmatterContent.split('\n');
      
      lines.forEach((line, index) => {
        if (index > 0) {
          runs.push(new TextRun({ break: 1 }));
        }
        runs.push(new TextRun({
          text: line || ' ',
          font: codeStyle.font,
          size: codeStyle.size,
          color: foregroundColor,
        }));
      });

      elements.push(new Paragraph({
        children: runs,
        wordWrap: true,
        alignment: AlignmentType.LEFT,
        spacing: { before: 200, after: 200, line: 276 },
        shading: { fill: codeBackground },
        indent: { left: 200, right: 200 },
        border: {
          top: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
          bottom: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
          left: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
          right: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
        },
      }));

      // Add spacing after raw block
      elements.push(new Paragraph({
        text: '',
        spacing: { before: spacing.before, after: spacing.after },
      }));
    }

    return elements;
  }

  private async convertAstToDocx(ast: DOCXASTNode): Promise<FileChild[]> {
    const elements: FileChild[] = [];
    let lastNodeType: string | null = null;
    this.listInstanceCounter = 0;

    // Add frontmatter at the beginning if present and not hidden
    const frontmatterElements = await this.convertFrontmatterToDocx();
    elements.push(...frontmatterElements);
    if (frontmatterElements.length > 0) {
      lastNodeType = 'frontmatter';
    }

    if (!ast.children) return elements;

    for (const node of ast.children) {
      // Check if this is a [toc] marker - insert TableOfContents only when detected
      if (this.isTocMarker(node)) {
        // Insert a table of contents at this position
        const toc = new TableOfContents('Contents', {
          hyperlink: true,
          headingStyleRange: '1-6',
        });
        elements.push(toc);
        // Add a spacing paragraph after TOC
        elements.push(new Paragraph({
          text: '',
          spacing: { before: 240, after: 120 },
        }));
        lastNodeType = 'toc';
        continue;
      }

      if (!this.docxHrAsPageBreak && node.type === 'thematicBreak' && lastNodeType === 'thematicBreak') {
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

      if (node.type === 'blockquote' && lastNodeType === 'blockquote') {
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

  private async convertNode(
    node: DOCXASTNode,
    parentStyle: Record<string, unknown> = {},
    listLevel = 0,
    blockquoteNestLevel = 0
  ): Promise<FileChild | FileChild[] | null> {
    const docxHelpers: DOCXHelpers = {
      Paragraph, TextRun, ImageRun, AlignmentType, convertInchesToTwip,
      themeStyles: this.themeStyles
    };

    const pluginRenderer: PluginRenderer = this.renderer
      ? {
          render: async (
            type: string,
            content: string | object
          ) => {
            const result = await this.renderer!.render(type, content);
            if (!result) {
              throw new Error('Plugin renderer returned empty result');
            }
            if (typeof result.width !== 'number' || typeof result.height !== 'number') {
              throw new Error('Plugin renderer returned invalid dimensions');
            }

            const format = (typeof result.format === 'string' && result.format) ? result.format : 'png';
            return {
              base64: result.base64,
              width: result.width,
              height: result.height,
              format: format,
              error: (result as any).error,
            };
          },
        }
      : {
          render: async () => {
            throw new Error('Renderer not available');
          },
        };

    const pluginResult = await convertNodeToDOCX(
      node, pluginRenderer, docxHelpers, () => this.reportResourceProgress()
    );
    if (pluginResult) return pluginResult as FileChild;

    switch (node.type) {
      case 'heading':
        return this.convertHeading(node);
      case 'paragraph':
        return await this.convertParagraph(node, parentStyle);
      case 'list':
        return await this.listConverter!.convertList(node as unknown as DOCXListNode);
      case 'code':
        return this.convertCodeBlock(node, listLevel, blockquoteNestLevel);
      case 'blockquote':
        return await this.blockquoteConverter!.convertBlockquote(node as unknown as DOCXBlockquoteNode, listLevel);
      case 'table':
        return await this.tableConverter!.convertTable(node as unknown as DOCXTableNode, listLevel);
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

  private convertHeading(node: DOCXASTNode): Paragraph {
    const levels: Record<number, typeof HeadingLevel[keyof typeof HeadingLevel]> = {
      1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4,
      5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
    };
    const text = this.inlineConverter!.extractText({
      type: 'root',
      children: (node.children || []) as unknown as InlineNode[],
    });
    const depth = node.depth || 1;
    const headingStyle = this.themeStyles?.paragraphStyles?.[`heading${depth}` as keyof typeof this.themeStyles.paragraphStyles];

    const config: {
      text: string;
      heading: typeof HeadingLevel[keyof typeof HeadingLevel];
      alignment?: typeof AlignmentType[keyof typeof AlignmentType];
    } = {
      text: text,
      heading: levels[depth] || HeadingLevel.HEADING_1,
    };

    if (headingStyle?.paragraph?.alignment === 'center') {
      config.alignment = AlignmentType.CENTER;
    }

    return new Paragraph(config);
  }

  private async convertParagraph(node: DOCXASTNode, parentStyle: Record<string, unknown> = {}): Promise<Paragraph> {
    const children = await this.inlineConverter!.convertInlineNodes(
      (node.children || []) as unknown as InlineNode[],
      parentStyle
    );
    const spacing = this.themeStyles?.default?.paragraph?.spacing || { before: 0, after: 200, line: 276 };

    return new Paragraph({
      children: children.length > 0 ? children : undefined,
      text: children.length === 0 ? '' : undefined,
      spacing: { before: spacing.before, after: spacing.after, line: spacing.line },
      alignment: AlignmentType.LEFT,
    });
  }

  private convertCodeBlock(node: DOCXASTNode, listLevel = 0, blockquoteNestLevel = 0): Paragraph {
    const runs = this.codeHighlighter!.getHighlightedRunsForCode(node.value ?? '', node.lang);
    const codeBackground = this.themeStyles?.characterStyles?.code?.background || 'F6F8FA';
    
    // Border space (10 points) extends outward, need to compensate with indent
    // 10 points = 200 twips (1 point = 20 twips)
    const borderSpace = 200;
    // Calculate indent based on list level (0.5 inch per level) plus border compensation
    const baseIndent = listLevel > 0 ? convertInchesToTwip(0.5 * listLevel) : 0;
    const indentLeft = baseIndent + borderSpace;
    // Right indent: border compensation + extra for each blockquote nesting level
    // Each blockquote level needs ~300 twips extra compensation for cell boundaries
    const blockquoteCompensation = blockquoteNestLevel > 0 ? 300 * blockquoteNestLevel : 0;
    const indentRight = borderSpace + blockquoteCompensation;

    return new Paragraph({
      children: runs,
      wordWrap: true,
      alignment: AlignmentType.LEFT,
      spacing: { before: 200, after: 200, line: 276 },
      shading: { fill: codeBackground },
      indent: { left: indentLeft, right: indentRight },
      border: {
        top: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
        bottom: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
        left: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
        right: { color: 'E1E4E8', space: 10, style: BorderStyle.SINGLE, size: 6 },
      },
    });
  }

  private convertHtml(node: DOCXASTNode): Paragraph {
    return new Paragraph({
      children: [new TextRun({ text: '[HTML Content]', italics: true, color: '666666' })],
      alignment: AlignmentType.LEFT,
      spacing: { before: 120, after: 120 },
    });
  }

  private convertThematicBreak(): Paragraph {
    if (this.docxHrAsPageBreak) {
      return new Paragraph({
        // Use pageBreakBefore instead of an explicit PageBreak run.
        // This avoids creating an extra blank page when the break happens to land
        // at the top of a page after Word's layout/pagination.
        pageBreakBefore: true,
        children: [new TextRun({ text: '', size: 1 })],
        spacing: { before: 0, after: 0, line: 1, lineRule: 'exact' },
        alignment: AlignmentType.LEFT,
      });
    }

    return new Paragraph({
      text: '',
      alignment: AlignmentType.LEFT,
      spacing: { before: 300, after: 300, line: 120, lineRule: 'exact' },
      border: { bottom: { color: 'E1E4E8', space: 1, style: BorderStyle.SINGLE, size: 12 } },
    });
  }

  private convertMathBlock(node: DOCXASTNode): Paragraph {
    try {
      const math = convertLatex2Math(node.value || '');
      return new Paragraph({
        children: [math],
        spacing: { before: 120, after: 120 },
        alignment: AlignmentType.CENTER,
      });
    } catch (error) {
      console.warn('Math conversion error:', error);
      const codeStyle = this.themeStyles?.characterStyles?.code || { font: 'Consolas', size: 20 };
      return new Paragraph({
        children: [new TextRun({ text: node.value || '', font: codeStyle.font, size: codeStyle.size })],
        alignment: AlignmentType.LEFT,
        spacing: { before: 120, after: 120 },
      });
    }
  }

  private toAlignmentType(
    alignment?: string
  ): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
    if (!alignment) return undefined;

    const normalized = alignment.trim().toLowerCase();
    if (!normalized) return undefined;

    const map: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
      left: AlignmentType.LEFT,
      center: AlignmentType.CENTER,
      right: AlignmentType.RIGHT,
      justify: AlignmentType.JUSTIFIED,
      justified: AlignmentType.JUSTIFIED,
      start: AlignmentType.START,
      end: AlignmentType.END,
    };

    const mapped = map[normalized];
    if (mapped) return mapped;

    const values = Object.values(AlignmentType) as Array<
      (typeof AlignmentType)[keyof typeof AlignmentType]
    >;
    return values.includes(normalized as any) ? (normalized as any) : undefined;
  }

  private toDocumentDefaults(defaults: DOCXThemeStyles['default']): IDocumentDefaultsOptions {
    const paragraph: IParagraphStylePropertiesOptions | undefined = defaults.paragraph
      ? {
          spacing: defaults.paragraph.spacing,
          alignment: this.toAlignmentType(defaults.paragraph.alignment),
        }
      : undefined;

    return {
      run: defaults.run,
      paragraph,
    };
  }

  private toHeadingStyle(style: DOCXHeadingStyle): IBaseParagraphStyleOptions {
    const paragraph: IParagraphStylePropertiesOptions = {
      spacing: style.paragraph.spacing,
      alignment: this.toAlignmentType(style.paragraph.alignment),
    };

    return {
      name: style.name,
      basedOn: style.basedOn,
      next: style.next,
      run: style.run,
      paragraph,
    };
  }

  async fetchImageAsBuffer(url: string): Promise<ImageBufferResult> {
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url)!;
    }

    // Handle data: URLs directly
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)[^,]*,(.+)$/);
      if (!match) throw new Error('Invalid data URL format');

      const contentType = match[1];
      const binaryString = atob(match[2]);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const result: ImageBufferResult = { buffer: bytes, contentType };
      this.imageCache.set(url, result);
      return result;
    }

    const doc = this.getDocumentService();
    if (!doc) {
      throw new Error('DocumentService not available - platform not initialized');
    }

    const isNetworkUrl = url.startsWith('http://') || url.startsWith('https://');

    try {
      if (isNetworkUrl) {
        // Use DocumentService.fetchRemote (handles CSP transparently)
        const bytes = await doc.fetchRemote(url);
        const contentType = this.guessContentType(url);
        const result: ImageBufferResult = { buffer: bytes, contentType };
        this.imageCache.set(url, result);
        return result;
      } else {
        // Use DocumentService.readRelativeFile for local files
        const content = await doc.readRelativeFile(url, { binary: true });
        const binaryString = atob(content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const contentType = this.guessContentType(url);
        const result: ImageBufferResult = { buffer: bytes, contentType };
        this.imageCache.set(url, result);
        return result;
      }
    } catch (error) {
      throw new Error(`Failed to fetch image: ${url} - ${(error as Error).message}`);
    }
  }

  /**
   * Guess content type from URL extension
   */
  private guessContentType(url: string): string {
    const ext = url.split('.').pop()?.toLowerCase().split('?')[0] || '';
    const map: Record<string, string> = {
      'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
      'gif': 'image/gif', 'bmp': 'image/bmp', 'webp': 'image/webp', 'svg': 'image/svg+xml'
    };
    return map[ext] || 'image/png';
  }
}

export default DocxExporter;
