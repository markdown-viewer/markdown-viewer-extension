// Embedded viewer for workspace mode
// Receives file content via postMessage, then runs the full viewer pipeline

import { platform } from '../webview/index';
import { getViewerMainRuntime, startViewer } from '../webview/viewer-main';
import { initializeViewerBase } from '../../../src/core/viewer/viewer-bootstrap';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';
import { applyCodeViewPresentation } from '../../../src/utils/code-preview';
import { createWorkspaceEmbedBridge } from './workspace-embed-bridge';
import { arrowLeft, arrowRight } from './file-icons';
import {
  createWorkspaceEmbedHostUiController,
  TOC_NAVIGATION_SCROLL_BEHAVIOR,
} from './workspace-embed-host-ui';
import { createWorkspaceEmbedParentBridge } from './workspace-embed-parent-bridge';
import type {
  ViewerIframeMessage,
  ViewerOpenDocumentMessage,
  ViewerUpdateContentMessage,
} from '../../../src/integration/iframe-viewer-host';

type DocumentMessage = ViewerOpenDocumentMessage | ViewerUpdateContentMessage;

interface WorkspaceHistoryUiMessage {
  type: 'SYNC_WORKSPACE_HISTORY_UI';
  visible?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

let initialized = false;
const EMBED_MODE = new URLSearchParams(window.location.search).get('embed') === '1';
let pendingWorkspaceHistoryUi: WorkspaceHistoryUiMessage | null = null;

const workspaceEmbedBridge = createWorkspaceEmbedBridge({
  documentService: platform.document as import('../webview/api-impl').ChromeDocumentService,
  postToParent: (message) => {
    window.parent.postMessage(message, '*');
  },
});

const parentBridge = createWorkspaceEmbedParentBridge({
  getRuntime: () => getViewerMainRuntime(),
  postToParent: (message) => {
    window.parent.postMessage(message, '*');
  },
  ensureWorkspaceResolvers: () => {
    workspaceEmbedBridge.ensureConnected();
  },
  scrollToAnchor,
});

const hostUiController = createWorkspaceEmbedHostUiController({
  scrollToAnchor,
  applyTheme: (themeId) => {
    const runtime = getViewerMainRuntime();
    if (runtime) {
      return runtime.setTheme(themeId);
    }
    return loadAndApplyTheme(themeId);
  },
});

async function waitForViewerMainRuntime(): Promise<NonNullable<ReturnType<typeof getViewerMainRuntime>>> {
  const runtime = getViewerMainRuntime();
  if (runtime) {
    return runtime;
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    const nextRuntime = getViewerMainRuntime();
    if (nextRuntime) {
      return nextRuntime;
    }
  }

  throw new Error('[viewer-embed] viewer runtime not initialized');
}

// Inject embed-mode CSS when loaded with ?embed=1 (from element.ts custom element iframe).
// This hides the toolbar and shifts the TOC panel up so it fills the full iframe height.
// In workspace-preview context (no ?embed=1 param) nothing is injected and the native
// toolbar + TOC layout is preserved.
if (EMBED_MODE) {
  // Mark body so that internal TOC manager skips its saved-state restoration.
  document.body.dataset.mvEmbed = '1';

  const style = document.createElement('style');
  style.id = 'embed-mode-styles';
  style.textContent = [
    '#page-header { display: none !important; }',
    '#table-of-contents { top: 0 !important; height: 100vh !important; }',
    'body.toc-hidden #markdown-wrapper { margin-left: 0 !important; margin-right: 0 !important; }',
    'body:not(.toc-hidden) #markdown-wrapper { margin-left: 280px !important; margin-right: 0 !important; }',
    'body.toc-position-right:not(.toc-hidden) #markdown-wrapper { margin-left: 0 !important; margin-right: 280px !important; }',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

// ── Restore pending content after Slidev→normal file switch reload ──────
// When switching away from a .slides.md file the viewer page is reloaded
// because renderSlidevContent destroyed the normal viewer DOM. Before the
// reload we stash the incoming OPEN_DOCUMENT message in sessionStorage;
// here we replay it through the normal message handler so initializeViewerMain
// picks up the content and renders it with a fresh DOM.
(function restorePendingOpenDocument() {
  try {
    const raw = sessionStorage.getItem('mv:pendingOpen');
    if (!raw) return;
    sessionStorage.removeItem('mv:pendingOpen');
    const message = JSON.parse(raw) as ViewerOpenDocumentMessage;
    if (message && typeof message.content === 'string') {
      // Replay through the normal handler — it will call ensureViewerInitialized
      // which triggers startViewer → initializeViewerMain.
      void handleDocumentMessage(message, 'open');
    }
  } catch { /* malformed JSON or storage blocked — ignore */ }
})();

function scrollToAnchor(anchor: string): void {
  const normalized = decodeURIComponent(anchor || '').replace(/^#/, '').trim();
  if (!normalized) return;

  const target = document.getElementById(normalized);
  if (!target) return;

  const wrapper = document.getElementById('markdown-wrapper') as HTMLElement | null;
  if (!wrapper) {
    target.scrollIntoView({ behavior: TOC_NAVIGATION_SCROLL_BEHAVIOR, block: 'start' });
    return;
  }
  const containerRect = wrapper.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = targetRect.top - containerRect.top + wrapper.scrollTop;
  wrapper.scrollTo({ top: Math.max(0, top), behavior: TOC_NAVIGATION_SCROLL_BEHAVIOR });
}

function normalizeTargetLine(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(1, Math.floor(value));
}

function applyOpenDocumentMetadata(message: ViewerOpenDocumentMessage): void {
  const filename = String(message.filename || 'inline.md');
  const workspaceName = String(message.workspaceName || '');
  const workspaceFilePath = String(message.workspaceFilePath || '');
  const codeView = Boolean(message.codeView);

  document.documentElement.dataset.viewerFilename = filename;
  if (workspaceName && workspaceFilePath) {
    document.documentElement.dataset.viewerWorkspaceName = workspaceName;
    document.documentElement.dataset.viewerWorkspaceFilePath = workspaceFilePath;
  } else {
    delete document.documentElement.dataset.viewerWorkspaceName;
    delete document.documentElement.dataset.viewerWorkspaceFilePath;
  }

  // Only enable TOC for plain .md / .markdown files (exclude .slides.md,
  // .drawio, .mermaid, and image previews whose filename is e.g. image.png.md).
  const IMAGE_PREVIEW_EXTS = /\.(svg|png|jpe?g|gif|webp|bmp|ico|tiff?|avif)\.(md|markdown)$/i;
  const tocEnabled = /\.(md|markdown)$/i.test(filename)
    && !/\.slides\.md$/i.test(filename)
    && !IMAGE_PREVIEW_EXTS.test(filename);
  if (tocEnabled) {
    delete document.documentElement.dataset.tocDisabled;
    // When switching back to .md from a non-.md file, the TOC panel may still be
    // hidden from the previous applyOpenDocumentMetadata call. Restore it so the
    // render pipeline's applyPredictedTocLayout can correctly manage visibility.
    const tocDiv = document.getElementById('table-of-contents');
    const overlayDiv = document.getElementById('toc-overlay');
    if (tocDiv) {
      tocDiv.style.display = '';
      tocDiv.classList.remove('hidden');
    }
    if (overlayDiv) {
      overlayDiv.classList.remove('hidden');
    }
    document.body.classList.remove('toc-hidden');
  } else {
    document.documentElement.dataset.tocDisabled = '1';
    // Immediately close the TOC panel so stale content from the previous file
    // is not visible while the render pipeline runs asynchronously.
    const tocDiv = document.getElementById('table-of-contents');
    const overlayDiv = document.getElementById('toc-overlay');
    if (tocDiv) {
      tocDiv.style.display = 'none';
      tocDiv.classList.add('hidden');
    }
    if (overlayDiv) {
      overlayDiv.classList.add('hidden');
    }
    document.body.classList.add('toc-hidden');
  }

  applyCodeViewPresentation(codeView);

  const fileNameSpan = document.getElementById('file-name');
  if (fileNameSpan) {
    fileNameSpan.textContent = filename;
  }
  document.title = filename;
}

function ensureWorkspaceHistoryInline(): {
  wrapper: HTMLSpanElement;
  backButton: HTMLButtonElement;
  forwardButton: HTMLButtonElement;
} | null {
  const fileNameSpan = document.getElementById('file-name');
  if (!fileNameSpan?.parentElement) {
    return null;
  }

  let wrapper = document.getElementById('workspace-history-inline') as HTMLSpanElement | null;
  if (!wrapper) {
    wrapper = document.createElement('span');
    wrapper.id = 'workspace-history-inline';
    wrapper.style.display = 'none';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '4px';
    wrapper.style.marginRight = '8px';

    const createButton = (id: string, title: string, icon: string, delta: -1 | 1): HTMLButtonElement => {
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.className = 'toolbar-btn';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.style.width = '30px';
      button.style.height = '30px';
      button.style.padding = '0';
      button.innerHTML = icon;
      const svg = button.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');
        svg.setAttribute('aria-hidden', 'true');
      }
      button.addEventListener('click', () => {
        if (button.disabled) {
          return;
        }
        window.parent.postMessage({ type: 'WORKSPACE_HISTORY_NAVIGATE', delta }, '*');
      });
      return button;
    };

    const backButton = createButton('workspace-history-back', 'Back', arrowLeft, -1);
    const forwardButton = createButton('workspace-history-forward', 'Forward', arrowRight, 1);
    wrapper.append(backButton, forwardButton);
    fileNameSpan.insertAdjacentElement('beforebegin', wrapper);
  }

  const backButton = document.getElementById('workspace-history-back') as HTMLButtonElement | null;
  const forwardButton = document.getElementById('workspace-history-forward') as HTMLButtonElement | null;
  if (!backButton || !forwardButton) {
    return null;
  }

  return { wrapper, backButton, forwardButton };
}

function applyWorkspaceHistoryUi(message: WorkspaceHistoryUiMessage): void {
  pendingWorkspaceHistoryUi = message;
  const controls = ensureWorkspaceHistoryInline();
  if (!controls) {
    return;
  }

  const { wrapper, backButton, forwardButton } = controls;
  wrapper.style.display = message.visible ? 'inline-flex' : 'none';
  backButton.disabled = !message.canGoBack;
  forwardButton.disabled = !message.canGoForward;
}

async function ensureViewerInitialized(initialContent: string): Promise<{
  runtime: NonNullable<ReturnType<typeof getViewerMainRuntime>>;
  wasInitialized: boolean;
}> {
  const wasInitialized = initialized;

  if (!initialized) {
    document.body.textContent = initialContent;
    await initializeViewerBase(platform).then((pluginRenderer) => {
      startViewer({
        platform,
        pluginRenderer,
        themeConfigRenderer: platform.renderer,
      });
      initialized = true;
      hostUiController.attachWrapperInteractionFixes();
    }).catch((error) => {
      console.error('[viewer-embed] viewer base init failed', error);
    });
  }

  const runtime = await waitForViewerMainRuntime();
  if (pendingWorkspaceHistoryUi) {
    applyWorkspaceHistoryUi(pendingWorkspaceHistoryUi);
  }

  return {
    runtime,
    wasInitialized,
  };
}

function applyTargetLine(runtime: NonNullable<ReturnType<typeof getViewerMainRuntime>>, targetLine: number | undefined): void {
  if (targetLine !== undefined) {
    runtime.setScrollLine(targetLine);
  }
}

async function handleDocumentMessage(message: DocumentMessage, mode: 'open' | 'update'): Promise<void> {
  const content = String(message.content || '');
  const targetLine = normalizeTargetLine(message.targetLine);

  if (mode === 'open') {
    applyOpenDocumentMetadata(message as ViewerOpenDocumentMessage);
  }

  const { runtime, wasInitialized } = await ensureViewerInitialized(content);

  if (mode === 'open') {
    if (wasInitialized) {
      const filename = (message as ViewerOpenDocumentMessage).filename || '';
      const isSlides = /\.slides\.md$/i.test(filename);
      const cameFromSlidev = document.documentElement.dataset.slidevActive === '1';

      if (isSlides) {
        await runtime.renderSlidev(content);
      } else if (cameFromSlidev) {
        // Switching away from Slidev — the normal viewer DOM was destroyed.
        // Save the pending open-document message to sessionStorage, reload the
        // page, and restore it on the next load so initializeViewerMain can
        // pick it up with a fresh DOM.
        try {
          sessionStorage.setItem('mv:pendingOpen', JSON.stringify(message));
        } catch { /* storage blocked */ }
        window.location.reload();
        return; // never reached after reload
      } else {
        await runtime.openDocument(content, { scrollLine: targetLine });
      }
    }
  } else {
    await runtime.updateContent(content, targetLine);
  }

  applyTargetLine(runtime, targetLine);
  parentBridge.prepareWorkspaceResolvers();
  hostUiController.applyAfterRender();
  parentBridge.notifyViewerRendered();
}

function handleViewerMessage(data: ViewerIframeMessage): void {
  switch (data.type) {
    case 'OPEN_DOCUMENT':
      void handleDocumentMessage(data, 'open');
      return;
    case 'UPDATE_CONTENT':
      void handleDocumentMessage(data, 'update');
      return;
    case 'SYNC_HOST_UI':
      hostUiController.syncHostUi(data);
      return;
    case 'SYNC_HOST_NAVIGATION':
      parentBridge.syncHostNavigation(data);
      return;
    default:
      return;
  }
}

parentBridge.bindViewerMessages(handleViewerMessage);

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as WorkspaceHistoryUiMessage | undefined;
  if (!data || data.type !== 'SYNC_WORKSPACE_HISTORY_UI') {
    return;
  }

  applyWorkspaceHistoryUi(data);
});

// Intercept clicks on relative file links and delegate to the workspace parent.
// Without this, the browser navigates the iframe to a non-existent chrome-extension:// URL.
document.addEventListener('click', (event) => {
  const anchor = (event.target as HTMLElement).closest?.('a');
  if (!anchor) return;

  const href = anchor.getAttribute('href');
  if (!href) return;

  // Anchor-only links (#heading) are handled by the viewer's hashchange logic
  if (href.startsWith('#')) return;

  // All non-anchor links must preventDefault to avoid navigating the iframe away
  // from the viewer page (which would destroy the viewer runtime).
  event.preventDefault();

  // Absolute URLs (http:, mailto:, tel:, etc.) open via window.open
  if (/^[a-z][a-z0-9+\-.]*:/i.test(href)) {
    window.open(href, '_blank');
    return;
  }

  // Relative path — delegate to workspace parent to open via File System Access API
  window.parent.postMessage({ type: 'WORKSPACE_NAVIGATE', path: href }, '*');
});

// Set up workspace file/image resolvers before notifying the parent that the
// viewer is ready. This ensures the workspace file reader (used by the SVG
// plugin to resolve relative image paths) is available before the first render,
// avoiding a race where `new URL(relativePath, _baseUrl)` fails because
// `_baseUrl` is an empty file:// URL in workspace mode.
workspaceEmbedBridge.ensureConnected();

parentBridge.notifyViewerReady();
