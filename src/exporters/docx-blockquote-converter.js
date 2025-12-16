// Blockquote conversion for DOCX export

import {
  Paragraph,
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
} from 'docx';

/**
 * Create a blockquote converter
 * @param {Object} options - Configuration options
 * @param {Object} options.themeStyles - Theme styles
 * @param {Function} options.convertInlineNodes - Function to convert inline nodes
 * @returns {Object} Blockquote converter
 */
export function createBlockquoteConverter({ themeStyles, convertInlineNodes }) {
  /**
   * Convert blockquote node to DOCX paragraphs
   * @param {Object} node - Blockquote AST node
   * @param {number} nestLevel - Current nesting level (default: 0)
   * @returns {Promise<Paragraph[]>} Array of DOCX Paragraphs
   */
  async function convertBlockquote(node, nestLevel = 0) {
    const paragraphs = [];
    const outerIndent = 0.3 + (nestLevel * 0.3);
    const leftBorderAndPadding = 0.13;
    const rightBorderAndPadding = 0.09;

    const defaultLineSpacing = themeStyles.default.paragraph.spacing.line;
    const compressedLineSpacing = Math.round(240 + (defaultLineSpacing - 240) / 4);
    const lineSpacingExtra = compressedLineSpacing - 240;
    const paragraphSpacing = themeStyles.default.paragraph.spacing;
    const originalHalfSpacing = paragraphSpacing.before - (defaultLineSpacing - 240) / 2;
    const blockquoteInterParagraphSpacing = originalHalfSpacing + lineSpacingExtra / 2;

    const buildParagraphConfig = (children, spacingBefore = 0, spacingAfter = 0) => ({
      children: children,
      spacing: { before: spacingBefore, after: spacingAfter, line: compressedLineSpacing },
      alignment: AlignmentType.LEFT,
      indent: {
        left: convertInchesToTwip(outerIndent - leftBorderAndPadding),
        right: convertInchesToTwip(rightBorderAndPadding),
      },
      border: {
        left: { color: 'DFE2E5', space: 6, style: BorderStyle.SINGLE, size: 24 },
        top: { color: 'F6F8FA', space: 4, style: BorderStyle.SINGLE, size: 1 },
        bottom: { color: 'F6F8FA', space: 4, style: BorderStyle.SINGLE, size: 1 },
        right: { color: 'F6F8FA', space: 6, style: BorderStyle.SINGLE, size: 1 },
      },
      shading: { fill: 'F6F8FA' },
    });

    const childCount = node.children.length;
    let childIndex = 0;

    for (const child of node.children) {
      if (child.type === 'paragraph') {
        const children = await convertInlineNodes(child.children, { color: '6A737D' });
        const isFirst = (childIndex === 0);
        const isLast = (childIndex === childCount - 1);

        let spacingBefore = 0;
        if (isFirst && nestLevel === 0) {
          spacingBefore = 200;
        } else if (!isFirst) {
          spacingBefore = blockquoteInterParagraphSpacing;
        }

        const spacingAfter = (isLast && nestLevel === 0) ? 300 : 0;
        paragraphs.push(new Paragraph(buildParagraphConfig(children, spacingBefore, spacingAfter)));
        childIndex++;
      } else if (child.type === 'blockquote') {
        const nested = await convertBlockquote(child, nestLevel + 1);
        paragraphs.push(...nested);
        childIndex++;
      }
    }

    return paragraphs;
  }

  return { convertBlockquote };
}
