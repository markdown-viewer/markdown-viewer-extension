// List conversion for DOCX export

import {
  Paragraph,
  TextRun,
  AlignmentType,
  convertInchesToTwip,
} from 'docx';

/**
 * Create numbering levels configuration for ordered lists
 * @returns {Array} Numbering levels configuration
 */
export function createNumberingLevels() {
  const levels = [];
  const formats = ['decimal', 'lowerRoman', 'lowerLetter', 'lowerLetter', 'lowerLetter', 'lowerLetter', 'lowerLetter', 'lowerLetter', 'lowerLetter'];
  const baseIndent = 0.42;
  const indentStep = 0.42;
  const hanging = 0.28;

  for (let i = 0; i < 9; i++) {
    levels.push({
      level: i,
      format: formats[i],
      text: `%${i + 1}.`,
      alignment: AlignmentType.START,
      style: {
        paragraph: {
          indent: {
            left: convertInchesToTwip(baseIndent + i * indentStep),
            hanging: convertInchesToTwip(i === 8 ? 0.30 : hanging)
          },
        },
      },
    });
  }
  return levels;
}

/**
 * Create a list converter
 * @param {Object} options - Configuration options
 * @param {Object} options.themeStyles - Theme styles
 * @param {Function} options.convertInlineNodes - Function to convert inline nodes
 * @param {Function} options.getListInstanceCounter - Function to get current list instance counter
 * @param {Function} options.incrementListInstanceCounter - Function to increment list instance counter
 * @returns {Object} List converter
 */
export function createListConverter({ 
  themeStyles, 
  convertInlineNodes, 
  getListInstanceCounter,
  incrementListInstanceCounter
}) {
  /**
   * Convert list node to DOCX paragraphs
   * @param {Object} node - List AST node
   * @returns {Promise<Paragraph[]>} Array of DOCX Paragraphs
   */
  async function convertList(node) {
    const items = [];
    const listInstance = incrementListInstanceCounter();

    for (const item of node.children) {
      const converted = await convertListItem(node.ordered, item, 0, listInstance);
      if (converted) {
        items.push(...converted);
      }
    }

    return items;
  }

  /**
   * Convert list item node to DOCX paragraphs
   * @param {boolean} ordered - Whether the list is ordered
   * @param {Object} node - ListItem AST node
   * @param {number} level - Current nesting level
   * @param {number} listInstance - List instance number for numbering
   * @returns {Promise<Paragraph[]>} Array of DOCX Paragraphs
   */
  async function convertListItem(ordered, node, level, listInstance) {
    const items = [];
    const isTaskList = node.checked !== null && node.checked !== undefined;

    for (const child of node.children) {
      if (child.type === 'paragraph') {
        const children = await convertInlineNodes(child.children);

        if (isTaskList) {
          const checkboxSymbol = node.checked ? '▣' : '☐';
          const bodyFont = themeStyles.default.run.font;
          const bodySize = themeStyles.default.run.size;
          children.unshift(new TextRun({
            text: checkboxSymbol + ' ',
            font: bodyFont,
            size: bodySize,
          }));
        }

        const defaultLineSpacing = themeStyles.default.paragraph.spacing.line;
        const paragraphConfig = {
          children: children,
          spacing: { before: 0, after: 0, line: defaultLineSpacing },
          alignment: AlignmentType.LEFT,
        };

        if (ordered && !isTaskList) {
          paragraphConfig.numbering = {
            reference: 'default-ordered-list',
            level: level,
            instance: listInstance,
          };
        } else {
          paragraphConfig.bullet = { level: level };
        }

        items.push(new Paragraph(paragraphConfig));
      } else if (child.type === 'list') {
        for (const nestedItem of child.children) {
          items.push(...await convertListItem(child.ordered, nestedItem, level + 1, listInstance));
        }
      }
    }

    return items;
  }

  return { convertList, convertListItem };
}
