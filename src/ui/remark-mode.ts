import { getCurrentDocumentUrl } from '../core/document-utils';
import { escapeHtml } from '../core/markdown-processor';
import type { TranslateFunction } from '../types/core';
import {
  truncate, formatLineRef, getBlockRange, rangesOverlap, isMediaBlock,
  formatExportText,
  findTrLineInBlock, findLiLineInBlock, findCodeLineInBlock, narrowLineInBlock,
  generateHighlightCSS, findSentenceBounds, SENTENCE_END_RE,
  COLOR_MAP, COLOR_LABELS, SKIP_ANNOTATION_TAGS,
  type RemarkColor, type RemarkAnnotation, type HighlightStyle,
} from './remark-utils';

/**
 * Remark Mode — Block-level annotation for rendered Markdown
 *
 * Features:
 * - Toolbar toggle to enter/exit Remark Mode
 * - Text selection → popup with color picker and note input
 * - Block-level highlights using data-line attributes
 * - Right sidebar listing all annotations with delete
 * - Hover tooltip showing annotation note on highlighted blocks
 * - Persistence via chrome.storage.local (keyed by page URL)
 * - Clipboard export in structured prompt format
 */

// ─── Types (re-exported from remark-utils for consumers) ─────────────────────

export type { RemarkColor, RemarkAnnotation } from './remark-utils';

export interface RemarkModeController {
  isActive(): boolean;
  enter(): void;
  exit(): void;
  getAnnotations(): RemarkAnnotation[];
  removeAnnotation(id: string): void;
  updateAnnotationNote(id: string, note: string): void;
  exportToClipboard(): Promise<{ ok: boolean; reason?: string }>;
  loadAnnotations(): Promise<void>;
  dispose(): void;
}

export interface RemarkModeOptions {
  /** The container holding rendered markdown blocks with data-line attrs */
  getContainer(): HTMLElement | null;
  /** Get raw markdown source for export context */
  getRawMarkdown(): string;
  /** Active translation function from the viewer runtime */
  translate?: TranslateFunction;
  /** Callback when mode changes */
  onModeChange?(active: boolean): void;
  /** Callback when annotation count changes (for badge on toolbar button) */
  onAnnotationCountChange?(count: number): void;
  /** Storage key for persistence (typically the page URL) */
  getStorageKey?(): string;
}

// ─── i18n helper ─────────────────────────────────────────────────────────────

function defaultTranslate(key: string, substitutions?: string | string[]): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
      const msg = chrome.i18n.getMessage(key, substitutions);
      if (msg) return msg;
    }
  } catch {
    // Non-extension context
  }
  return key;
}

// ─── Controller ──────────────────────────────────────────────────────────────

export function createRemarkMode(options: RemarkModeOptions): RemarkModeController {
  const { getContainer, getRawMarkdown, onModeChange, onAnnotationCountChange, getStorageKey } = options;
  const translate = options.translate || defaultTranslate;

  function t(key: string, fallback: string): string {
    const translated = translate(key);
    return !translated || translated === key ? fallback : translated;
  }

  function tf(key: string, fallback: string, substitutions: string | string[]): string {
    const translated = translate(key, substitutions);
    if (!translated || translated === key) {
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return values.reduce((result, value, index) => result.split(`{${index}}`).join(value), fallback);
    }
    return translated;
  }

  // ─── Config (persisted via chrome.storage.local) ────────────────────────────
  const CONFIG_STORAGE_KEY = 'remarkConfig';
  const CONFIG_DEFAULTS = {
    autoDeleteEmpty: true,
    autoDeleteDelay: 3000,    // ms wait after blur before auto-delete sequence starts
    closeAfterCopy: false,    // close file/tab after export
    highlightStyle: 'background' as 'background' | 'underline' | 'wavy' | 'border',
    defaultColor: 'yellow' as RemarkColor,
    fontSize: 13,             // sidebar font size 12-16
  };
  type RemarkConfig = typeof CONFIG_DEFAULTS;
  const config: RemarkConfig = { ...CONFIG_DEFAULTS };

  async function loadConfig(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const data = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
        if (data[CONFIG_STORAGE_KEY]) {
          Object.assign(config, data[CONFIG_STORAGE_KEY]);
        }
      } else {
        const stored = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (stored) Object.assign(config, JSON.parse(stored));
      }
    } catch { /* storage unavailable — use defaults */ }
  }

  function saveConfig(): void {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        void chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: { ...config } });
      } else {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
      }
    } catch { /* ignore */ }
  }

  function resetConfig(): void {
    Object.assign(config, CONFIG_DEFAULTS);
    saveConfig();
  }

  // Listen for config changes from popup settings page
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[CONFIG_STORAGE_KEY]?.newValue) {
        Object.assign(config, changes[CONFIG_STORAGE_KEY].newValue);
        applyConfigStyles();
        if (active) renderHighlights();
      }
    });
  }

  /** Apply config-driven CSS variables to sidebar + highlights */
  function applyConfigStyles(): void {
    if (sidebarEl) {
      sidebarEl.style.setProperty('--remark-font-size', `${config.fontSize}px`);
    }
    // Dynamic highlight style sheet
    let dynStyle = document.getElementById('remark-dynamic-styles') as HTMLStyleElement;
    if (!dynStyle) {
      dynStyle = document.createElement('style');
      dynStyle.id = 'remark-dynamic-styles';
      document.head.appendChild(dynStyle);
    }
    dynStyle.textContent = generateHighlightCSS(config.highlightStyle as HighlightStyle);
  }

  let active = false;
  let annotations: RemarkAnnotation[] = [];
  let softDeletedIds: Set<string> = new Set(); // IDs in 5s undo window — excluded from export
  let abortController: AbortController | null = null;
  let sidebarEl: HTMLElement | null = null;
  let tooltipEl: HTMLElement | null = null;
  let pendingFocusId: string | null = null; // for focus chain across re-renders
  let sidebarHideCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let sidebarHideCleanupToken = 0;
  const autoDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelPendingSidebarCleanup(): void {
    sidebarHideCleanupToken += 1;
    if (sidebarHideCleanupTimer !== null) {
      clearTimeout(sidebarHideCleanupTimer);
      sidebarHideCleanupTimer = null;
    }
  }

  function getColorLabel(color: RemarkColor): string {
    switch (color) {
      case 'yellow':
        return t('remark_color_yellow', COLOR_LABELS.yellow);
      case 'green':
        return t('remark_color_green', COLOR_LABELS.green);
      case 'blue':
        return t('remark_color_blue', COLOR_LABELS.blue);
      case 'pink':
        return t('remark_color_pink', COLOR_LABELS.pink);
    }
  }

  function isActive(): boolean {
    return active;
  }

  function enter(): void {
    if (active) return;
    active = true;
    abortController = new AbortController();
    const signal = abortController.signal;

    const container = getContainer();
    if (container) {
      container.classList.add('remark-mode-active');
      container.addEventListener('mouseup', handleSelection, { signal });
      container.addEventListener('mouseover', handleHover, { signal });
      container.addEventListener('mouseout', handleHoverOut, { signal });
    }

    // Clamp table selection to single cell — prevents cross-cell selection visually
    document.addEventListener('selectionchange', clampTableSelection, { signal });


    document.body.classList.add('remark-panel-open');
    injectStyles();

    // Load config before rendering so sidebar reflects persisted values
    void loadConfig().then(() => {
      if (!active) return; // exited during async load
      renderHighlights();
      showSidebar();
    });

    // Always schedule to catch streamed/async blocks that appear after enter().
    // Handles: container not yet in DOM, [data-line] not yet rendered, and
    // incremental streaming renders where only a partial DOM exists at enter() time.
    scheduleHighlightsAfterRender();

    onModeChange?.(true);
  }

  function exit(): void {
    if (!active) return;
    active = false;
    abortController?.abort();
    abortController = null;

    // Commit any pending deletes immediately on exit
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    if (undoQueue.length) { commitPendingDeletes(); }

    hideTooltip();
    onModeChange?.(false); // toolbar state changes immediately

    // Choreographed exit: fade marks, then clear
    const container = getContainer();
    if (container) {
      container.classList.remove('remark-mode-active');
      container.classList.add('remark-exiting');
      // Marks fade via CSS transition (120ms)
      setTimeout(() => {
        container.classList.remove('remark-exiting');
        clearMarks();
      }, 160);
    }
    hideSidebar();
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  function storageKey(): string {
    if (getStorageKey) return getStorageKey();
    // Normalize against the active document rather than the iframe URL, so
    // workspace mode keys by the current file path instead of viewer-embed.html.
    try {
      const url = new URL(getCurrentDocumentUrl());
      url.hash = '';
      url.search = '';
      return `rmk:${url.href}`;
    } catch {
      const { origin, pathname } = window.location;
      return `rmk:${origin}${pathname}`;
    }
  }

  async function saveAnnotations(): Promise<void> {
    try {
      const key = storageKey();
      // Exclude soft-deleted annotations (in undo window) from persistence
      const toSave = annotations.filter(a => !softDeletedIds.has(a.id));
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ [key]: toSave });
      } else {
        localStorage.setItem(key, JSON.stringify(toSave));
      }
    } catch {
      // Silently fail — annotations remain in-memory
    }
  }

  async function loadAnnotations(): Promise<void> {
    try {
      const key = storageKey();
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const result = await chrome.storage.local.get(key);
        if (result[key] && Array.isArray(result[key])) {
          annotations = result[key];
        }
      } else {
        const stored = localStorage.getItem(key);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) annotations = parsed;
        }
      }
    } catch {
      // Start with empty annotations
    }
    if (active) {
      renderHighlights();
      renderSidebarContent();
    } else {
      notifyCount();
      // If URL contains ?remarker=true, always auto-enter after DOM is ready
      if (typeof window !== 'undefined' && window.location.search.includes('remarker=true')) {
        enter();
      } else if (annotations.length > 0) {
        // Not auto-entering, but schedule highlights so badge renders after DOM is ready
        scheduleHighlightsAfterRender();
      }
    }
  }

  function scheduleHighlightsAfterRender(): void {
    // Watches for new [data-line] blocks being added to the container (streaming render).
    // Only reacts to additions of block elements, NOT to highlight spans added by
    // renderHighlights() itself — preventing infinite loops.
    // Debounces to coalesce burst renders; self-disconnects after the DOM stabilises.
    function watchContainer(container: Element): void {
      // Immediate render if blocks already exist.
      if (container.querySelector('[data-line]')) {
        if (active) { renderHighlights(); renderSidebarContent(); } else { notifyCount(); }
      }

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let stableTimer: ReturnType<typeof setTimeout> | null = null;
      const DEBOUNCE_MS = 150;
      const STABLE_MS = 3000;   // disconnect 3 s after the last new block arrives
      const MAX_MS = 15000;     // hard cap to avoid leaks on very large files

      const obs = new MutationObserver((mutations) => {
        // Only react when new [data-line] block elements are added, not when
        // renderHighlights() inserts its own highlight spans (no data-line attr).
        const hasNewBlock = mutations.some(m =>
          [...m.addedNodes].some(n =>
            n instanceof Element &&
            (n.hasAttribute('data-line') || n.querySelector('[data-line]') !== null)
          )
        );
        if (!hasNewBlock) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (active) { renderHighlights(); renderSidebarContent(); } else { notifyCount(); }
        }, DEBOUNCE_MS);

        // Reset the stability timer so we disconnect only after a quiet period.
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => obs.disconnect(), STABLE_MS);
      });

      obs.observe(container, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), MAX_MS);
    }

    const container = getContainer();
    if (container) {
      watchContainer(container);
      return;
    }

    // Container not yet in DOM (e.g., ?remarker=true fires before markdown renders).
    // Watch document.body until the container element appears.
    const bodyObs = new MutationObserver(() => {
      const c = getContainer();
      if (c) {
        bodyObs.disconnect();
        watchContainer(c);
      }
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Selection Handling ──────────────────────────────────────────────────

  /** Clamp selection to stay within a single table cell */
  function clampTableSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer instanceof HTMLElement
      ? range.startContainer : range.startContainer.parentElement;
    const startCell = startEl?.closest('td, th');
    if (!startCell) return; // Not in a table — no clamping needed
    const endEl = range.endContainer instanceof HTMLElement
      ? range.endContainer : range.endContainer.parentElement;
    const endCell = endEl?.closest('td, th');
    if (endCell === startCell) return; // Within same cell — OK
    // Selection crossed cell boundary — clamp to starting cell
    const clamped = document.createRange();
    clamped.setStart(range.startContainer, range.startOffset);
    clamped.setEnd(startCell, startCell.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(clamped);
  }

  function handleSelection(): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;

    const container = getContainer();
    if (!container) return;

    // Click-to-annotate: collapsed selection = click without drag
    if (sel.isCollapsed) {
      handleClickToAnnotate(sel, container);
      return;
    }

    let range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    // Table guard: if selection somehow crosses cell boundary, ignore
    const startNode = range.startContainer;
    const startEl = startNode instanceof HTMLElement ? startNode : startNode.parentElement;
    if (startEl?.closest('td, th')) {
      const endNode = range.endContainer;
      const endEl = endNode instanceof HTMLElement ? endNode : endNode.parentElement;
      const startCell = startEl.closest('td, th');
      const endCell = endEl?.closest('td, th');
      if (startCell !== endCell) return; // Cross-cell — should not happen due to clamp
    }

    const selectedText = sel.toString().trim();
    if (!selectedText) return;

    const { startLine, endLine, blockId, startBlock } = findBlockRange(range, container);
    if (startLine < 0) return;

    // Skip media blocks (images, charts, diagrams)
    if (startBlock && isMediaBlock(startBlock)) return;

    // Deduplicate: if same text already annotated in same block, scroll to it
    const existing = annotations.find(a =>
      a.selectedText === selectedText && a.startLine === startLine && !softDeletedIds.has(a.id)
    );
    if (existing) {
      sel.removeAllRanges();
      onMarkClick(existing.id);
      return;
    }

    // Create annotation with precise mark from live Range
    createAndFocusSidebar(selectedText, startLine, endLine, range, blockId);
    sel.removeAllRanges();
  }

  function handleClickToAnnotate(sel: Selection, container: HTMLElement): void {
    const anchor = sel.anchorNode;
    if (!anchor || !container.contains(anchor)) return;

    // Don't trigger on mark clicks (handled by onMarkClick)
    const el = anchor instanceof HTMLElement ? anchor : anchor.parentElement;
    if (el?.closest('mark.remark-ann')) return;

    // Find block
    const block = findBlockAncestor(anchor, container);
    if (!block || isMediaBlock(block)) return;

    // For table clicks, narrow to the clicked cell
    const cell = el?.closest('td, th') as HTMLElement | null;
    const scope = cell || block;

    const fullText = scope.textContent || '';
    if (!fullText.trim()) return;

    // Find the sentence around the click offset
    const offset = sel.anchorOffset;
    // Walk text nodes to find global offset in scope
    let globalOffset = 0;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let found = false;
    while (walker.nextNode()) {
      if (walker.currentNode === anchor) {
        globalOffset += offset;
        found = true;
        break;
      }
      globalOffset += (walker.currentNode as Text).textContent!.length;
    }
    if (!found) globalOffset = 0;

    // Find sentence boundaries
    const bounds = findSentenceBounds(fullText, globalOffset);

    const sentenceText = fullText.slice(bounds.start, bounds.end).trim();
    if (!sentenceText) return;

    const startLine = Number(block.getAttribute('data-line')) || 0;
    const lineCount = Number(block.getAttribute('data-line-count')) || 1;
    const endLine = startLine + lineCount - 1;

    // Deduplicate
    const existing = annotations.find(a =>
      a.selectedText === sentenceText && a.startLine === startLine && !softDeletedIds.has(a.id)
    );
    if (existing) { onMarkClick(existing.id); return; }

    // Create range for the sentence text
    const range = findTextRange(scope, sentenceText);
    if (!range) return;

    createAndFocusSidebar(sentenceText, startLine, endLine, range,
      block.getAttribute('data-block-id') || undefined);
  }


  function findBlockRange(range: Range, container: HTMLElement): { startLine: number; endLine: number; blockId?: string; startBlock: HTMLElement | null } {
    const startBlock = findBlockAncestor(range.startContainer, container);
    const endBlock = findBlockAncestor(range.endContainer, container);

    if (!startBlock) return { startLine: -1, endLine: -1, startBlock: null };

    const startLine = Number(startBlock.getAttribute('data-line')) || 0;
    const startCount = Number(startBlock.getAttribute('data-line-count')) || 1;

    // Browser Range boundary quirk: when a selection ends exactly at the start of the
    // next sibling block (offset 0 of the next div.md-block), endContainer lands on that
    // next block rather than inside the current one.  Treat this as a single-block
    // selection ending at the end of startBlock.
    const isBoundaryEnd = endBlock && endBlock !== startBlock && range.endOffset === 0;

    if (!endBlock || endBlock === startBlock || isBoundaryEnd) {
      const narrow = narrowLineInBlock(range.startContainer, range.startOffset, range.endContainer, range.endOffset, startBlock);
      return {
        startLine: narrow?.startLine ?? startLine,
        endLine: narrow?.endLine ?? (startLine + startCount - 1),
        blockId: startBlock.getAttribute('data-block-id') || undefined,
        startBlock,
      };
    }

    const endLine = Number(endBlock.getAttribute('data-line')) || 0;
    const endCount = Number(endBlock.getAttribute('data-line-count')) || 1;

    // Cross-block selection: try to narrow each endpoint independently
    const startNarrow = narrowLineInBlock(range.startContainer, range.startOffset, range.startContainer, range.startOffset, startBlock);
    const endNarrow = narrowLineInBlock(range.endContainer, range.endOffset, range.endContainer, range.endOffset, endBlock);
    return {
      startLine: startNarrow?.startLine ?? startLine,
      endLine: endNarrow?.endLine ?? (endLine + endCount - 1),
      blockId: startBlock.getAttribute('data-block-id') || undefined,
      startBlock,
    };
  }




  function findBlockAncestor(node: Node, container: HTMLElement): HTMLElement | null {
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    while (el && el !== container) {
      if (el.hasAttribute('data-line') && el.hasAttribute('data-block-id')) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ─── Hover Tooltip ─────────────────────────────────────────────────────────

  function handleHover(e: Event): void {
    // Show tooltip when hovering over a marked annotation
    const mark = (e.target as HTMLElement).closest?.('mark.remark-ann') as HTMLElement | null;
    if (!mark) return;
    const annId = mark.dataset.annId;
    if (!annId) return;

    const ann = annotations.find(a => a.id === annId);
    if (!ann || !ann.note) return; // Only show tooltip if there's a note

    showTooltip(mark, [ann]);
  }

  function handleHoverOut(e: Event): void {
    const mark = (e.target as HTMLElement).closest?.('mark.remark-ann') as HTMLElement | null;
    if (!mark) {
      // Also handle moving away from tooltip itself
      const tooltip = (e.target as HTMLElement).closest?.('.remark-tooltip');
      if (!tooltip) return;
    }
    const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (related && (related.closest?.('.remark-tooltip') || related.closest?.('mark.remark-ann'))) {
      return;
    }
    hideTooltip();
  }

  function showTooltip(anchor: HTMLElement, anns: RemarkAnnotation[]): void {
    // Only show tooltip for annotations that have a note written
    const annsWithNote = anns.filter(a => a.note);
    if (annsWithNote.length === 0) return;

    hideTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'remark-tooltip';

    const items = annsWithNote.map(a => {
      return `<div class="remark-tooltip-item">${COLOR_MAP[a.color].emoji} ${escapeHtml(a.note)}</div>`;
    }).join('');

    tooltipEl.innerHTML = items;
    document.body.appendChild(tooltipEl);

    const rect = anchor.getBoundingClientRect();
    tooltipEl.style.top = `${rect.top - tooltipEl.offsetHeight - 6}px`;
    tooltipEl.style.left = `${rect.left}px`;

    // Keep in viewport
    if (tooltipEl.offsetTop < 4) {
      tooltipEl.style.top = `${rect.bottom + 6}px`;
    }

    tooltipEl.addEventListener('mouseleave', () => hideTooltip());
  }

  function hideTooltip(): void {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  // ─── Precise Mark Highlighting ───────────────────────────────────────────────

  /**
   * Find text within a DOM subtree and return a Range spanning it.
   * Skips existing <mark> elements to avoid double-wrapping.
   */
  function findTextRange(root: Element, text: string): Range | null {
    const full = root.textContent || '';
    const idx = full.indexOf(text);
    if (idx === -1) return null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;
    let node: Node | null;

    while ((node = walker.nextNode())) {
      // Skip text inside existing marks
      if ((node as Text).parentElement?.closest('mark.remark-ann')) continue;
      const len = (node as Text).textContent!.length;
      if (!startNode && charCount + len > idx) {
        startNode = node as Text;
        startOffset = idx - charCount;
      }
      if (charCount + len >= idx + text.length) {
        endNode = node as Text;
        endOffset = idx + text.length - charCount;
        break;
      }
      charCount += len;
    }

    if (!startNode || !endNode) return null;
    try {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    } catch { return null; }
  }

  /**
   * Collect text nodes within a Range, splitting at boundaries.
   * Skips table-structural whitespace nodes (children of tr/tbody/thead/table).
   */
  function getTextNodesInRange(range: Range): Array<{ node: Text; start: number; end: number }> {
    const nodes: Array<{ node: Text; start: number; end: number }> = [];
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
      root.nodeType === Node.TEXT_NODE ? root.parentNode! : root,
      NodeFilter.SHOW_TEXT
    );
    const TABLE_STRUCTURAL = new Set(['TR', 'TBODY', 'THEAD', 'TFOOT', 'TABLE']);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if ((node as Text).parentElement?.closest('mark.remark-ann')) continue;
      if (!range.intersectsNode(node)) continue;
      // Skip whitespace-only text nodes that are direct children of table structural elements
      const parentTag = (node as Text).parentElement?.tagName;
      if (parentTag && TABLE_STRUCTURAL.has(parentTag) && !(node as Text).textContent?.trim()) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : (node as Text).textContent!.length;
      if (start < end) nodes.push({ node: node as Text, start, end });
    }
    return nodes;
  }

  const BLOCK_TAGS = new Set(['LI', 'TD', 'TH', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'BLOCKQUOTE', 'PRE']);

  /** Check if a Range spans across block-level element boundaries (e.g., multiple <li>) */
  function rangeSpansBlockElements(range: Range): boolean {
    const startEl = range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement;
    const endEl = range.endContainer instanceof HTMLElement ? range.endContainer : range.endContainer.parentElement;
    if (!startEl || !endEl) return false;
    const startBlock = startEl.closest('li, td, th, p, pre');
    const endBlock = endEl.closest('li, td, th, p, pre');
    return !!(startBlock && endBlock && startBlock !== endBlock);
  }

  /**
   * Wrap a Range with <mark> elements. Returns the first mark, or null on failure.
   * Handles both simple (single text node) and complex (multi-node) cases.
   */
  function applyMark(range: Range, id: string, color: RemarkColor): HTMLElement | null {
    const cls = `remark-ann remark-ann-${color}`;

    // Detect if range spans block-level elements (li, td, p, etc.)
    // In that case, extractContents would rip block structure → go straight to per-node wrap
    const spansBlocks = rangeSpansBlockElements(range);

    // Strategy 1: extractContents (works when range is within a single inline context)
    if (!spansBlocks) {
      try {
        const contents = range.extractContents();
        const mark = document.createElement('mark');
        mark.className = cls;
        mark.dataset.annId = id;
        mark.addEventListener('click', (e) => { e.stopPropagation(); onMarkClick(id); });
        mark.appendChild(contents);
        range.insertNode(mark);
        return mark;
      } catch {
        // Falls through to multi-node wrap
      }
    }

    // Strategy 2: Wrap each text node independently
    const textNodes = getTextNodesInRange(range);
    let first: HTMLElement | null = null;
    for (const { node, start, end } of textNodes) {
      try {
        const r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, end);
        const mark = document.createElement('mark');
        mark.className = cls;
        mark.dataset.annId = id;
        mark.dataset.annSeq = first ? 'cont' : 'first';
        mark.addEventListener('click', (e) => { e.stopPropagation(); onMarkClick(id); });
        r.surroundContents(mark);
        if (!first) first = mark;
      } catch {
        // Skip nodes that can't be wrapped
      }
    }
    return first;
  }

  /**
   * Remove all <mark> elements, preserving their content.
   */
  function clearMarks(): void {
    const container = getContainer();
    if (!container) return;
    container.querySelectorAll('mark.remark-ann').forEach(mark => {
      const parent = mark.parentNode!;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });
    // Normalize text nodes that were split by mark insertion
    container.normalize();
  }

  /**
   * Restore marks for all annotations by searching their selectedText in the DOM.
   */
  function restoreMarks(): void {
    const container = getContainer();
    if (!container) return;

    const visibleAnnotations = annotations.filter(a => !softDeletedIds.has(a.id));
    for (const ann of visibleAnnotations) {
      // Find the block this annotation belongs to
      const blocks = container.querySelectorAll<HTMLElement>('[data-line]');
      let marked = false;
      for (const block of blocks) {
        const { start: blockLine, end: blockEnd } = getBlockRange(block);
        if (!rangesOverlap(blockLine, blockEnd, ann.startLine, ann.endLine)) continue;

        const range = findTextRange(block, ann.selectedText);
        if (range) {
          applyMark(range, ann.id, ann.color);
          marked = true;
          break;
        }
      }
      // If text not found (document changed), annotation is "orphaned"
      // It still appears in sidebar with ⚠️ but no inline mark
      if (!marked) {
        // Tag for sidebar display
        (ann as RemarkAnnotation & { _orphaned?: boolean })._orphaned = true;
      }
    }
  }

  /**
   * Click on an inline <mark> → scroll sidebar to that annotation + focus textarea
   */
  function onMarkClick(annId: string): void {
    if (!sidebarEl) return;
    const item = sidebarEl.querySelector<HTMLElement>(`.remark-sidebar-item[data-ann-id="${annId}"]`);
    const ta = item?.querySelector<HTMLTextAreaElement>('.remark-sidebar-note-editor');
    if (item) {
      item.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      // Landing pulse on sidebar item
      item.classList.add('remark-item-landing');
      setTimeout(() => item.classList.remove('remark-item-landing'), 800);
    }
    if (ta) ta.focus();

    // Landing pulse on marks
    const container = getContainer();
    if (container) {
      container.querySelectorAll<HTMLElement>(`mark[data-ann-id="${annId}"]`).forEach(m => {
        m.classList.add('remark-landing');
        setTimeout(() => m.classList.remove('remark-landing'), 800);
      });
    }
  }

  // ─── Sidebar-first creation ────────────────────────────────────────────────

  function createAndFocusSidebar(selectedText: string, startLine: number, endLine: number, range: Range, blockId?: string): void {
    const annId = generateId();
    const ann: RemarkAnnotation = {
      id: annId, startLine, endLine, selectedText,
      note: '', color: config.defaultColor, timestamp: Date.now(), blockId,
    };
    annotations.push(ann);

    // Apply inline mark directly from the live Range (most reliable)
    applyMark(range, annId, ann.color);

    renderSidebarContent();
    notifyCount();
    void saveAnnotations();

    // Focus the new item's textarea in sidebar
    requestAnimationFrame(() => {
      const item = sidebarEl?.querySelector(`.remark-sidebar-item[data-ann-id="${annId}"]`);
      const ta = item?.querySelector<HTMLTextAreaElement>('.remark-sidebar-note-editor');
      if (ta) {
        item?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
        ta.focus();
      }
    });
  }

  // ─── Annotations ───────────────────────────────────────────────────────────

  function notifyCount(): void {
    const visibleCount = annotations.filter(a => !softDeletedIds.has(a.id)).length;
    onAnnotationCountChange?.(visibleCount);
  }

  function addAnnotation(
    selectedText: string, note: string, color: RemarkColor,
    startLine: number, endLine: number, blockId?: string
  ): void {
    const ann: RemarkAnnotation = {
      id: generateId(),
      startLine,
      endLine,
      selectedText,
      note,
      color,
      timestamp: Date.now(),
      blockId,
    };
    annotations.push(ann);
    renderHighlights();
    renderSidebarContent();
    notifyCount();
    void saveAnnotations();
  }

  function updateExportBtnState(): void {
    const exportBtn = sidebarEl?.querySelector<HTMLButtonElement>('.remark-sidebar-export');
    if (!exportBtn) return;
    const hasVisible = annotations.some(a => !softDeletedIds.has(a.id));
    exportBtn.disabled = !hasVisible;
    exportBtn.style.opacity = hasVisible ? '' : '0.5';
    exportBtn.style.cursor = hasVisible ? '' : 'not-allowed';
  }

  // ─── Undo Toast System ─────────────────────────────────────────────────────
  // Gmail-style: item disappears immediately, quiet toast with Undo at sidebar bottom.
  // No countdown, no progress bar, no dimmed corpse.

  let undoQueue: Array<{ id: string; ann: RemarkAnnotation }> = [];
  let undoTimer: ReturnType<typeof setTimeout> | null = null;
  const UNDO_MS = 5000;

  function showUndoToast(): void {
    if (!sidebarEl) return;
    let toast = sidebarEl.querySelector<HTMLElement>('.remark-undo-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'remark-undo-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      sidebarEl.appendChild(toast);
    }
    const count = undoQueue.length;
    const label = count > 1
      ? `${t('remark_deleted', 'Deleted')} ${count}`
      : t('remark_deleted', 'Deleted');
    toast.innerHTML = `<span>${label}</span><button class="remark-undo-btn">↩ ${t('remark_undo', 'Undo')}</button>`;
    toast.style.display = 'flex';

    toast.querySelector('.remark-undo-btn')?.addEventListener('click', () => {
      if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
      for (const entry of undoQueue) {
        softDeletedIds.delete(entry.id);
        // Restore if already removed from array
        if (!annotations.find(a => a.id === entry.id)) {
          annotations.push(entry.ann);
        }
      }
      undoQueue = [];
      hideUndoToast();
      renderHighlights();
      renderSidebarContent();
      notifyCount();
      updateExportBtnState();
      void saveAnnotations();
    }, { once: true });

    // Reset the commit timer
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(commitPendingDeletes, UNDO_MS);
  }

  function hideUndoToast(): void {
    const toast = sidebarEl?.querySelector<HTMLElement>('.remark-undo-toast');
    if (toast) toast.style.display = 'none';
  }

  function commitPendingDeletes(): void {
    undoTimer = null;
    for (const entry of undoQueue) {
      annotations = annotations.filter(a => a.id !== entry.id);
      softDeletedIds.delete(entry.id);
    }
    undoQueue = [];
    hideUndoToast();
    notifyCount();
    void saveAnnotations();
  }

  function removeAnnotation(id: string): void {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    // Optimistic delete: disappear immediately, undo via toast
    softDeletedIds.add(id);
    undoQueue.push({ id, ann: { ...ann } });
    updateExportBtnState();
    // Remove marks for this annotation
    removeMarksForAnnotation(id);
    // Animate sidebar item collapse instead of full re-render
    const sidebarItem = sidebarEl?.querySelector<HTMLElement>(`.remark-sidebar-item[data-ann-id="${id}"]`);
    if (sidebarItem) {
      sidebarItem.classList.add('remark-item-collapsing');
      setTimeout(() => sidebarItem.remove(), 500);
    }
    notifyCount();
    showUndoToast();
    void saveAnnotations(); // Persist immediately so refresh reflects deletion
  }

  /** Remove annotation silently (no undo toast) — used for auto-delete empty */
  function silentRemoveAnnotation(id: string): void {
    const idx = annotations.findIndex(a => a.id === id);
    if (idx === -1) return;
    annotations.splice(idx, 1);
    removeMarksForAnnotation(id);
    // Remove sidebar item directly (already collapsed by CSS animation)
    const sidebarItem = sidebarEl?.querySelector<HTMLElement>(`.remark-sidebar-item[data-ann-id="${id}"]`);
    if (sidebarItem) sidebarItem.remove();
    notifyCount();
    void saveAnnotations();
  }

  /** Remove inline <mark> elements for a specific annotation */
  function removeMarksForAnnotation(id: string): void {
    const container = getContainer();
    if (!container) return;
    container.querySelectorAll<HTMLElement>(`mark[data-ann-id="${id}"]`).forEach(mark => {
      const parent = mark.parentNode!;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });
    container.normalize();
  }

  function updateAnnotationNote(id: string, note: string): void {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    ann.note = note;
    renderSidebarContent();
    void saveAnnotations();
  }

  function getAnnotations(): RemarkAnnotation[] {
    return [...annotations];
  }

  // ─── Sidebar ───────────────────────────────────────────────────────────────

  function showSidebar(): void {
    const el = document.getElementById('remark-sidebar');
    if (!el) return;
    cancelPendingSidebarCleanup();
    sidebarEl = el;

    // Always inject fresh content (innerHTML is cleared after hide transition)
    el.innerHTML = `
      <div class="remark-sidebar-header">
        <span class="remark-sidebar-title">${t('remark_sidebar_title', 'Remarks')} <span class="remark-sidebar-count"></span></span>
        <div class="remark-sidebar-actions">
          <button class="remark-sidebar-export" title="${t('remark_copy_tooltip', 'Copy all remarks to clipboard')}">📋 ${t('remark_copy_btn', 'Copy')}</button>
          <button class="remark-sidebar-clear" title="${t('remark_clear_all', 'Clear all remarks')}">🗑️</button>
        </div>
      </div>
      <div class="remark-sidebar-list"></div>
    `;

    el.classList.remove('remark-sidebar-closed');
    applyConfigStyles();

    // Wire export button: copy and reset (no auto-exit, allows repeated copy)
    const exportBtn = el.querySelector<HTMLButtonElement>('.remark-sidebar-export');
    exportBtn?.addEventListener('click', async () => {
      const result = await exportToClipboard();
      if (exportBtn) {
        if (result.ok) {
          if (config.closeAfterCopy) {
            exportBtn.textContent = `✅ ${t('remark_copied', 'Copied!')}`;
            exportBtn.disabled = true;
            let countdown = 3;
            const tick = (): void => {
              if (countdown <= 0) { window.close(); return; }
              exportBtn.textContent = `🔄 closing ${countdown}`;
              countdown--;
              setTimeout(tick, 1000);
            };
            setTimeout(tick, 1000); // 1s showing "Copied!" then start countdown
            return;
          }
          exportBtn.textContent = `✅ ${t('remark_copied', 'Copied!')}`;
          exportBtn.disabled = true;
          setTimeout(() => {
            exportBtn.textContent = `📋 ${t('remark_copy_btn', 'Copy')}`;
            exportBtn.disabled = false;
          }, 2000);
        } else {
          exportBtn.textContent = `⚠️ ${t('remark_copy_failed', 'Failed')}`;
          setTimeout(() => { exportBtn.textContent = `📋 ${t('remark_copy_btn', 'Copy')}`; exportBtn.disabled = false; }, 2000);
        }
      }
    });

    // Set initial copy button disabled state
    updateExportBtnState();

    // Wire clear-all button — uses unified undo toast system
    const clearBtn = el.querySelector<HTMLButtonElement>('.remark-sidebar-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const activeAnns = annotations.filter(a => !softDeletedIds.has(a.id));
        if (activeAnns.length === 0) return;
        // Queue all active annotations for undo
        for (const ann of activeAnns) {
          softDeletedIds.add(ann.id);
          undoQueue.push({ id: ann.id, ann: { ...ann } });
        }
        updateExportBtnState();
        renderHighlights();
        renderSidebarContent();
        notifyCount();
        showUndoToast();
        void saveAnnotations(); // Persist immediately so refresh reflects deletion
      });
    }

    renderSidebarContent();
  }

  function hideSidebar(): void {
    if (sidebarEl) {
      sidebarEl.classList.add('remark-sidebar-closed');
      // Body margin transitions via CSS (same duration as sidebar slide-out)
      document.body.classList.remove('remark-panel-open');
      const el = sidebarEl;
      sidebarEl = null;
      const cleanupToken = ++sidebarHideCleanupToken;
      const onDone = (): void => {
        if (cleanupToken !== sidebarHideCleanupToken) {
          el.removeEventListener('transitionend', onDone);
          return;
        }

        el.removeEventListener('transitionend', onDone);
        if (sidebarHideCleanupTimer !== null) {
          clearTimeout(sidebarHideCleanupTimer);
          sidebarHideCleanupTimer = null;
        }
        el.innerHTML = ''; // Clear content after slide-out so next enter creates fresh HTML
      };
      el.addEventListener('transitionend', onDone, { once: true });
      sidebarHideCleanupTimer = setTimeout(onDone, 400);
    }
  }

  function renderSidebarContent(): void {
    if (!sidebarEl) return;
    const list = sidebarEl.querySelector('.remark-sidebar-list');
    const countEl = sidebarEl.querySelector('.remark-sidebar-count');
    if (!list) return;

    // Filter out soft-deleted annotations
    const visibleAnnotations = annotations.filter(a => !softDeletedIds.has(a.id));

    // Update count badge in header
    if (countEl) {
      countEl.textContent = visibleAnnotations.length > 0 ? `(${visibleAnnotations.length})` : '';
    }

    if (visibleAnnotations.length === 0) {
      list.innerHTML = `<div class="remark-sidebar-empty">${t('remark_empty_hint', 'Select text to add remarks')}</div>`;
      return;
    }

    const sorted = [...visibleAnnotations].sort((a, b) => a.startLine - b.startLine);
    list.innerHTML = sorted.map((ann, idx) => {
      const lineRef = formatLineRef(ann.startLine, ann.endLine);
      const quote = escapeHtml(truncate(ann.selectedText, 50));
      const noteEscaped = escapeHtml(ann.note || '');
      const orphaned = (ann as RemarkAnnotation & { _orphaned?: boolean })._orphaned;
      const colorOptions = (['yellow', 'green', 'blue', 'pink'] as RemarkColor[]).map(c =>
        `<span class="remark-color-opt${c === ann.color ? ' active' : ''}" data-color="${c}" title="${COLOR_LABELS[c]}">${COLOR_MAP[c].emoji}</span>`
      ).join('');

      return `
        <div class="remark-sidebar-item" data-ann-id="${ann.id}">
          <div class="remark-sidebar-item-header">
            <span class="remark-sidebar-ref">
              <span class="remark-color-dot" data-ann-id="${ann.id}">${COLOR_MAP[ann.color].emoji}</span>
              <span class="remark-lineref-pill">${orphaned ? '⚠️ ' : ''}${lineRef}</span>
              <span class="remark-ann-seq">#${idx + 1}</span>
            </span>
            <button class="remark-sidebar-delete" data-ann-id="${ann.id}" title="${t('remark_delete', 'Delete')}">✕</button>
          </div>
          <div class="remark-color-picker" style="display:none">${colorOptions}</div>
          <div class="remark-sidebar-quote">"${quote}"</div>
          <textarea class="remark-sidebar-note-editor" placeholder="${t('remark_add_note', 'Add a note…')}" rows="1">${noteEscaped}</textarea>
        </div>
      `;
    }).join('');

    const focusAnnotationFromSidebar = (id: string): void => {
      const ann = annotations.find(a => a.id === id);
      if (!ann) return;

      const container = getContainer();
      if (container) {
        // Find the inline <mark> for this annotation
        const mark = container.querySelector<HTMLElement>(`mark[data-ann-id="${id}"]`);
        if (mark) {
          const rect = mark.getBoundingClientRect();
          const inViewport = rect.top >= 0 && rect.bottom <= window.innerHeight;
          if (!inViewport) {
            mark.scrollIntoView({ behavior: 'auto', block: 'center' });
          }
          // Landing pulse on the mark
          mark.classList.add('remark-landing');
          setTimeout(() => mark.classList.remove('remark-landing'), 800);
        } else {
          // Fallback: scroll to block if mark not rendered (orphaned)
          const block = Array.from(
            container.querySelectorAll<HTMLElement>('[data-line]')
          ).find(el => {
            const { start, end } = getBlockRange(el);
            return rangesOverlap(start, end, ann.startLine, ann.endLine);
          });
          if (block) block.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
      }

      const targetItem = list.querySelector(`.remark-sidebar-item[data-ann-id="${id}"]`);
      const ta = targetItem?.querySelector<HTMLTextAreaElement>('.remark-sidebar-note-editor');
      if (ta) ta.focus();
    };

    const requestAnnotationFocus = (id: string, _event?: MouseEvent): void => {
      focusAnnotationFromSidebar(id);
    };

    // Wire delete buttons
    list.querySelectorAll('.remark-sidebar-delete').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.annId;
        if (id) removeAnnotation(id);
      });
    });

    // Wire color dot → toggle picker
    list.querySelectorAll('.remark-color-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = (dot as HTMLElement).closest('.remark-sidebar-item');
        const picker = item?.querySelector<HTMLElement>('.remark-color-picker');
        if (picker) picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
      });
    });

    // Wire color picker options
    list.querySelectorAll('.remark-color-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = (opt as HTMLElement).dataset.color as RemarkColor;
        const item = (opt as HTMLElement).closest('.remark-sidebar-item') as HTMLElement | null;
        const id = item?.dataset.annId;
        if (!id || !color) return;
        const ann = annotations.find(a => a.id === id);
        if (!ann) return;
        ann.color = color;
        // Update marks in content
        removeMarksForAnnotation(id);
        const container = getContainer();
        if (container) {
          const blocks = container.querySelectorAll<HTMLElement>('[data-line]');
          for (const block of blocks) {
            const { start, end } = getBlockRange(block);
            if (rangesOverlap(start, end, ann.startLine, ann.endLine)) {
              const range = findTextRange(block, ann.selectedText);
              if (range) applyMark(range, id, color);
              break;
            }
          }
        }
        // Update sidebar item in-place (no full re-render)
        const dot = item?.querySelector<HTMLElement>('.remark-color-dot');
        if (dot) dot.textContent = COLOR_MAP[color].emoji;
        const picker = item?.querySelector<HTMLElement>('.remark-color-picker');
        if (picker) picker.style.display = 'none';
        void saveAnnotations();
      });
    });

    // Wire click-to-scroll (on header/quote area)
    list.querySelectorAll('.remark-sidebar-item').forEach(item => {
      const header = item.querySelector('.remark-sidebar-item-header');
      const quote = item.querySelector('.remark-sidebar-quote');
      [header, quote].forEach(el => {
        el?.addEventListener('mousedown', (e) => {
          if ((e.target as HTMLElement | null)?.closest?.('.remark-sidebar-delete, .remark-color-dot')) return;
          const id = (item as HTMLElement).dataset.annId;
          if (!id) return;
          requestAnnotationFocus(id, e as MouseEvent);
        });
      });

      // Wire always-visible textarea (auto-grow + save on input)
      const ta = item.querySelector<HTMLTextAreaElement>('.remark-sidebar-note-editor');
      if (!ta) return;
      const id = (item as HTMLElement).dataset.annId;

      const autoResize = (): void => {
        ta.style.height = 'auto';
        const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 18;
        const maxH = lineHeight * 5 + 12;
        ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
        ta.style.overflow = ta.scrollHeight > maxH ? 'auto' : 'hidden';
      };

      // Auto-resize on content
      requestAnimationFrame(autoResize);

      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      ta.addEventListener('input', () => {
        autoResize();
        // Debounced save (300ms)
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          if (!id) return;
          const ann = annotations.find(a => a.id === id);
          if (ann) {
            ann.note = ta.value.trim();
            void saveAnnotations();
          }
        }, 300);
      });

      // Stop keyboard events from bubbling (prevents ext shortcuts)
      ta.addEventListener('keydown', (e) => { e.stopPropagation(); });
      ta.addEventListener('keyup', (e) => { e.stopPropagation(); });

      // Auto-delete empty: double-fade sidebar note only, then remove (3s total)
      ta.addEventListener('blur', () => {
        if (!id || !config.autoDeleteEmpty) return;
        const ann = annotations.find(a => a.id === id);
        if (!ann || ann.note.trim()) return; // Has note → keep

        // Cancel any existing timer for this id
        if (autoDeleteTimers.has(id)) clearTimeout(autoDeleteTimers.get(id)!);

        const timer = setTimeout(() => {
          autoDeleteTimers.delete(id);
          // Re-check: user may have re-focused or typed
          if (document.activeElement === ta) return;
          const annCheck = annotations.find(a => a.id === id);
          if (!annCheck || annCheck.note.trim()) return;

          const sidebarItem = sidebarEl?.querySelector<HTMLElement>(`.remark-sidebar-item[data-ann-id="${id}"]`);

          // Phase 1: fade sidebar note (0→800ms)
          if (sidebarItem) sidebarItem.classList.add('remark-item-fading');

          setTimeout(() => {
            // Phase 2: fade back (800→1600ms)
            if (sidebarItem) sidebarItem.classList.remove('remark-item-fading');

            setTimeout(() => {
              // Re-check before final removal
              if (document.activeElement === ta) return;
              const annFinal = annotations.find(a => a.id === id);
              if (!annFinal || annFinal.note.trim()) return;

              // Phase 3: final fade + collapse (1600→3000ms)
              if (sidebarItem) sidebarItem.classList.add('remark-item-collapsing');

              setTimeout(() => {
                silentRemoveAnnotation(id);
              }, 1400);
            }, 800);
          }, 800);
        }, config.autoDeleteDelay);

        autoDeleteTimers.set(id, timer);
      });

      // Cancel auto-delete on re-focus
      ta.addEventListener('focus', () => {
        if (id && autoDeleteTimers.has(id)) {
          clearTimeout(autoDeleteTimers.get(id)!);
          autoDeleteTimers.delete(id);
        }
      });
    });

    // Handle pending focus from click chain
    if (pendingFocusId) {
      const focusId = pendingFocusId;
      pendingFocusId = null;
      setTimeout(() => focusAnnotationFromSidebar(focusId), 0);
    }

    // Keep copy button state in sync with visible annotation count
    updateExportBtnState();
  }

  // ─── Highlights (mark-based) ─────────────────────────────────────────────────

  function renderHighlights(): void {
    // Clear existing marks and re-apply from annotations
    clearMarks();
    restoreMarks();
  }

  function clearHighlights(): void {
    clearMarks();
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  function formatExport(): string {
    if (annotations.length === 0) return '';

    const activeUrl = getCurrentDocumentUrl();
    const viewerFilePath = document.documentElement.dataset.viewerFilePath;
    let filePath = viewerFilePath
      || document.title
      || decodeURIComponent(window.location.pathname);

    try {
      const url = new URL(activeUrl);
      if (url.protocol === 'file:') {
        filePath = viewerFilePath || decodeURIComponent(url.pathname);
      } else {
        filePath = document.title || decodeURIComponent(url.pathname);
      }
    } catch {
      // Keep the best-effort fallback above.
    }

    return formatExportText(annotations.filter(a => !softDeletedIds.has(a.id)), filePath, {
      intro: tf('remark_export_intro', 'I reviewed **{0}** and have the following feedback:', filePath),
      noteLabel: t('remark_export_note', 'Note'),
      colorLabels: {
        yellow: getColorLabel('yellow'),
        green: getColorLabel('green'),
        blue: getColorLabel('blue'),
        pink: getColorLabel('pink'),
      },
    });
  }

  async function exportToClipboard(): Promise<{ ok: boolean; reason?: string }> {
    const text = formatExport();
    if (!text) return { ok: false, reason: 'No annotations to export' };

    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    }
  }

  function dispose(): void {
    exit();
    annotations = [];
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  function generateId(): string {
    return `rmk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ─── Styles ────────────────────────────────────────────────────────────────

  let stylesInjected = false;

  function injectStyles(): void {
    if (stylesInjected) return;
    stylesInjected = true;

    const style = document.createElement('style');
    style.id = 'remark-mode-styles';
    style.textContent = `
      .remark-mode-active {
        cursor: text;
      }
      /* Choreographed exit: fade marks before removing them */
      .remark-exiting mark.remark-ann {
        opacity: 0;
        transition: opacity 120ms ease-out;
      }

      /* ── Inline <mark> highlights ─────────────────────────────── */
      mark.remark-ann {
        background-color: rgba(250, 204, 21, 0.25) !important;
        border-radius: 2px;
        cursor: pointer;
        padding: 1px 0;
        transition: opacity 0.3s ease-out, background-color 0.2s;
      }
      /* Hide structural whitespace marks between block elements */
      ul > mark.remark-ann, ol > mark.remark-ann,
      tr > mark.remark-ann, tbody > mark.remark-ann,
      thead > mark.remark-ann, table > mark.remark-ann {
        display: none !important;
      }
      mark.remark-ann-yellow { background-color: rgba(255, 212, 0, 0.25) !important; }
      mark.remark-ann-green  { background-color: rgba(46, 160, 67, 0.18) !important; }
      mark.remark-ann-blue   { background-color: rgba(9, 105, 218, 0.15) !important; }
      mark.remark-ann-pink   { background-color: rgba(219, 97, 162, 0.18) !important; }

      /* Auto-delete animation: double-fade then collapse */
      /* Landing pulse on mark */
      @keyframes remark-mark-landing {
        0%   { box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.5); }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      mark.remark-ann.remark-landing {
        animation: remark-mark-landing 0.8s ease-out;
        border-radius: 2px;
      }
      @keyframes remark-item-landing {
        0%   { background: rgba(250, 204, 21, 0.12); }
        100% { background: transparent; }
      }
      .remark-sidebar-item.remark-item-landing {
        animation: remark-item-landing 0.8s ease-out;
      }

      /* Hover outline for selectable blocks */
      .remark-mode-active [data-line][data-block-id]:not(:has(img, svg, canvas, figure, video)):hover {
        outline: 1px dashed var(--color-nav-active-border, var(--color-theme-accent, var(--color-primary, #2563eb)));
        outline-offset: 2px;
        border-radius: 3px;
      }

      /* Tooltip */
      .remark-tooltip {
        position: fixed;
        z-index: 10002;
        background: var(--color-bg-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 6px;
        box-shadow: var(--shadow-popover, 0 2px 8px rgba(0,0,0,0.12));
        padding: 8px 12px;
        max-width: 300px;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: var(--color-text-primary, #1a1a1a);
        pointer-events: auto;
      }
      .remark-tooltip-item {
        padding: 2px 0;
        line-height: 1.4;
      }
      .remark-tooltip-item em {
        color: var(--gray-500, #6b7280);
      }

      /* Sidebar inner layout (positioning/size handled by #remark-sidebar in styles.css) */
      .remark-sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
      }
      .remark-sidebar-title {
        font-weight: 600;
        font-size: 14px;
      }
      .remark-sidebar-export {
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 6px;
        background: var(--gray-50, #f9fafb);
        padding: 4px 10px;
        cursor: pointer;
        font-size: 12px;
        color: inherit;
        transition: background 0.15s;
      }
      .remark-sidebar-export:hover {
        background: var(--gray-200, #e5e7eb);
      }
      .remark-sidebar-actions {
        display: flex;
        gap: 4px;
        align-items: center;
      }
      .remark-sidebar-clear {
        border: 1px solid transparent;
        border-radius: 6px;
        background: none;
        padding: 4px 6px;
        cursor: pointer;
        font-size: 14px;
        color: var(--gray-400, #9ca3af);
        transition: color 0.15s, background 0.15s;
      }
      .remark-sidebar-clear:hover {
        color: var(--color-danger, #ef4444);
        background: var(--color-danger-bg, rgba(239, 68, 68, 0.08));
      }
      .remark-sidebar-clear.remark-confirm {
        color: var(--color-danger, #ef4444);
        border-color: var(--color-danger-border, #fecaca);
        animation: remark-pulse 1s ease-in-out infinite;
      }
      @keyframes remark-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      .remark-sidebar-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        font-size: var(--remark-font-size, 13px);
      }
      .remark-sidebar-empty {
        color: var(--gray-400, #9ca3af);
        text-align: center;
        padding: 24px 16px;
        font-style: italic;
      }
      .remark-sidebar-item {
        padding: 10px 12px;
        border-radius: 6px;
        border: 1px solid var(--color-border, #e2e8f0);
        margin-bottom: 8px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .remark-sidebar-item:hover {
        background: var(--gray-50, #f9fafb);
      }
      .remark-sidebar-item-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }
      .remark-sidebar-delete {
        border: none;
        background: none;
        cursor: pointer;
        color: var(--gray-400, #9ca3af);
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }
      .remark-sidebar-delete:hover {
        color: var(--color-danger, #ef4444);
        background: var(--color-danger-bg, rgba(239, 68, 68, 0.1));
      }
      /* Undo toast — fixed at bottom of sidebar */
      .remark-undo-toast {
        display: none;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        border-top: 1px solid var(--color-border, #e2e8f0);
        background: var(--gray-100, #f3f4f6);
        font-size: 12px;
        color: var(--gray-600, #4b5563);
        flex-shrink: 0;
      }
      .remark-undo-toast .remark-undo-btn {
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-bg-surface, #fff);
        cursor: pointer;
        font-size: 11px;
        padding: 3px 10px;
        color: var(--color-theme-accent, var(--color-primary, #2563eb));
        transition: background 0.1s;
      }
      .remark-undo-toast .remark-undo-btn:hover { background: var(--gray-50, #f9fafb); }
      .remark-sidebar-quote {
        font-style: italic;
        color: var(--gray-500, #6b7280);
        font-size: calc(var(--remark-font-size, 13px) - 1px);
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .remark-sidebar-note-editor {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        padding: 4px 6px;
        font-size: var(--remark-font-size, 13px);
        font-family: inherit;
        resize: none;
        overflow: hidden;
        margin-top: 4px;
        background: var(--gray-50, #f9fafb);
        color: var(--color-text-primary, #1a1a1a);
        line-height: 1.4;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .remark-sidebar-note-editor:focus {
        outline: none;
        border-color: var(--color-nav-active-border, var(--color-theme-accent, var(--color-primary, #2563eb)));
        background: var(--color-bg-surface, #fff);
        box-shadow: 0 0 0 2px var(--color-theme-accent-subtle, var(--color-primary-subtle, #dbeafe));
      }
      .remark-sidebar-note-editor::placeholder {
        color: var(--gray-400, #9ca3af);
        font-style: italic;
      }

      /* ── Sidebar polish: line ref pill, color picker, seq badge ── */
      .remark-sidebar-ref {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .remark-color-dot {
        cursor: pointer;
        font-size: 14px;
        transition: transform 0.1s;
      }
      .remark-color-dot:hover {
        transform: scale(1.2);
      }
      .remark-lineref-pill {
        font-family: 'SF Mono', Consolas, 'Liberation Mono', monospace;
        font-size: 10px;
        font-weight: 600;
        background: var(--gray-100, #f3f4f6);
        color: var(--gray-600, #4b5563);
        padding: 1px 6px;
        border-radius: 8px;
        letter-spacing: 0.3px;
      }
      .remark-ann-seq {
        font-size: 10px;
        color: var(--gray-400, #9ca3af);
      }
      .remark-color-picker {
        display: flex;
        gap: 4px;
        padding: 4px 0;
        margin-bottom: 2px;
      }
      .remark-color-opt {
        cursor: pointer;
        font-size: 16px;
        padding: 2px 4px;
        border-radius: 4px;
        transition: background 0.1s;
        opacity: 0.6;
      }
      .remark-color-opt:hover {
        background: var(--gray-100, #f3f4f6);
        opacity: 1;
      }
      .remark-color-opt.active {
        opacity: 1;
        background: var(--gray-200, #e5e7eb);
      }

      /* Toolbar button active state */
      .toolbar-btn.remark-active {
        background: var(--color-nav-active-bg, var(--color-theme-accent-bg, var(--color-primary-light, #eff6ff)));
        color: var(--color-nav-active-text, var(--color-theme-accent, var(--color-primary, #2563eb)));
      }

      /* Count badge on toolbar button */
      .remark-count-badge {
        position: absolute;
        top: 2px;
        right: 2px;
        background: var(--color-badge-bg, #6b7280);
        color: var(--color-badge-text, #fff);
        font-size: 9px;
        font-weight: 700;
        min-width: 14px;
        height: 14px;
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 3px;
        line-height: 1;
        pointer-events: none;
      }

      .remark-sidebar-count {
        color: var(--gray-500, #6b7280);
        font-weight: normal;
        font-size: 13px;
      }

      /* ── UX Delight: Animations ─────────────────────────────── */
      @media (prefers-reduced-motion: no-preference) {
        /* Sidebar item fade-in */
        .remark-sidebar-item {
          animation: remark-item-in 0.15s ease-out;
          transition: opacity 0.5s ease, max-height 0.5s ease, margin 0.5s ease, padding 0.5s ease;
          max-height: 400px;
          overflow: hidden;
        }
        @keyframes remark-item-in {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .remark-sidebar-item.remark-item-fading {
          opacity: 0.3;
        }
        .remark-sidebar-item.remark-item-collapsing {
          opacity: 0;
          max-height: 0;
          margin-top: 0 !important;
          margin-bottom: 0 !important;
          padding-top: 0 !important;
          padding-bottom: 0 !important;
        }
      }

    `;
    document.head.appendChild(style);
  }

  // After loading, notify toolbar of initial count
  const _loadAnnotations = loadAnnotations;
  async function loadAnnotationsAndNotify(): Promise<void> {
    await _loadAnnotations();
    notifyCount();
  }

  return {
    isActive,
    enter,
    exit,
    getAnnotations,
    removeAnnotation,
    updateAnnotationNote,
    exportToClipboard,
    loadAnnotations: loadAnnotationsAndNotify,
    dispose,
  };
}
