import { getCurrentDocumentUrl } from '../core/document-utils';
import { escapeHtml } from '../core/markdown-processor';
import type { TranslateFunction } from '../types/core';
import {
  truncate, formatLineRef, getBlockRange, rangesOverlap, isMediaBlock,
  formatExportText,
  COLOR_MAP, COLOR_LABELS, SKIP_ANNOTATION_TAGS,
  type RemarkColor, type RemarkAnnotation,
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

  let active = false;
  let annotations: RemarkAnnotation[] = [];
  let abortController: AbortController | null = null;
  let popupEl: HTMLElement | null = null;
  let sidebarEl: HTMLElement | null = null;
  let tooltipEl: HTMLElement | null = null;
  let pendingFocusId: string | null = null; // for focus chain across re-renders
  let sidebarHideCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let sidebarHideCleanupToken = 0;

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


    document.body.classList.add('remark-panel-open');
    injectStyles();
    renderHighlights();
    showSidebar();

    // Schedule highlight render for when markdown DOM is ready.
    // Handles: container not yet in DOM, [data-line] not yet rendered, or async re-render.
    if (!container || !container.querySelector('[data-line]')) {
      scheduleHighlightsAfterRender();
    }

    onModeChange?.(true);
  }

  function exit(): void {
    if (!active) return;
    active = false;
    abortController?.abort();
    abortController = null;

    hidePopup();
    hideTooltip();
    hideSidebar(); // hideSidebar handles removing remark-panel-open after transition
    const container = getContainer();
    if (container) {
      container.classList.remove('remark-mode-active');
    }
    clearHighlights();
    onModeChange?.(false);
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
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ [key]: annotations });
      } else {
        localStorage.setItem(key, JSON.stringify(annotations));
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
      // If URL contains ?remarker=true, auto-enter after DOM is ready
      if (typeof window !== 'undefined' && window.location.search.includes('remarker=true')) {
        if (annotations.length > 0) {
          enter();
        } else {
          scheduleHighlightsAfterRender();
        }
      } else if (annotations.length > 0) {
        // Not auto-entering, but schedule highlights so badge renders after DOM is ready
        scheduleHighlightsAfterRender();
      }
    }
  }

  function scheduleHighlightsAfterRender(): void {
    function tryOnContainer(): void {
      const container = getContainer();
      if (!container) return;

      if (container.querySelector('[data-line]')) {
        if (active) { renderHighlights(); renderSidebarContent(); } else { notifyCount(); }
        return;
      }

      const obs = new MutationObserver(() => {
        if (container.querySelector('[data-line]')) {
          obs.disconnect();
          if (active) {
            renderHighlights();
            renderSidebarContent();
          } else {
            notifyCount();
          }
        }
      });
      obs.observe(container, { childList: true, subtree: true });
    }

    const container = getContainer();
    if (container) {
      tryOnContainer();
      return;
    }

    // Container not yet in DOM (e.g., ?remarker=true fires before markdown renders).
    // Watch document.body until the container element appears.
    const bodyObs = new MutationObserver(() => {
      if (getContainer()) {
        bodyObs.disconnect();
        tryOnContainer();
      }
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Selection Handling ──────────────────────────────────────────────────

  function handleSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      return;
    }

    const range = sel.getRangeAt(0);
    const container = getContainer();
    if (!container || !container.contains(range.commonAncestorContainer)) {
      return;
    }

    const selectedText = sel.toString().trim();
    if (!selectedText) return;

    const { startLine, endLine, blockId, startBlock } = findBlockRange(range, container);
    if (startLine < 0) return;

    // Skip media blocks (images, charts, diagrams)
    if (startBlock && isMediaBlock(startBlock)) return;

    showPopup(range, selectedText, startLine, endLine, blockId, startBlock ?? undefined);
  }


  function findBlockRange(range: Range, container: HTMLElement): { startLine: number; endLine: number; blockId?: string; startBlock: HTMLElement | null } {
    const startBlock = findBlockAncestor(range.startContainer, container);
    const endBlock = findBlockAncestor(range.endContainer, container);

    if (!startBlock) return { startLine: -1, endLine: -1, startBlock: null };

    const startLine = Number(startBlock.getAttribute('data-line')) || 0;
    const startCount = Number(startBlock.getAttribute('data-line-count')) || 1;

    if (!endBlock || endBlock === startBlock) {
      return {
        startLine,
        endLine: startLine + startCount - 1,
        blockId: startBlock.getAttribute('data-block-id') || undefined,
        startBlock,
      };
    }

    const endLine = Number(endBlock.getAttribute('data-line')) || 0;
    const endCount = Number(endBlock.getAttribute('data-line-count')) || 1;
    return {
      startLine,
      endLine: endLine + endCount - 1,
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
    const target = (e.target as HTMLElement).closest?.('[data-line][data-block-id]') as HTMLElement | null;
    if (!target || !target.classList.contains('remark-highlighted')) return;
    if (isMediaBlock(target)) return;

    const { start: blockLine, end: blockEnd } = getBlockRange(target);

    // Find annotations for this block
    const blockAnns = annotations.filter(a => rangesOverlap(a.startLine, a.endLine, blockLine, blockEnd));
    if (blockAnns.length === 0) return;

    showTooltip(target, blockAnns);
  }

  function handleHoverOut(e: Event): void {
    const target = (e.target as HTMLElement).closest?.('[data-line][data-block-id]') as HTMLElement | null;
    if (!target) return;
    // Only hide if moving away from a highlighted block
    const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (related && (related.closest?.('.remark-tooltip') || related.closest?.('[data-line][data-block-id].remark-highlighted'))) {
      return;
    }
    hideTooltip();
  }

  function showTooltip(anchor: HTMLElement, anns: RemarkAnnotation[]): void {
    hideTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'remark-tooltip';

    const items = anns.map(a => {
      const noteText = a.note
        ? escapeHtml(a.note)
        : `<em>${escapeHtml(truncate(a.selectedText, 60))}</em>`;
      return `<div class="remark-tooltip-item">${COLOR_MAP[a.color].emoji} ${noteText}</div>`;
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

  // ─── Popup ─────────────────────────────────────────────────────────────────

  function showPopup(range: Range, selectedText: string, startLine: number, endLine: number, blockId?: string, targetBlock?: HTMLElement): void {
    hidePopup();

    // Highlight the block being annotated
    if (targetBlock) {
      targetBlock.classList.add('remark-popup-target');
    }

    // Create annotation immediately with default color
    const annId = generateId();
    const ann: RemarkAnnotation = {
      id: annId, startLine, endLine, selectedText,
      note: '', color: 'yellow', timestamp: Date.now(), blockId,
    };
    annotations.push(ann);
    renderHighlights();
    renderSidebarContent();
    notifyCount();
    void saveAnnotations();

    const rect = range.getBoundingClientRect();
    popupEl = document.createElement('div');
    popupEl.className = 'remark-popup';
    popupEl.innerHTML = buildPopupHTML(selectedText);

    document.body.appendChild(popupEl);

    // Position below selection
    const popupRect = popupEl.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left + (rect.width / 2) - (popupRect.width / 2);

    if (left < 8) left = 8;
    if (left + popupRect.width > window.innerWidth - 8) {
      left = window.innerWidth - popupRect.width - 8;
    }
    if (top + popupRect.height > window.innerHeight - 8) {
      top = rect.top - popupRect.height - 8;
    }

    popupEl.style.top = `${top}px`;
    popupEl.style.left = `${left}px`;

    // Wire color buttons — change existing annotation's color
    let interacted = false;
    const colorBtns = popupEl.querySelectorAll<HTMLButtonElement>('.remark-color-btn');
    colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        interacted = true;
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ann.color = btn.dataset.color as RemarkColor;
        renderHighlights();
        renderSidebarContent();
        void saveAnnotations();
      });
    });

    const cancelBtn = popupEl.querySelector('.remark-cancel-btn');
    const noteInput = popupEl.querySelector<HTMLTextAreaElement>('.remark-note-input');

    // Cancel → delete the just-created annotation
    cancelBtn?.addEventListener('click', () => {
      annotations = annotations.filter(a => a.id !== annId);
      renderHighlights();
      renderSidebarContent();
      notifyCount();
      void saveAnnotations();
      hidePopup();
      window.getSelection()?.removeAllRanges();
    });

    // Save note on Enter (without shift)
    noteInput?.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter' && !ke.shiftKey) {
        ke.preventDefault();
        ann.note = noteInput.value.trim();
        renderSidebarContent();
        void saveAnnotations();
        hidePopup();
        window.getSelection()?.removeAllRanges();
      }
    });

    setTimeout(() => noteInput?.focus(), 50);


    // Click outside → cancel (remove annotation) if user never interacted; otherwise save
    const outsideHandler = (e: MouseEvent) => {
      if (popupEl && !popupEl.contains(e.target as Node)) {
        const note = noteInput?.value.trim() ?? '';
        if (!interacted && note === '') {
          // No interaction — silently discard the annotation
          annotations = annotations.filter(a => a.id !== annId);
          renderHighlights();
          renderSidebarContent();
          notifyCount();
          void saveAnnotations();
          window.getSelection()?.removeAllRanges();
        } else if (noteInput) {
          ann.note = note;
          renderSidebarContent();
          void saveAnnotations();
        }
        hidePopup();
        document.removeEventListener('mousedown', outsideHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', outsideHandler), 100);
  }

  function buildPopupHTML(selectedText: string): string {
    const preview = escapeHtml(truncate(selectedText, 80));

    return `
      <div class="remark-popup-header">
        <span class="remark-popup-quote">"${preview}"</span>
      </div>
      <div class="remark-popup-colors">
        ${(Object.keys(COLOR_MAP) as RemarkColor[]).map((c, i) => `
          <button class="remark-color-btn${i === 0 ? ' active' : ''}" data-color="${c}" title="${t(`remark_color_${c}`, COLOR_LABELS[c])}">
            ${COLOR_MAP[c].emoji} <span class="remark-color-label">${getColorLabel(c)}</span>
          </button>
        `).join('')}
      </div>
      <textarea class="remark-note-input" placeholder="${t('remark_add_note', 'Add a note...')}" rows="2"></textarea>
      <div class="remark-popup-actions">
        <button class="remark-cancel-btn">${t('remark_cancel', 'Cancel & remove')}</button>
      </div>
    `;
  }

  function hidePopup(): void {
    if (popupEl) {
      popupEl.remove();
      popupEl = null;
    }
    // Remove any temporary block highlight
    document.querySelectorAll('.remark-popup-target')
      .forEach(el => el.classList.remove('remark-popup-target'));
  }

  // ─── Annotations ───────────────────────────────────────────────────────────

  function notifyCount(): void {
    onAnnotationCountChange?.(annotations.length);
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

  function removeAnnotation(id: string): void {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    // Soft-delete: hide item and show undo toast with countdown
    const item = sidebarEl?.querySelector<HTMLElement>(`.remark-sidebar-item[data-ann-id="${id}"]`);
    if (item) {
      item.style.opacity = '0.3';
      item.style.pointerEvents = 'none';
      const UNDO_SECONDS = 5;
      let remaining = UNDO_SECONDS;
      // Show inline undo row with countdown and progress bar
      const undo = document.createElement('div');
      undo.className = 'remark-undo-row';
      undo.setAttribute('role', 'status');
      undo.setAttribute('aria-live', 'polite');
      undo.innerHTML = `<span>${t('remark_deleted', 'Deleted')}</span><div class="remark-undo-actions"><span class="remark-undo-countdown">${remaining}s</span><button class="remark-undo-btn">↩ ${t('remark_undo', 'Undo')}</button></div><div class="remark-undo-progress" style="animation-duration:${UNDO_SECONDS}s"></div>`;
      item.after(undo);
      const countdownEl = undo.querySelector('.remark-undo-countdown')!;
      let committed = false;
      const tick = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          countdownEl.textContent = `${remaining}s`;
        } else {
          clearInterval(tick);
        }
      }, 1000);
      const commit = () => {
        if (committed) return;
        committed = true;
        clearInterval(tick);
        undo.remove();
        annotations = annotations.filter(a => a.id !== id);
        renderHighlights();
        renderSidebarContent();
        notifyCount();
        void saveAnnotations();
      };
      undo.querySelector('.remark-undo-btn')?.addEventListener('click', () => {
        if (committed) return;
        committed = true;
        clearInterval(tick);
        clearTimeout(timer);
        undo.remove();
        item.style.opacity = '';
        item.style.pointerEvents = '';
      });
      const timer = setTimeout(commit, UNDO_SECONDS * 1000);
    } else {
      // Fallback: immediate delete (sidebar not rendered)
      annotations = annotations.filter(a => a.id !== id);
      renderHighlights();
      renderSidebarContent();
      notifyCount();
      void saveAnnotations();
    }
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
          <button class="remark-sidebar-export" title="${t('remark_copy_tooltip', 'Copy all remarks to clipboard')}">📋 ${t('remark_copy_btn', 'Copy remarks')}</button>
          <button class="remark-sidebar-clear" title="${t('remark_clear_all', 'Clear all remarks')}">🗑️</button>
        </div>
      </div>
      <div class="remark-sidebar-list"></div>
    `;

    el.classList.remove('remark-sidebar-closed');

    // Wire export button: copy and reset (no auto-exit, allows repeated copy)
    const exportBtn = el.querySelector<HTMLButtonElement>('.remark-sidebar-export');
    exportBtn?.addEventListener('click', async () => {
      const result = await exportToClipboard();
      if (exportBtn) {
        if (result.ok) {
          exportBtn.textContent = `✅ ${t('remark_copied', 'Copied!')}`;
          exportBtn.disabled = true;
          setTimeout(() => {
            exportBtn.textContent = `📋 ${t('remark_copy_btn', 'Copy remarks')}`;
            exportBtn.disabled = false;
          }, 2000);
        } else {
          exportBtn.textContent = `⚠️ ${t('remark_copy_failed', 'Failed')}`;
          setTimeout(() => { exportBtn.textContent = `📋 ${t('remark_copy_btn', 'Copy remarks')}`; exportBtn.disabled = false; }, 2000);
        }
      }
    });

    // Wire clear-all button — immediate clear with 5s undo (consistent with single-item delete)
    const clearBtn = el.querySelector<HTMLButtonElement>('.remark-sidebar-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (annotations.length === 0) return;
        const UNDO_SECONDS = 5;
        const savedAnnotations = [...annotations];
        annotations = [];
        renderHighlights();
        renderSidebarContent();
        notifyCount();
        void saveAnnotations();

        const list = el.querySelector<HTMLElement>('.remark-sidebar-list');
        if (!list) return;
        let remaining = UNDO_SECONDS;
        const undo = document.createElement('div');
        undo.className = 'remark-undo-row';
        undo.setAttribute('role', 'status');
        undo.setAttribute('aria-live', 'polite');
        undo.innerHTML = `<span>${t('remark_all_cleared', 'All cleared')}</span><div class="remark-undo-actions"><span class="remark-undo-countdown">${remaining}s</span><button class="remark-undo-btn">↩ ${t('remark_undo', 'Undo')}</button></div><div class="remark-undo-progress" style="animation-duration:${UNDO_SECONDS}s"></div>`;
        list.prepend(undo);

        const countdownEl = undo.querySelector<HTMLElement>('.remark-undo-countdown')!;
        let committed = false;
        const tick = setInterval(() => {
          remaining--;
          if (remaining > 0) countdownEl.textContent = `${remaining}s`;
          else clearInterval(tick);
        }, 1000);
        const commit = (): void => {
          if (committed) return;
          committed = true;
          clearInterval(tick);
          undo.remove();
        };
        undo.querySelector('.remark-undo-btn')?.addEventListener('click', () => {
          if (committed) return;
          committed = true;
          clearInterval(tick);
          clearTimeout(timer);
          undo.remove();
          annotations = savedAnnotations;
          renderHighlights();
          renderSidebarContent();
          notifyCount();
          void saveAnnotations();
        });
        const timer = setTimeout(commit, UNDO_SECONDS * 1000);
      });
    }

    renderSidebarContent();
  }

  function hideSidebar(): void {
    if (sidebarEl) {
      sidebarEl.classList.add('remark-sidebar-closed');
      // Remove margin immediately so it transitions simultaneously with the sidebar slide-out
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

    // Update count badge in header
    if (countEl) {
      countEl.textContent = annotations.length > 0 ? `(${annotations.length})` : '';
    }

    if (annotations.length === 0) {
      list.innerHTML = `<div class="remark-sidebar-empty">${t('remark_empty_hint', 'Select text to add remarks')}</div>`;
      return;
    }

    const sorted = [...annotations].sort((a, b) => a.startLine - b.startLine);
    list.innerHTML = sorted.map(ann => {
      const lineRef = formatLineRef(ann.startLine, ann.endLine);
      const quote = escapeHtml(truncate(ann.selectedText, 50));
      const noteHtml = ann.note
        ? `<div class="remark-sidebar-note" data-editable title="${t('remark_edit_note', 'Click to edit')}">${escapeHtml(ann.note)}</div>`
        : `<div class="remark-sidebar-note remark-note-placeholder" data-editable title="${t('remark_add_note', 'Add a note…')}">${t('remark_add_note', 'Add a note…')}</div>`;

      return `
        <div class="remark-sidebar-item" data-ann-id="${ann.id}">
          <div class="remark-sidebar-item-header">
            <span>${COLOR_MAP[ann.color].emoji} <strong>${lineRef}</strong></span>
            <button class="remark-sidebar-delete" data-ann-id="${ann.id}" title="${t('remark_delete', 'Delete')}">✕</button>
          </div>
          <div class="remark-sidebar-quote">"${quote}"</div>
          ${noteHtml}
        </div>
      `;
    }).join('');

    const focusAnnotationFromSidebar = (id: string): void => {
      const ann = annotations.find(a => a.id === id);
      if (!ann) return;

      const container = getContainer();
      if (container) {
        const block = container.querySelector(`[data-line="${ann.startLine}"]`) as HTMLElement | null;
        if (block) block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      const targetItem = list.querySelector(`.remark-sidebar-item[data-ann-id="${id}"]`);
      const noteEl = targetItem?.querySelector('[data-editable]') as HTMLElement | null;
      if (noteEl) noteEl.click();
    };

    const requestAnnotationFocus = (id: string, event?: MouseEvent): void => {
      const activeEditor = sidebarEl?.querySelector('.remark-sidebar-note-editor') as HTMLTextAreaElement | null;
      const activeItemId = activeEditor?.closest('.remark-sidebar-item')?.getAttribute('data-ann-id') || null;

      if (activeEditor && activeItemId !== id) {
        pendingFocusId = id;
        event?.preventDefault();
        activeEditor.blur();
        return;
      }

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

    // Wire click-to-scroll (on header/quote area, not note)
    list.querySelectorAll('.remark-sidebar-item').forEach(item => {
      const header = item.querySelector('.remark-sidebar-item-header');
      const quote = item.querySelector('.remark-sidebar-quote');
      [header, quote].forEach(el => {
        el?.addEventListener('mousedown', (e) => {
          if ((e.target as HTMLElement | null)?.closest?.('.remark-sidebar-delete')) return;
          const id = (item as HTMLElement).dataset.annId;
          if (!id) return;
          requestAnnotationFocus(id, e as MouseEvent);
        });
      });

      // Wire inline note editing
      const noteEl = item.querySelector('[data-editable]') as HTMLElement | null;
      noteEl?.addEventListener('mousedown', (e) => {
        const id = (item as HTMLElement).dataset.annId;
        if (!id) return;
        const activeEditor = sidebarEl?.querySelector('.remark-sidebar-note-editor') as HTMLTextAreaElement | null;
        const activeItemId = activeEditor?.closest('.remark-sidebar-item')?.getAttribute('data-ann-id') || null;
        if (activeEditor && activeItemId !== id) {
          pendingFocusId = id;
          e.preventDefault();
          activeEditor.blur();
        }
      });
      noteEl?.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (item as HTMLElement).dataset.annId;
        if (!id) return;
        const ann = annotations.find(a => a.id === id);
        if (!ann) return;

        // Replace with textarea
        const ta = document.createElement('textarea');
        ta.className = 'remark-sidebar-note-editor';
        ta.value = ann.note;
        ta.placeholder = t('remark_add_note', 'Add a note…');
        ta.rows = 1;
        noteEl.replaceWith(ta);

        // Auto-expand textarea up to 5 lines
        const autoResize = (): void => {
          ta.style.height = 'auto';
          const lineHeight = parseInt(getComputedStyle(ta).lineHeight) || 18;
          const maxH = lineHeight * 5 + 12; // 5 lines + padding
          ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
          ta.style.overflow = ta.scrollHeight > maxH ? 'auto' : 'hidden';
        };
        ta.addEventListener('input', autoResize);
        // Initial auto-resize after DOM insertion
        requestAnimationFrame(autoResize);

        ta.focus();
        // Place cursor at end without selecting text
        const len = ta.value.length;
        ta.setSelectionRange(len, len);

        const saveEdit = (): void => {
          const newNote = ta.value.trim();
          updateAnnotationNote(id, newNote);
          // renderSidebarContent is called inside updateAnnotationNote
        };

        ta.addEventListener('blur', saveEdit);
        ta.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter' && !ke.shiftKey) {
            ke.preventDefault();
            ta.blur();
          }
          if (ke.key === 'Escape') {
            ta.removeEventListener('blur', saveEdit);
            renderSidebarContent();
          }
        });
      });
    });

    // Handle pending focus from click chain (when clicking note B while A was editing)
    if (pendingFocusId) {
      const focusId = pendingFocusId;
      pendingFocusId = null;
      setTimeout(() => focusAnnotationFromSidebar(focusId), 0);
    }
  }

  // ─── Highlights ────────────────────────────────────────────────────────────

  function renderHighlights(): void {
    clearHighlights();
    const container = getContainer();
    if (!container) return;

    for (const ann of annotations) {
      const blocks = container.querySelectorAll<HTMLElement>('[data-line]');
      for (const block of blocks) {
        const { start: blockLine, end: blockEnd } = getBlockRange(block);

        if (rangesOverlap(blockLine, blockEnd, ann.startLine, ann.endLine)) {
          block.classList.add('remark-highlighted');
          block.style.setProperty('--remark-bg', COLOR_MAP[ann.color].bg);
          block.style.setProperty('--remark-border', COLOR_MAP[ann.color].border);

          if (!block.querySelector(`.remark-badge[data-ann-id="${ann.id}"]`)) {
            const badge = document.createElement('span');
            badge.className = 'remark-badge';
            badge.dataset.annId = ann.id;
            badge.textContent = '✕';
            badge.title = `${t('remark_delete', 'Delete')}: ${ann.note || getColorLabel(ann.color)}`;
            badge.style.color = COLOR_MAP[ann.color].border;
            block.style.position = 'relative';
            badge.addEventListener('click', (e) => {
              e.stopPropagation();
              removeAnnotation(ann.id);
            });
            block.appendChild(badge);
          }
        }
      }
    }
  }

  function clearHighlights(): void {
    const container = getContainer();
    if (!container) return;

    container.querySelectorAll('.remark-highlighted').forEach(el => {
      el.classList.remove('remark-highlighted');
      (el as HTMLElement).style.removeProperty('--remark-bg');
      (el as HTMLElement).style.removeProperty('--remark-border');
    });
    container.querySelectorAll('.remark-badge').forEach(el => el.remove());
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

    return formatExportText(annotations, filePath, {
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
      .remark-mode-active [data-line][data-block-id]:not(:has(img, svg, canvas, figure, video)):hover {
        outline: 1px dashed var(--color-nav-active-border, var(--color-theme-accent, var(--color-primary, #2563eb)));
        outline-offset: 2px;
        border-radius: 3px;
      }
      /* Temporary highlight on the block being annotated */
      .remark-popup-target {
        outline: 2px dashed var(--color-nav-active-border, var(--color-theme-accent, var(--color-primary, #2563eb))) !important;
        outline-offset: 3px;
        border-radius: 3px;
        background: var(--color-nav-active-bg, var(--color-theme-accent-subtle, var(--color-primary-subtle, rgba(37, 99, 235, 0.06))));
      }
      .remark-highlighted {
        background: var(--remark-bg, rgba(250, 204, 21, 0.15));
        border-left: 3px solid var(--remark-border, rgba(250, 204, 21, 0.6));
        padding-left: 8px;
        border-radius: 3px;
        transition: background 0.2s;
        cursor: pointer;
      }
      .remark-badge {
        position: absolute;
        top: 2px;
        right: -24px;
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
        opacity: 0;
        transition: opacity 0.15s, background 0.15s;
        width: 16px;
        height: 16px;
        line-height: 16px;
        text-align: center;
        border-radius: 50%;
        background: var(--gray-100, #f3f4f6);
      }
      .remark-highlighted:hover .remark-badge,
      .remark-badge:hover {
        opacity: 1;
      }
      .remark-badge:hover {
        background: var(--color-danger-bg, rgba(239, 68, 68, 0.15));
        color: var(--color-danger, #ef4444) !important;
        transform: scale(1.1);
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
      /* Undo row after soft-deleted item */
      .remark-undo-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 8px;
        margin-bottom: 8px;
        border-radius: 6px;
        background: var(--gray-100, #f3f4f6);
        font-size: 12px;
        color: var(--gray-500, #6b7280);
        position: relative;
        overflow: hidden;
      }
      .remark-undo-btn {
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        background: var(--color-bg-surface, #fff);
        cursor: pointer;
        font-size: 11px;
        padding: 2px 8px;
        color: var(--color-theme-accent, var(--color-primary, #2563eb));
      }
      .remark-undo-btn:hover { background: var(--gray-50, #f9fafb); }
      .remark-undo-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .remark-undo-countdown {
        font-size: 10px;
        color: var(--gray-400, #9ca3af);
        font-variant-numeric: tabular-nums;
        min-width: 18px;
        text-align: right;
      }
      .remark-sidebar-quote {
        font-style: italic;
        color: var(--gray-500, #6b7280);
        font-size: 12px;
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .remark-sidebar-note {
        margin-top: 4px;
        font-size: 12px;
        color: var(--color-text-primary, #1a1a1a);
        background: var(--gray-50, #f9fafb);
        padding: 4px 8px;
        border-radius: 4px;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 5;
        -webkit-box-orient: vertical;
        line-height: 18px;
      }

      /* Popup */
      .remark-popup {
        position: fixed;
        z-index: 10001;
        background: var(--color-bg-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 8px;
        box-shadow: var(--shadow-floating, 0 4px 16px rgba(0,0,0,0.15));
        padding: 12px;
        width: 320px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: var(--color-text-primary, #1a1a1a);
      }
      .remark-popup-header {
        margin-bottom: 8px;
      }
      .remark-popup-quote {
        font-style: italic;
        color: var(--gray-500, #6b7280);
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .remark-popup-colors {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
      }
      .remark-color-btn {
        border: 2px solid transparent;
        border-radius: 6px;
        background: var(--gray-100, #f3f4f6);
        padding: 4px 8px;
        cursor: pointer;
        font-size: 16px;
        color: var(--color-text-primary, #1a1a1a);
        transition: border-color 0.15s;
      }
      .remark-color-btn:hover {
        background: var(--gray-200, #e5e7eb);
      }
      .remark-color-btn.active {
        border-color: var(--color-nav-active-border, var(--color-theme-accent, var(--color-primary, #2563eb)));
        background: var(--color-nav-active-bg, var(--color-theme-accent-bg, var(--color-primary-light, #eff6ff)));
        color: var(--color-nav-active-text, var(--color-theme-accent, var(--color-primary, #2563eb)));
      }
      .remark-note-input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 6px;
        padding: 8px;
        font-size: 13px;
        font-family: inherit;
        resize: vertical;
        min-height: 48px;
        margin-bottom: 8px;
        color: inherit;
        background: var(--gray-50, #f9fafb);
      }
      .remark-note-input:focus {
        outline: none;
        border-color: var(--color-nav-active-border, var(--color-theme-accent, var(--color-primary, #2563eb)));
        box-shadow: 0 0 0 2px var(--color-theme-accent-subtle, var(--color-primary-subtle, #dbeafe));
      }
      .remark-popup-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .remark-popup-actions button {
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        border: 1px solid var(--color-border, #e2e8f0);
        background: var(--gray-50, #f9fafb);
        color: inherit;
        transition: background 0.15s;
      }
      .remark-popup-actions button:hover {
        background: var(--gray-200, #e5e7eb);
      }
      .remark-save-btn {
        background: var(--color-theme-accent, var(--color-primary, #2563eb)) !important;
        color: var(--color-text-on-primary, #fff) !important;
        border-color: var(--color-theme-accent, var(--color-primary, #2563eb)) !important;
      }
      .remark-save-btn:hover {
        background: var(--color-theme-accent-hover, var(--color-primary-hover, #1d4ed8)) !important;
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

      /* Sidebar note editable */
      .remark-sidebar-note[data-editable] {
        cursor: pointer;
      }
      .remark-note-placeholder {
        color: var(--gray-400, #9ca3af) !important;
        font-style: italic;
      }
      .remark-sidebar-note-editor {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-nav-active-border, var(--color-theme-accent, var(--color-primary, #2563eb)));
        border-radius: 4px;
        padding: 4px 6px;
        font-size: 12px;
        font-family: inherit;
        resize: none;
        overflow: hidden;
        margin-top: 4px;
        background: var(--color-bg-surface, #fff);
        color: var(--color-text-primary, #1a1a1a);
        box-shadow: 0 0 0 2px var(--color-theme-accent-subtle, var(--color-primary-subtle, #dbeafe));
        line-height: 18px;
      }
      .remark-sidebar-count {
        color: var(--gray-500, #6b7280);
        font-weight: normal;
        font-size: 13px;
      }

      /* ── UX Delight: Animations ─────────────────────────────── */
      @media (prefers-reduced-motion: no-preference) {
        /* Popup scale-in */
        .remark-popup {
          animation: remark-popup-in 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
          transform-origin: top center;
        }
        @keyframes remark-popup-in {
          from { opacity: 0; transform: scale(0.9) translateY(-4px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }

        /* Color button ink splash on selection */
        .remark-color-btn.active {
          animation: remark-ink 0.3s ease-out;
        }
        @keyframes remark-ink {
          0% { box-shadow: 0 0 0 0 var(--color-theme-accent-subtle, var(--color-primary-subtle, #dbeafe)); }
          70% { box-shadow: 0 0 0 6px transparent; }
          100% { box-shadow: none; }
        }

        /* Undo progress bar shrink */
        .remark-undo-progress {
          animation: remark-shrink linear forwards;
        }
        @keyframes remark-shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      }

      /* Undo progress bar base style */
      .remark-undo-progress {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 2px;
        width: 100%;
        background: var(--color-theme-accent, var(--color-primary, #2563eb));
        opacity: 0.4;
        pointer-events: none;
      }

      /* Color button labels */
      .remark-color-label {
        font-size: 11px;
        vertical-align: middle;
        color: inherit;
        opacity: 0.8;
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
