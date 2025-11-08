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
  Table,
  TableCell,
  TableRow,
  WidthType,
  BorderStyle,
  convertInchesToTwip,
  Math as MathBlock,
  MathRun,
  TableLayoutType,
} from 'docx';
import { VerticalAlign as VerticalAlignTable } from 'docx';
import { mathJaxReady, convertLatex2Math as originalConvertLatex2Math } from '@hungknguyen/docx-math-converter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';

// Patch convertLatex2Math to fix issues with unsupported LaTeX commands
function convertLatex2Math(latex) {
  // Preprocessing: handle commands that MathJax converts to unsupported OMML structures
  let processedLatex = latex;
  
  // \xleftarrow and \xrightarrow use <mover> which needs special handling
  // Convert to explicit stacked structure
  processedLatex = processedLatex.replace(/\\xleftarrow\{([^}]+)\}/g, '\\overset{$1}{\\leftarrow}');
  processedLatex = processedLatex.replace(/\\xrightarrow\{([^}]+)\}/g, '\\overset{$1}{\\rightarrow}');
  
  // \xleftrightarrow
  processedLatex = processedLatex.replace(/\\xleftrightarrow\{([^}]+)\}/g, '\\overset{$1}{\\leftrightarrow}');
  
  // More extensible arrow commands
  processedLatex = processedLatex.replace(/\\xLeftarrow\{([^}]+)\}/g, '\\overset{$1}{\\Leftarrow}');
  processedLatex = processedLatex.replace(/\\xRightarrow\{([^}]+)\}/g, '\\overset{$1}{\\Rightarrow}');
  processedLatex = processedLatex.replace(/\\xLeftrightarrow\{([^}]+)\}/g, '\\overset{$1}{\\Leftrightarrow}');
  
  return originalConvertLatex2Math(processedLatex);
}

/**
 * Main class for exporting Markdown to DOCX
 */
class DocxExporter {
  constructor(renderer = null) {
    this.renderer = renderer; // ExtensionRenderer instance for rendering images
    this.imageCache = new Map(); // Cache for processed images
    this.listInstanceCounter = 0; // Counter for list instances to restart numbering
    this.mathJaxInitialized = false; // Track MathJax initialization
    this.baseUrl = null; // Base URL for resolving relative paths
  }

  /**
   * Set base URL for resolving relative image paths
   * @param {string} url - The base URL (typically the markdown file's location)
   */
  setBaseUrl(url) {
    this.baseUrl = url;
  }

  /**
   * Initialize MathJax for LaTeX conversion
   */
  async initializeMathJax() {
    if (!this.mathJaxInitialized) {
      await mathJaxReady();
      this.mathJaxInitialized = true;
    }
  }

  /**
   * Export markdown content to DOCX file
   * @param {string} markdown - Raw markdown content
   * @param {string} filename - Output filename (default: 'document.docx')
   */
  async exportToDocx(markdown, filename = 'document.docx', onProgress = null) {
    try {
      // Set base URL for resolving relative image paths
      this.setBaseUrl(window.location.href);
      
      // Initialize progress tracking
      this.progressCallback = onProgress;
      this.totalResources = 0;
      this.processedResources = 0;
      
      // Initialize MathJax first
      await this.initializeMathJax();
      
      // Parse markdown to AST
      const ast = this.parseMarkdown(markdown);
      
      // Count resources that need processing (images, mermaid, html, svg)
      this.totalResources = this.countResources(ast);
      
      // Report initial progress
      if (onProgress && this.totalResources > 0) {
        onProgress(0, this.totalResources);
      }
      
      // Convert AST to docx elements
      const sections = await this.convertAstToDocx(ast);
      
      // Create document
      const doc = new Document({
        numbering: {
          config: [
            {
              reference: 'default-ordered-list',
              levels: [
                {
                  level: 0,
                  format: 'decimal', // 1. 2. 3.
                  text: '%1.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(0.5),  // 0.5 inch left indent
                        hanging: convertInchesToTwip(0.30) // 0.30 inch hanging indent for number spacing
                      },
                    },
                  },
                },
                {
                  level: 1,
                  format: 'lowerRoman', // i. ii. iii. iv. v. vi. vii.
                  text: '%2.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(1.0),  // 1.0 inch for nested level
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
                {
                  level: 2,
                  format: 'lowerLetter', // a. b. c.
                  text: '%3.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(1.5),  // 1.5 inch for double-nested level
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
                {
                  level: 3,
                  format: 'lowerLetter', // a. b. c. (same as level 2)
                  text: '%4.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(2.0),  // 2.0 inch for level 4
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
                {
                  level: 4,
                  format: 'lowerLetter', // a. b. c. (same as level 2)
                  text: '%5.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(2.5),  // 2.5 inch for level 5
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
                {
                  level: 5,
                  format: 'lowerLetter', // a. b. c. (same as level 2)
                  text: '%6.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(3.0),  // 3.0 inch for level 6
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
                {
                  level: 6,
                  format: 'lowerLetter', // a. b. c. (same as level 2)
                  text: '%7.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(3.5),  // 3.5 inch for level 7
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
                {
                  level: 7,
                  format: 'lowerLetter', // a. b. c. (same as level 2)
                  text: '%8.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(4.0),  // 4.0 inch for level 8
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
                {
                  level: 8,
                  format: 'lowerLetter', // a. b. c. (same as level 2)
                  text: '%9.',
                  alignment: AlignmentType.START,
                  style: {
                    paragraph: {
                      indent: { 
                        left: convertInchesToTwip(4.5),  // 4.5 inch for level 9
                        hanging: convertInchesToTwip(0.30)
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
        styles: {
          default: {
            document: {
              run: {
                font: {
                  ascii: 'Times New Roman',
                  eastAsia: 'SimSun', // Chinese characters
                  hAnsi: 'Times New Roman',
                  cs: 'Times New Roman',
                },
                size: 28, // 14pt in half-points
              },
              paragraph: {
                spacing: {
                  line: 360, // 1.5 line spacing
                  after: 240, // Default paragraph spacing
                },
              },
            },
            heading1: {
              run: {
                size: 58, // 29pt in half-points
                bold: true,
                font: {
                  ascii: 'Times New Roman',
                  eastAsia: 'SimSun',
                  hAnsi: 'Times New Roman',
                  cs: 'Times New Roman',
                },
              },
              paragraph: {
                spacing: {
                  before: 240,
                  after: 120,
                  line: 360,
                },
                alignment: AlignmentType.CENTER,
              },
            },
            heading2: {
              run: {
                size: 48, // 24pt
                bold: true,
                font: {
                  ascii: 'Times New Roman',
                  eastAsia: 'SimSun',
                  hAnsi: 'Times New Roman',
                  cs: 'Times New Roman',
                },
              },
              paragraph: {
                spacing: {
                  before: 240,
                  after: 120,
                  line: 360,
                },
              },
            },
            heading3: {
              run: {
                size: 44, // 22pt
                bold: true,
                font: {
                  ascii: 'Times New Roman',
                  eastAsia: 'SimSun',
                  hAnsi: 'Times New Roman',
                  cs: 'Times New Roman',
                },
              },
              paragraph: {
                spacing: {
                  before: 240,
                  after: 120,
                  line: 360,
                },
              },
            },
            heading4: {
              run: {
                size: 38, // 19pt
                bold: true,
                font: {
                  ascii: 'Times New Roman',
                  eastAsia: 'SimSun',
                  hAnsi: 'Times New Roman',
                  cs: 'Times New Roman',
                },
              },
              paragraph: {
                spacing: {
                  before: 240,
                  after: 120,
                  line: 360,
                },
              },
            },
            heading5: {
              run: {
                size: 32, // 16pt
                bold: true,
                font: {
                  ascii: 'Times New Roman',
                  eastAsia: 'SimSun',
                  hAnsi: 'Times New Roman',
                  cs: 'Times New Roman',
                },
              },
              paragraph: {
                spacing: {
                  before: 240,
                  after: 120,
                  line: 360,
                },
              },
            },
            heading6: {
              run: {
                size: 28, // 14pt
                bold: true,
                font: {
                  ascii: 'Times New Roman',
                  eastAsia: 'SimSun',
                  hAnsi: 'Times New Roman',
                  cs: 'Times New Roman',
                },
              },
              paragraph: {
                spacing: {
                  before: 240,
                  after: 120,
                  line: 360,
                },
              },
            },
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
      
      // Generate blob
      const blob = await Packer.toBlob(doc);
      
      // Download file
      this.downloadBlob(blob, filename);
      
      // Clean up progress tracking
      this.progressCallback = null;
      this.totalResources = 0;
      this.processedResources = 0;
      
      return { success: true };
    } catch (error) {
      console.error('DOCX export error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Count resources that need processing (images and mermaid diagrams)
   */
  countResources(ast) {
    let count = 0;
    
    const countNode = (node) => {
      // Count images (including SVG images)
      if (node.type === 'image') {
        count++;
      }
      
      // Count mermaid code blocks
      if (node.type === 'code' && node.lang === 'mermaid') {
        count++;
      }
      
      // Recursively count in children
      if (node.children) {
        node.children.forEach(countNode);
      }
    };
    
    if (ast.children) {
      ast.children.forEach(countNode);
    }
    
    return count;
  }

  /**
   * Report progress for a processed resource
   */
  reportResourceProgress() {
    this.processedResources++;
    if (this.progressCallback && this.totalResources > 0) {
      this.progressCallback(this.processedResources, this.totalResources);
    }
  }

  /**
   * Parse markdown to AST
   */
  parseMarkdown(markdown) {
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkBreaks) // Add line break processing
      .use(remarkMath);
    
    // Parse and transform AST (remark-breaks needs runSync to work)
    const ast = processor.parse(markdown);
    return processor.runSync(ast);
  }

  /**
   * Convert AST to docx elements
   */
  async convertAstToDocx(ast) {
    const elements = [];
    let lastNodeType = null;
    
    // Reset list instance counter for each document
    this.listInstanceCounter = 0;
    
    for (const node of ast.children) {
      // Add minimal spacing paragraph between consecutive thematicBreaks to prevent merging
      if (node.type === 'thematicBreak' && lastNodeType === 'thematicBreak') {
        elements.push(new Paragraph({
          text: '',
          spacing: { 
            before: 0,
            after: 0,
            line: 1,  // Minimal line height (almost invisible)
            lineRule: 'exact',
          },
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

  /**
   * Convert a single AST node to docx element
   */
  async convertNode(node, parentStyle = {}) {
    switch (node.type) {
      case 'heading':
        return this.convertHeading(node);
      
      case 'paragraph':
        return await this.convertParagraph(node, parentStyle);
      
      case 'list':
        return await this.convertList(node);
      
      case 'listItem':
        return await this.convertListItem(node);
      
      case 'code':
        return this.convertCodeBlock(node);
      
      case 'blockquote':
        return await this.convertBlockquote(node);
      
      case 'table':
        return await this.convertTable(node);
      
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

  /**
   * Convert heading node
   */
  convertHeading(node) {
    const level = this.getHeadingLevel(node.depth);
    const text = this.extractText(node);
    
    // Calculate spacing in twips (1/20 of a point)
    // H1: larger spacing, H2-H6: smaller spacing
    const spacingBefore = node.depth === 1 ? 240 : 240; // 12pt before
    const spacingAfter = 120; // 6pt after
    
    const paragraphConfig = {
      text: text,
      heading: level,
      spacing: {
        before: spacingBefore,
        after: spacingAfter,
        line: 360, // 1.5 line spacing (360 = 1.5 * 240)
      },
    };
    
    // H1 should be centered and larger
    if (node.depth === 1) {
      paragraphConfig.alignment = AlignmentType.CENTER;
    }
    
    return new Paragraph(paragraphConfig);
  }

  /**
   * Get docx heading level with custom font sizes matching CSS
   */
  getHeadingLevel(depth) {
    const levels = {
      1: HeadingLevel.HEADING_1, // 29px -> 29pt
      2: HeadingLevel.HEADING_2, // 24px -> 24pt
      3: HeadingLevel.HEADING_3, // 22px -> 22pt
      4: HeadingLevel.HEADING_4, // 19px -> 19pt
      5: HeadingLevel.HEADING_5, // 16px -> 16pt
      6: HeadingLevel.HEADING_6, // 14px -> 14pt
    };
    return levels[depth] || HeadingLevel.HEADING_1;
  }

  /**
   * Convert paragraph node
   */
  async convertParagraph(node, parentStyle = {}) {
    const children = await this.convertInlineNodes(node.children, parentStyle);
    
    if (children.length === 0) {
      // Empty paragraph
      return new Paragraph({
        text: '',
        spacing: { 
          after: 240, // 16px -> 12pt
          line: 360,  // 1.5 line spacing
        },
      });
    }
    
    return new Paragraph({
      children: children,
      spacing: { 
        after: 240, // 16px -> 12pt
        line: 360,  // 1.5 line spacing
      },
    });
  }

  /**
   * Convert inline nodes (text, emphasis, strong, etc.)
   */
  async convertInlineNodes(nodes, parentStyle = {}) {
    const runs = [];
    
    // Default font settings matching CSS: 14px = 28 half-points
    // Use SimSun for better Chinese character support
    const defaultStyle = {
      font: {
        ascii: 'Times New Roman',
        eastAsia: 'SimSun', // Chinese font
        hAnsi: 'Times New Roman',
        cs: 'Times New Roman',
      },
      size: 28, // 14pt (half-points)
      ...parentStyle,
    };
    
    for (const node of nodes) {
      const converted = await this.convertInlineNode(node, defaultStyle);
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
   */
  async convertInlineNode(node, parentStyle = {}) {
    switch (node.type) {
      case 'text':
        return new TextRun({
          text: node.value,
          ...parentStyle,
        });
      
      case 'strong':
        return await this.convertInlineNodes(node.children, { ...parentStyle, bold: true });
      
      case 'emphasis':
        return await this.convertInlineNodes(node.children, { ...parentStyle, italics: true });
      
      case 'delete':
        return await this.convertInlineNodes(node.children, { ...parentStyle, strike: true });
      
      case 'inlineCode':
        return new TextRun({
          text: node.value,
          font: 'Consolas', // Monospace font matching CSS
          size: 25, // 0.9em of 14pt = 12.6pt ≈ 13pt = 25 half-points
          shading: {
            fill: 'F6F8FA', // Light gray background matching CSS
          },
          ...parentStyle,
        });
      
      case 'link':
        return await this.convertLink(node, parentStyle);
      
      case 'image':
        return await this.convertImage(node);
      
      case 'inlineMath':
        return await this.convertInlineMath(node, parentStyle);
      
      case 'break':
        return new TextRun({ text: '', break: 1 });
      
      case 'html':
        // Handle inline HTML tags
        const htmlValue = node.value?.trim() || '';
        // Check if it's a <br> or <br/> tag
        if (/^<br\s*\/?>$/i.test(htmlValue)) {
          return new TextRun({ text: '', break: 1 });
        }
        // For other inline HTML, return the raw text (strip tags)
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
   */
  convertLink(node, parentStyle) {
    const text = this.extractText(node);
    
    return new TextRun({
      text: text,
      ...parentStyle,
      color: '0366D6', // GitHub blue matching CSS
      underline: {},
    });
  }

  /**
   * Fetch image as ArrayBuffer
   * @param {string} url - Image URL (can be http://, file://, or data:)
   * @returns {Promise<{buffer: ArrayBuffer, contentType: string}>}
   */
  /**
   * Fetch image as ArrayBuffer
   * @param {string} url - Image URL (can be http://, file://, or data:)
   * @returns {Promise<{buffer: Uint8Array, contentType: string}>}
   */
  async fetchImageAsBuffer(url) {
    // Check cache first
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url);
    }

    // Handle data: URLs
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)[^,]*,(.+)$/);
      if (!match) {
        throw new Error('Invalid data URL format');
      }

      const contentType = match[1];
      const base64Data = match[2];
      
      // Decode base64 to binary
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const result = {
        buffer: bytes,  // Return Uint8Array directly
        contentType: contentType
      };
      
      this.imageCache.set(url, result);
      return result;
    }

    // Handle http:// and https:// URLs
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: HTTP ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') || 'image/png';
      
      const result = { 
        buffer: new Uint8Array(arrayBuffer),  // Convert to Uint8Array
        contentType 
      };
      this.imageCache.set(url, result);
      return result;
    }

    // Handle local file:// URLs
    const absoluteUrl = this.baseUrl ? new URL(url, this.baseUrl).href : url;
    
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
        
        // Convert base64 to Uint8Array
        const binaryString = atob(response.content);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Determine content type from file extension
        const ext = url.split('.').pop().toLowerCase();
        const contentTypeMap = {
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'bmp': 'image/bmp',
          'webp': 'image/webp'
        };
        const contentType = contentTypeMap[ext] || 'image/png';
        
        const result = {
          buffer: bytes,  // Return Uint8Array directly
          contentType: contentType
        };
        
        this.imageCache.set(url, result);
        resolve(result);
      });
    });
  }

  /**
   * Get image dimensions from buffer
   * @param {Uint8Array} buffer - Image buffer
   * @param {string} contentType - Image content type
   * @returns {Promise<{width: number, height: number}>}
   */
  async getImageDimensions(buffer, contentType) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([buffer], { type: contentType });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.width, height: img.height });
      };
      
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      
      img.src = url;
    });
  }

  /**
   * Calculate appropriate dimensions for DOCX
   * Maximum width: 6 inches (page width with 1 inch margins on letter size)
   * @param {number} originalWidth - Original image width
   * @param {number} originalHeight - Original image height
   * @returns {Object} - {width: number, height: number} in pixels
   */
  calculateImageDimensions(originalWidth, originalHeight) {
    const maxWidthInches = 6; // 8.5 - 1 - 1 = 6.5, use 6 for safety
    const maxWidthPixels = maxWidthInches * 96; // 96 DPI = 576 pixels
    
    // If image is smaller than max width, use original size
    if (originalWidth <= maxWidthPixels) {
      return { width: originalWidth, height: originalHeight };
    }
    
    // Scale down proportionally
    const ratio = maxWidthPixels / originalWidth;
    return {
      width: maxWidthPixels,
      height: Math.round(originalHeight * ratio)
    };
  }

  /**
   * Convert image node
   */
  async convertImage(node) {
    try {
      // Check if image is SVG
      const isSvg = node.url.toLowerCase().endsWith('.svg') || 
                    node.url.toLowerCase().includes('image/svg+xml');
      
      if (isSvg) {
        // Handle SVG images by converting to PNG
        const result = await this.convertSvgImageFromUrl(node.url);
        this.reportResourceProgress();
        return result;
      }
      
      // Fetch image as buffer (returns Uint8Array)
      const { buffer, contentType } = await this.fetchImageAsBuffer(node.url);
      
      // Double-check content type to ensure it's not SVG
      if (contentType && contentType.includes('svg')) {
        // Get SVG content and convert to PNG
        const svgContent = new TextDecoder().decode(buffer);
        const result = await this.convertSvgImage(svgContent);
        this.reportResourceProgress();
        return result;
      }
      
      // Get image dimensions
      const { width: originalWidth, height: originalHeight } = 
        await this.getImageDimensions(buffer, contentType);
      
      // Calculate display dimensions in pixels
      const { width: widthPx, height: heightPx } = this.calculateImageDimensions(originalWidth, originalHeight);
      
      // Determine image type from content type or URL
      let imageType = 'png'; // default
      if (contentType) {
        if (contentType.includes('jpeg') || contentType.includes('jpg')) {
          imageType = 'jpg';
        } else if (contentType.includes('png')) {
          imageType = 'png';
        } else if (contentType.includes('gif')) {
          imageType = 'gif';
        } else if (contentType.includes('bmp')) {
          imageType = 'bmp';
        }
      } else {
        // Fallback: determine from URL extension
        const ext = node.url.toLowerCase().split('.').pop().split('?')[0];
        if (['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(ext)) {
          imageType = ext === 'jpeg' ? 'jpg' : ext;
        }
      }
      
      // Report progress after processing image
      this.reportResourceProgress();
      
      // Create ImageRun with complete parameters
      return new ImageRun({
        data: buffer,
        transformation: {
          width: widthPx,
          height: heightPx,
        },
        type: imageType,
        altText: {
          title: node.alt || 'Image',
          description: node.alt || '',
          name: node.alt || 'image',
        },
      });
    } catch (error) {
      console.warn('Failed to load image:', node.url, error);
      // Report progress even on error
      this.reportResourceProgress();
      // Fallback to text placeholder
      return new TextRun({
        text: `[Image: ${node.alt || node.url}]`,
        italics: true,
        color: '666666',
      });
    }
  }

  /**
   * Convert SVG image from URL by fetching and converting to PNG
   * @param {string} url - SVG image URL
   */
  async convertSvgImageFromUrl(url) {
    try {
      let svgContent;
      
      // Handle data: URLs
      if (url.startsWith('data:image/svg+xml')) {
        const base64Match = url.match(/^data:image\/svg\+xml;base64,(.+)$/);
        if (base64Match) {
          svgContent = atob(base64Match[1]);
        } else {
          // Try URL encoded format
          const urlMatch = url.match(/^data:image\/svg\+xml[;,](.+)$/);
          if (urlMatch) {
            svgContent = decodeURIComponent(urlMatch[1]);
          } else {
            throw new Error('Unsupported SVG data URL format');
          }
        }
      } else {
        // Fetch SVG file (local or remote)
        const { buffer } = await this.fetchImageAsBuffer(url);
        svgContent = new TextDecoder().decode(buffer);
      }
      
      // Convert SVG to PNG
      return await this.convertSvgImage(svgContent);
    } catch (error) {
      console.warn('Failed to load SVG image:', url, error);
      return new TextRun({
        text: `[SVG Image: ${url}]`,
        italics: true,
        color: '999999',
      });
    }
  }

  /**
   * Convert list node
   */
  async convertList(node) {
    const items = [];
    
    // Assign a unique instance number for this list to restart numbering
    const listInstance = this.listInstanceCounter++;
    
    for (const item of node.children) {
      const converted = await this.convertListItem(node.ordered, item, 0, listInstance);
      if (converted) {
        items.push(...converted);
      }
    }
    
    return items;
  }

  /**
   * Convert list item node
   */
  async convertListItem(ordered, node, level, listInstance) {
    const items = [];
    
    // Check if this is a task list item (GFM extension)
    const isTaskList = node.checked !== null && node.checked !== undefined;
    
    for (const child of node.children) {
      if (child.type === 'paragraph') {
        const children = await this.convertInlineNodes(child.children);
        
        // For task lists, prepend checkbox symbol
        if (isTaskList) {
          const checkboxSymbol = node.checked ? '▣' : '☐';  // ▣ for checked, ☐ for unchecked
          children.unshift(new TextRun({
            text: checkboxSymbol + ' ',
            font: {
              ascii: 'Times New Roman',
              eastAsia: 'SimSun',
              hAnsi: 'Times New Roman',
              cs: 'Times New Roman',
            },
            size: 28,
          }));
        }
        
        const paragraphConfig = {
          children: children,
          spacing: { 
            after: 60,  // 0.25em spacing between items
            line: 360,  // 1.5 line spacing
          },
        };
        
        // Use numbering for ordered lists, bullet for unordered lists
        // Task lists use bullet points
        if (ordered && !isTaskList) {
          paragraphConfig.numbering = {
            reference: 'default-ordered-list',
            level: level,
            instance: listInstance, // Add instance to restart numbering for each list
          };
        } else {
          paragraphConfig.bullet = {
            level: level,
          };
        }
        
        items.push(new Paragraph(paragraphConfig));
      } else if (child.type === 'list') {
        // Nested list - use same instance for nested lists
        for (const nestedItem of child.children) {
          items.push(...await this.convertListItem(child.ordered, nestedItem, level + 1, listInstance));
        }
      }
    }
    
    return items;
  }

  /**
   * Convert code block node
   */
  async convertCodeBlock(node) {
    // Check if it's a Mermaid diagram
    if (node.lang === 'mermaid') {
      return await this.convertMermaidDiagram(node.value);
    }
    
    const lines = node.value.split('\n');
    const runs = [];
    
    for (let i = 0; i < lines.length; i++) {
      runs.push(new TextRun({
        text: lines[i],
        font: 'Consolas', // Monospace font matching CSS
        size: 28, // 14pt = 28 half-points (same as body text)
      }));
      
      if (i < lines.length - 1) {
        runs.push(new TextRun({ text: '', break: 1 }));
      }
    }
    
    return new Paragraph({
      children: runs,
      spacing: { 
        before: 240, // 16px = 12pt
        after: 240,  // 16px = 12pt
        line: 348,   // 1.45 line height for code blocks
      },
      shading: {
        fill: 'F6F8FA', // Light gray background matching CSS
      },
      border: {
        top: { color: 'E1E4E8', space: 12, value: BorderStyle.SINGLE, size: 6 }, // space: 12pt = 16px padding
        bottom: { color: 'E1E4E8', space: 12, value: BorderStyle.SINGLE, size: 6 },
        left: { color: 'E1E4E8', space: 12, value: BorderStyle.SINGLE, size: 6 },
        right: { color: 'E1E4E8', space: 12, value: BorderStyle.SINGLE, size: 6 },
      },
    });
  }

  /**
   * Convert blockquote node
   */
  /**
   * Convert blockquote node
   * @param {number} nestLevel - Nesting level for indentation (0 = top level)
   */
  async convertBlockquote(node, nestLevel = 0) {
    const paragraphs = [];
    
    // Calculate indentation based on nesting level
    // Base indent for first level: 0.3" (same as second level would have been)
    // Each nesting level adds 0.3 inch
    const outerIndent = 0.3 + (nestLevel * 0.3);  // Start at 0.3", add 0.3" per level
    
    // Calculate total width added by borders and padding on left side
    // Left border: 3pt (24/8) ≈ 0.04", Left space: 7pt ≈ 0.1"
    // Total left side ≈ 0.14 inch
    const leftBorderAndPadding = 0.14;
    
    // Calculate total width added by right padding
    // Right space: 7pt ≈ 0.1"
    const rightBorderAndPadding = 0.1;
    
    for (const child of node.children) {
      if (child.type === 'paragraph') {
        const children = await this.convertInlineNodes(child.children, { color: '6A737D' }); // Gray text
        paragraphs.push(new Paragraph({
          children: children,
          spacing: { 
            before: 0,   // No external spacing
            after: 0,    // No external spacing
            line: 360,   // 1.5 line spacing
          },
          indent: { 
            left: convertInchesToTwip(outerIndent - leftBorderAndPadding),     // Compensate for left border and padding
            right: convertInchesToTwip(rightBorderAndPadding),                 // Compensate for right padding
          },
          border: {
            left: {
              color: 'DFE2E5',         // Light gray border (matching CSS border-left: 4px solid #dfe2e5)
              space: 7,                // 7pt ≈ inner left padding (half of 15pt)
              style: BorderStyle.SINGLE,
              size: 24,                // 24 = 3pt (24/8) ≈ 4px border width
            },
            top: {
              color: 'F6F8FA',         // Same as background - invisible border
              space: 4,                // 4pt = top padding (half of 8pt)
              style: BorderStyle.SINGLE,
              size: 1,                 // Minimal border
            },
            bottom: {
              color: 'F6F8FA',         // Same as background - invisible border
              space: 4,                // 4pt = bottom padding (half of 8pt)
              style: BorderStyle.SINGLE,
              size: 1,                 // Minimal border
            },
            right: {
              color: 'F6F8FA',         // Same as background - invisible border
              space: 7,                // 7pt ≈ inner right padding (half of 15pt)
              style: BorderStyle.SINGLE,
              size: 1,                 // Minimal border
            },
          },
          shading: {
            fill: 'F6F8FA',        // Light gray background (matching CSS background-color: #f6f8fa)
          },
        }));
      } else if (child.type === 'blockquote') {
        // Handle nested blockquotes with increased nesting level
        const nested = await this.convertBlockquote(child, nestLevel + 1);
        paragraphs.push(...nested);
      }
    }
    
    return paragraphs;
  }

  /**
   * Convert table node
   */
  async convertTable(node) {
    const rows = [];
    let isHeaderRow = true;
    
    // Get table alignment info from AST
    const alignments = node.align || [];
    
    // Process table rows
    for (const row of node.children) {
      if (row.type === 'tableRow') {
        const cells = [];
        
        for (let colIndex = 0; colIndex < row.children.length; colIndex++) {
          const cell = row.children[colIndex];
          
          if (cell.type === 'tableCell') {
            // For header row, make text bold
            const children = isHeaderRow 
              ? await this.convertInlineNodes(cell.children, { bold: true })
              : await this.convertInlineNodes(cell.children);
            
            // Get cell alignment from table definition
            const cellAlignment = alignments[colIndex];
            let paragraphAlignment;
            
            // Header row: always center horizontally
            // Data rows: use table alignment
            if (isHeaderRow) {
              paragraphAlignment = AlignmentType.CENTER;
            } else {
              if (cellAlignment === 'left') {
                paragraphAlignment = AlignmentType.LEFT;
              } else if (cellAlignment === 'right') {
                paragraphAlignment = AlignmentType.RIGHT;
              } else if (cellAlignment === 'center') {
                paragraphAlignment = AlignmentType.CENTER;
              } else {
                paragraphAlignment = AlignmentType.LEFT; // Default
              }
            }
            
            const cellConfig = {
              children: [new Paragraph({ 
                children: children,
                alignment: paragraphAlignment, // Apply cell alignment to paragraph
                spacing: {
                  before: 60,
                  after: 60, 
                  line: 240,
                },
              })],
              verticalAlign: VerticalAlignTable.CENTER, // Vertical center all cells
              margins: {
                top: convertInchesToTwip(0.1),     // Reduced from 0.125 to 0.1 inch
                bottom: convertInchesToTwip(0.1),  // Reduced from 0.125 to 0.1 inch
                left: convertInchesToTwip(0.125),   // 0.125 inch = 9pt ≈ 12px
                right: convertInchesToTwip(0.125),  // 0.125 inch = 9pt ≈ 12px
              },
            };
            
            // Header row gets gray background
            if (isHeaderRow) {
              cellConfig.shading = { fill: 'F6F8FA' };
            }
            
            cells.push(new TableCell(cellConfig));
          }
        }
        
        rows.push(new TableRow({ 
          children: cells,
          tableHeader: isHeaderRow, // Mark first row as header
        }));
        
        isHeaderRow = false; // Only first row is header
      }
    }
    
    return new Table({
      rows: rows,
      layout: TableLayoutType.AUTOFIT, // Auto-fit to content
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: 'DFE2E5' },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DFE2E5' },
        left: { style: BorderStyle.SINGLE, size: 4, color: 'DFE2E5' },
        right: { style: BorderStyle.SINGLE, size: 4, color: 'DFE2E5' },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'DFE2E5' },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'DFE2E5' },
      },
      alignment: AlignmentType.CENTER, // Center table like in CSS
    });
  }

  /**
   * Convert thematic break (horizontal rule)
   */
  convertThematicBreak() {
    // Use paragraph with bottom border to create horizontal line
    // Double the thickness and use lighter color
    return new Paragraph({
      text: '',
      spacing: {
        before: 120,  // 6pt spacing before
        after: 120,   // 6pt spacing after
        line: 120,    // Exact line height: 6pt
        lineRule: 'exact',  // Use exact line height
      },
      border: {
        bottom: {
          color: 'E1E4E8',      // Lighter gray color (was default dark gray)
          space: 1,
          style: BorderStyle.SINGLE,
          size: 12,             // 12 = 1.5pt (double the default ~0.75pt), roughly 2px
        },
      },
    });
  }

  /**
   * Convert HTML block (including complex HTML tables and diagrams)
   */
  async convertHtml(node) {
    const htmlContent = node.value.trim();
    
    // Check if it's a significant HTML block that should be converted to image
    if ((htmlContent.startsWith('<div') || htmlContent.startsWith('<table') || htmlContent.startsWith('<svg')) && htmlContent.length > 100) {
      return await this.convertHtmlDiagram(htmlContent);
    }
    
    // For simple HTML, return placeholder
    return new Paragraph({
      children: [
        new TextRun({
          text: '[HTML Content]',
          italics: true,
          color: '666666',
        }),
      ],
    });
  }

  /**
   * Convert math block (display math)
   */
  async convertMathBlock(node) {
    try {
      // Use library to convert LaTeX to docx math (with preprocessing)
      const math = convertLatex2Math(node.value);
      
      return new Paragraph({
        children: [math],
        spacing: { 
          before: 120, // 6pt
          after: 120,  // 6pt
        },
        alignment: AlignmentType.CENTER,
      });
    } catch (error) {
      console.warn('Math conversion error:', error);
      // Fallback: display as monospace text
      return new Paragraph({
        children: [
          new TextRun({
            text: node.value,
            font: 'Consolas',
            size: 24, // 12pt
          }),
        ],
        spacing: { before: 120, after: 120 },
      });
    }
  }

  /**
   * Convert inline math
   */
  async convertInlineMath(node, parentStyle) {
    try {
      // Use library to convert LaTeX to docx math (with preprocessing)
      const math = convertLatex2Math(node.value);
      return math;
    } catch (error) {
      console.warn('Inline math conversion error:', error);
      // Fallback: display as monospace text
      return new TextRun({
        text: node.value,
        font: 'Consolas',
        size: 24,
        ...parentStyle,
      });
    }
  }

  /**
   * Extract plain text from node and its children
   */
  extractText(node) {
    let text = '';
    
    if (node.value) {
      return node.value;
    }
    
    if (node.children) {
      for (const child of node.children) {
        text += this.extractText(child);
      }
    }
    
    return text;
  }

  /**
   * Convert Mermaid diagram to PNG and embed as image
   * @param {string} mermaidCode - Mermaid diagram code
   */
  async convertMermaidDiagram(mermaidCode) {
    if (!this.renderer) {
      // No renderer available, return placeholder
      this.reportResourceProgress();
      return new Paragraph({
        children: [
          new TextRun({
            text: '[Mermaid Diagram - Renderer not available]',
            italics: true,
            color: '666666',
          }),
        ],
      });
    }

    try {
      // Render Mermaid to PNG
      const pngResult = await this.renderer.renderMermaidToPng(mermaidCode);
      
      // Convert base64 to Uint8Array
      const binaryString = atob(pngResult.base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Calculate display size (1/4 of original PNG size for high DPI)
      let displayWidth = Math.round(pngResult.width / 4);
      let displayHeight = Math.round(pngResult.height / 4);
      
      // Apply max-width constraint (same as regular images)
      const maxWidthInches = 6;
      const maxWidthPixels = maxWidthInches * 96; // 576 pixels
      
      if (displayWidth > maxWidthPixels) {
        const ratio = maxWidthPixels / displayWidth;
        displayWidth = maxWidthPixels;
        displayHeight = Math.round(displayHeight * ratio);
      }
      
      // Report progress after processing mermaid
      this.reportResourceProgress();
      
      // Create ImageRun
      return new Paragraph({
        children: [
          new ImageRun({
            data: bytes,
            transformation: {
              width: displayWidth,
              height: displayHeight,
            },
            type: 'png',
            altText: {
              title: 'Mermaid Diagram',
              description: 'Mermaid diagram',
              name: 'mermaid-diagram',
            },
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: {
          before: 240,
          after: 240,
        },
      });
    } catch (error) {
      console.warn('Failed to render Mermaid diagram:', error);
      // Report progress even on error
      this.reportResourceProgress();
      return new Paragraph({
        children: [
          new TextRun({
            text: `[Mermaid Error: ${error.message}]`,
            italics: true,
            color: 'FF0000',
          }),
        ],
      });
    }
  }

  /**
   * Convert HTML diagram to PNG and embed as image
   * @param {string} htmlContent - HTML content
   */
  async convertHtmlDiagram(htmlContent) {
    if (!this.renderer) {
      return new Paragraph({
        children: [
          new TextRun({
            text: '[HTML Diagram - Renderer not available]',
            italics: true,
            color: '666666',
          }),
        ],
      });
    }

    try {
      // Render HTML to PNG
      const pngResult = await this.renderer.renderHtmlToPng(htmlContent);
      
      // Convert base64 to Uint8Array
      const binaryString = atob(pngResult.base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Calculate display size (1/4 of original PNG size)
      let displayWidth = Math.round(pngResult.width / 4);
      let displayHeight = Math.round(pngResult.height / 4);
      
      // Apply max-width constraint (same as regular images)
      const maxWidthInches = 6;
      const maxWidthPixels = maxWidthInches * 96; // 576 pixels
      
      if (displayWidth > maxWidthPixels) {
        const ratio = maxWidthPixels / displayWidth;
        displayWidth = maxWidthPixels;
        displayHeight = Math.round(displayHeight * ratio);
      }
      
      // Create ImageRun
      return new Paragraph({
        children: [
          new ImageRun({
            data: bytes,
            transformation: {
              width: displayWidth,
              height: displayHeight,
            },
            type: 'png',
            altText: {
              title: 'HTML Diagram',
              description: 'HTML diagram',
              name: 'html-diagram',
            },
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: {
          before: 240,
          after: 240,
        },
      });
    } catch (error) {
      console.warn('Failed to render HTML diagram:', error);
      return new Paragraph({
        children: [
          new TextRun({
            text: `[HTML Error: ${error.message}]`,
            italics: true,
            color: 'FF0000',
          }),
        ],
      });
    }
  }

  /**
   * Convert SVG to PNG and embed as image
   * @param {string} svgContent - SVG content
   */
  async convertSvgImage(svgContent) {
    if (!this.renderer) {
      return new TextRun({
        text: '[SVG Image - Renderer not available]',
        italics: true,
        color: '666666',
      });
    }

    try {
      // Render SVG to PNG
      const pngResult = await this.renderer.renderSvgToPng(svgContent);
      
      // Convert base64 to Uint8Array
      const binaryString = atob(pngResult.base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      // Calculate display size (1/4 of original PNG size)
      let displayWidth = Math.round(pngResult.width / 4);
      let displayHeight = Math.round(pngResult.height / 4);
      
      // Apply max-width constraint (same as regular images)
      const { width: constrainedWidth, height: constrainedHeight } = 
        this.calculateImageDimensions(displayWidth, displayHeight);
      
      // Create ImageRun
      return new ImageRun({
        data: bytes,
        transformation: {
          width: constrainedWidth,
          height: constrainedHeight,
        },
        type: 'png',
        altText: {
          title: 'SVG Image',
          description: 'SVG image',
          name: 'svg-image',
        },
      });
    } catch (error) {
      console.warn('Failed to render SVG:', error);
      return new TextRun({
        text: `[SVG Error: ${error.message}]`,
        italics: true,
        color: 'FF0000',
      });
    }
  }

  /**
   * Download blob as file
   */
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }
}

export default DocxExporter;
