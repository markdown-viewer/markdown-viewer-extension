/**
 * Shared TOC Panel Component
 *
 * Narrow-screen first Table of Contents drawer.
 * Uses an overlay drawer and collapses immediately after heading selection.
 */

import Localization from '../utils/localization';
import type { HeadingInfo } from '../core/markdown-processor';

export interface TocPanelOptions {
  onSelectHeading?: (headingId: string) => void;
}

export interface TocPanel {
  setHeadings: (headings: HeadingInfo[]) => void;
  setActiveHeading: (headingId: string | null) => void;
  show: () => void;
  hide: () => void;
  toggle: () => void;
  isVisible: () => boolean;
  updateLocalization: () => void;
  getElement: () => HTMLElement;
  dispose: () => void;
}

export function createTocPanel(options: TocPanelOptions = {}): TocPanel {
  const { onSelectHeading } = options;

  let visible = false;
  let headings: HeadingInfo[] = [];
  let activeHeadingId: string | null = null;

  const root = document.createElement('div');
  root.className = 'vscode-toc-root';

  root.innerHTML = `
    <button class="vscode-toc-fab" type="button" aria-label="${Localization.translate('toc') || 'Table of Contents'}" title="${Localization.translate('toolbar_toggle_toc_title') || 'Show or hide table of contents'}">
      <span class="vscode-toc-fab-icon" aria-hidden="true">≡</span>
    </button>
    <div class="vscode-toc-overlay" hidden></div>
    <aside class="vscode-toc-drawer" aria-hidden="true">
      <div class="vscode-toc-header">
        <span class="vscode-toc-title">${Localization.translate('toc') || 'Table of Contents'}</span>
        <button class="vscode-toc-close" type="button" aria-label="${Localization.translate('close') || 'Close'}" title="${Localization.translate('close') || 'Close'}">×</button>
      </div>
      <div class="vscode-toc-body">
        <ul class="vscode-toc-list"></ul>
        <div class="vscode-toc-empty">-</div>
      </div>
    </aside>
  `;

  const fab = root.querySelector('.vscode-toc-fab') as HTMLButtonElement;
  fab.style.display = 'none'; // hidden until headings are set
  const overlay = root.querySelector('.vscode-toc-overlay') as HTMLDivElement;
  const drawer = root.querySelector('.vscode-toc-drawer') as HTMLElement;
  const closeBtn = root.querySelector('.vscode-toc-close') as HTMLButtonElement;
  const list = root.querySelector('.vscode-toc-list') as HTMLUListElement;
  const emptyState = root.querySelector('.vscode-toc-empty') as HTMLDivElement;
  const title = root.querySelector('.vscode-toc-title') as HTMLSpanElement;
  let pendingHideTransitionHandler: (() => void) | null = null;

  function clearPendingHideTransitionHandler(): void {
    if (!pendingHideTransitionHandler) {
      return;
    }

    drawer.removeEventListener('transitionend', pendingHideTransitionHandler);
    pendingHideTransitionHandler = null;
  }

  function setVisible(nextVisible: boolean): void {
    visible = nextVisible;
    clearPendingHideTransitionHandler();

    if (nextVisible) {
      // Show: make element visible before triggering slide-in transition
      drawer.style.display = 'flex';
      // Force reflow so the transition fires from the hidden transform state
      void drawer.offsetWidth;
      drawer.classList.add('visible');
      drawer.setAttribute('aria-hidden', 'false');
    } else {
      // Hide: slide out first, then set display:none after transition
      drawer.classList.remove('visible');
      drawer.setAttribute('aria-hidden', 'true');
      pendingHideTransitionHandler = (): void => {
        clearPendingHideTransitionHandler();
        // Only hide if still not visible (user may have re-opened during transition)
        if (!visible) {
          drawer.style.display = 'none';
        }
      };
      drawer.addEventListener('transitionend', pendingHideTransitionHandler);
    }
    overlay.hidden = !nextVisible;
    fab.classList.toggle('active', nextVisible);
  }

  function hideImmediately(): void {
    visible = false;
    clearPendingHideTransitionHandler();
    drawer.classList.remove('visible');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.style.display = 'none';
    overlay.hidden = true;
    fab.classList.remove('active');
  }

  function hide(): void {
    setVisible(false);
  }

  function show(): void {
    if (headings.length === 0) {
      return;
    }
    setVisible(true);
  }

  function renderList(): void {
    list.innerHTML = '';

    if (headings.length === 0) {
      emptyState.style.display = 'block';
      fab.disabled = true;
      fab.style.display = 'none';
      hide();
      return;
    }

    emptyState.style.display = 'none';
    fab.disabled = false;
    fab.style.display = '';

    for (const heading of headings) {
      const li = document.createElement('li');
      li.className = 'vscode-toc-item';
      li.style.setProperty('--toc-indent', `${Math.max(0, heading.level - 1) * 10}px`);

      const btn = document.createElement('button');
      btn.className = 'vscode-toc-link';
      btn.type = 'button';
      btn.textContent = heading.text || heading.id;
      btn.dataset.headingId = heading.id;
      btn.title = heading.text || heading.id;

      if (activeHeadingId === heading.id) {
        btn.classList.add('active');
      }

      btn.addEventListener('click', () => {
        hideImmediately();
        onSelectHeading?.(heading.id);
      });

      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  function setHeadings(nextHeadings: HeadingInfo[]): void {
    headings = Array.isArray(nextHeadings) ? nextHeadings : [];

    if (headings.length === 0) {
      activeHeadingId = null;
      hide();
    } else if (!activeHeadingId || !headings.some((h) => h.id === activeHeadingId)) {
      activeHeadingId = headings[0].id;
    }

    renderList();
  }

  function setActiveHeading(headingId: string | null): void {
    activeHeadingId = headingId;

    list.querySelectorAll('.vscode-toc-link').forEach((el) => {
      const link = el as HTMLButtonElement;
      const isActive = headingId !== null && link.dataset.headingId === headingId;
      link.classList.toggle('active', isActive);

      if (isActive) {
        link.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  fab.addEventListener('click', () => {
    if (visible) {
      hide();
    } else {
      show();
    }
  });

  overlay.addEventListener('click', () => {
    hide();
  });

  closeBtn.addEventListener('click', () => {
    hide();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible) {
      e.preventDefault();
      hide();
    }
  });

  function updateLocalization(): void {
    const tocText = Localization.translate('toc') || 'Table of Contents';
    const toggleTitle = Localization.translate('toolbar_toggle_toc_title') || 'Show or hide table of contents';
    const closeText = Localization.translate('close') || 'Close';

    fab.setAttribute('aria-label', tocText);
    fab.title = toggleTitle;
    title.textContent = tocText;
    closeBtn.title = closeText;
    closeBtn.setAttribute('aria-label', closeText);
  }

  return {
    setHeadings,
    setActiveHeading,
    show,
    hide,
    toggle: () => {
      if (visible) {
        hide();
      } else {
        show();
      }
    },
    isVisible: () => visible,
    updateLocalization,
    getElement: () => root,
    dispose: () => {
      root.remove();
    }
  };
}