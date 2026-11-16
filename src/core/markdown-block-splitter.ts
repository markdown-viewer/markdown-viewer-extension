/**
 * Standalone markdown block splitter with no dependencies.
 * Each block type has its own detection logic.
 */

export interface BlockWithLine {
  content: string;
  startLine: number; // 0-based line number in source
}

export interface BlockWithContent {
  content: string;
}

// Block type detectors
interface BlockDetector {
  name: string;
  // Check if this line starts the block (given lines and current index)
  isStart: (lines: string[], index: number) => boolean;
  // Find the end index (inclusive) of this block starting from startIndex
  findEnd: (lines: string[], startIndex: number) => number;
}

// Fenced code block: ```lang or ~~~
const fencedCodeDetector: BlockDetector = {
  name: 'fenced-code',
  isStart: (lines, index) => {
    const trimmed = lines[index].trim();
    return /^(`{3,}|~{3,})/.test(trimmed);
  },
  findEnd: (lines, startIndex) => {
    const startLine = lines[startIndex].trim();
    const match = startLine.match(/^(`{3,}|~{3,})/);
    if (!match) return startIndex;
    
    const fence = match[1];
    const fenceChar = fence[0];
    const fenceLen = fence.length;
    
    for (let i = startIndex + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const closeMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        return i;
      }
    }
    return lines.length - 1; // Unclosed, consume rest
  }
};

// Math block: $$
const mathBlockDetector: BlockDetector = {
  name: 'math',
  isStart: (lines, index) => lines[index].trim() === '$$',
  findEnd: (lines, startIndex) => {
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (lines[i].trim() === '$$') {
        return i;
      }
    }
    return lines.length - 1; // Unclosed
  }
};

// Front matter: --- at start of file
const frontMatterDetector: BlockDetector = {
  name: 'front-matter',
  isStart: (lines, index) => index === 0 && lines[index].trim() === '---',
  findEnd: (lines, startIndex) => {
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        return i;
      }
    }
    return lines.length - 1; // Unclosed
  }
};

// HTML block: starts with a recognized raw/block HTML tag, ends with empty line
const HTML_CONTAINER_TAGS = /^<(script|style|pre)(\s|>|\/|$)/i;
const HTML_BLOCK_TAGS = /^<(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(\s|>|\/|$)/i;
const HTML_RAW_START = /^<(!--|!DOCTYPE|\?|!\[CDATA\[)/i;

// CommonMark HTML block kinds 2-5 end at a closing marker, NOT at a blank line,
// so a comment such as `<!--\n\nfoo\n\n-->` is a single block.
const HTML_RAW_END_MARKERS: Array<{ start: RegExp; end: string }> = [
  { start: /^<!--/, end: '-->' },
  { start: /^<\?/, end: '?>' },
  { start: /^<!\[CDATA\[/i, end: ']]>' },
  { start: /^<!DOCTYPE/i, end: '>' },
];

/**
 * If `line` opens a raw HTML block (comment, PI, CDATA, doctype), return the
 * index of the line containing its closing marker (or the last line when it is
 * never closed). Returns null for any other line.
 */
function findRawHtmlEnd(lines: string[], startIndex: number): number | null {
  const first = lines[startIndex].trim();
  const kind = HTML_RAW_END_MARKERS.find((k) => k.start.test(first));
  if (!kind) return null;

  // The closing marker may be on the opening line, but must come after the opener.
  const opener = first.match(kind.start)![0];
  const openerPos = lines[startIndex].indexOf(opener) + opener.length;
  if (lines[startIndex].indexOf(kind.end, openerPos) !== -1) return startIndex;

  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].includes(kind.end)) return i;
  }
  return lines.length - 1;
}

function getHtmlContainerTagName(line: string): string | null {
  const match = line.trim().match(HTML_CONTAINER_TAGS);
  return match ? match[1].toLowerCase() : null;
}

function isHtmlBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return HTML_CONTAINER_TAGS.test(trimmed) || HTML_BLOCK_TAGS.test(trimmed) || HTML_RAW_START.test(trimmed);
}

function findContiguousHtmlEnd(lines: string[], startIndex: number): number {
  let endIndex = startIndex;

  while (endIndex + 1 < lines.length && isHtmlBlockStart(lines[endIndex + 1])) {
    const nextStart = endIndex + 1;
    const nextContainerTag = getHtmlContainerTagName(lines[nextStart]);

    if (nextContainerTag) {
      const closingTagRegex = new RegExp(`</${nextContainerTag}>`, 'i');
      let nextEnd = nextStart;
      for (; nextEnd < lines.length; nextEnd++) {
        if (closingTagRegex.test(lines[nextEnd])) {
          break;
        }
      }
      endIndex = nextEnd < lines.length ? nextEnd : lines.length - 1;
      continue;
    }

    const rawEnd = findRawHtmlEnd(lines, nextStart);
    if (rawEnd !== null) {
      endIndex = rawEnd;
      continue;
    }

    for (let nextEnd = nextStart + 1; nextEnd < lines.length; nextEnd++) {
      if (lines[nextEnd].trim() === '') {
        endIndex = nextEnd;
        return endIndex;
      }
      if (isHtmlBlockStart(lines[nextEnd])) {
        endIndex = nextEnd - 1;
        break;
      }
      if (nextEnd === lines.length - 1) {
        endIndex = nextEnd;
      }
    }

    if (endIndex < nextStart) {
      endIndex = nextStart;
    }

    if (endIndex === nextStart) {
      continue;
    }
  }

  return endIndex;
}

const htmlBlockDetector: BlockDetector = {
  name: 'html',
  isStart: (lines, index) => {
    return isHtmlBlockStart(lines[index]);
  },
  findEnd: (lines, startIndex) => {
    const containerTag = getHtmlContainerTagName(lines[startIndex]);
    if (containerTag) {
      const closingTagRegex = new RegExp(`</${containerTag}>`, 'i');
      let endIndex = startIndex;
      for (; endIndex < lines.length; endIndex++) {
        if (closingTagRegex.test(lines[endIndex])) {
          break;
        }
      }
      if (endIndex >= lines.length) {
        endIndex = lines.length - 1;
      }
      endIndex = findContiguousHtmlEnd(lines, endIndex);
      if (endIndex + 1 < lines.length && lines[endIndex + 1].trim() === '') {
        return endIndex + 1;
      }
      return endIndex;
    }

    // Raw HTML blocks (comments etc.) end at their closing marker
    const rawEnd = findRawHtmlEnd(lines, startIndex);
    if (rawEnd !== null) {
      const contiguousEnd = findContiguousHtmlEnd(lines, rawEnd);
      if (contiguousEnd + 1 < lines.length && lines[contiguousEnd + 1].trim() === '') {
        return contiguousEnd + 1; // Include the empty line
      }
      return contiguousEnd;
    }

    // HTML block ends at empty line or EOF
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        return i; // Include the empty line
      }
    }
    return lines.length - 1;
  }
};

// Table: starts with |
const tableDetector: BlockDetector = {
  name: 'table',
  isStart: (lines, index) => lines[index].trim().startsWith('|'),
  findEnd: (lines, startIndex) => {
    let i = startIndex;
    while (i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1].trim();
      if (nextTrimmed === '' || !nextTrimmed.startsWith('|')) {
        break;
      }
      i++;
    }
    return i;
  }
};

// Blockquote: starts with >
const blockquoteDetector: BlockDetector = {
  name: 'blockquote',
  isStart: (lines, index) => lines[index].trim().startsWith('>'),
  findEnd: (lines, startIndex) => {
    let i = startIndex;
    while (i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1].trim();
      // Continue if next line is also blockquote or empty (lazy continuation)
      if (nextTrimmed.startsWith('>')) {
        i++;
      } else if (nextTrimmed === '' && i + 2 < lines.length && lines[i + 2].trim().startsWith('>')) {
        // Empty line followed by blockquote - include empty line
        i++;
      } else {
        break;
      }
    }
    return i;
  }
};

// List: starts with -, *, +, •, ◦, ▪, ▸, ►, ○, ●, or 1.
// Also supports Unicode bullets and multiple space indentation
const LIST_ITEM_REGEX = /^(\s*)(?:[-*+•◦▪▸►○●]|\d+\.)\s/;

// Check if line is a list item (handles both standard and Unicode bullets)
function isListItem(line: string): boolean {
  return LIST_ITEM_REGEX.test(line);
}

// Check if line is indented content (continuation of list item)
// Supports both standard (2 spaces/tab) and extended (multiple spaces) indentation
function isIndentedContent(line: string): boolean {
  // Standard indentation: 2+ spaces or tab
  if (line.startsWith('  ') || line.startsWith('\t')) return true;
  // Extended: line starts with spaces and has non-space content
  const match = line.match(/^(\s+)\S/);
  return match !== null && match[1].length >= 2;
}

// Check if line could be a list continuation (not a new block type)
function isListContinuation(line: string, lines: string[], index: number): boolean {
  const trimmed = line.trim();
  
  // Empty line is not a continuation (handled separately)
  if (trimmed === '') return false;
  
  // Another list item continues the list
  if (isListItem(line)) return true;
  
  // Indented content continues the list
  if (isIndentedContent(line)) return true;
  
  // Check if this looks like a new block (heading, code fence, etc.)
  if (/^#{1,6}\s/.test(trimmed)) return false;
  if (/^(`{3,}|~{3,})/.test(trimmed)) return false;
  if (trimmed === '$$') return false;
  if (trimmed.startsWith('|')) return false;
  if (trimmed.startsWith('>')) return false;
  
  // Plain text that doesn't start with indentation - check context
  // If previous line was a list item with bullet, this might be a description line
  // Also check if there's another list item coming up (loose list pattern)
  const prevLine = lines[index - 1];
  if (prevLine && isListItem(prevLine)) {
    // This looks like a loose list item description
    return true;
  }
  
  // Check if this plain text is between list items (continuation of loose list)
  // Look back to find if we're still within a list context
  for (let i = index - 1; i >= 0 && i >= index - 5; i--) {
    const checkLine = lines[i];
    if (checkLine.trim() === '') continue; // Skip empty lines
    if (isListItem(checkLine)) {
      // We found a list item within 5 lines back, check if there's a list item ahead
      for (let j = index + 1; j < lines.length && j <= index + 3; j++) {
        if (lines[j].trim() === '') continue;
        if (isListItem(lines[j])) {
          // There's a list item ahead, this line is part of the list
          return true;
        }
        break; // Found a non-empty, non-list line
      }
      break;
    }
    break; // Found a non-list item
  }
  
  return false;
}

const listDetector: BlockDetector = {
  name: 'list',
  isStart: (lines, index) => isListItem(lines[index]),
  findEnd: (lines, startIndex) => {
    const startMatch = lines[startIndex].match(LIST_ITEM_REGEX);
    if (!startMatch) return startIndex;
    
    let i = startIndex;
    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const nextTrimmed = nextLine.trim();
      
      // Continue if:
      // 1. Another list item (standard or Unicode bullet)
      // 2. Indented content (continuation)
      // 3. Plain text continuation after a list item
      // 4. Empty line followed by list item or indented content
      if (isListContinuation(nextLine, lines, i + 1)) {
        i++;
      } else if (nextTrimmed === '') {
        // Check if list continues after empty line
        if (i + 2 < lines.length) {
          const afterEmpty = lines[i + 2];
          if (isListItem(afterEmpty) || isIndentedContent(afterEmpty)) {
            i++; // Include empty line
          } else {
            break;
          }
        } else {
          break;
        }
      } else {
        break;
      }
    }
    return i;
  }
};

// Indented code block: 4 spaces or tab
const indentedCodeDetector: BlockDetector = {
  name: 'indented-code',
  isStart: (lines, index) => {
    const line = lines[index];
    return (line.startsWith('    ') || line.startsWith('\t')) && line.trim() !== '';
  },
  findEnd: (lines, startIndex) => {
    let i = startIndex;
    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const isIndented = nextLine.startsWith('    ') || nextLine.startsWith('\t');
      const isEmpty = nextLine.trim() === '';
      
      if (isIndented) {
        i++;
      } else if (isEmpty) {
        // Check if code continues after empty line
        if (i + 2 < lines.length) {
          const afterEmpty = lines[i + 2];
          if (afterEmpty.startsWith('    ') || afterEmpty.startsWith('\t')) {
            i++; // Include empty line
          } else {
            break;
          }
        } else {
          break;
        }
      } else {
        break;
      }
    }
    return i;
  }
};

// Heading: starts with #
const headingDetector: BlockDetector = {
  name: 'heading',
  isStart: (lines, index) => lines[index].trim().startsWith('#'),
  findEnd: (lines, startIndex) => startIndex // Single line
};

// Priority order: higher priority detectors are checked first
const DETECTORS: BlockDetector[] = [
  frontMatterDetector,  // Must be first (only at line 0)
  fencedCodeDetector,   // Fenced code has priority
  mathBlockDetector,    // Math blocks
  htmlBlockDetector,    // HTML blocks
  tableDetector,        // Tables
  blockquoteDetector,   // Blockquotes
  listDetector,         // Lists
  indentedCodeDetector, // Indented code (lower priority than lists)
  headingDetector,      // Headings
];

/**
 * Split markdown into semantic blocks with source line numbers.
 */
export function splitMarkdownIntoBlocksWithLines(markdown: string): BlockWithLine[] {
  const lines = markdown.split('\n');
  const blocks: BlockWithLine[] = [];
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Skip leading empty lines
    if (trimmed === '') {
      i++;
      continue;
    }
    
    // Try each detector
    let matched = false;
    for (const detector of DETECTORS) {
      if (detector.isStart(lines, i)) {
        const endIndex = detector.findEnd(lines, i);
        const blockLines = lines.slice(i, endIndex + 1);
        blocks.push({
          content: blockLines.join('\n'),
          startLine: i
        });
        i = endIndex + 1;
        matched = true;
        break;
      }
    }
    
    // No special block detected - collect paragraph
    if (!matched) {
      const paragraphStart = i;
      const paragraphLines: string[] = [];
      
      while (i < lines.length) {
        const currentLine = lines[i];
        const currentTrimmed = currentLine.trim();
        
        // Empty line ends paragraph
        if (currentTrimmed === '') {
          break;
        }
        
        // Check if a special block starts - end paragraph before it
        let specialBlockStarts = false;
        for (const detector of DETECTORS) {
          if (detector.isStart(lines, i) && paragraphLines.length > 0) {
            specialBlockStarts = true;
            break;
          }
        }
        
        if (specialBlockStarts) {
          break;
        }
        
        paragraphLines.push(currentLine);
        i++;
      }
      
      if (paragraphLines.length > 0) {
        blocks.push({
          content: paragraphLines.join('\n'),
          startLine: paragraphStart
        });
      }
    }
  }
  
  return blocks;
}

/**
 * Split markdown into semantic blocks.
 */
export function splitMarkdownIntoBlocks(markdown: string): string[] {
  return splitMarkdownIntoBlocksWithLines(markdown).map(b => b.content);
}

export function hasHeadingBlocks(blocks: readonly BlockWithContent[]): boolean {
  return blocks.some((block) => {
    const firstNonEmptyLine = block.content
      .split('\n')
      .find((line) => line.trim().length > 0);

    return firstNonEmptyLine !== undefined && /^#{1,6}(?:\s|$)/.test(firstNonEmptyLine.trim());
  });
}
