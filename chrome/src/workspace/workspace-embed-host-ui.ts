import { createTocPanel } from '../../../src/ui/toc-panel';
import type { TocPanel } from '../../../src/ui/toc-panel';
import { extractHeadings } from '../../../src/core/markdown-utils';
import { resolveTocPresentation } from '../../../src/core/viewer/viewer-session-contract';
import type { ViewerSyncHostUiMessage } from '../../../src/integration/iframe-viewer-host';

interface HostUiSnapshot {
  containerMode?: ViewerSyncHostUiMessage['containerMode'];
  tocDepth?: number;
}

interface PendingHostUiEffects {
  layoutChanged: boolean;
}

interface WorkspaceEmbedHostUiOptions {
  scrollToAnchor: (anchor: string) => void;
  applyTheme: (themeId: string) => void | Promise<void>;
}

export interface WorkspaceEmbedHostUiController {
  attachWrapperInteractionFixes(): void;
  syncHostUi(message: ViewerSyncHostUiMessage): void;
  applyAfterRender(): void;
}

const TOC_NAVIGATION_SCROLL_BEHAVIOR: ScrollBehavior = 'auto';

export function createWorkspaceEmbedHostUiController(
  options: WorkspaceEmbedHostUiOptions,
): WorkspaceEmbedHostUiController {
  const { scrollToAnchor, applyTheme } = options;

  let hostUiSnapshot: HostUiSnapshot = {
    containerMode: 'browser',
    tocDepth: undefined,
  };

  let pendingHostUiEffects: PendingHostUiEffects = {
    layoutChanged: false,
  };

  let floatingTocPanel: TocPanel | null = null;
  let floatingScrollListener: (() => void) | null = null;
  let floatingContentObserver: MutationObserver | null = null;
  let floatingUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeWheelFallbackArmed = false;
  let wrapperInteractionFixesAttached = false;
  let handlingManualWheelScroll = false;
  let wheelFallbackHandler: ((event: WheelEvent) => void) | null = null;
  let wheelFallbackTimeout: ReturnType<typeof setTimeout> | null = null;

  const updateFloatingTocActiveHeading = (): void => {
    if (!floatingTocPanel) return;
    const contentDiv = document.getElementById('markdown-content');
    const wrapper = document.getElementById('markdown-wrapper');
    if (!contentDiv || !wrapper) {
      floatingTocPanel.setActiveHeading(null);
      return;
    }

    const headings = contentDiv.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) {
      floatingTocPanel.setActiveHeading(null);
      return;
    }

    const scrollTop = wrapper.scrollTop;
    const wrapperRect = wrapper.getBoundingClientRect();
    let activeId: string | null = null;
    for (const heading of headings) {
      const top = heading.getBoundingClientRect().top - wrapperRect.top + scrollTop;
      if (top <= scrollTop + 10) activeId = heading.id || null;
      else break;
    }
    if (!activeId && headings[0]) activeId = headings[0].id || null;
    floatingTocPanel.setActiveHeading(activeId);
  };

  const updateFloatingTocHeadings = (): void => {
    if (!floatingTocPanel) return;
    const contentDiv = document.getElementById('markdown-content');
    if (!contentDiv) return;
    const maxDepth = typeof hostUiSnapshot.tocDepth === 'number' && Number.isFinite(hostUiSnapshot.tocDepth)
      ? Math.max(1, Math.min(6, Math.floor(hostUiSnapshot.tocDepth)))
      : 6;
    const all = extractHeadings(contentDiv);
    floatingTocPanel.setHeadings(all.filter((heading) => heading.level <= maxDepth));
    updateFloatingTocActiveHeading();
  };

  const scheduleFloatingTocHeadingsUpdate = (): void => {
    if (!floatingTocPanel) return;
    if (floatingUpdateTimer !== null) clearTimeout(floatingUpdateTimer);
    floatingUpdateTimer = setTimeout(() => {
      floatingUpdateTimer = null;
      updateFloatingTocHeadings();
    }, 150);
  };

  const ensureFloatingTocPanel = (): TocPanel => {
    if (floatingTocPanel && !floatingTocPanel.getElement().isConnected) {
      floatingTocPanel.dispose();
      floatingTocPanel = null;
      floatingContentObserver = null;
      floatingScrollListener = null;
    }

    if (!floatingTocPanel) {
      floatingTocPanel = createTocPanel({ onSelectHeading: scrollToAnchor });
      document.body.appendChild(floatingTocPanel.getElement());
    }

    const wrapper = document.getElementById('markdown-wrapper');
    if (wrapper && !floatingScrollListener) {
      floatingScrollListener = () => updateFloatingTocActiveHeading();
      wrapper.addEventListener('scroll', floatingScrollListener);
    }

    const contentDiv = document.getElementById('markdown-content');
    if (contentDiv && !floatingContentObserver) {
      floatingContentObserver = new MutationObserver(() => scheduleFloatingTocHeadingsUpdate());
      floatingContentObserver.observe(contentDiv, { childList: true, subtree: true });
    }
    return floatingTocPanel;
  };

  const destroyFloatingTocPanel = (): void => {
    if (floatingUpdateTimer !== null) {
      clearTimeout(floatingUpdateTimer);
      floatingUpdateTimer = null;
    }
    if (floatingContentObserver) {
      floatingContentObserver.disconnect();
      floatingContentObserver = null;
    }
    if (floatingScrollListener) {
      document.getElementById('markdown-wrapper')?.removeEventListener('scroll', floatingScrollListener);
      floatingScrollListener = null;
    }
    if (floatingTocPanel) {
      floatingTocPanel.dispose();
      floatingTocPanel = null;
    }
  };

  const normalizeWheelDelta = (event: WheelEvent, wrapper: HTMLElement): number => {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return event.deltaY * 16;
    }
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return event.deltaY * wrapper.clientHeight;
    }
    return event.deltaY;
  };

  const clearWheelFallbackTimeout = (): void => {
    if (wheelFallbackTimeout !== null) {
      clearTimeout(wheelFallbackTimeout);
      wheelFallbackTimeout = null;
    }
  };

  const disarmResizeWheelFallback = (): void => {
    resizeWheelFallbackArmed = false;
    clearWheelFallbackTimeout();

    const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
    if (!wrapper || !wheelFallbackHandler) {
      return;
    }

    wrapper.removeEventListener('wheel', wheelFallbackHandler as EventListener);
    wheelFallbackHandler = null;
  };

  const armResizeWheelFallback = (): void => {
    const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
    if (!wrapper) {
      return;
    }

    resizeWheelFallbackArmed = true;

    if (!wheelFallbackHandler) {
      wheelFallbackHandler = (event: WheelEvent) => {
        if (!resizeWheelFallbackArmed) {
          return;
        }

        if (event.defaultPrevented || event.ctrlKey || event.metaKey) {
          return;
        }

        const maxScrollTop = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
        if (maxScrollTop <= 0) {
          return;
        }

        const beforeScrollTop = wrapper.scrollTop;
        const nextScrollTop = Math.max(
          0,
          Math.min(maxScrollTop, beforeScrollTop + normalizeWheelDelta(event, wrapper)),
        );

        if (Math.abs(nextScrollTop - beforeScrollTop) < 0.5) {
          return;
        }

        event.preventDefault();
        handlingManualWheelScroll = true;
        wrapper.scrollTop = nextScrollTop;
      };

      wrapper.addEventListener('wheel', wheelFallbackHandler, { passive: false });
    }

    clearWheelFallbackTimeout();
    wheelFallbackTimeout = setTimeout(() => {
      disarmResizeWheelFallback();
    }, 1500);
  };

  const focusWrapperAfterLayoutChange = (): void => {
    const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
    if (!wrapper) {
      return;
    }

    if (!wrapper.hasAttribute('tabindex')) {
      wrapper.tabIndex = -1;
    }

    window.focus();
    wrapper.focus({ preventScroll: true });
  };

  const updateHostUiSnapshot = (message: Pick<ViewerSyncHostUiMessage, 'containerMode' | 'tocDepth'>): void => {
    hostUiSnapshot = {
      ...hostUiSnapshot,
      ...message,
    };
  };

  const queueHostUiEffects = (message: Pick<ViewerSyncHostUiMessage, 'layoutChanged'>): void => {
    if (message.layoutChanged) {
      pendingHostUiEffects = {
        ...pendingHostUiEffects,
        layoutChanged: true,
      };
    }
  };

  const applyHostUiSnapshot = (): void => {
    const { containerMode, tocDepth } = hostUiSnapshot;

    const tocDiv = document.getElementById('table-of-contents') as HTMLElement | null;
    const overlayDiv = document.getElementById('toc-overlay') as HTMLElement | null;
    const tocPresentation = resolveTocPresentation(containerMode ?? 'browser');

    if (tocPresentation === 'floating') {
      if (tocDiv) {
        tocDiv.classList.add('hidden');
        tocDiv.style.display = 'none';
      }
      document.body.classList.add('toc-hidden');
      if (overlayDiv) overlayDiv.classList.add('hidden');
      ensureFloatingTocPanel();
      updateFloatingTocHeadings();
      return;
    }

    destroyFloatingTocPanel();

    // When TOC is disabled for the current file (non-.md / non-.markdown),
    // keep the panel hidden — do not undo the state set by applyOpenDocumentMetadata.
    if (document.documentElement.dataset.tocDisabled === '1') {
      if (tocDiv) {
        tocDiv.classList.add('hidden');
        tocDiv.style.display = 'none';
      }
      document.body.classList.add('toc-hidden');
      if (overlayDiv) overlayDiv.classList.add('hidden');
      return;
    }

    if (tocDiv) {
      tocDiv.classList.remove('hidden');
      tocDiv.style.display = '';
    }
    document.body.classList.remove('toc-hidden');
    if (overlayDiv) overlayDiv.classList.add('hidden');
    if (tocDiv && typeof tocDepth === 'number' && Number.isFinite(tocDepth)) {
      const maxDepth = Math.max(1, Math.min(6, Math.floor(tocDepth)));
      tocDiv.querySelectorAll('li').forEach((item) => {
        const marginLeft = Number.parseInt((item as HTMLElement).style.marginLeft || '0', 10);
        const level = Math.floor(marginLeft / 20) + 1;
        (item as HTMLElement).style.display = level > maxDepth ? 'none' : '';
      });
    }
  };

  const applyPendingHostUiEffects = (): void => {
    if (!pendingHostUiEffects.layoutChanged) {
      return;
    }

    pendingHostUiEffects = {
      ...pendingHostUiEffects,
      layoutChanged: false,
    };

    armResizeWheelFallback();
    requestAnimationFrame(() => {
      focusWrapperAfterLayoutChange();
    });
  };

  const applyHostUiState = (options: { afterRender?: boolean } = {}): void => {
    const { afterRender = false } = options;

    applyHostUiSnapshot();
    applyPendingHostUiEffects();

    if (!afterRender || resolveTocPresentation(hostUiSnapshot.containerMode ?? 'browser') !== 'floating') {
      return;
    }

    let attempts = 0;
    const retryApplyFloating = (): void => {
      attempts += 1;
      applyHostUiSnapshot();

      const contentDiv = document.getElementById('markdown-content');
      const panelConnected = Boolean(floatingTocPanel?.getElement().isConnected);
      if (contentDiv && panelConnected) {
        return;
      }

      if (attempts >= 10) {
        return;
      }

      setTimeout(retryApplyFloating, 80);
    };

    setTimeout(retryApplyFloating, 0);
  };

  return {
    attachWrapperInteractionFixes(): void {
      const install = () => {
        const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
        if (!wrapper || wrapperInteractionFixesAttached) {
          return;
        }

        wrapperInteractionFixesAttached = true;

        wrapper.addEventListener('scroll', () => {
          if (handlingManualWheelScroll) {
            handlingManualWheelScroll = false;
            return;
          }

          disarmResizeWheelFallback();
        }, { passive: true });
      };

      requestAnimationFrame(install);
      window.setTimeout(install, 150);
    },

    syncHostUi(message: ViewerSyncHostUiMessage): void {
      if (message.themeId) {
        void applyTheme(message.themeId);
      }

      if (message.containerMode !== undefined || message.tocDepth !== undefined) {
        updateHostUiSnapshot({
          containerMode: message.containerMode,
          tocDepth: message.tocDepth,
        });
      }

      queueHostUiEffects({ layoutChanged: message.layoutChanged });
      applyHostUiState();
    },

    applyAfterRender(): void {
      applyHostUiState({ afterRender: true });
    },
  };
}

export { TOC_NAVIGATION_SCROLL_BEHAVIOR };