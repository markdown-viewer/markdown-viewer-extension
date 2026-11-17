/**
 * Remark plugin to convert inline HTML to MDAST nodes
 * 
 * This plugin transforms inline HTML tags (like <b>, <i>, <sup>) into
 * their equivalent MDAST nodes (strong, emphasis, superscript), ensuring
 * consistent rendering in both web preview and DOCX export.
 * 
 * Block-level HTML (parent is root) is left unchanged for HtmlPlugin to handle.
 * Unknown tags (like <M>) are converted to text nodes showing the original HTML.
 */

import { visit } from 'unist-util-visit';
import type { Root, Parent, Html, PhrasingContent, Text } from 'mdast';

function mergeContiguousRootHtmlNodes(tree: Root): void {
  const mergedChildren = [] as Root['children'];

  for (const child of tree.children) {
    const previous = mergedChildren[mergedChildren.length - 1];
    if (
      previous?.type === 'html' &&
      child.type === 'html' &&
      shouldMergeRootHtmlNodes(previous as Html, child as Html)
    ) {
      const previousHtml = previous as Html;
      const nextHtml = child as Html;
      const separator = getRootHtmlMergeSeparator(previousHtml, nextHtml);
      previousHtml.value = `${previousHtml.value}${separator}${nextHtml.value}`;
      if (previousHtml.position && nextHtml.position?.end) {
        previousHtml.position.end = nextHtml.position.end;
      }
      continue;
    }

    mergedChildren.push(child);
  }

  tree.children = mergedChildren;
}

function shouldMergeRootHtmlNodes(previous: Html, next: Html): boolean {
  const previousEndLine = previous.position?.end?.line;
  const nextStartLine = next.position?.start?.line;

  if (!previousEndLine || !nextStartLine) {
    return false;
  }

  return nextStartLine <= previousEndLine + 1;
}

function getRootHtmlMergeSeparator(previous: Html, next: Html): string {
  const previousEndLine = previous.position?.end?.line;
  const nextStartLine = next.position?.start?.line;

  if (!previousEndLine || !nextStartLine || nextStartLine <= previousEndLine) {
    return '';
  }

  return '\n'.repeat(nextStartLine - previousEndLine);
}

// Supported HTML tags and their MDAST equivalents
const TAG_TO_NODE_TYPE: Record<string, string> = {
  'b': 'strong',
  'strong': 'strong',
  'i': 'emphasis',
  'em': 'emphasis',
  's': 'delete',
  'del': 'delete',
  'strike': 'delete',
  'sup': 'superscript',
  'sub': 'subscript',
  'code': 'inlineCode',
  'kbd': 'inlineCode',
};

// Tags that should be completely removed (dangerous)
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'style', 'link', 'meta', 'base', 'applet', 'frame', 'frameset',
]);

// Tags that should be skipped (remove tags but keep content)
const SKIP_TAGS = new Set([
  // Text formatting (no MDAST equivalent)
  'u', 'ins', 'mark', 'small', 'big',
  // Semantic
  'samp', 'var', 'q', 'cite', 'dfn', 'abbr', 'time', 'data',
  // Interactive
  'span',
  // Ruby annotations
  'ruby', 'rt', 'rp', 'rb', 'rtc',
  // Bidirectional
  'bdo', 'bdi',
  // Other
  'wbr', 'meter', 'progress', 'output',
]);

interface ConversionResult {
  node: PhrasingContent;
  endIndex: number;
}

/**
 * Try to convert <tag>content</tag> sequence to MDAST node
 */
function tryConvertHtmlSequence(
  children: PhrasingContent[],
  startIndex: number
): ConversionResult | null {
  const openTag = children[startIndex] as Html;
  if (openTag.type !== 'html') return null;

  // Match opening tag: <tagname> or <tagname attr="value"> or self-closing <tagname/>
  const tagMatch = openTag.value.match(/^<([a-zA-Z][a-zA-Z0-9]*)\s*[^>]*\/?>$/);
  if (!tagMatch) return null;

  const tagName = tagMatch[1].toLowerCase();

  // Check for dangerous tags - remove them entirely
  if (DANGEROUS_TAGS.has(tagName)) {
    // Find and skip to closing tag
    const closeTag = `</${tagName}>`;
    for (let i = startIndex + 1; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'html' && child.value.toLowerCase() === closeTag) {
        return {
          node: { type: 'text', value: '' } as Text,
          endIndex: i
        };
      }
    }
    // No closing tag, just remove the opening tag
    return {
      node: { type: 'text', value: '' } as Text,
      endIndex: startIndex
    };
  }

  // Handle <a href="...">text</a> - convert to link node
  if (tagName === 'a') {
    const hrefMatch = openTag.value.match(/href\s*=\s*["']([^"']*)["']/i);
    const url = hrefMatch ? hrefMatch[1] : '';
    
    const closeTag = '</a>';
    let endIndex = -1;

    // Find closing tag
    for (let i = startIndex + 1; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'html' && child.value.toLowerCase() === closeTag) {
        endIndex = i;
        break;
      }
    }

    // Skip javascript: URLs (dangerous) - remove tag and content
    if (url.toLowerCase().startsWith('javascript:')) {
      return {
        node: { type: 'text', value: '' } as Text,
        endIndex: endIndex !== -1 ? endIndex : startIndex
      };
    }
    
    const innerNodes: PhrasingContent[] = [];
    for (let i = startIndex + 1; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'html' && child.value.toLowerCase() === closeTag) {
        break;
      }
      innerNodes.push(child);
    }

    if (endIndex === -1) {
      // No closing tag, treat as text
      return null;
    }

    return {
      node: {
        type: 'link',
        url,
        children: innerNodes.length > 0 ? innerNodes : [{ type: 'text', value: '' }]
      } as PhrasingContent,
      endIndex
    };
  }

  // Handle <img src="..." alt="..."> - convert to image node
  if (tagName === 'img') {
    const srcMatch = openTag.value.match(/src\s*=\s*["']([^"']*)["']/i);
    const altMatch = openTag.value.match(/alt\s*=\s*["']([^"']*)["']/i);
    const widthMatch = openTag.value.match(/\bwidth\s*=\s*["']([^"']*)["']/i);
    const heightMatch = openTag.value.match(/\bheight\s*=\s*["']([^"']*)["']/i);
    const url = srcMatch ? srcMatch[1] : '';
    const alt = altMatch ? altMatch[1] : '';

    // Preserve authored width/height. They are carried in data.hProperties
    // (the remark-rehype convention) so normal images get width="24" in the
    // rendered HTML, and plugins that take over the image node can read them
    // from the same place.
    const hProperties: Record<string, string> = {};
    if (widthMatch) hProperties.width = widthMatch[1];
    if (heightMatch) hProperties.height = heightMatch[1];

    return {
      node: {
        type: 'image',
        url,
        alt,
        data: Object.keys(hProperties).length > 0 ? { hProperties } : undefined
      } as PhrasingContent,
      endIndex: startIndex
    };
  }

  // Check for skip tags - remove tags but keep content
  if (SKIP_TAGS.has(tagName)) {
    const closeTag = `</${tagName}>`;
    const innerNodes: PhrasingContent[] = [];
    let endIndex = -1;

    for (let i = startIndex + 1; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'html' && child.value.toLowerCase() === closeTag) {
        endIndex = i;
        break;
      }
      innerNodes.push(child);
    }

    // No closing tag found - just remove the opening tag
    if (endIndex === -1) {
      return {
        node: { type: 'text', value: '' } as Text,
        endIndex: startIndex
      };
    }

    // Return inner nodes (remove tags, keep content)
    // If multiple inner nodes, wrap in a container; otherwise return single node
    if (innerNodes.length === 0) {
      return {
        node: { type: 'text', value: '' } as Text,
        endIndex
      };
    } else if (innerNodes.length === 1) {
      return {
        node: innerNodes[0],
        endIndex
      };
    } else {
      // Return first node and mark others to be added after
      return {
        node: innerNodes[0],
        endIndex,
        extraNodes: innerNodes.slice(1)
      } as ConversionResult & { extraNodes?: PhrasingContent[] };
    }
  }

  // Check for supported tags
  const nodeType = TAG_TO_NODE_TYPE[tagName];
  if (!nodeType) return null;

  const closeTag = `</${tagName}>`;

  // Find closing tag
  const innerNodes: PhrasingContent[] = [];
  let endIndex = -1;

  for (let i = startIndex + 1; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'html' && child.value.toLowerCase() === closeTag) {
      endIndex = i;
      break;
    }
    innerNodes.push(child);
  }

  // No closing tag found - not a valid pair
  if (endIndex === -1) return null;

  // Handle inlineCode specially (has value, not children)
  if (nodeType === 'inlineCode') {
    const textContent = innerNodes
      .map(n => (n as Text).value || '')
      .join('');
    return {
      node: { type: 'inlineCode', value: textContent } as PhrasingContent,
      endIndex
    };
  }

  // Create node with children
  // Add data.hName for custom nodes that remark-rehype needs
  const nodeData: { hName?: string } = {};
  if (nodeType === 'superscript') {
    nodeData.hName = 'sup';
  } else if (nodeType === 'subscript') {
    nodeData.hName = 'sub';
  }

  return {
    node: {
      type: nodeType,
      children: innerNodes.length > 0 ? innerNodes : [{ type: 'text', value: '' }],
      ...(nodeData.hName ? { data: nodeData } : {})
    } as PhrasingContent,
    endIndex
  };
}

/**
 * Check if a tag is a self-closing tag like <br> or <br/>
 */
function isSelfClosingBreak(html: string): boolean {
  return /^<br\s*\/?>$/i.test(html);
}

/**
 * Remark plugin to convert inline HTML to MDAST nodes
 */
export default function remarkInlineHtml() {
  return (tree: Root) => {
    // Visit all nodes that can contain inline content
    visit(tree, (node, _index, parent) => {
      if (!parent || !Array.isArray((node as Parent).children)) return;

      // Skip if this node is root (block-level HTML should stay as-is)
      if (node.type === 'root') return;

      const nodeWithChildren = node as Parent;
      const newChildren: PhrasingContent[] = [];
      let i = 0;

      while (i < nodeWithChildren.children.length) {
        const child = nodeWithChildren.children[i] as PhrasingContent;

        if (child.type === 'html') {
          const htmlNode = child as Html;

          // Drop HTML comments entirely (<!-- ... -->)
          if (/^<!--[\s\S]*-->$/.test(htmlNode.value.trim())) {
            i++;
            continue;
          }

          // Handle <br> tags
          if (isSelfClosingBreak(htmlNode.value)) {
            newChildren.push({ type: 'break' } as PhrasingContent);
            i++;
            continue;
          }

          // Try to convert <tag>content</tag> sequence
          const result = tryConvertHtmlSequence(
            nodeWithChildren.children as PhrasingContent[],
            i
          ) as (ConversionResult & { extraNodes?: PhrasingContent[] }) | null;

          if (result) {
            // Skip empty nodes (from dangerous tag removal)
            if (result.node.type !== 'text' || (result.node as Text).value !== '') {
              newChildren.push(result.node);
            }
            // Add extra nodes if present (from SKIP_TAGS with multiple children)
            if (result.extraNodes) {
              newChildren.push(...result.extraNodes);
            }
            i = result.endIndex + 1;
            continue;
          }

          // Unknown or unpaired tag - convert to literal text
          newChildren.push({ type: 'text', value: htmlNode.value } as Text);
        } else {
          newChildren.push(child);
        }
        i++;
      }

      nodeWithChildren.children = newChildren;
    });

    mergeContiguousRootHtmlNodes(tree);
  };
}

// Export for testing
export { TAG_TO_NODE_TYPE, DANGEROUS_TAGS };
