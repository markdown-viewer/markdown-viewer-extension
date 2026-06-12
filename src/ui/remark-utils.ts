/**
 * Pure utility functions for Remark Mode.
 *
 * These functions have no DOM, chrome.*, or side-effect dependencies
 * so they can be imported directly in unit tests.
 */

// ─── Types (re-exported for test convenience) ────────────────────────────────

export type RemarkColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface RemarkAnnotation {
  id: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  note: string;
  color: RemarkColor;
  timestamp: number;
  blockId?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const COLOR_MAP: Record<RemarkColor, { emoji: string; bg: string; border: string }> = {
  yellow: { emoji: '🟡', bg: 'rgba(250, 204, 21, 0.2)', border: 'rgba(250, 204, 21, 0.6)' },
  green:  { emoji: '🟢', bg: 'rgba(74, 222, 128, 0.2)', border: 'rgba(74, 222, 128, 0.6)' },
  blue:   { emoji: '🔵', bg: 'rgba(96, 165, 250, 0.2)', border: 'rgba(96, 165, 250, 0.6)' },
  pink:   { emoji: '🩷', bg: 'rgba(244, 114, 182, 0.2)', border: 'rgba(244, 114, 182, 0.6)' },
};

export const COLOR_LABELS: Record<RemarkColor, string> = {
  yellow: 'Suggestion',
  green: 'Keep',
  blue: 'Question',
  pink: 'Concern',
};

export interface RemarkExportLabels {
  intro?: string;
  noteLabel?: string;
  colorLabels?: Partial<Record<RemarkColor, string>>;
}

// Tags that should not be annotatable (images, charts, media)
export const SKIP_ANNOTATION_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME']);

// ─── Pure functions ──────────────────────────────────────────────────────────

/**
 * Width-aware text truncation. CJK characters and fullwidth punctuation count
 * as 2 units of width; everything else counts as 1. When the text exceeds
 * `maxWidth`, it is cut and an ellipsis `…` (width 1) is appended.
 */
export function truncate(str: string, maxWidth: number): string {
  if (!str) return str;
  // First pass: measure total width
  let totalWidth = 0;
  for (const ch of str) {
    totalWidth += /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1;
  }
  if (totalWidth <= maxWidth) return str; // fits, no truncation needed

  // Needs truncation: cut to (maxWidth - 1) and append ellipsis
  const limit = maxWidth - 1;
  let width = 0;
  let cutIndex = 0;
  for (const ch of str) {
    const w = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1;
    if (width + w > limit) {
      return str.slice(0, cutIndex) + '…';
    }
    width += w;
    cutIndex += ch.length;
  }
  return str.slice(0, cutIndex) + '…';
}

/** Format a line reference: `L5` for single line, `L5–L10` for a range. */
export function formatLineRef(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}–L${endLine}`;
}

/** Read the line range of a rendered markdown block element. */
export function getBlockRange(el: HTMLElement): { start: number; end: number } {
  const start = Number(el.getAttribute('data-line')) || 0;
  const count = Number(el.getAttribute('data-line-count')) || 1;
  return { start, end: start + count - 1 };
}

/** Check whether two inclusive integer ranges [aS, aE] and [bS, bE] overlap. */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

// ─── Sub-block line narrowing helpers ───────────────────────────────────────
// Exported here (not in remark-mode.ts) so unit tests can import without DOM globals.

const TEXT_NODE = 3; // Node.TEXT_NODE constant

function toElement(node: Node): Element | null {
  return ('tagName' in node) ? (node as unknown as Element) : (node as Node).parentElement;
}

/**
 * Table row → exact markdown line.
 * header row = blockStart, separator = blockStart+1, tbody[i] = blockStart+2+i
 */
export function findTrLineInBlock(node: Node, blockEl: Element): number | null {
  let el: Element | null = toElement(node);
  const blockStart = Number(blockEl.getAttribute('data-line')) || 0;
  while (el && el !== blockEl) {
    if ((el as Element).tagName === 'TR') {
      const section = el.parentElement;
      if (!section) return null;
      if (section.tagName === 'THEAD') return blockStart;
      if (section.tagName === 'TBODY') {
        const rowIdx = Array.from(section.children).indexOf(el as HTMLElement);
        return rowIdx >= 0 ? blockStart + 2 + rowIdx : null;
      }
      return null;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * List item → approximate markdown line.
 * Uses document-order <li> index within the block as the line offset.
 * Works for flat and nested lists; may be off by ≤1 for multi-line items.
 */
export function findLiLineInBlock(node: Node, blockEl: Element): number | null {
  let el: Element | null = toElement(node);
  const blockStart = Number(blockEl.getAttribute('data-line')) || 0;
  while (el && el !== blockEl) {
    if (el.tagName === 'LI') {
      const allLis = Array.from(blockEl.querySelectorAll('li'));
      const idx = allLis.indexOf(el as HTMLElement);
      return idx >= 0 ? blockStart + idx : null;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Code block → approximate markdown line.
 * Walks text nodes inside <pre> counting newlines before the selection point.
 * blockStart = opening fence line; code body starts at blockStart+1.
 */
export function findCodeLineInBlock(node: Node, offset: number, blockEl: Element): number | null {
  const pre = (blockEl.tagName === 'PRE' ? blockEl : blockEl.querySelector('pre')) as Node | null;
  if (!pre) return null;
  const blockStart = Number(blockEl.getAttribute('data-line')) || 0;

  let newlines = 0;
  let found = false;

  const walk = (n: Node): void => {
    if (found) return;
    if (n === node) {
      newlines += ((n.textContent || '').slice(0, offset).match(/\n/g) || []).length;
      found = true;
      return;
    }
    if (n.nodeType === TEXT_NODE) {
      newlines += (n.textContent || '').split('\n').length - 1;
    }
    for (const child of n.childNodes) {
      if (found) break;
      walk(child);
    }
  };
  walk(pre);
  // blockStart = ``` fence line; first code line = blockStart+1
  return found ? blockStart + 1 + newlines : null;
}

/**
 * Try to narrow a selection within a block to a specific line range.
 * Tries table rows → list items → code lines, in that order.
 * Returns null when the block type has no useful sub-structure.
 */
export function narrowLineInBlock(
  startNode: Node, startOffset: number,
  endNode: Node, endOffset: number,
  blockEl: Element,
): { startLine: number; endLine: number } | null {
  // 1. Table row (exact)
  const startTr = findTrLineInBlock(startNode, blockEl);
  if (startTr !== null) {
    const endTr = findTrLineInBlock(endNode, blockEl);
    return { startLine: startTr, endLine: endTr ?? startTr };
  }
  // 2. List item (approximate — LI document order within block)
  const startLi = findLiLineInBlock(startNode, blockEl);
  if (startLi !== null) {
    const endLi = findLiLineInBlock(endNode, blockEl);
    return { startLine: startLi, endLine: endLi ?? startLi };
  }
  // 3. Code block (approximate — newline count in pre/code text)
  const startCode = findCodeLineInBlock(startNode, startOffset, blockEl);
  if (startCode !== null) {
    const endCode = findCodeLineInBlock(endNode, endOffset, blockEl);
    return { startLine: startCode, endLine: endCode ?? startCode };
  }
  return null;
}

/** Check if a block element is a media/image block that should not be annotatable. */
export function isMediaBlock(el: HTMLElement): boolean {
  if (SKIP_ANNOTATION_TAGS.has(el.tagName)) return true;
  return !!(el.querySelector('img, svg, canvas, video, figure, picture'));
}

/**
 * Pure-function version of export formatting.
 * Takes annotations + filePath, returns structured prompt text.
 */
export function formatExportText(
  annotations: readonly RemarkAnnotation[],
  filePath: string,
  labels: RemarkExportLabels = {},
): string {
  if (annotations.length === 0) return '';

  const intro = labels.intro || `I reviewed **${filePath}** and have the following feedback:`;
  const noteLabel = labels.noteLabel || 'Note';
  const colorLabels = { ...COLOR_LABELS, ...(labels.colorLabels || {}) };

  const sorted = [...annotations].sort((a, b) => a.startLine - b.startLine);

  const groups: { key: string; lineRef: string; anns: RemarkAnnotation[] }[] = [];
  for (const ann of sorted) {
    const key = `${ann.startLine}-${ann.endLine}`;
    const lineRef = formatLineRef(ann.startLine, ann.endLine);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.anns.push(ann);
    } else {
      groups.push({ key, lineRef, anns: [ann] });
    }
  }

  const lines: string[] = [];
  lines.push(`${intro}\n`);

  for (let i = 0; i < groups.length; i++) {
    const { lineRef, anns } = groups[i];
    for (let j = 0; j < anns.length; j++) {
      const ann = anns[j];
      const label = colorLabels[ann.color];
      const quote = truncate(ann.selectedText, 120);

      if (j === 0) {
        let line = `${i + 1}. [${COLOR_MAP[ann.color].emoji} ${label}] ${lineRef}: "${quote}"`;
        if (ann.note) line += `\n   ${noteLabel}: "${ann.note}"`;
        lines.push(line);
      } else {
        let line = `   [${COLOR_MAP[ann.color].emoji} ${label}] "${quote}"`;
        if (ann.note) line += `\n   ${noteLabel}: "${ann.note}"`;
        lines.push(line);
      }
    }
  }

  return lines.join('\n');
}

// ─── Config Style Generation ─────────────────────────────────────────────────

export type HighlightStyle = 'background' | 'underline' | 'wavy' | 'border';

export const BG_COLORS: Record<RemarkColor, string> = {
  yellow: 'rgba(255, 212, 0, 0.25)',
  green: 'rgba(46, 160, 67, 0.18)',
  blue: 'rgba(9, 105, 218, 0.15)',
  pink: 'rgba(219, 97, 162, 0.18)',
};

export const LINE_COLORS: Record<RemarkColor, string> = {
  yellow: 'rgba(202, 138, 4, 0.8)',
  green: 'rgba(22, 128, 50, 0.75)',
  blue: 'rgba(9, 80, 180, 0.7)',
  pink: 'rgba(190, 60, 130, 0.75)',
};

/** Generate CSS rules for mark elements based on highlight style config */
export function generateHighlightCSS(style: HighlightStyle): string {
  if (style === 'background') {
    return Object.entries(BG_COLORS).map(([c, rgba]) =>
      `mark.remark-ann-${c} { background-color: ${rgba} !important; text-decoration: none !important; border: none !important; }`
    ).join('\n');
  } else if (style === 'underline') {
    return Object.entries(LINE_COLORS).map(([c, rgba]) =>
      `mark.remark-ann-${c} { background-color: transparent !important; text-decoration: underline 2px ${rgba} !important; text-underline-offset: 3px; border: none !important; }`
    ).join('\n');
  } else if (style === 'wavy') {
    return Object.entries(LINE_COLORS).map(([c, rgba]) =>
      `mark.remark-ann-${c} { background-color: transparent !important; text-decoration: wavy underline ${rgba} !important; text-underline-offset: 2px; border: none !important; }`
    ).join('\n');
  } else if (style === 'border') {
    return Object.entries(LINE_COLORS).map(([c, rgba]) =>
      `mark.remark-ann-${c} { background-color: transparent !important; text-decoration: none !important; border: 1.5px solid ${rgba} !important; border-radius: 3px; padding: 0 2px; }`
    ).join('\n');
  }
  return '';
}

// ─── Sentence Boundary Detection ─────────────────────────────────────────────

/** Regex for sentence-ending punctuation */
export const SENTENCE_END_RE = /[。.?!？！\n]/;

/**
 * Find sentence boundaries around a given offset in text.
 * Returns [start, end) indices of the sentence containing the offset.
 */
export function findSentenceBounds(text: string, offset: number): { start: number; end: number } {
  let start = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (SENTENCE_END_RE.test(text[i])) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = offset; i < text.length; i++) {
    if (SENTENCE_END_RE.test(text[i])) { end = i + 1; break; }
  }
  return { start, end };
}

// ─── Text Node Offset Calculation ────────────────────────────────────────────

export interface TextNodeOffset {
  nodeIndex: number;
  localOffset: number;
}

/**
 * Given an array of text node lengths, find which node contains a given
 * global character offset. Returns nodeIndex and localOffset within that node.
 * Returns null if offset is beyond total length.
 */
export function locateOffsetInNodes(
  nodeLengths: number[],
  globalOffset: number
): TextNodeOffset | null {
  let charCount = 0;
  for (let i = 0; i < nodeLengths.length; i++) {
    if (charCount + nodeLengths[i] > globalOffset) {
      return { nodeIndex: i, localOffset: globalOffset - charCount };
    }
    charCount += nodeLengths[i];
  }
  // Exact end of last node
  if (charCount === globalOffset && nodeLengths.length > 0) {
    const last = nodeLengths.length - 1;
    return { nodeIndex: last, localOffset: nodeLengths[last] };
  }
  return null;
}

/**
 * Find start and end positions for a substring within concatenated text nodes.
 * Used by findTextRange to map text.indexOf() result to node-level offsets.
 */
export function locateSubstringInNodes(
  nodeLengths: number[],
  substringStart: number,
  substringLength: number
): { start: TextNodeOffset; end: TextNodeOffset } | null {
  const startPos = locateOffsetInNodes(nodeLengths, substringStart);
  const endPos = locateOffsetInNodes(nodeLengths, substringStart + substringLength);
  if (!startPos || !endPos) return null;
  return { start: startPos, end: endPos };
}
