/**
 * Line-Based Scroll Manager
 * 
 * Scroll synchronization based on block IDs and source line numbers.
 * Uses MarkdownDocument for line mapping, DOM only for pixel calculations.
 */

/**
 * Interface for document line mapping (provided by MarkdownDocument)
 */
export interface LineMapper {
  /** Convert blockId + progress to source line number */
  getLineFromBlockId(blockId: string, progress: number): number | null;
  /** Convert source line to blockId + progress */
  getBlockPositionFromLine(line: number): { blockId: string; progress: number } | null;
}

/**
 * Options for scroll operations
 */
export interface ScrollOptions {
  /** Content container element */
  container: HTMLElement;
  /** Optional scroll container; defaults to window */
  scrollContainer?: HTMLElement;
  /** Scroll behavior */
  behavior?: ScrollBehavior;
  /** Offset from viewport top (e.g., fixed toolbar height) */
  topOffset?: number;
}

function getScrollTop(scrollContainer?: HTMLElement): number {
  return scrollContainer ? scrollContainer.scrollTop : (window.scrollY || window.pageYOffset || 0);
}

function scrollToPosition(top: number, behavior: ScrollBehavior, scrollContainer?: HTMLElement): void {
  if (scrollContainer) {
    scrollContainer.scrollTo({ top, behavior });
    return;
  }

  window.scrollTo({ top, behavior });
}

function getBlockTop(block: HTMLElement, scrollContainer?: HTMLElement): number {
  if (!scrollContainer) {
    return block.getBoundingClientRect().top + getScrollTop();
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  return block.getBoundingClientRect().top - containerRect.top + scrollContainer.scrollTop;
}

function getCodeViewLineElements(block: HTMLElement): HTMLElement[] {
  return Array.from(block.querySelectorAll<HTMLElement>(':scope .mv-code-line'));
}

function getCodeViewLogicalLine(
  block: HTMLElement,
  effectiveScrollTop: number,
  scrollContainer?: HTMLElement,
): number | null {
  const lineElements = getCodeViewLineElements(block);
  if (lineElements.length === 0) {
    return null;
  }

  let targetIndex = 0;
  for (let i = 0; i < lineElements.length; i++) {
    const lineTop = getBlockTop(lineElements[i], scrollContainer);
    if (lineTop > effectiveScrollTop) {
      break;
    }
    targetIndex = i;
  }

  const lineElement = lineElements[targetIndex];
  const lineTop = getBlockTop(lineElement, scrollContainer);
  const lineHeight = Math.max(lineElement.getBoundingClientRect().height, 1);
  const lineProgress = Math.max(0, Math.min(1, (effectiveScrollTop - lineTop) / lineHeight));

  return targetIndex + lineProgress;
}

function getProgressFromCodeViewLines(
  block: HTMLElement,
  effectiveScrollTop: number,
  scrollContainer?: HTMLElement,
): number | null {
  const logicalLine = getCodeViewLogicalLine(block, effectiveScrollTop, scrollContainer);
  const lineElements = getCodeViewLineElements(block);
  if (logicalLine === null || lineElements.length === 0) {
    return null;
  }

  return Math.max(0, Math.min(1, logicalLine / lineElements.length));
}

function scrollToCodeViewLogicalLine(
  block: HTMLElement,
  logicalLine: number,
  options: ScrollOptions,
): boolean {
  const lineElements = getCodeViewLineElements(block);
  if (lineElements.length === 0) {
    return false;
  }

  const { behavior = 'auto', scrollContainer, topOffset = 0 } = options;
  const clampedLogicalLine = Math.max(0, Math.min(logicalLine, lineElements.length - 0.000001));
  const lineIndex = Math.min(lineElements.length - 1, Math.floor(clampedLogicalLine));
  const lineProgress = clampedLogicalLine - lineIndex;
  const lineElement = lineElements[lineIndex];
  const lineTop = getBlockTop(lineElement, scrollContainer);
  const lineHeight = lineElement.getBoundingClientRect().height;
  const scrollTo = lineTop + lineHeight * lineProgress - topOffset;

  scrollToPosition(Math.max(0, scrollTo), behavior, scrollContainer);
  return true;
}

function scrollToCodeViewLine(
  block: HTMLElement,
  progress: number,
  options: ScrollOptions,
): boolean {
  const lineElements = getCodeViewLineElements(block);
  if (lineElements.length === 0) {
    return false;
  }

  const { behavior = 'auto', scrollContainer, topOffset = 0 } = options;
  const logicalLine = Math.max(0, Math.min(progress, 0.999999)) * lineElements.length;
  const lineIndex = Math.min(lineElements.length - 1, Math.floor(logicalLine));
  const lineProgress = logicalLine - lineIndex;
  const lineElement = lineElements[lineIndex];
  const lineTop = getBlockTop(lineElement, scrollContainer);
  const lineHeight = lineElement.getBoundingClientRect().height;
  const scrollTo = lineTop + lineHeight * lineProgress - topOffset;

  scrollToPosition(Math.max(0, scrollTo), behavior, scrollContainer);
  return true;
}

/**
 * Find the block element at current scroll position
 * @returns blockId and progress (0-1) within that block
 */
export function getBlockAtScrollPosition(options: ScrollOptions): { blockId: string; progress: number } | null {
  const { container, scrollContainer, topOffset = 0 } = options;
  
  // Get all block elements
  const blocks = container.querySelectorAll<HTMLElement>('[data-block-id]');
  if (blocks.length === 0) return null;
  
  const scrollTop = getScrollTop(scrollContainer);
  // Account for fixed elements (e.g., toolbar) covering the viewport top
  const effectiveScrollTop = scrollTop + topOffset;
  
  // Find the block containing current scroll position
  let targetBlock: HTMLElement | null = null;
  
  for (const block of Array.from(blocks)) {
    const blockTop = getBlockTop(block, scrollContainer);
    
    if (blockTop > effectiveScrollTop) {
      break;
    }
    targetBlock = block;
  }
  
  if (!targetBlock) {
    targetBlock = blocks[0] as HTMLElement;
  }
  
  const blockId = targetBlock.getAttribute('data-block-id');
  if (!blockId) return null;

  const codeViewProgress = getProgressFromCodeViewLines(targetBlock, effectiveScrollTop, scrollContainer);
  if (codeViewProgress !== null) {
    return { blockId, progress: codeViewProgress };
  }
  
  // Calculate progress within block
  const blockTop = getBlockTop(targetBlock, scrollContainer);
  const blockHeight = targetBlock.getBoundingClientRect().height;
  
  const pixelOffset = effectiveScrollTop - blockTop;
  const progress = blockHeight > 0 ? Math.max(0, Math.min(1, pixelOffset / blockHeight)) : 0;
  
  return { blockId, progress };
}

/**
 * Scroll to a specific block with progress
 * @returns true if scroll was performed
 */
export function scrollToBlock(
  blockId: string, 
  progress: number, 
  options: ScrollOptions
): boolean {
  const { container, scrollContainer, behavior = 'auto', topOffset = 0 } = options;
  
  // Find the block element
  const block = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
  if (!block) return false;

  if (scrollToCodeViewLine(block, progress, options)) {
    return true;
  }
  
  // Calculate target scroll position
  const blockTop = getBlockTop(block, scrollContainer);
  const blockHeight = block.getBoundingClientRect().height;
  
  const clampedProgress = Math.max(0, Math.min(1, progress));
  // Subtract topOffset so content appears below fixed elements (e.g., toolbar)
  const scrollTo = blockTop + clampedProgress * blockHeight - topOffset;
  
  // Perform scroll
  scrollToPosition(Math.max(0, scrollTo), behavior, scrollContainer);
  
  return true;
}

/**
 * Get current scroll position as source line number
 * Returns null if no blocks in DOM or lineMapper unavailable
 */
export function getLineForScrollPosition(
  lineMapper: LineMapper | null | undefined,
  options: ScrollOptions
): number | null {
  if (!lineMapper) return null;

  const effectiveScrollTop = getScrollTop(options.scrollContainer) + (options.topOffset ?? 0);
  const blocks = options.container.querySelectorAll<HTMLElement>('[data-block-id]');
  let targetBlock: HTMLElement | null = null;
  for (const block of Array.from(blocks)) {
    const blockTop = getBlockTop(block, options.scrollContainer);
    if (blockTop > effectiveScrollTop) {
      break;
    }
    targetBlock = block;
  }

  if (!targetBlock && blocks.length > 0) {
    targetBlock = blocks[0] as HTMLElement;
  }

  if (targetBlock) {
    const codeViewLogicalLine = getCodeViewLogicalLine(targetBlock, effectiveScrollTop, options.scrollContainer);
    if (codeViewLogicalLine !== null) {
      return codeViewLogicalLine;
    }
  }
  
  const pos = getBlockAtScrollPosition(options);
  if (!pos) return null;
  
  const line = lineMapper.getLineFromBlockId(pos.blockId, pos.progress);
  
  return line;
}

/**
 * Scroll to reveal a specific source line
 * @returns true if scroll was performed
 */
export function scrollToLine(
  line: number, 
  lineMapper: LineMapper | null | undefined,
  options: ScrollOptions
): boolean {
  const { behavior = 'auto' } = options;
  
  // Special case: line <= 0 means scroll to top
  if (line <= 0) {
    scrollToPosition(0, behavior, options.scrollContainer);
    return true;
  }
  
  // If no lineMapper, can't scroll to line
  if (!lineMapper) {
    return false;
  }
  
  const pos = lineMapper.getBlockPositionFromLine(line);
  if (!pos) {
    return false;
  }

  const block = options.container.querySelector<HTMLElement>(`[data-block-id="${pos.blockId}"]`);
  if (block) {
    const codeViewLineCount = getCodeViewLineElements(block).length;
    if (codeViewLineCount > 0) {
      return scrollToCodeViewLogicalLine(block, line, options);
    }
  }
  
  return scrollToBlock(pos.blockId, pos.progress, options);
}

/**
 * Scroll sync controller interface
 */
export interface ScrollSyncController {
  /** Set target line from source (e.g., editor or restore) */
  setTargetLine(line: number): void;
  /** Get current scroll position as line number */
  getCurrentLine(): number | null;
  /** Notify that a streaming chunk is done — attempts scroll if not yet settled */
  onStreamingComplete(): void;
  /** Force a final re-scroll after async content (diagrams) finishes rendering */
  onRenderComplete(): void;
  /** Reset to initial state (call when document changes) */
  reset(): void;
  /** Start the controller */
  start(): void;
  /** Stop and cleanup */
  dispose(): void;
}

/**
 * Options for scroll sync controller
 */
export interface ScrollSyncControllerOptions {
  /** Content container element */
  container: HTMLElement;
  /** Optional scroll container; defaults to window */
  scrollContainer?: HTMLElement;
  /** Line mapper getter (called each time to get latest document state) */
  getLineMapper: () => LineMapper;
  /** Callback when user scrolls (for reverse sync) */
  onUserScroll?: (line: number) => void;
  /** Offset from viewport top (e.g., fixed toolbar height) */
  topOffset?: number;
}

/**
 * Create a scroll sync controller
 *
 * NOTE:
 * The original implementation used a 4-state machine (INITIAL/RESTORING/TRACKING/LOCKED)
 * to handle async rendering and programmatic scroll interactions.
 *
 * The current implementation is intentionally simplified: always attempt to scroll to the
 * latest target line immediately, and rely on browser scroll anchoring to preserve viewport
 * stability during async DOM growth.
 */
export function createScrollSyncController(options: ScrollSyncControllerOptions): ScrollSyncController {
  const {
    container,
    scrollContainer,
    getLineMapper,
    onUserScroll,
    topOffset,
  } = options;

  let targetLine: number | undefined;
  let disposed = false;

  // Once we successfully scroll to targetLine, stop re-scrolling in onStreamingComplete.
  // This prevents fighting browser scroll anchoring while later chunks/diagrams are loading.
  // onRenderComplete() resets this for the final post-processAll re-scroll.
  let scrollSettled = false;

  // Prevent feedback loop between programmatic scroll (host-driven) and user scroll reporting.
  // When we scroll due to setTargetLine/onStreamingComplete, we temporarily suppress
  // onUserScroll emissions triggered by the resulting scroll event.
  let suppressUserScrollUntilMs = 0;

  // Reduce noisy reverse-sync messages by only emitting when the line meaningfully changes.
  let lastReportedLine: number | null = null;

  const scrollOptions: ScrollOptions = {
    container,
    scrollContainer,
    topOffset,
  };

  /**
   * Perform scroll to target line, returns true if block was found and scrolled to
   */
  const doScroll = (line: number): boolean => {
    const result = scrollToLine(line, getLineMapper(), scrollOptions);
    return result;
  };

  /**
   * Update targetLine from current scroll position and report to host
   */
  const handleUserScroll = (): void => {
    // Ignore scroll events caused by our own programmatic scroll.
    if (Date.now() < suppressUserScrollUntilMs) {
      return;
    }

    const currentLine = getLineForScrollPosition(getLineMapper(), scrollOptions);
    if (currentLine === null || isNaN(currentLine)) return;

    // Only report when the line changes enough to matter.
    const normalizedLine = Math.max(0, Math.floor(currentLine));
    if (lastReportedLine !== null && Math.floor(lastReportedLine) === normalizedLine) {
      // Exception: detect scroll-to-top. Transitions like 0.5 → 0.0 are
      // normally swallowed (both floor to 0), but we must report 0 so that
      // restore uses the fast scrollTo({top:0}) path instead of scrollToLine(0.5).
      const scrollTop = getScrollTop(scrollContainer);
      if (scrollTop >= 1 || lastReportedLine <= 0) {
        if (targetLine === undefined && currentLine <= 0) {
          return;
        }
        targetLine = currentLine;
        return;
      }
    }

    // No explicit scroll target has been set yet. Ignore passive top-position
    // samples (line<=0) so initial render/streaming does not trigger forced
    // scroll-to-top retries.
    if (targetLine === undefined && currentLine <= 0) {
      return;
    }
    
    targetLine = currentLine;
    lastReportedLine = currentLine;
    
    if (onUserScroll) {
      onUserScroll(currentLine);
    }
  };

  /**
   * Handle scroll event based on current state
   */
  const handleScroll = (): void => {
    if (disposed) return;
    
    // Call handleUserScroll on every scroll event
    handleUserScroll();
  };

  const setupListeners = (): void => {
    const target = scrollContainer ?? window;
    target.addEventListener('scroll', handleScroll, { passive: true });
  };

  const removeListeners = (): void => {
    const target = scrollContainer ?? window;
    target.removeEventListener('scroll', handleScroll);
  };

  return {
    setTargetLine(line: number): void {
      targetLine = line;
      scrollSettled = false;

      // Suppress reverse-sync for a short window; window.scrollTo triggers 'scroll'.
      // Keep this small to preserve legitimate user scroll reporting.
      suppressUserScrollUntilMs = Date.now() + 200;
      if (doScroll(line)) {
        scrollSettled = true;
      }
    },

    getCurrentLine(): number | null {
      return getLineForScrollPosition(getLineMapper(), scrollOptions);
    },

    onStreamingComplete(): void {
      if (targetLine === undefined) {
        return;
      }

      // Once scroll has settled (target block found and scrolled to), stop re-scrolling.
      // Repeated doScrolls fight browser scroll anchoring and cause visible position jumps
      // as scroll anchoring adjusts for content changes (font load, early diagram render).
      if (scrollSettled) return;

      suppressUserScrollUntilMs = Date.now() + 200;
      if (doScroll(targetLine)) {
        scrollSettled = true;
      }
    },

    onRenderComplete(): void {
      if (targetLine === undefined) {
        return;
      }

      // Force one final re-scroll after async rendering (diagrams etc.) finishes.
      // At this point all block heights are final, so the position is accurate.
      scrollSettled = false;
      suppressUserScrollUntilMs = Date.now() + 200;
      if (doScroll(targetLine)) {
        scrollSettled = true;
      }
    },

    reset(): void {
      targetLine = undefined;
      scrollSettled = false;
      lastReportedLine = null;
    },

    start(): void {
      if (disposed) return;
      setupListeners();
    },

    dispose(): void {
      disposed = true;
      removeListeners();
    },
  };
}
