import type { TranslateFn } from '../core/viewer/viewer-host';
import { exportViewerDocument, type ViewerExportFormat } from '../core/viewer/viewer-host';
import { createPanelViewer } from '../core/viewer/panel-viewer';
import { createViewerAssembler } from '../core/viewer/viewer-assembler';
import { createPersistedStateHostBridge } from '../core/viewer/viewer-host-bridge';
import { createViewerSession } from '../core/viewer/viewer-session';
import type {
  ViewerDocumentDescriptor,
  ViewerPersistedState,
  ViewerResolvedMode,
} from '../core/viewer/viewer-session-contract';
import { createViewerSurfacePort } from '../core/viewer/viewer-surface-port';
import { escapeHtml } from '../core/markdown-utils';
import themeManager from '../utils/theme-manager';
import { loadAndApplyTheme } from '../utils/theme-to-css';
import { getWebExtensionApi } from '../utils/platform-info';
import { createTocManager } from '../../chrome/src/webview/ui/toc-manager';
import type { PluginRenderer, PlatformAPI } from '../types';
import { createViewerIframeHostBridge } from './iframe-viewer-host';

const OBSERVED_ATTRIBUTES = ['value', 'scroll-line', 'mode'] as const;
const RENDER_REQUEST_EVENT = 'mv:render-request';
const ANCHOR_REQUEST_EVENT = 'mv:scroll-to-anchor-request';
const EXPORT_REQUEST_EVENT = 'mv:export-request';
const RESPONSE_EVENT = 'mv:response';
const ELEMENT_BASE_STYLE_ID = 'mdv-element-base-style';

type MarkdownViewerRuntimeMode = 'inline' | 'iframe';

/**
 * Export formats accepted by the programmatic export command, mirroring the
 * standalone preview toolbar's export menu:
 * - 'docx' — Export to DOCX
 * - 'epub' — Export to EPUB
 * - 'html' — Export to HTML (single self-contained file)
 * - 'pdf'  — Print to PDF (browser print dialog)
 * - 'save' — Save the raw markdown file
 */
export type MarkdownViewerExportFormat = ViewerExportFormat;

/** Accepted aliases, e.g. 'docs' for 'docx'. */
export const MARKDOWN_VIEWER_EXPORT_FORMATS: readonly string[] = [
  'docx',
  'epub',
  'html',
  'pdf',
  'save',
];

export interface MarkdownViewerExportOptions {
  /** Base filename override (extension is normalized per format). */
  filename?: string;
  /** Document title override (used by 'html', 'epub' and 'pdf'). */
  title?: string;
}

interface MarkdownViewerExportRequestDetail extends MarkdownViewerExportOptions {
  requestId?: string;
  format?: string;
}

export interface MarkdownViewerElementFactoryOptions {
  platform: PlatformAPI;
  renderer: PluginRenderer;
  translate: TranslateFn;
}

interface MarkdownViewerBridgeRequestDetail {
  requestId?: string;
  markdown?: string;
  anchor?: string;
}

export interface MarkdownViewerElementRuntimeController {
  render(markdown: string): Promise<void>;
  switchTheme(themeId: string): Promise<void>;
  scrollToAnchor(anchor: string): void;
  getCurrentLine(): number | null;
  setScrollLine(line: number): void;
  /** Run an export command (docx | epub | html | pdf | save). */
  export(format: MarkdownViewerExportFormat, options?: MarkdownViewerExportOptions): Promise<void>;
  destroy(): void;
}

function normalizeExportFormat(format: unknown): MarkdownViewerExportFormat | null {
  if (typeof format !== 'string') {
    return null;
  }
  const lower = format.toLowerCase();
  if (lower === 'docs') {
    return 'docx';
  }
  return MARKDOWN_VIEWER_EXPORT_FORMATS.includes(lower)
    ? (lower as MarkdownViewerExportFormat)
    : null;
}

interface IncomingBroadcastMessage {
  type?: string;
  payload?: unknown;
}

export function bindThemeSyncFromSettingsBroadcast(
  platform: PlatformAPI,
  controllers: Map<HTMLElement, MarkdownViewerElementRuntimeController>,
): void {
  platform.message.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    const msg = message as IncomingBroadcastMessage;
    if (msg.type !== 'SETTING_CHANGED') {
      return;
    }

    const payload = msg.payload && typeof msg.payload === 'object'
      ? (msg.payload as Record<string, unknown>)
      : null;
    const key = payload?.key;
    const value = payload?.value;

    if (key === 'themeId' && typeof value === 'string') {
      controllers.forEach((controller, element) => {
        if (!element.isConnected) {
          controllers.delete(element);
          return;
        }
        void controller.switchTheme(value).catch((error) => {
          console.error('[element-runtime] switchTheme failed on setting change', error);
        });
      });
    } else if (key === 'firstLineIndent') {
      const currentTheme = themeManager.getCurrentTheme();
      if (currentTheme) {
        controllers.forEach((controller, element) => {
          if (!element.isConnected) {
            controllers.delete(element);
            return;
          }
          void controller.switchTheme(currentTheme.id).catch((error) => {
            console.error('[element-runtime] switchTheme failed on firstLineIndent change', error);
          });
        });
      }
    }
  });
}

function dispatchBridgeResponse(target: HTMLElement, requestId: string | undefined, ok: boolean, error?: unknown): void {
  target.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
    detail: {
      requestId,
      ok,
      error: error instanceof Error ? error.message : (error ? String(error) : undefined),
    },
    bubbles: true,
    composed: true,
  }));
}

function ensureElementBaseStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(ELEMENT_BASE_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = ELEMENT_BASE_STYLE_ID;
  style.textContent = `
markdown-viewer {
  display: block;
  position: relative;
}

/* Embedded layout (no toolbar, no card, TOC docked in the container) lives
   in the shared stylesheet under .mv-embed — attachMarkdownViewerElementRuntime
   adds that class to the element. This style only covers the element box
   itself, which the shared CSS cannot express. */
`;
  document.head.appendChild(style);
}

function hasRenderableContent(markdown: string): boolean {
  return markdown.trim().length > 0;
}

function resolveRuntimeMode(target: HTMLElement): MarkdownViewerRuntimeMode {
  const requestedMode = target.getAttribute('mode');
  if (requestedMode === 'inline' || requestedMode === 'iframe') {
    return requestedMode;
  }

  const existingMarkdownContent = document.getElementById('markdown-content');
  const canUseIframeEmbed = !existingMarkdownContent || existingMarkdownContent === target;
  return canUseIframeEmbed ? 'iframe' : 'inline';
}

export function attachMarkdownViewerElementRuntime(
  target: HTMLElement,
  options: MarkdownViewerElementFactoryOptions,
): MarkdownViewerElementRuntimeController {
  const { platform, renderer, translate } = options;

  ensureElementBaseStyle();
  // Embedded layout (no toolbar / card) is defined once in the shared
  // stylesheet under .mv-embed; the element just opts in.
  target.classList.add('mv-embed');

  const resolveThemeId = async (themeId: string): Promise<string> => {
    if (themeId === 'auto' || themeId === 'light' || themeId === 'dark' || !themeId) {
      return themeManager.loadSelectedTheme();
    }
    return themeId;
  };

  const saveElementState = (state: Record<string, unknown>): void => {
    const current = (target as unknown as { __mdvState?: Record<string, unknown> }).__mdvState || {};
    (target as unknown as { __mdvState?: Record<string, unknown> }).__mdvState = {
      ...current,
      ...state,
    };
  };

  const getElementState = async (): Promise<Record<string, unknown>> => {
    return (target as unknown as { __mdvState?: Record<string, unknown> }).__mdvState || {};
  };

  let container = target.querySelector(':scope > .markdown-viewer-content') as HTMLDivElement | null;
  let scrollContainer: HTMLElement | null = target.closest('#markdown-wrapper') as HTMLElement | null;
  let generateTOC = async (): Promise<void> => {};
  let updateActiveTocItem = (): void => {};
  const tocManager = createTocManager(
    (state) => saveElementState(state as Record<string, unknown>),
    async () => getElementState(),
    false,
  );
  generateTOC = tocManager.generateTOC;
  updateActiveTocItem = tocManager.updateActiveTocItem;
  const runtimeMode = resolveRuntimeMode(target);

  // HTML element mode: host the full reader in an iframe, instead of rebuilding
  // toolbar/toc logic in this runtime.
  if (runtimeMode === 'iframe') {
    const webExtensionApi = getWebExtensionApi();
    const frameId = target.id ? `mdv-frame-${target.id}` : 'mdv-frame';
    let frame = target.querySelector(`:scope > iframe#${CSS.escape(frameId)}`) as HTMLIFrameElement | null;

    if (!frame) {
      target.innerHTML = '';
      frame = document.createElement('iframe');
      frame.id = frameId;
      frame.style.display = 'block';
      frame.style.width = '100%';
      frame.style.height = 'min(78vh, 880px)';
      frame.style.border = '0';
      frame.style.borderRadius = '10px';
      frame.style.background = 'transparent';
      frame.src = webExtensionApi.runtime.getURL('ui/workspace/viewer-embed.html') + '?embed=1';
      target.appendChild(frame);
    }

    let frameReady = false;
    let currentValue = target.getAttribute('value') ?? '';
    const frameHostBridge = createViewerIframeHostBridge((message) => {
      postToFrame(message);
    });

    interface PendingIframeExport {
      resolve: () => void;
      reject: (error: Error) => void;
      dispatchResponse: (ok: boolean, error?: string) => void;
      timer: ReturnType<typeof setTimeout>;
    }
    const pendingIframeExports = new Map<string, PendingIframeExport>();

    const setFrameVisible = (visible: boolean): void => {
      if (!frame) return;
      frame.style.display = visible ? 'block' : 'none';
    };
    setFrameVisible(false);

    const postToFrame = (data: unknown): void => {
      if (!frame || !frame.contentWindow || !frameReady) {
        return;
      }
      frame.contentWindow.postMessage(data, '*');
    };

    const syncUi = (): void => {
      frameHostBridge.syncHostUi({
        containerMode: 'panel',
      });
    };

    const syncRender = (targetLine?: number): void => {
      frameHostBridge.syncDocument({
        documentKey: 'inline',
        content: currentValue,
        filename: 'inline.md',
        fileDir: '',
        codeView: false,
        targetLine,
      });
    };

    const onFrameMessage = (event: MessageEvent): void => {
      if (!frame || event.source !== frame.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;
      const data = event.data as { type?: string };
      if (data.type === 'VIEWER_READY') {
        frameReady = true;
        frameHostBridge.reset();
        syncUi();
        const shouldShow = hasRenderableContent(currentValue);
        setFrameVisible(shouldShow);
        if (shouldShow) {
          const rawLine = target.getAttribute('scroll-line');
          const line = rawLine ? Number.parseInt(rawLine, 10) : Number.NaN;
          syncRender(Number.isFinite(line) ? line : undefined);
        }
        return;
      }
      if (data.type === 'VIEWER_RENDERED') {
        setFrameVisible(hasRenderableContent(currentValue));
        return;
      }
      if (data.type === 'EXPORT_RESULT') {
        const detail = data as { requestId?: string; ok?: boolean; error?: string };
        const requestId = detail.requestId;
        if (!requestId) {
          return;
        }
        const pending = pendingIframeExports.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingIframeExports.delete(requestId);
          pending.dispatchResponse(Boolean(detail.ok), detail.error);
          if (detail.ok) {
            pending.resolve();
          } else {
            pending.reject(new Error(detail.error || 'Export failed'));
          }
        }
        return;
      }
      if (data.type === 'VIEWER_SCROLL_LINE_CHANGED') {
        const detail = data as { line?: unknown };
        const line = typeof detail.line === 'number' && Number.isFinite(detail.line) ? detail.line : null;
        if (line === null) {
          return;
        }
        target.setAttribute('data-mv-current-line', String(line));
        target.dispatchEvent(new CustomEvent('scrolllinechange', {
          detail: { line },
          bubbles: true,
          composed: true,
        }));
      }
    };
    window.addEventListener('message', onFrameMessage);

    const runIframeExport = (
      format: MarkdownViewerExportFormat,
      options: MarkdownViewerExportOptions | undefined,
      requestId: string,
      dispatchResponse: (ok: boolean, error?: string) => void,
    ): Promise<void> => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingIframeExports.delete(requestId);
          const error = new Error('Export timed out: the embedded viewer did not respond');
          dispatchResponse(false, error.message);
          reject(error);
        }, 60000);
        pendingIframeExports.set(requestId, {
          resolve,
          reject,
          dispatchResponse,
          timer,
        });
        frameHostBridge.requestExport({
          format,
          requestId,
          filename: options?.filename,
          title: options?.title,
        });
      });
    };

    const iframeExportDocument = (
      format: MarkdownViewerExportFormat,
      options?: MarkdownViewerExportOptions,
      requestId?: string,
    ): Promise<void> => {
      const exportId = requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const dispatchResponse = (ok: boolean, error?: string): void => {
        if (!requestId) {
          return;
        }
        dispatchBridgeResponse(target, requestId, ok, error);
      };
      return runIframeExport(format, options, exportId, dispatchResponse);
    };

    const onExportRequest = (event: Event): void => {
      const detail = (event as CustomEvent<MarkdownViewerExportRequestDetail>).detail ?? {};
      const format = normalizeExportFormat(detail.format);
      if (!format) {
        dispatchBridgeResponse(
          target,
          detail.requestId,
          false,
          `Unsupported export format: ${String(detail.format)}`,
        );
        return;
      }
      void iframeExportDocument(format, detail, detail.requestId).catch(() => {
        // Failure already reported via dispatchResponse above.
      });
    };
    target.addEventListener(EXPORT_REQUEST_EVENT, onExportRequest as EventListener);

    const attributeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes') continue;
        const name = mutation.attributeName;
        if (name === 'value') {
          currentValue = target.getAttribute('value') ?? '';
          const shouldShow = hasRenderableContent(currentValue);
          setFrameVisible(shouldShow);
          const rawLine = target.getAttribute('scroll-line');
          const line = rawLine ? Number.parseInt(rawLine, 10) : Number.NaN;
          syncRender(Number.isFinite(line) ? line : undefined);
          continue;
        }
        if (name === 'scroll-line') {
          const rawLine = target.getAttribute('scroll-line');
          if (!rawLine) continue;
          const line = Number.parseInt(rawLine, 10);
          if (Number.isFinite(line)) {
            frameHostBridge.syncHostNavigation({ line });
          }
          continue;
        }
      }
    });
    attributeObserver.observe(target, {
      attributes: true,
      attributeFilter: ['value', 'scroll-line'],
    });

    return {
      async render(markdown: string): Promise<void> {
        currentValue = markdown;
        const shouldShow = hasRenderableContent(currentValue);
        setFrameVisible(shouldShow);
        const rawLine = target.getAttribute('scroll-line');
        const line = rawLine ? Number.parseInt(rawLine, 10) : Number.NaN;
        syncRender(Number.isFinite(line) ? line : undefined);
      },
      async switchTheme(themeId: string): Promise<void> {
        const resolvedThemeId = await resolveThemeId(themeId);
        frameHostBridge.syncHostUi({ themeId: resolvedThemeId });
      },
      scrollToAnchor(anchor: string): void {
        frameHostBridge.syncHostNavigation({ anchor });
      },
      getCurrentLine(): number | null {
        return null;
      },
      setScrollLine(): void {
        const rawLine = target.getAttribute('scroll-line');
        if (!rawLine) {
          return;
        }
        const line = Number.parseInt(rawLine, 10);
        if (Number.isFinite(line)) {
          frameHostBridge.syncHostNavigation({ line });
        }
      },
      export(format: MarkdownViewerExportFormat, options?: MarkdownViewerExportOptions): Promise<void> {
        return iframeExportDocument(format, options);
      },
      destroy(): void {
        window.removeEventListener('message', onFrameMessage);
        attributeObserver.disconnect();
        target.removeEventListener(EXPORT_REQUEST_EVENT, onExportRequest as EventListener);
        for (const pending of pendingIframeExports.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('markdown-viewer element destroyed before export completed'));
        }
        pendingIframeExports.clear();
      },
    };
  }

  if (!container) {
    container = document.createElement('div');
    container.className = 'markdown-viewer-content';
    target.appendChild(container);
  }
  // The content root KEEPS id="markdown-content" so every shared content rule
  // (#markdown-content ...) applies in inline mode too. The id lives inside
  // the element box, and viewer code addresses the container by reference
  // (not by document-wide id lookup), so it cannot collide with the host page.
  if (!container.id) {
    container.id = 'markdown-content';
  }

  if (!container) {
    throw new Error('[element-runtime] markdown-content container not found after shell init');
  }

  const getMountedReaderRoot = (): HTMLElement => {
    const shell = target.querySelector(':scope > #page-shell') as HTMLElement | null;
    return shell ?? container;
  };

  const setMountedReaderVisible = (visible: boolean): void => {
    const root = getMountedReaderRoot();
    root.style.display = visible ? '' : 'none';
  };

  setMountedReaderVisible(false);

  const applyUiAttributes = (): void => {
    const pageHeader = target.querySelector('#page-header') as HTMLElement | null;
    const tocDiv = target.querySelector('#table-of-contents') as HTMLElement | null;
    const overlayDiv = target.querySelector('#toc-overlay') as HTMLElement | null;

    if (pageHeader) {
      pageHeader.style.display = '';
    }

    if (tocDiv) {
      tocDiv.classList.remove('floating');
    }

    if (overlayDiv) {
      overlayDiv.classList.add('hidden');
    }

  };

  const panelViewer = createPanelViewer({
    container,
    scrollContainer: scrollContainer ?? undefined,
    platform,
    renderer,
    translate,
    // The element manages its own scroll-line attribute; no fileState
    // persistence under a shared key (multiple elements on one page).
    persistScroll: false,
    onHeadings: () => {
      void generateTOC().then(() => {
        updateActiveTocItem();
      });
    },
    onScrollLineChange: (line) => {
      void viewerAssembler.reportCurrentLine(line);
      target.setAttribute('data-mv-current-line', String(line));
      target.dispatchEvent(new CustomEvent('scrolllinechange', {
        detail: { line },
        bubbles: true,
        composed: true,
      }));
      updateActiveTocItem();
    },
    applyTheme: (themeId) => loadAndApplyTheme(themeId),
    saveTheme: (themeId) => themeManager.saveSelectedTheme(themeId),
  });

  const mapElementStateToPersistedState = (state: Record<string, unknown>): ViewerPersistedState => {
    const persistedState: ViewerPersistedState = {};

    if (typeof state.scrollLine === 'number') {
      persistedState.scrollLine = state.scrollLine;
    }
    if (typeof state.zoom === 'number') {
      persistedState.zoomPercent = state.zoom;
    }
    if (typeof state.tocVisible === 'boolean') {
      persistedState.tocVisible = state.tocVisible;
    }
    if (typeof state.layoutMode === 'string'
      && (state.layoutMode === 'normal' || state.layoutMode === 'fullscreen' || state.layoutMode === 'narrow')) {
      persistedState.layoutMode = state.layoutMode;
    }

    return persistedState;
  };

  const mapPersistedStateToElementState = (state: Partial<ViewerPersistedState>): Record<string, unknown> => {
    const nextState: Record<string, unknown> = {};

    if (typeof state.scrollLine === 'number') {
      nextState.scrollLine = state.scrollLine;
    }
    if (typeof state.zoomPercent === 'number') {
      nextState.zoom = state.zoomPercent;
    }
    if (typeof state.tocVisible === 'boolean') {
      nextState.tocVisible = state.tocVisible;
    }
    if (typeof state.layoutMode === 'string') {
      nextState.layoutMode = state.layoutMode;
    }

    return nextState;
  };

  const applyResolvedModePresentation = (resolvedMode: ViewerResolvedMode, tocVisible: boolean): void => {
    const tocDiv = target.querySelector('#table-of-contents') as HTMLElement | null;
    const overlayDiv = target.querySelector('#toc-overlay') as HTMLElement | null;
    const readerRoot = getMountedReaderRoot();

    if (resolvedMode !== 'rendered') {
      if (tocDiv) {
        tocDiv.classList.add('hidden');
        tocDiv.style.display = 'none';
      }
      overlayDiv?.classList.add('hidden');
      readerRoot.classList.add('toc-hidden');
      return;
    }

    if (tocDiv?.style.display === 'none') {
      overlayDiv?.classList.add('hidden');
      readerRoot.classList.add('toc-hidden');
      return;
    }

    tocDiv?.classList.toggle('hidden', !tocVisible);
    readerRoot.classList.toggle('toc-hidden', !tocVisible);
    overlayDiv?.classList.add('hidden');
  };

  // Style-gated first reveal. The filtered content CSS (#mv-content-styles,
  // injected asynchronously by inject-element-styles) and the theme CSS
  // (#theme-dynamic-style, injected by loadAndApplyTheme) both arrive AFTER
  // the runtime attaches, so a first render that starts immediately can paint
  // before either lands — a visible flash of unstyled content that then jumps
  // to the themed look (the takeover/embed surfaces avoid this via the preload
  // opacity gate + theme-first init; the inline element needs its own gate).
  // Bounded: if the styles never arrive (e.g. a non-extension host where the
  // stylesheet fetch failed), reveal anyway after the deadline so the page
  // never stays blank.
  let stylingGate: Promise<void> | null = null;
  const waitForElementStyling = (): Promise<void> => {
    if (!stylingGate) {
      stylingGate = (async () => {
        const deadline = Date.now() + 1500;
        const ready = (): boolean =>
          Boolean(document.getElementById('mv-content-styles'))
          && Boolean(document.getElementById('theme-dynamic-style'));
        while (!ready() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
      })();
    }
    return stylingGate;
  };

  const viewerSurface = createViewerSurfacePort({
    render: async (effect) => {
      const shouldShow = hasRenderableContent(effect.renderModel.markdown);
      if (shouldShow) {
        // Do not reveal (or render into the live DOM) until the styling
        // resources are present — the first paint must be themed, not a flash
        // of unstyled defaults that then jumps to the themed look.
        await waitForElementStyling();
      }
      setMountedReaderVisible(shouldShow);
      // The shared panel document state machine: a viewport-preserving
      // update vs a fresh document (same semantics as editor panels).
      const update = { scrollLine: effect.targetLine } as const;
      if (effect.preserveViewport) {
        await panelViewer.updateContent(effect.renderModel.markdown, 'document.md', update);
      } else {
        await panelViewer.openDocument(effect.renderModel.markdown, 'document.md', update);
      }
      await generateTOC();
      applyUiAttributes();
      updateActiveTocItem();
    },
    applyTheme: async (themeId) => {
      const resolvedThemeId = await resolveThemeId(themeId);
      await panelViewer.switchTheme(resolvedThemeId);
    },
    applyPresentation: (effect) => {
      applyResolvedModePresentation(effect.resolvedMode, effect.tocVisible);
    },
    readCurrentLine: () => panelViewer.getCurrentLine(),
    scrollToLine: (line) => {
      panelViewer.setScrollLine(line);
    },
    scrollToAnchor: (anchor) => {
      panelViewer.scrollToAnchor(anchor);
    },
  });

  const viewerHostBridge = createPersistedStateHostBridge({
    readPersistedState: async () => mapElementStateToPersistedState(await getElementState()),
    writePersistedState: async (_documentKey, patch) => {
      saveElementState(mapPersistedStateToElementState(patch));
    },
  });

  const viewerAssembler = createViewerAssembler({
    session: createViewerSession(),
    surface: viewerSurface,
    host: viewerHostBridge,
  });

  let currentValue = '';
  let hasOpenedDocument = false;

  const buildElementDocumentDescriptor = (): ViewerDocumentDescriptor => ({
    documentKey: target.id || 'markdown-viewer-element',
    displayName: 'markdown-viewer',
    format: 'markdown',
    sourceToggleSupported: false,
    containerMode: 'embedded',
    embedded: true,
  });

  const render = async (markdown: string): Promise<void> => {
    currentValue = markdown;
    if (!hasOpenedDocument) {
      const persistedState = mapElementStateToPersistedState(await getElementState());
      await viewerAssembler.openDocument({
        document: buildElementDocumentDescriptor(),
        content: markdown,
        persistedState,
        targetLine: typeof persistedState.scrollLine === 'number' ? persistedState.scrollLine : undefined,
      });
      hasOpenedDocument = true;
      return;
    }

    const targetLineAttr = target.getAttribute('scroll-line');
    const targetLine = targetLineAttr ? Number.parseInt(targetLineAttr, 10) : Number.NaN;
    await viewerAssembler.updateContent(markdown, Number.isFinite(targetLine) ? targetLine : undefined);
  };

  const switchTheme = async (themeId: string): Promise<void> => {
    const resolvedThemeId = await resolveThemeId(themeId);
    // No-op when the resolved theme is already active AND its CSS is actually
    // in the DOM: skip the full apply+rerender cycle. The attach-time
    // switchTheme('') would otherwise re-render (forceRender) concurrently
    // with the initial render and race it — the aborted initial render could
    // still append its footnote section into the re-render's container (see
    // viewer-controller abort guards). The CSS-tag check keeps the guard
    // honest: if the styles were somehow removed, re-apply instead of leaving
    // the page unstyled.
    if (themeManager.getCurrentTheme()?.id === resolvedThemeId
      && document.getElementById('theme-dynamic-style')) {
      return;
    }
    await viewerAssembler.setTheme(resolvedThemeId);
  };

  const scrollToAnchor = (anchor: string): void => {
    void viewerAssembler.requestAnchor(anchor);
  };

  const setScrollLine = (line: number): void => {
    void viewerAssembler.requestTargetLine(line);
  };

  const runInlineExport = async (
    format: MarkdownViewerExportFormat,
    options?: MarkdownViewerExportOptions,
  ): Promise<void> => {
    const filename = options?.filename || target.id || 'document';
    await exportViewerDocument({
      format,
      markdown: currentValue,
      filename,
      title: options?.title || filename,
      container,
      renderer,
      platform,
    });
  };

  const inlineExportDocument = (
    format: MarkdownViewerExportFormat,
    options?: MarkdownViewerExportOptions,
    requestId?: string,
  ): Promise<void> => {
    return runInlineExport(format, options).then(
      () => {
        if (requestId) {
          dispatchBridgeResponse(target, requestId, true);
        }
      },
      (error: unknown) => {
        if (requestId) {
          dispatchBridgeResponse(target, requestId, false, error);
        }
        throw error;
      },
    );
  };

  const onExportRequest = (event: Event): void => {
    const detail = (event as CustomEvent<MarkdownViewerExportRequestDetail>).detail ?? {};
    const format = normalizeExportFormat(detail.format);
    if (!format) {
      dispatchBridgeResponse(
        target,
        detail.requestId,
        false,
        `Unsupported export format: ${String(detail.format)}`,
      );
      return;
    }
    void inlineExportDocument(format, detail, detail.requestId).catch(() => {
      // Failure already reported via dispatchBridgeResponse above.
    });
  };
  target.addEventListener(EXPORT_REQUEST_EVENT, onExportRequest as EventListener);

  const toggleTocBtn = target.querySelector('#toggle-toc-btn') as HTMLButtonElement | null;
  if (toggleTocBtn) {
    toggleTocBtn.addEventListener('click', () => {
      const tocDiv = target.querySelector('#table-of-contents') as HTMLElement | null;
      if (!tocDiv || tocDiv.style.display === 'none') {
        return;
      }
      const nextVisible = tocDiv.classList.contains('hidden');
      void viewerAssembler.setTocVisibility(nextVisible);
    });
  }

  const applyCurrentAttributes = (): void => {
    const valueAttr = target.getAttribute('value');
    if (typeof valueAttr === 'string' && valueAttr !== currentValue) {
      void render(valueAttr);
    }

    const scrollLineAttr = target.getAttribute('scroll-line');
    if (scrollLineAttr) {
      const line = Number.parseInt(scrollLineAttr, 10);
      if (Number.isFinite(line)) {
        setScrollLine(line);
      }
    }

    applyUiAttributes();
  };

  const attributeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'attributes') continue;
      const name = mutation.attributeName;
      const nextValue = name ? target.getAttribute(name) : null;
      if (name === 'value') {
        const value = target.getAttribute('value') ?? '';
        if (value !== currentValue) {
          void render(value);
        }
        continue;
      }
      if (name === 'scroll-line') {
        const rawLine = target.getAttribute('scroll-line');
        if (!rawLine) continue;
        const line = Number.parseInt(rawLine, 10);
        if (Number.isFinite(line)) {
          setScrollLine(line);
        }
        continue;
      }
    }
  });
  attributeObserver.observe(target, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [...OBSERVED_ATTRIBUTES],
  });

  const onRenderRequest = (event: Event): void => {
    const detail = (event as CustomEvent<MarkdownViewerBridgeRequestDetail>).detail ?? {};
    void render(detail.markdown ?? '').then(() => {
      dispatchBridgeResponse(target, detail.requestId, true);
    }).catch((error) => {
      dispatchBridgeResponse(target, detail.requestId, false, error);
    });
  };

  const onAnchorRequest = (event: Event): void => {
    const detail = (event as CustomEvent<MarkdownViewerBridgeRequestDetail>).detail ?? {};
    if (detail.anchor) {
      scrollToAnchor(detail.anchor);
    }
  };

  target.addEventListener(RENDER_REQUEST_EVENT, onRenderRequest as EventListener);
  target.addEventListener(ANCHOR_REQUEST_EVENT, onAnchorRequest as EventListener);

  void switchTheme('');
  applyCurrentAttributes();

  return {
    render,
    switchTheme,
    scrollToAnchor,
    getCurrentLine(): number | null {
      return viewerAssembler.getSnapshot().currentLine ?? panelViewer.getCurrentLine();
    },
    setScrollLine,
    export(format: MarkdownViewerExportFormat, options?: MarkdownViewerExportOptions): Promise<void> {
      return inlineExportDocument(format, options);
    },
    destroy(): void {
      attributeObserver.disconnect();
      target.removeEventListener(RENDER_REQUEST_EVENT, onRenderRequest as EventListener);
      target.removeEventListener(ANCHOR_REQUEST_EVENT, onAnchorRequest as EventListener);
      target.removeEventListener(EXPORT_REQUEST_EVENT, onExportRequest as EventListener);
      panelViewer.destroy();
    },
  };
}

export function createMarkdownViewerElementClass(options: MarkdownViewerElementFactoryOptions) {
  return class MarkdownViewerElementImpl extends HTMLElement {
    static get observedAttributes(): string[] {
      return [...OBSERVED_ATTRIBUTES];
    }

    private runtimeController: MarkdownViewerElementRuntimeController | null = null;

    connectedCallback(): void {
      if (!this.runtimeController) {
        try {
          this.runtimeController = attachMarkdownViewerElementRuntime(this, options);
        } catch (error) {
          console.error('[markdown-viewer-element] createMountedViewer failed', error);
          throw error;
        }
      }
    }

    disconnectedCallback(): void {
      this.runtimeController?.destroy();
      this.runtimeController = null;
    }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
      if (!this.runtimeController || oldValue === newValue) return;

      if (name === 'mode') {
        this.runtimeController.destroy();
        this.runtimeController = attachMarkdownViewerElementRuntime(this, options);
        return;
      }

      if (name === 'value') {
        void this.render(newValue ?? '');
        return;
      }

      if (name === 'scroll-line' && newValue) {
        const line = Number.parseInt(newValue, 10);
        if (Number.isFinite(line)) {
          this.runtimeController.setScrollLine(line);
        }
      }
    }

    async render(markdown: string): Promise<void> {
      await this.runtimeController?.render(markdown);
    }

    get value(): string | undefined {
      return this.getAttribute('value') ?? undefined;
    }

    set value(markdown: string | undefined) {
      if (markdown === undefined) {
        this.removeAttribute('value');
        return;
      }
      this.setAttribute('value', markdown);
    }

    get mode(): MarkdownViewerRuntimeMode | undefined {
      const value = this.getAttribute('mode');
      return value === 'inline' || value === 'iframe' ? value : undefined;
    }

    set mode(mode: MarkdownViewerRuntimeMode | undefined) {
      if (mode === undefined) {
        this.removeAttribute('mode');
        return;
      }
      this.setAttribute('mode', mode);
    }

    get scrollLine(): number | undefined {
      const value = this.getAttribute('scroll-line');
      if (!value) return undefined;
      const line = Number.parseInt(value, 10);
      return Number.isFinite(line) ? line : undefined;
    }

    set scrollLine(line: number | undefined) {
      if (line === undefined || Number.isNaN(line)) {
        this.removeAttribute('scroll-line');
        return;
      }
      this.setAttribute('scroll-line', String(line));
    }

    getCurrentLine(): number | null {
      return this.runtimeController?.getCurrentLine() ?? null;
    }

    scrollToAnchor(anchor: string): void {
      this.runtimeController?.scrollToAnchor(anchor);
    }

    /**
     * Run an export command, mirroring the standalone preview toolbar's
     * export menu: 'docx' | 'epub' | 'html' | 'pdf' | 'save' ('docs' is an
     * alias for 'docx'). Resolves when the export completes; rejects on
     * failure.
     */
    async export(
      format: MarkdownViewerExportFormat | 'docs',
      options?: MarkdownViewerExportOptions,
    ): Promise<void> {
      const normalized = normalizeExportFormat(format);
      if (!normalized) {
        throw new Error(`Unsupported export format: ${String(format)}`);
      }
      await this.runtimeController?.export(normalized, options);
    }
  };
}

export function defineMarkdownViewerElement(
  tagName: string,
  options: MarkdownViewerElementFactoryOptions,
): void {
  const registry = globalThis.customElements;
  if (!registry) return;
  if (registry.get(tagName)) {
    return;
  }

  const ElementClass = createMarkdownViewerElementClass(options);
  registry.define(tagName, ElementClass);
}
