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
  /** Scroll behavior */
  behavior?: ScrollBehavior;
}

/**
 * Find the block element at current scroll position
 * @returns blockId and progress (0-1) within that block
 */
export function getBlockAtScrollPosition(options: ScrollOptions): { blockId: string; progress: number } | null {
  const { container } = options;
  
  // Get all block elements
  const blocks = container.querySelectorAll<HTMLElement>('[data-block-id]');
  if (blocks.length === 0) return null;
  
  // Get current scroll position (always use window scroll)
  const scrollTop = window.scrollY || window.pageYOffset || 0;
  
  // Find the block containing current scroll position
  let targetBlock: HTMLElement | null = null;
  
  for (const block of Array.from(blocks)) {
    const rect = block.getBoundingClientRect();
    const blockTop = rect.top + scrollTop;
    
    if (blockTop > scrollTop) {
      break;
    }
    targetBlock = block;
  }
  
  if (!targetBlock) {
    targetBlock = blocks[0] as HTMLElement;
  }
  
  const blockId = targetBlock.getAttribute('data-block-id');
  if (!blockId) return null;
  
  // Calculate progress within block
  const rect = targetBlock.getBoundingClientRect();
  const blockTop = rect.top + scrollTop;
  const blockHeight = rect.height;
  
  const pixelOffset = scrollTop - blockTop;
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
  const { container, behavior = 'auto' } = options;
  
  // Find the block element
  const block = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
  if (!block) return false;
  
  // Get current scroll context (always use window scroll)
  const currentScroll = window.scrollY || window.pageYOffset || 0;
  
  // Calculate target scroll position
  const rect = block.getBoundingClientRect();
  const blockTop = rect.top + currentScroll;
  const blockHeight = rect.height;
  
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const scrollTo = blockTop + clampedProgress * blockHeight;
  
  // Perform scroll
  window.scrollTo({ top: Math.max(0, scrollTo), behavior });
  
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
  
  const pos = getBlockAtScrollPosition(options);
  if (!pos) return null;
  
  return lineMapper.getLineFromBlockId(pos.blockId, pos.progress);
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
    window.scrollTo({ top: 0, behavior });
    return true;
  }
  
  // If no lineMapper, can't scroll to line
  if (!lineMapper) return false;
  
  const pos = lineMapper.getBlockPositionFromLine(line);
  if (!pos) return false;
  
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
  /** Notify that streaming has completed */
  onStreamingComplete(): void;
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
  /** Line mapper getter (called each time to get latest document state) */
  getLineMapper: () => LineMapper;
  /** Callback when user scrolls (for reverse sync) */
  onUserScroll?: (line: number) => void;
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
    getLineMapper,
    onUserScroll,
  } = options;

  let targetLine: number = 0;
  let disposed = false;

  // Prevent feedback loop between programmatic scroll (host-driven) and user scroll reporting.
  // When we scroll due to setTargetLine/onStreamingComplete, we temporarily suppress
  // onUserScroll emissions triggered by the resulting scroll event.
  let suppressUserScrollUntilMs = 0;

  // Reduce noisy reverse-sync messages by only emitting when the line meaningfully changes.
  let lastReportedLine: number | null = null;

  const scrollOptions: ScrollOptions = {
    container,
  };

  /**
   * Perform scroll to target line
   */
  const doScroll = (line: number): void => {
    scrollToLine(line, getLineMapper(), scrollOptions);
  };

  /**
   * Update targetLine from current scroll position and report to host
   */
  const handleUserScroll = (): void => {
    // Ignore scroll events caused by our own programmatic scroll.
    if (Date.now() < suppressUserScrollUntilMs) return;

    const currentLine = getLineForScrollPosition(getLineMapper(), scrollOptions);
    if (currentLine === null || isNaN(currentLine)) return;

    // Only report when the line changes enough to matter.
    const normalizedLine = Math.max(0, Math.floor(currentLine));
    if (lastReportedLine !== null && Math.floor(lastReportedLine) === normalizedLine) {
      // Exception: detect scroll-to-top. Transitions like 0.5 → 0.0 are
      // normally swallowed (both floor to 0), but we must report 0 so that
      // restore uses the fast scrollTo({top:0}) path instead of scrollToLine(0.5).
      const scrollTop = window.scrollY || window.pageYOffset || 0;
      if (scrollTop >= 1 || lastReportedLine <= 0) {
        targetLine = currentLine;
        return;
      }
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
    window.addEventListener('scroll', handleScroll, { passive: true });
  };

  const removeListeners = (): void => {
    window.removeEventListener('scroll', handleScroll);
  };

  return {
    setTargetLine(line: number): void {
      targetLine = line;

      // Suppress reverse-sync for a short window; window.scrollTo triggers 'scroll'.
      // Keep this small to preserve legitimate user scroll reporting.
      suppressUserScrollUntilMs = Date.now() + 200;
      doScroll(line);
    },

    getCurrentLine(): number | null {
      return getLineForScrollPosition(getLineMapper(), scrollOptions);
    },

    onStreamingComplete(): void {
      // Re-apply the latest target line after the main (streaming) render phase.
      // This helps the preview catch up when blocks become available.
      suppressUserScrollUntilMs = Date.now() + 200;
      doScroll(targetLine);
    },

    reset(): void {
      targetLine = 0;
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
