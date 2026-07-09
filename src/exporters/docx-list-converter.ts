// List conversion for DOCX export

import {
  Paragraph,
  TextRun,
  AlignmentType,
  convertInchesToTwip,
  LevelFormat,
  NumberFormat,
  LevelSuffix,
  type IParagraphOptions,
  type ParagraphChild,
  type FileChild,
} from 'docx';
import type { DOCXListNode, DOCXASTNode } from '../types/docx';
import type { InlineResult, InlineNode } from './docx-inline-converter';

// List item node within a DOCXListNode
interface ListItemNode {
  type: string;
  checked?: boolean | null;
  children: (InlineNode | DOCXListNode | { type: string; children?: InlineNode[] })[];
}

type ConvertInlineNodesFunction = (children: InlineNode[], options?: Record<string, unknown>) => Promise<InlineResult[]>;
type ConvertChildNodeFunction = (node: DOCXASTNode, listLevel?: number) => Promise<FileChild | FileChild[] | null>;

interface ListConverterOptions {
  convertInlineNodes: ConvertInlineNodesFunction;
  incrementListInstanceCounter: () => number;
}

interface NumberingLevel {
  level: number;
  format: (typeof LevelFormat)[keyof typeof LevelFormat];
  text: string;
  alignment: (typeof AlignmentType)[keyof typeof AlignmentType];
  suffix?: (typeof LevelSuffix)[keyof typeof LevelSuffix];
  style: {
    paragraph: {
      indent: {
        left: number;
      };
    };
  };
}

/**
 * Create numbering levels configuration for ordered lists
 * @param extraLeftIndentTwips - Additional left indent in twips (e.g., for first-line indent)
 * @returns Numbering levels configuration
 */
export function createNumberingLevels(extraLeftIndentTwips = 0): NumberingLevel[] {
  const levels: NumberingLevel[] = [];
  const formats: Array<(typeof LevelFormat)[keyof typeof LevelFormat]> = [
    LevelFormat.DECIMAL,
    LevelFormat.LOWER_ROMAN,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_LETTER,
    LevelFormat.LOWER_LETTER
  ];
  // baseIndent = 0.34" (former left) − 0.14" (former hanging). With "special: none"
  // the number sits at `left`, so subtract the old hanging to keep the list at its
  // original horizontal position instead of shifting right by the hanging amount.
  const baseIndent = 0.20;
  const indentStep = 0.34;

  for (let i = 0; i < 9; i++) {
    levels.push({
      level: i,
      format: formats[i],
      text: `%${i + 1}.`,
      alignment: AlignmentType.END,
      suffix: LevelSuffix.SPACE,
      style: {
        paragraph: {
          indent: {
            left: convertInchesToTwip(baseIndent + i * indentStep) + extraLeftIndentTwips,
          },
        },
      },
    });
  }
  return levels;
}

/**
 * Create numbering levels configuration for bullet (unordered) lists
 * @param extraLeftIndentTwips - Additional left indent in twips (e.g., for first-line indent)
 * @returns Numbering levels configuration
 */
export function createBulletNumberingLevels(extraLeftIndentTwips = 0): NumberingLevel[] {
  const levels: NumberingLevel[] = [];
  const bulletChars = ['\u2022', '\u25E6', '\u25AA', '\u2022', '\u25E6', '\u25AA', '\u2022', '\u25E6', '\u25AA'];
  // baseIndent = 0.34" (former left) − 0.14" (former hanging). With "special: none"
  // the number sits at `left`, so subtract the old hanging to keep the list at its
  // original horizontal position instead of shifting right by the hanging amount.
  const baseIndent = 0.20;
  const indentStep = 0.34;

  for (let i = 0; i < 9; i++) {
    levels.push({
      level: i,
      format: NumberFormat.BULLET,
      text: bulletChars[i],
      alignment: AlignmentType.END,
      suffix: LevelSuffix.SPACE,
      style: {
        paragraph: {
          indent: {
            left: convertInchesToTwip(baseIndent + i * indentStep) + extraLeftIndentTwips,
          },
        },
      },
    });
  }
  return levels;
}

export interface ListConverter {
  convertList(node: DOCXListNode, insideBlockquote?: boolean): Promise<FileChild[]>;
  convertListItem(ordered: boolean, item: ListItemNode, level: number, listInstance: number, insideBlockquote?: boolean): Promise<FileChild[]>;
  setConvertChildNode(fn: ConvertChildNodeFunction): void;
}

/**
 * Create a list converter
 * @param options - Configuration options
 * @returns List converter
 */
export function createListConverter({ 
  convertInlineNodes, 
  incrementListInstanceCounter
}: ListConverterOptions): ListConverter {

  // Mutable reference to convertChildNode (set later to avoid circular dependency)
  let convertChildNode: ConvertChildNodeFunction | undefined;

  /**
   * Set the convertChildNode function (called after all converters are initialized)
   */
  function setConvertChildNode(fn: ConvertChildNodeFunction): void {
    convertChildNode = fn;
  }
  
  /**
   * Convert list node to DOCX elements (paragraphs, tables, etc.)
   * @param node - List AST node
   * @returns Array of DOCX FileChild elements
   */
  async function convertList(node: DOCXListNode, insideBlockquote = false): Promise<FileChild[]> {
    const items: FileChild[] = [];
    const listInstance = incrementListInstanceCounter();

    for (const item of node.children) {
      const converted = await convertListItem(node.ordered ?? false, item as ListItemNode, 0, listInstance, insideBlockquote);
      if (converted) {
        items.push(...converted);
      }
    }

    return items;
  }

  /**
   * Convert list item node to DOCX elements
   * @param ordered - Whether the list is ordered
   * @param node - ListItem AST node
   * @param level - Current nesting level
   * @param listInstance - List instance number for numbering
   * @returns Array of DOCX FileChild elements
   */
  async function convertListItem(ordered: boolean, node: ListItemNode, level: number, listInstance: number, insideBlockquote = false): Promise<FileChild[]> {
    const items: FileChild[] = [];
    const isTaskList = node.checked !== null && node.checked !== undefined;

    for (const child of node.children) {
      if (child.type === 'paragraph') {
        const paragraphChild = child as { type: string; children?: InlineNode[] };
        const children = await convertInlineNodes(paragraphChild.children || []);

        if (isTaskList) {
          const checkboxSymbol = node.checked ? '▣' : '☐';
          children.unshift(new TextRun({
            text: checkboxSymbol + ' ',
          }));
        }

        const baseParagraphConfig: IParagraphOptions = {
          children: children as ParagraphChild[],
          style: 'ListParagraph',
        };

        const paragraph = ordered && !isTaskList
          ? new Paragraph({
              ...baseParagraphConfig,
              numbering: {
                reference: insideBlockquote ? 'blockquote-ordered-list' : 'default-ordered-list',
                level: level,
                instance: listInstance,
              },
            })
          : isTaskList
            ? new Paragraph({
                ...baseParagraphConfig,
                bullet: { level: level },
              })
            : new Paragraph({
                ...baseParagraphConfig,
                numbering: {
                  reference: insideBlockquote ? 'blockquote-bullet-list' : 'default-bullet-list',
                  level: level,
                  instance: listInstance,
                },
              });

        items.push(paragraph);
      } else if (child.type === 'list') {
        const listChild = child as DOCXListNode;
        for (const nestedItem of listChild.children) {
          items.push(...await convertListItem(listChild.ordered ?? false, nestedItem as ListItemNode, level + 1, listInstance, insideBlockquote));
        }
      } else if (convertChildNode) {
        // Handle other node types (e.g., blockquote, code, table) within list items
        // Pass the current list level for proper indentation
        const converted = await convertChildNode(child as DOCXASTNode, level + 1);
        if (converted) {
          if (Array.isArray(converted)) {
            items.push(...converted);
          } else {
            items.push(converted);
          }
        }
      }
    }

    return items;
  }

  return { convertList, convertListItem, setConvertChildNode };
}
