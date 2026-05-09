import { createMountedViewer, type TranslateFn } from '../core/viewer/viewer-host';
import { escapeHtml } from '../core/markdown-utils';
import themeManager from '../utils/theme-manager';
import { loadAndApplyTheme } from '../utils/theme-to-css';
import { getWebExtensionApi } from '../utils/platform-info';
import { createTocManager } from '../../chrome/src/webview/ui/toc-manager';
import { generateToolbarHTML } from '../../chrome/src/webview/ui/toolbar';
import type { PluginRenderer, PlatformAPI } from '../types';

const OBSERVED_ATTRIBUTES = ['value', 'scroll-line'] as const;
const RENDER_REQUEST_EVENT = 'mv:render-request';
const ANCHOR_REQUEST_EVENT = 'mv:scroll-to-anchor-request';
const RESPONSE_EVENT = 'mv:response';
const ELEMENT_BASE_STYLE_ID = 'mdv-element-base-style';

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
  destroy(): void;
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

    if (key !== 'themeId' || typeof value !== 'string') {
      return;
    }

    controllers.forEach((controller, element) => {
      if (!element.isConnected) {
        controllers.delete(element);
        return;
      }
      void controller.switchTheme(value).catch((error) => {
        console.error('[element-runtime] switchTheme failed on setting change', error);
      });
    });
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

markdown-viewer > #markdown-content {
  box-sizing: border-box;
  padding: 40px;
}

/* Scope shared viewer shell to the element box instead of the viewport. */
markdown-viewer #page-shell {
  position: relative;
  top: auto;
  left: auto;
  right: auto;
  bottom: auto;
  min-height: 420px;
}

markdown-viewer #page-content {
  position: relative;
  min-height: 0;
}

markdown-viewer #table-of-contents {
  position: absolute;
  top: 50px;
  left: 0;
  height: calc(100% - 50px);
}

markdown-viewer #toc-overlay {
  position: absolute;
}

markdown-viewer #markdown-wrapper {
  height: 100%;
  max-height: min(70vh, 680px);
}

@media screen and (max-width: 768px) {
  markdown-viewer > #markdown-content {
    padding: 20px;
  }

  markdown-viewer #page-shell {
    min-height: 360px;
  }

  markdown-viewer #markdown-wrapper {
    max-height: min(60vh, 520px);
  }
}
`;
  document.head.appendChild(style);
}

function hasRenderableContent(markdown: string): boolean {
  return markdown.trim().length > 0;
}

export function attachMarkdownViewerElementRuntime(
  target: HTMLElement,
  options: MarkdownViewerElementFactoryOptions,
): MarkdownViewerElementRuntimeController {
  const { platform, renderer, translate } = options;

  ensureElementBaseStyle();

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
  const existingMarkdownContent = document.getElementById('markdown-content');
  const canUseMarkdownContentId = !existingMarkdownContent || existingMarkdownContent === target;

  // HTML element mode: host the full reader in an iframe, instead of rebuilding
  // toolbar/toc logic in this runtime.
  if (canUseMarkdownContentId) {
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
      postToFrame({
        type: 'SET_EMBED_UI',
        toc: 'none',
      });
    };

    const enableFloatingToc = (): void => {
      const payload: {
        type: 'SET_EMBED_UI';
        toc: 'floating';
      } = {
        type: 'SET_EMBED_UI',
        toc: 'floating',
      };

      postToFrame(payload);
    };

    const syncRender = (): void => {
      postToFrame({
        type: 'RENDER_FILE',
        content: currentValue,
        filename: 'inline.md',
        fileDir: '',
        codeView: false,
      });
    };

    const onFrameMessage = (event: MessageEvent): void => {
      if (!frame || event.source !== frame.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;
      const data = event.data as { type?: string };
      if (data.type === 'VIEWER_READY') {
        frameReady = true;
        syncUi();
        const shouldShow = hasRenderableContent(currentValue);
        if (shouldShow) {
          enableFloatingToc();
        }
        setFrameVisible(shouldShow);
        if (shouldShow) {
          syncRender();
        }
        return;
      }
      if (data.type === 'VIEWER_RENDERED') {
        setFrameVisible(hasRenderableContent(currentValue));
        // Keep contract parity with mounted viewer mode.
        target.dispatchEvent(new CustomEvent('scrolllinechange', {
          detail: { line: 0 },
          bubbles: true,
          composed: true,
        }));
      }
    };
    window.addEventListener('message', onFrameMessage);

    const attributeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes') continue;
        const name = mutation.attributeName;
        if (name === 'value') {
          currentValue = target.getAttribute('value') ?? '';
          const shouldShow = hasRenderableContent(currentValue);
          setFrameVisible(shouldShow);
          if (shouldShow) {
            enableFloatingToc();
          }
          syncRender();
          continue;
        }
        if (name === 'scroll-line') {
          // Full reader doesn't expose direct line API in embed mode yet.
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
        if (shouldShow) {
          enableFloatingToc();
        }
        syncRender();
      },
      async switchTheme(themeId: string): Promise<void> {
        const resolvedThemeId = await resolveThemeId(themeId);
        postToFrame({ type: 'SET_THEME', themeId: resolvedThemeId });
      },
      scrollToAnchor(anchor: string): void {
        postToFrame({ type: 'SCROLL_TO_ANCHOR', anchor });
      },
      getCurrentLine(): number | null {
        return null;
      },
      setScrollLine(): void {
        // No-op in embed mode.
      },
      destroy(): void {
        window.removeEventListener('message', onFrameMessage);
        attributeObserver.disconnect();
      },
    };
  }

  if (canUseMarkdownContentId) {
    const hasShell = Boolean(target.querySelector(':scope > #page-shell'));
    if (!hasShell) {
      target.innerHTML = generateToolbarHTML({
        translate,
        escapeHtml,
        initialTocClass: '',
        initialMaxWidth: '1360px',
        initialZoom: 100,
      });
      saveElementState({ tocVisible: true, zoom: 100, layoutMode: 'normal' });
    }

    const fileName = target.querySelector('#file-name') as HTMLSpanElement | null;
    if (fileName) {
      fileName.textContent = 'markdown-viewer';
    }

    container = target.querySelector('#markdown-content') as HTMLDivElement | null;
    scrollContainer = target.querySelector('#markdown-wrapper') as HTMLElement | null;

    const toggleToc = tocManager.setupTocToggle();
    void tocManager.setupResponsiveToc();

    const toggleTocBtn = target.querySelector('#toggle-toc-btn') as HTMLButtonElement | null;
    if (toggleTocBtn) {
      toggleTocBtn.addEventListener('click', () => {
        toggleToc();
      });
    }

  } else {
    if (!container) {
      container = document.createElement('div');
      container.className = 'markdown-viewer-content';
      target.appendChild(container);
    }
    if (container.id === 'markdown-content') {
      container.removeAttribute('id');
    }

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

  const mountedViewer = createMountedViewer({
    container,
    scrollContainer: scrollContainer ?? undefined,
    platform,
    renderer,
    translate,
    onHeadings: () => {
      void generateTOC().then(() => {
        updateActiveTocItem();
      });
    },
    onScrollLineChange: (line) => {
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

  let currentValue = '';

  const render = async (markdown: string): Promise<void> => {
    currentValue = markdown;
    const shouldShow = hasRenderableContent(markdown);
    setMountedReaderVisible(shouldShow);
    await mountedViewer.render(markdown);
    await generateTOC();
    applyUiAttributes();
    updateActiveTocItem();
  };

  const switchTheme = async (themeId: string): Promise<void> => {
    const resolvedThemeId = await resolveThemeId(themeId);
    await mountedViewer.switchTheme(resolvedThemeId);
  };

  const scrollToAnchor = (anchor: string): void => {
    mountedViewer.scrollToAnchor(anchor);
  };

  const setScrollLine = (line: number): void => {
    mountedViewer.setScrollLine(line);
  };

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
      return mountedViewer.getCurrentLine();
    },
    setScrollLine,
    destroy(): void {
      attributeObserver.disconnect();
      target.removeEventListener(RENDER_REQUEST_EVENT, onRenderRequest as EventListener);
      target.removeEventListener(ANCHOR_REQUEST_EVENT, onAnchorRequest as EventListener);
      mountedViewer.destroy();
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
