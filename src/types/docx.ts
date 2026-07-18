/**
 * DOCX Export Type Definitions
 * 
 * This file defines types for DOCX export functionality.
 * 
 * IMPORTANT: These types are INTERNAL types for theme configuration and conversion.
 * They are NOT the same as docx library types. The conversion layer (theme-to-docx.ts)
 * is responsible for converting these internal types to docx library types.
 */

import { BorderStyle, AlignmentType, type IFontAttributesProperties } from 'docx';

// =============================================================================
// Type Helpers - Extract value types from docx const objects
// =============================================================================

/**
 * Alignment type values from docx library
 * Use this type when you need to store alignment values
 */
export type AlignmentTypeValue = (typeof AlignmentType)[keyof typeof AlignmentType];

/**
 * Border style values from docx library
 * Use this type when you need to store border style values
 */
export type BorderStyleValue = (typeof BorderStyle)[keyof typeof BorderStyle];

// =============================================================================
// Emoji Style Configuration
// =============================================================================

/**
 * Emoji font style options for DOCX export
 * - 'apple': Use Apple Color Emoji (iOS/macOS style, 3D glossy)
 * - 'windows': Use Segoe UI Emoji (Windows/WPS style, flat design)
 * - 'system': Use system emoji (no font processing, preserve original)
 */
export type EmojiStyle = 'apple' | 'windows' | 'system';

// =============================================================================
// Internal Theme Styles - Used by theme-to-docx conversion
// =============================================================================

/**
 * Internal run style for theme configuration
 * This is converted to IRunStylePropertiesOptions when creating DOCX
 */
export interface DOCXRunStyle {
  font: string | IFontAttributesProperties;
  size: number;  // In half-points (e.g., 24 = 12pt)
  bold?: boolean;
  color?: string;  // Hex color without #
}

/**
 * Internal paragraph spacing for theme configuration
 * Values are in twips (twentieth of a point, 1440 twips = 1 inch)
 */
export interface DOCXParagraphSpacing {
  line?: number;
  before?: number;
  after?: number;
}

/**
 * Internal paragraph style for theme configuration
 * Note: alignment is stored as string for flexibility in theme files,
 * converted to AlignmentTypeValue at runtime
 */
export interface DOCXParagraphStyle {
  spacing?: DOCXParagraphSpacing;
  alignment?: string;  // 'left' | 'center' | 'right' - converted at runtime
}

/**
 * Internal heading style for theme configuration
 */
export interface DOCXHeadingStyle {
  id: string;
  name: string;
  basedOn: string;
  next: string;
  run: DOCXRunStyle;
  paragraph: DOCXParagraphStyle;
}

/**
 * Internal named paragraph style (supports both heading and custom block styles)
 */
export interface DOCXNamedParagraphStyle {
  id: string;
  name: string;
  basedOn: string;
  next: string;
  run?: Partial<DOCXRunStyle>;
  paragraph?: DOCXParagraphStyle;
}

/**
 * Internal character style for code blocks
 */
export interface DOCXCharacterStyle {
  font: string | IFontAttributesProperties;
  size: number;
  background: string;  // Hex color without #
}

/**
 * Internal border style
 * Note: style is BorderStyleValue from docx library
 */
export interface DOCXBorder {
  style: BorderStyleValue;
  size: number;
  color: string;  // Hex color without #
}

/**
 * Internal table borders configuration
 */
export interface DOCXTableBorders {
  all?: DOCXBorder;
  headerTop?: DOCXBorder;
  headerBottom?: DOCXBorder;
  insideHorizontal?: DOCXBorder;
  lastRowBottom?: DOCXBorder;
}

/**
 * Internal table style configuration
 */
export interface DOCXTableStyle {
  borders: DOCXTableBorders;
  header: {
    shading?: { fill: string };
    color?: string;  // Header text color (hex without #)
    bold?: boolean;
  };
  cell: {
    margins?: {
      top: number;
      bottom: number;
      left: number;
      right: number;
    };
  };
  zebra: boolean | {
    even: string;
    odd: string;
  };
}

/**
 * Code syntax highlighting colors
 */
export interface DOCXCodeColors {
  background: string;  // Hex color without #
  foreground: string;  // Hex color without #
  colors: Record<string, string>;  // Token type -> hex color
}

/**
 * Block spacing values generated from layout-scheme blocks settings
 */
export interface DOCXBlockSpacing {
  list?: DOCXParagraphSpacing;
  listItem?: DOCXParagraphSpacing;
  blockquote?: DOCXParagraphSpacing & {
    paddingVertical?: number;
    paddingHorizontal?: number;
  };
  codeBlock?: DOCXParagraphSpacing;
  table?: DOCXParagraphSpacing;
  horizontalRule?: DOCXParagraphSpacing;
  math?: DOCXParagraphSpacing;
}

/**
 * Complete internal DOCX theme styles configuration
 * Used throughout the DOCX export system
 */
export interface DOCXThemeStyles {
  default: {
    run: DOCXRunStyle;
    paragraph: DOCXParagraphStyle;
  };
  paragraphStyles: Record<string, DOCXNamedParagraphStyle>;
  characterStyles: {
    code: DOCXCharacterStyle;
  };
  tableStyles: DOCXTableStyle;
  codeColors: DOCXCodeColors;
  linkColor: string;  // Link color from colorScheme (hex without #)
  blockquoteColor: string;  // Blockquote left border color from colorScheme (hex without #)
  /** Page background color (hex without #), omitted when theme does not define one */
  pageBackground?: string;
  /** Blockquote background shading (hex without #), omitted when theme does not define one */
  blockquoteBackground?: string;
  blockSpacing: DOCXBlockSpacing;
  /** TableText paragraph spacing (before/after in twips) used to compensate cell margins */
  tableTextSpacing?: DOCXParagraphSpacing;
  /** Whether the current theme's layout scheme supports first-line indentation */
  firstLineIndentEnabled?: boolean;
}

// =============================================================================
// DOCX Converter Types
// =============================================================================

/**
 * Link definition from markdown reference links
 */
export interface LinkDefinition {
  url: string;
  title: string | null;  // null when not specified
}

/**
 * Image buffer result from fetching
 */
export interface ImageBufferResult {
  buffer: Uint8Array;
  contentType: string;
}

/**
 * Supported image types for DOCX
 */
export type DOCXImageType = 'png' | 'jpg' | 'gif' | 'bmp';

/**
 * Fetch image result with dimensions
 */
export interface FetchImageResult {
  buffer: Uint8Array;
  width: number;
  height: number;
  type: DOCXImageType;
}

/**
 * DOCX export result
 */
export interface DOCXExportResult {
  success: boolean;
  error?: string;
}

/**
 * Progress callback type
 */
export type DOCXProgressCallback = (processed: number, total: number) => void;

/**
 * Public DOCX exporter interface
 * Implemented by the DocxExporter class in src/exporters/docx-exporter.ts
 */
export interface DocxExporter {
  exportToDocx(
    markdown: string,
    filename?: string,
    onProgress?: DOCXProgressCallback | null
  ): Promise<DOCXExportResult>;
  setBaseUrl?(url: string): void;
}

// =============================================================================
// AST Node Types for DOCX conversion
// =============================================================================

/**
 * Base AST node interface
 */
export interface DOCXASTNode {
  type: string;
  children?: DOCXASTNode[];
  value?: string;
  depth?: number;
  lang?: string;
  url?: string;
  title?: string;
  identifier?: string;
  ordered?: boolean;
  start?: number;
  [key: string]: unknown;
}

/**
 * List node with ordering info
 */
export interface DOCXListNode extends DOCXASTNode {
  type: 'list';
  ordered: boolean;
  start?: number;
  children: DOCXASTNode[];
}

/**
 * Blockquote node
 */
export interface DOCXBlockquoteNode extends DOCXASTNode {
  type: 'blockquote';
  children: DOCXASTNode[];
}

/**
 * Table node
 */
export interface DOCXTableNode extends DOCXASTNode {
  type: 'table';
  children: DOCXASTNode[];  // Table rows
}

/**
 * Inline node (text, link, emphasis, etc.)
 */
export interface DOCXInlineNode extends DOCXASTNode {
  type: 'text' | 'link' | 'emphasis' | 'strong' | 'inlineCode' | 'image' | 'linkReference' | 'inlineMath' | 'break' | 'html';
  url?: string;
  title?: string;
  identifier?: string;
  alt?: string;
}

// =============================================================================
// Re-export for convenience
// =============================================================================

export { BorderStyle, AlignmentType };
