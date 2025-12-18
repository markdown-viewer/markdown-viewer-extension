/**
 * Remark plugin to support superscript (^text^) and subscript (~text~) syntax.
 * Compatible with unified 11 / remark-parse 11 / micromark architecture.
 * 
 * Syntax:
 *   - Superscript: ^text^ → <sup>text</sup>
 *   - Subscript: ~text~ → <sub>text</sub>
 * 
 * Note: Single ~ is used for subscript (different from GFM's ~~ for strikethrough)
 */

import { visit } from 'unist-util-visit';
import type { Plugin } from 'unified';
import type { Root, Text, Parent } from 'mdast';

// Define custom node types
interface SuperscriptNode {
  type: 'superscript';
  children: Array<{ type: 'text'; value: string }>;
  data?: {
    hName: string;
  };
}

interface SubscriptNode {
  type: 'subscript';
  children: Array<{ type: 'text'; value: string }>;
  data?: {
    hName: string;
  };
}

type ScriptNode = SuperscriptNode | SubscriptNode;

/**
 * Parse text for superscript (^text^) and subscript (~text~) patterns.
 * Returns array of text and script nodes.
 */
function parseScriptSyntax(text: string): Array<Text | ScriptNode> {
  const result: Array<Text | ScriptNode> = [];
  let remaining = text;
  
  // Pattern matches ^text^ or ~text~ but not ^^ or ~~
  // Also ensures no spaces immediately after opening or before closing marker
  const pattern = /(?<!\^)\^([^\s^][^^]*?[^\s^]|[^\s^])\^(?!\^)|(?<!~)~([^\s~][^~]*?[^\s~]|[^\s~])~(?!~)/g;
  
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  
  while ((match = pattern.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      result.push({
        type: 'text',
        value: text.slice(lastIndex, match.index)
      });
    }
    
    // Determine if superscript or subscript
    const isSuperscript = match[0].startsWith('^');
    const content = isSuperscript ? match[1] : match[2];
    
    if (isSuperscript) {
      result.push({
        type: 'superscript',
        children: [{ type: 'text', value: content }],
        data: { hName: 'sup' }
      });
    } else {
      result.push({
        type: 'subscript',
        children: [{ type: 'text', value: content }],
        data: { hName: 'sub' }
      });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    result.push({
      type: 'text',
      value: text.slice(lastIndex)
    });
  }
  
  return result;
}

/**
 * Remark plugin to support superscript and subscript syntax.
 */
const remarkSuperSub: Plugin<[], Root> = function () {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index: number | undefined, parent: Parent | undefined) => {
      if (index === undefined || !parent) return;
      
      const value = node.value;
      
      // Quick check: if no ^ or ~ in text, skip
      if (!value.includes('^') && !value.includes('~')) return;
      
      const parsed = parseScriptSyntax(value);
      
      // If no changes, return
      if (parsed.length === 1 && parsed[0].type === 'text') return;
      
      // Replace the text node with parsed nodes
      parent.children.splice(index, 1, ...parsed as typeof parent.children);
    });
  };
};

export default remarkSuperSub;
