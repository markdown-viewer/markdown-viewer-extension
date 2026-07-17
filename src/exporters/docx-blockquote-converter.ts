// Blockquote conversion for DOCX export
// Uses a single-cell table to create a true container that supports nested content

import {
  Paragraph,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  TableLayoutType,
  convertInchesToTwip,
  type IParagraphOptions,
  type ParagraphChild,
  type FileChild,
} from 'docx';
import type { DOCXThemeStyles, DOCXBlockquoteNode, DOCXASTNode } from '../types/docx';
import type { InlineResult, InlineNode } from './docx-inline-converter';

type ConvertInlineNodesFunction = (children: InlineNode[], options?: { color?: string }) => Promise<InlineResult[]>;
type ConvertChildNodeFunction = (node: DOCXASTNode, blockquoteNestLevel?: number) => Promise<FileChild | FileChild[] | null>;

interface BlockquoteConverterOptions {
  themeStyles: DOCXThemeStyles;
  convertInlineNodes: ConvertInlineNodesFunction;
  convertChildNode?: ConvertChildNodeFunction;
}

export interface BlockquoteConverter {
  convertBlockquote(node: DOCXBlockquoteNode, listLevel?: number): Promise<Table>;
  setConvertChildNode(fn: ConvertChildNodeFunction): void;
}

// Blockquote style constants
const BLOCKQUOTE_STYLES = {
  leftBorderSize: 18,
};

// Alert type colors — matches GitHub's canonical palette in theme-to-css.ts
const ALERT_COLORS: Record<string, string> = {
  note: '0969da',
  tip: '1a7f37',
  important: '8250df',
  warning: '9a6700',
  caution: 'cf222e',
};

/** Extract alert type (e.g. "note", "warning") from blockquote node's hProperties, or null */
function getAlertType(node: DOCXBlockquoteNode): string | null {
  const data = (node as unknown as Record<string, unknown>).data as Record<string, unknown> | undefined;
  const hProperties = data?.hProperties as Record<string, unknown> | undefined;
  const className = hProperties?.className;
  if (!className) return null;
  const classes: string[] = Array.isArray(className) ? className : [String(className)];
  for (const cls of classes) {
    const match = /^markdown-alert-(\w+)$/.exec(cls);
    if (match) return match[1];
  }
  return null;
}

/** Check whether a child paragraph carries the markdown-alert-title class */
function isAlertTitle(child: DOCXASTNode): boolean {
  const data = (child as unknown as Record<string, unknown>).data as Record<string, unknown> | undefined;
  const hProperties = data?.hProperties as Record<string, unknown> | undefined;
  const className = hProperties?.className;
  if (!className) return false;
  const classes: string[] = Array.isArray(className) ? className : [String(className)];
  return classes.includes('markdown-alert-title');
}

/**
 * Blend alert color with page background (10 % alert + 90 % page).
 * Replicates the CSS color-mix(in srgb, COLOR 10%, PAGE_BG) in theme-to-css.ts.
 */
function blendAlertBackground(alertColor: string, pageBg: string): string {
  const r1 = parseInt(alertColor.slice(0, 2), 16);
  const g1 = parseInt(alertColor.slice(2, 4), 16);
  const b1 = parseInt(alertColor.slice(4, 6), 16);
  const r2 = parseInt(pageBg.slice(0, 2), 16);
  const g2 = parseInt(pageBg.slice(2, 4), 16);
  const b2 = parseInt(pageBg.slice(4, 6), 16);
  const r = Math.round(r1 * 0.1 + r2 * 0.9);
  const g = Math.round(g1 * 0.1 + g2 * 0.9);
  const b = Math.round(b1 * 0.1 + b2 * 0.9);
  return [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a blockquote converter using table-based approach
 * This allows true nesting and supports any content type inside blockquotes
 * @param options - Configuration options
 * @returns Blockquote converter
 */
export function createBlockquoteConverter({ themeStyles, convertInlineNodes, convertChildNode: initialConvertChildNode }: BlockquoteConverterOptions): BlockquoteConverter {
  const blockquoteSpacing = themeStyles.blockSpacing?.blockquote;
  
  // Cell padding for the blockquote container.
  // BlockquoteText paragraph spacing is now globally compensated via
  // compensateParagraphSpacing(), so cell padding can be symmetric
  // without adding extra line-height offset.
  const basePadding = blockquoteSpacing?.paddingVertical ?? 80;
  const horizontalPadding = blockquoteSpacing?.paddingHorizontal ?? 200;
  const cellPadding = {
    top: basePadding,
    bottom: basePadding,
    left: horizontalPadding,
    right: Math.round(horizontalPadding / 2),
  };

  // Mutable reference to convertChildNode (set later to avoid circular dependency)
  let convertChildNode: ConvertChildNodeFunction | undefined = initialConvertChildNode;

  /**
   * Set the convertChildNode function (called after all converters are initialized)
   */
  function setConvertChildNode(fn: ConvertChildNodeFunction): void {
    convertChildNode = fn;
  }

  /**
   * Convert a paragraph node inside blockquote.
   * When the blockquote is an alert, the title paragraph gets the alert colour.
   */
  async function convertBlockquoteParagraph(child: DOCXASTNode, isFirst: boolean, alertColor?: string): Promise<Paragraph> {
    const isTitle = isAlertTitle(child);
    const inlineColor = (alertColor && isTitle) ? alertColor : undefined;
    const children = await convertInlineNodes(child.children as InlineNode[], inlineColor ? { color: inlineColor } : undefined);
    
    // Use the BlockquoteText style spacing as-is. It is globally compensated
    // (before/after balanced around the line leading), so each paragraph is
    // self-balanced and the container's symmetric cell padding keeps the
    // top/bottom gaps equal — no per-paragraph spacing override needed.
    const paragraphConfig: IParagraphOptions = {
      children: children as ParagraphChild[],
      style: 'BlockquoteText',
    };
    
    return new Paragraph(paragraphConfig);
  }

  /**
   * Convert blockquote node to a DOCX Table (single-cell table as container)
   * @param node - Blockquote AST node
   * @param listLevel - List nesting level for indentation (default: 0)
   * @param nestLevel - Blockquote nesting level within blockquotes (default: 0)
   * @returns DOCX Table representing the blockquote
   */
  async function convertBlockquote(node: DOCXBlockquoteNode, listLevel = 0, nestLevel = 0): Promise<Table> {
    // Detect alert type from node metadata (set by remark-github-alerts plugin)
    const alertType = getAlertType(node);
    const alertColor = alertType ? ALERT_COLORS[alertType] : undefined;
    // Alert-specific background = 10% alert color mixed with page background
    const alertBackground = (alertColor && themeStyles.pageBackground)
      ? blendAlertBackground(alertColor, themeStyles.pageBackground)
      : undefined;

    const cellChildren: FileChild[] = [];

    let isFirst = true;
    for (const child of node.children) {
      if (child.type === 'paragraph') {
        cellChildren.push(await convertBlockquoteParagraph(child, isFirst, alertColor));
        isFirst = false;
      } else if (child.type === 'blockquote') {
        // Nested blockquote: recursively create another table (keep same listLevel, increment nestLevel)
        const nestedTable = await convertBlockquote(child as DOCXBlockquoteNode, listLevel, nestLevel + 1);
        cellChildren.push(nestedTable);
        isFirst = false;
      } else if (convertChildNode) {
        // Use generic converter for other node types (code, table, etc.)
        // Pass blockquote nest level + 1 for proper right margin compensation
        const converted = await convertChildNode(child, nestLevel + 1);
        if (converted) {
          if (Array.isArray(converted)) {
            cellChildren.push(...converted);
          } else {
            cellChildren.push(converted);
          }
        }
        isFirst = false;
      }
    }

    // Ensure at least one paragraph in the cell (Word requirement)
    if (cellChildren.length === 0) {
      cellChildren.push(new Paragraph({ text: '' }));
    }

    // Alert-specific colours take precedence; fall back to generic blockquote theme colours
    const borderColor = alertColor ?? themeStyles.blockquoteColor;
    const backgroundColor = alertBackground ?? themeStyles.blockquoteBackground;

    // Hidden-border color: prefer actual background, then page bg, fallback white.
    const hiddenBorderColor = backgroundColor
      || themeStyles.pageBackground
      || 'FFFFFF';

    // Create the table cell with blockquote / alert styling
    const cell = new TableCell({
      children: cellChildren,
      margins: cellPadding,
      borders: {
        top: { style: BorderStyle.SINGLE, size: 0, color: hiddenBorderColor },
        bottom: { style: BorderStyle.SINGLE, size: 0, color: hiddenBorderColor },
        right: { style: BorderStyle.SINGLE, size: 0, color: hiddenBorderColor },
        left: {
          style: BorderStyle.SINGLE,
          size: BLOCKQUOTE_STYLES.leftBorderSize,
          color: borderColor,
        },
      },
      ...(backgroundColor
        ? { shading: { fill: backgroundColor } }
        : {}),
    });

    // Create single-row table
    const row = new TableRow({
      children: [cell],
    });

    // Calculate indent for this blockquote level
    // For top-level (nestLevel=0): use listLevel indent if inside a list
    // For nested blockquotes (nestLevel>0): use a fixed small indent relative to parent
    const listIndent = listLevel > 0 ? 0.5 * listLevel : 0;
    const blockquoteIndent = 0.2 * nestLevel; // Fixed indent per nesting level
    const totalIndent = listIndent + blockquoteIndent;

    // Width calculation:
    // - Top level: full content width minus indent
    // - Nested: use 100% of parent cell width (parent already constrains it)
    const isNested = nestLevel > 0;
    
    // Create table with appropriate width
    const table = new Table({
      rows: [row],
      width: isNested 
        ? { size: 100, type: WidthType.PERCENTAGE }  // Nested: fill parent cell
        : { size: convertInchesToTwip(6.5 - listIndent), type: WidthType.DXA },  // Top level: calculated width
      layout: TableLayoutType.FIXED,
      indent: isNested
        ? undefined  // Nested: no extra indent, align with parent text
        : (listIndent > 0 ? { size: convertInchesToTwip(listIndent), type: WidthType.DXA } : undefined),  // Top level: list indent only
    });

    return table;
  }

  return { convertBlockquote, setConvertChildNode };
}
