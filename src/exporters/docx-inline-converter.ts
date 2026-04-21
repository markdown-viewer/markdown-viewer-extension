/**
 * Inline node conversion for DOCX export
 */

import {
  TextRun,
  ImageRun,
  ExternalHyperlink,
  type IRunOptions,
  type ParagraphChild
} from 'docx';
import { convertLatex2Math } from './docx-math-converter';
import {
  calculateImageDimensions,
  getImageDimensions,
  determineImageType,
  isSvgImage,
  convertSvgToPng,
  getSvgContent,
} from './docx-image-utils';
import type {
  DOCXThemeStyles,
  LinkDefinition,
  ImageBufferResult,
  DOCXImageType,
  EmojiStyle,
} from '../types/docx';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Renderer interface for SVG conversion
 */
interface Renderer {
  render(type: string, content: string, options?: object): Promise<{
    base64: string;
    width: number;
    height: number;
    format: string;
  }>;
}

/**
 * Options for creating inline converter
 */
interface InlineConverterOptions {
  themeStyles: DOCXThemeStyles;
  fetchImageAsBuffer: (url: string) => Promise<ImageBufferResult>;
  reportResourceProgress: () => void;
  linkDefinitions?: Map<string, LinkDefinition>;
  renderer?: Renderer | null;
  emojiStyle?: EmojiStyle;
  linkColor?: string;  // Link color from colorScheme (hex without #)
}

/**
 * Parent style for inline elements
 */
interface ParentStyle extends Partial<IRunOptions> {
  size?: number;
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
}

/**
 * AST Node types
 */
interface BaseNode {
  type: string;
}

interface TextNode extends BaseNode {
  type: 'text';
  value: string;
}

interface StrongNode extends BaseNode {
  type: 'strong';
  children: InlineNode[];
}

interface EmphasisNode extends BaseNode {
  type: 'emphasis';
  children: InlineNode[];
}

interface DeleteNode extends BaseNode {
  type: 'delete';
  children: InlineNode[];
}

interface InlineCodeNode extends BaseNode {
  type: 'inlineCode';
  value: string;
}

interface LinkNode extends BaseNode {
  type: 'link';
  url: string;
  title?: string;
  children: InlineNode[];
}

interface LinkReferenceNode extends BaseNode {
  type: 'linkReference';
  identifier: string;
  children: InlineNode[];
}

interface ImageNode extends BaseNode {
  type: 'image';
  url: string;
  alt?: string;
  title?: string;
}

interface InlineMathNode extends BaseNode {
  type: 'inlineMath';
  value: string;
}

interface BreakNode extends BaseNode {
  type: 'break';
}

interface HtmlNode extends BaseNode {
  type: 'html';
  value?: string;
}

interface SuperscriptNode extends BaseNode {
  type: 'superscript';
  children: InlineNode[];
}

interface SubscriptNode extends BaseNode {
  type: 'subscript';
  children: InlineNode[];
}

export type InlineNode = 
  | TextNode 
  | StrongNode 
  | EmphasisNode 
  | DeleteNode 
  | InlineCodeNode 
  | LinkNode 
  | LinkReferenceNode 
  | ImageNode 
  | InlineMathNode 
  | BreakNode 
  | HtmlNode
  | SuperscriptNode
  | SubscriptNode;

/**
 * Inline converter result type
 */
export type InlineResult = ParagraphChild;

/**
 * Inline converter interface
 */
export interface InlineConverter {
  convertInlineNodes(nodes: InlineNode[], parentStyle?: ParentStyle): Promise<InlineResult[]>;
  convertInlineNode(node: InlineNode, parentStyle?: ParentStyle): Promise<InlineResult | InlineResult[] | null>;
  convertImage(node: ImageNode): Promise<ImageRun | TextRun>;
  extractText(node: InlineNode | { type: string; children?: InlineNode[]; value?: string }): string;
}

// ============================================================================
// Emoji Detection and Font Handling
// ============================================================================

/**
 * Emoji font definitions for different styles
 */
const EMOJI_FONTS = {
  /** Apple Color Emoji - iOS/macOS style (3D, glossy) */
  apple: {
    ascii: 'Apple Color Emoji',
    eastAsia: 'Apple Color Emoji',
    hAnsi: 'Apple Color Emoji',
    cs: 'Apple Color Emoji',
  },
  /** Segoe UI Emoji - Windows style (flat design) */
  windows: {
    ascii: 'Segoe UI Emoji',
    eastAsia: 'Segoe UI Emoji',
    hAnsi: 'Segoe UI Emoji',
    cs: 'Segoe UI Emoji',
  },
} as const;

/**
 * Get emoji font configuration based on style
 * @param style - Emoji style preference
 * @returns Font configuration for the specified style
 */
function getEmojiFont(style: EmojiStyle = 'windows') {
  // 'system' style is handled separately, default to 'windows' for EMOJI_FONTS lookup
  if (style === 'system') {
    return EMOJI_FONTS.windows;
  }
  return EMOJI_FONTS[style];
}

/**
 * Regex to match emoji characters
 * Covers: emoticons, dingbats, symbols, flags, skin tone modifiers, ZWJ sequences, keycap emoji
 * - \p{RI}\p{RI}: Regional Indicator pairs (flags like 🇺🇸)
 * - [#*0-9]\u{FE0F}?\u{20E3}: Keycap emoji (#️⃣, 1️⃣, etc.)
 * - \p{Extended_Pictographic}: Main emoji characters
 * - \p{Emoji_Modifier}: Skin tone modifiers
 * - \u{200D}: Zero-width joiner for compound emoji (👨‍👩‍👧‍👦)
 */
const EMOJI_REGEX = /(?:\p{RI}\p{RI}|[#*0-9]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\u{FE0F}|[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u{200D}(?:\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\u{FE0F}|[\u{E0020}-\u{E007E}]+\u{E007F})?|[#*0-9]\u{FE0F}?\u{20E3}))*)/gu;

/**
 * Split text into segments of regular text and emoji
 * @param text - Input text
 * @returns Array of segments with type ('text' or 'emoji') and content
 */
function splitTextByEmoji(text: string): Array<{ type: 'text' | 'emoji'; content: string }> {
  const segments: Array<{ type: 'text' | 'emoji'; content: string }> = [];
  let lastIndex = 0;

  // Reset regex state
  EMOJI_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = EMOJI_REGEX.exec(text)) !== null) {
    // Add text before emoji (if any)
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    // Add emoji
    segments.push({ type: 'emoji', content: match[0] });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text (if any)
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an inline node converter
 * @param options - Configuration options
 * @returns Inline node converter
 */
export function createInlineConverter({ 
  themeStyles, 
  fetchImageAsBuffer, 
  reportResourceProgress,
  linkDefinitions,
  renderer,
  emojiStyle = 'system',
  linkColor = '0366D6'  // Default to GitHub blue
}: InlineConverterOptions): InlineConverter {
  // Get emoji font based on user preference (null for system style)
  const emojiFont = emojiStyle === 'system' ? null : getEmojiFont(emojiStyle);
  
  /**
   * Remove Variation Selector (U+FE0F) from emoji for better WPS compatibility
   * WPS doesn't handle FE0F well, showing it as a box character
   * @param emoji - Emoji string that may contain FE0F
   * @returns Emoji string with FE0F removed
   */
  function stripVariationSelector(emoji: string): string {
    return emoji.replace(/\uFE0F/g, '');
  }

  /**
   * Convert text with emoji handling - split emoji into separate runs with emoji font
   * @param text - Text content
   * @param parentStyle - Parent style to apply
   * @returns Single TextRun or array of TextRuns
   */
  function convertTextWithEmoji(text: string, parentStyle: ParentStyle): TextRun | TextRun[] {
    // If system style, don't process emoji, return as-is
    if (emojiFont === null) {
      return new TextRun({ text: text, ...parentStyle });
    }

    const segments = splitTextByEmoji(text);
    
    // If no emoji found, return simple TextRun
    if (segments.length === 1 && segments[0].type === 'text') {
      return new TextRun({ text: text, ...parentStyle });
    }
    
    // If only emoji (no regular text), return emoji TextRun(s)
    if (segments.length === 1 && segments[0].type === 'emoji') {
      const cleanEmoji = stripVariationSelector(text);
      return new TextRun({ text: cleanEmoji, ...parentStyle, font: emojiFont });
    }
    
    // Mixed content: create separate TextRuns for text and emoji
    return segments.map(segment => {
      if (segment.type === 'emoji') {
        const cleanEmoji = stripVariationSelector(segment.content);
        return new TextRun({ text: cleanEmoji, ...parentStyle, font: emojiFont });
      }
      return new TextRun({ text: segment.content, ...parentStyle });
    });
  }

  /**
   * Convert inline nodes (text, emphasis, strong, etc.)
   * @param nodes - Array of inline AST nodes
   * @param parentStyle - Parent style to inherit
   * @returns Array of DOCX elements
   */
  async function convertInlineNodes(nodes: InlineNode[], parentStyle: ParentStyle = {}): Promise<InlineResult[]> {
    const runs: InlineResult[] = [];
    const defaultStyle: ParentStyle = { ...parentStyle };

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
   * @param node - Inline AST node
   * @param parentStyle - Parent style to inherit
   * @returns DOCX element(s) or null
   */
  async function convertInlineNode(node: InlineNode, parentStyle: ParentStyle = {}): Promise<InlineResult | InlineResult[] | null> {
    switch (node.type) {
      case 'text':
        return convertTextWithEmoji(node.value, parentStyle);

      case 'strong':
        return await convertInlineNodes(node.children, { ...parentStyle, bold: true });

      case 'emphasis':
        return await convertInlineNodes(node.children, { ...parentStyle, italics: true });

      case 'delete':
        return await convertInlineNodes(node.children, { ...parentStyle, strike: true });

      case 'superscript':
        return await convertInlineNodes(node.children, { ...parentStyle, superScript: true });

      case 'subscript':
        return await convertInlineNodes(node.children, { ...parentStyle, subScript: true });

      case 'inlineCode': {
        const codeStyle = themeStyles.characterStyles.code;
        return new TextRun({
          ...parentStyle,
          text: node.value,
          font: codeStyle.font,
          size: codeStyle.size,
          shading: { fill: codeStyle.background },
        });
      }

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

      case 'html': {
        const htmlValue = node.value?.trim() || '';
        if (/^<br\s*\/?>$/i.test(htmlValue)) {
          return new TextRun({ text: '', break: 1 });
        }
        const textContent = htmlValue.replace(/<[^>]+>/g, '');
        return convertTextWithEmoji(textContent, parentStyle);
      }

      default:
        return null;
    }
  }

  /**
   * Convert link node
   * @param node - Link AST node
   * @param parentStyle - Parent style
   * @returns DOCX ExternalHyperlink
   */
  async function convertLink(node: LinkNode, parentStyle: ParentStyle): Promise<ExternalHyperlink | ImageRun | TextRun> {
    const url = node.url || '#';

    // Check if link contains an image (e.g., [![alt](img-url)](link-url))
    const imageChild = node.children?.find((child: InlineNode) => child.type === 'image') as ImageNode | undefined;
    if (imageChild) {
      // For image links, just render the image (DOCX doesn't support clickable images well)
      return await convertImage(imageChild);
    }

    const text = extractText(node);

    const linkStyle = {
      ...parentStyle,
      style: 'Hyperlink' as const,
      color: linkColor,
      underline: { type: 'single' as const, color: linkColor },
    };

    // Handle emoji in link text
    const textRuns = convertTextWithEmoji(text, linkStyle);

    return new ExternalHyperlink({
      children: Array.isArray(textRuns) ? textRuns : [textRuns],
      link: url,
    });
  }

  /**
   * Convert link reference node
   * @param node - LinkReference AST node
   * @param parentStyle - Parent style
   * @returns DOCX ExternalHyperlink
   */
  async function convertLinkReference(node: LinkReferenceNode, parentStyle: ParentStyle): Promise<ExternalHyperlink> {
    const text = extractText(node);
    const identifier = node.identifier.toLowerCase();
    const definition = linkDefinitions?.get(identifier);
    const url = definition?.url || '#';

    const linkStyle = {
      ...parentStyle,
      style: 'Hyperlink' as const,
      color: linkColor,
      underline: { type: 'single' as const, color: linkColor },
    };

    // Handle emoji in link text
    const textRuns = convertTextWithEmoji(text, linkStyle);

    return new ExternalHyperlink({
      children: Array.isArray(textRuns) ? textRuns : [textRuns],
      link: url,
    });
  }

  /**
   * Convert image node
   * @param node - Image AST node
   * @returns DOCX ImageRun or error TextRun
   */
  async function convertImage(node: ImageNode): Promise<ImageRun | TextRun> {
    try {
      // Check if image is SVG (by URL)
      const isSvg = isSvgImage(node.url);
      if (isSvg) {
        return await convertSvgImageFromUrl(node.url, node.alt);
      }

      // Fetch image as buffer
      const { buffer, contentType } = await fetchImageAsBuffer(node.url);
      
      // Double-check content type to ensure it's not SVG
      if (contentType && contentType.includes('svg')) {
        const svgContent = new TextDecoder().decode(buffer);
        return await convertSvgImageContent(svgContent, node.alt);
      }

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
      console.warn('[DOCX] Failed to load image:', node.url, error);
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
   * Convert SVG image from URL by fetching and converting to PNG
   * @param url - SVG image URL
   * @param alt - Alt text
   * @returns ImageRun or TextRun
   */
  async function convertSvgImageFromUrl(url: string, alt?: string): Promise<ImageRun | TextRun> {
    try {
      // Remote SVG: pass URL directly to renderer (uses renderFromUrl internally)
      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (!renderer) {
          reportResourceProgress();
          return new TextRun({ text: '[SVG 图片 - 渲染器不可用]', italics: true, color: '666666' });
        }
        const pngResult = await renderer.render('svg', url, { outputFormat: 'png' });
        const binaryString = atob(pngResult.base64);
        const buffer = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          buffer[i] = binaryString.charCodeAt(i);
        }
        const displayWidth = Math.round(pngResult.width / 4);
        const displayHeight = Math.round(pngResult.height / 4);
        const { width: constrainedWidth, height: constrainedHeight } =
          calculateImageDimensions(displayWidth, displayHeight);
        reportResourceProgress();
        return new ImageRun({
          data: buffer,
          transformation: { width: constrainedWidth, height: constrainedHeight },
          type: 'png',
          altText: { title: alt || 'SVG Image', description: alt || 'SVG image', name: alt || 'svg-image' },
        });
      }
      // Local SVG: fetch content then convert
      const svgContent = await getSvgContent(url, fetchImageAsBuffer);
      return await convertSvgImageContent(svgContent, alt);
    } catch (error) {
      console.warn('[DOCX] Failed to load SVG image:', url, error);
      reportResourceProgress();
      return new TextRun({
        text: `[SVG 图片加载失败: ${alt || url}]`,
        italics: true,
        color: 'DC2626',
      });
    }
  }

  /**
   * Convert SVG content to PNG and create ImageRun
   * @param svgContent - SVG content string
   * @param alt - Alt text
   * @returns ImageRun or TextRun
   */
  async function convertSvgImageContent(svgContent: string, alt?: string): Promise<ImageRun | TextRun> {
    if (!renderer) {
      reportResourceProgress();
      return new TextRun({
        text: '[SVG 图片 - 渲染器不可用]',
        italics: true,
        color: '666666',
      });
    }

    try {
      const { buffer, width, height } = await convertSvgToPng(svgContent, renderer);
      
      // Calculate display size (1/4 of original PNG size)
      const displayWidth = Math.round(width / 4);
      const displayHeight = Math.round(height / 4);
      
      // Apply max-width constraint
      const { width: constrainedWidth, height: constrainedHeight } = 
        calculateImageDimensions(displayWidth, displayHeight);

      reportResourceProgress();

      return new ImageRun({
        data: buffer,
        transformation: {
          width: constrainedWidth,
          height: constrainedHeight,
        },
        type: 'png',
        altText: {
          title: alt || 'SVG Image',
          description: alt || 'SVG image',
          name: alt || 'svg-image',
        },
      });
    } catch (error) {
      console.warn('Failed to render SVG:', error);
      reportResourceProgress();
      return new TextRun({
        text: `[SVG 渲染失败: ${(error as Error).message}]`,
        italics: true,
        color: 'FF0000',
      });
    }
  }

  /**
   * Convert inline math node
   * @param node - InlineMath AST node
   * @param parentStyle - Parent style
   * @returns DOCX Math or fallback TextRun
   */
  async function convertInlineMath(node: InlineMathNode, parentStyle: ParentStyle): Promise<InlineResult> {
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
   * @param node - AST node
   * @returns Plain text content
   */
  function extractText(node: InlineNode): string {
    if ('value' in node && node.value) {
      return node.value;
    }
    if ('children' in node && node.children) {
      let text = '';
      for (const child of node.children) {
        text += extractText(child);
      }
      return text;
    }
    return '';
  }

  return { 
    convertInlineNodes, 
    convertInlineNode,
    convertImage,
    extractText
  };
}
