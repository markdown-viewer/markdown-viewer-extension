import {
  createMountedViewer,
  type MountedViewerController,
  type MountedViewerOptions,
} from './viewer-host';
import type { ViewerDisplayMode } from './viewer-host-adapter';

export type ViewerKernelRenderReason =
  | 'content-update'
  | 'theme-switch'
  | 'settings-change'
  | 'explicit-rerender';

export interface ViewerKernel extends MountedViewerController {
  loadDocument(markdown: string, options?: Parameters<MountedViewerController['render']>[1]): Promise<void>;
  updateContent(markdown: string, options?: Parameters<MountedViewerController['render']>[1]): Promise<void>;
  setDisplayMode(mode: ViewerDisplayMode): void;
  toggleSourceMode(): ViewerDisplayMode;
  getDisplayMode(): ViewerDisplayMode;
  isCodeViewActive(): boolean;
  setTargetLine(line: number | undefined): void;
  getTargetLine(): number | undefined;
  captureCurrentLine(): number | null;
  restorePreviewScroll(line: number): void;
  restoreCodeViewScroll(line: number): void;
  rerenderPreservingScroll(reason: ViewerKernelRenderReason): Promise<void>;
  switchThemePreservingScroll(themeId: string): Promise<void>;
}

export function createViewerKernel(options: MountedViewerOptions): ViewerKernel {
  const mountedViewer = createMountedViewer(options);
  let currentMarkdown = '';
  let displayMode: ViewerDisplayMode = 'markdown';
  let targetLine: number | undefined;
  let lastRenderOptions: Parameters<MountedViewerController['render']>[1] | undefined;

  const render: ViewerKernel['render'] = async (markdown, renderOptions) => {
    currentMarkdown = markdown;
    targetLine = renderOptions?.targetLine;
    lastRenderOptions = renderOptions;
    if (renderOptions?.sourceView) {
      if (displayMode !== 'source') {
        displayMode = 'auto-code';
      }
    } else if (displayMode === 'auto-code') {
      displayMode = 'markdown';
    }
    await mountedViewer.render(markdown, renderOptions);
  };

  return {
    ...mountedViewer,
    render,
    async loadDocument(markdown, renderOptions) {
      await render(markdown, {
        ...renderOptions,
        fileChanged: renderOptions?.fileChanged ?? true,
      });
    },
    async updateContent(markdown, renderOptions) {
      await render(markdown, renderOptions);
    },
    setDisplayMode(mode) {
      displayMode = mode;
    },
    toggleSourceMode() {
      if (displayMode === 'source') {
        displayMode = 'markdown';
      } else if (displayMode === 'markdown') {
        displayMode = 'source';
      }
      return displayMode;
    },
    getDisplayMode() {
      return displayMode;
    },
    isCodeViewActive() {
      return displayMode !== 'markdown';
    },
    setTargetLine(line) {
      targetLine = line;
      if (typeof line === 'number' && Number.isFinite(line)) {
        mountedViewer.setScrollLine(line);
      }
    },
    getTargetLine() {
      return targetLine;
    },
    captureCurrentLine() {
      return mountedViewer.getCurrentLine();
    },
    restorePreviewScroll(line) {
      mountedViewer.setScrollLine(line);
    },
    restoreCodeViewScroll(line) {
      mountedViewer.setScrollLine(line);
    },
    async rerenderPreservingScroll(_reason) {
      await render(currentMarkdown, {
        ...lastRenderOptions,
        targetLine: mountedViewer.getCurrentLine() ?? targetLine,
      });
    },
    async switchThemePreservingScroll(themeId) {
      const line = mountedViewer.getCurrentLine() ?? targetLine;
      await mountedViewer.switchTheme(themeId);
      if (typeof line === 'number' && Number.isFinite(line)) {
        mountedViewer.setScrollLine(line);
      }
    },
  };
}