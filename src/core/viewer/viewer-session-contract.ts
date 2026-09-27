export type ViewerModeIntent = 'rendered' | 'source';

export type ViewerResolvedMode = 'rendered' | 'source' | 'code-reading';

export type ViewerLayoutMode = 'normal' | 'fullscreen' | 'narrow';

export type ViewerContainerMode = 'browser' | 'panel' | 'embedded';

export type ViewerTocPresentation = 'sidebar' | 'floating';

export function resolveDefaultTocVisibility(containerMode: ViewerContainerMode): boolean {
  switch (containerMode) {
    case 'browser':
      return true;
    case 'panel':
      return false;
    case 'embedded':
      return false;
  }
}

export function resolveTocPresentation(containerMode: ViewerContainerMode): ViewerTocPresentation {
  switch (containerMode) {
    case 'browser':
      return 'sidebar';
    case 'panel':
    case 'embedded':
      return 'floating';
  }
}

export interface ViewerDocumentDescriptor {
  documentKey: string;
  displayName: string;
  sourcePath?: string;
  format: 'markdown' | 'code' | 'diagram' | 'html-converted';
  language?: string;
  sourceToggleSupported: boolean;
  containerMode: ViewerContainerMode;
  embedded: boolean;
}

export interface ViewerPersistedState {
  scrollLine?: number;
  themeId?: string;
  zoomPercent?: number;
  tocVisible?: boolean;
  layoutMode?: ViewerLayoutMode;
  modeIntent?: ViewerModeIntent;
}

export interface ViewerRenderModel {
  markdown: string;
  directCodeView?: {
    content: string;
    language: string;
  };
}

export interface ViewerSessionSnapshot {
  document: ViewerDocumentDescriptor | null;
  revision: number;
  modeIntent: ViewerModeIntent;
  resolvedMode: ViewerResolvedMode;
  renderModel: ViewerRenderModel | null;
  targetLine?: number;
  currentLine?: number;
  pendingAnchor?: string;
  themeId?: string;
  zoomPercent: number;
  tocVisible: boolean;
  predictedHasHeadings?: boolean;
  layoutMode: ViewerLayoutMode;
}

export type ViewerCommand =
  | {
      type: 'open-document';
      document: ViewerDocumentDescriptor;
      content: string;
      persistedState?: ViewerPersistedState;
      targetLine?: number;
      anchor?: string;
    }
  | {
      type: 'update-content';
      content: string;
      targetLine?: number;
    }
  | {
      type: 'set-mode-intent';
      modeIntent: ViewerModeIntent;
    }
  | {
      type: 'toggle-mode-intent';
    }
  | {
      type: 'set-theme';
      themeId: string;
    }
  | {
      type: 'set-zoom';
      zoomPercent: number;
    }
  | {
      type: 'set-layout-mode';
      layoutMode: ViewerLayoutMode;
    }
  | {
      type: 'set-toc-visibility';
      visible: boolean;
    }
  | {
      type: 'request-anchor';
      anchor: string;
    }
  | {
      type: 'request-target-line';
      line?: number;
    }
  | {
      type: 'report-current-line';
      line?: number;
    }
  | {
      type: 'report-heading-presence';
      hasHeadings: boolean;
    }
  | {
      type: 'rerender';
      reason: 'settings-change' | 'theme-change' | 'explicit';
    };

export type ViewerEffect =
  | {
      type: 'render';
      renderModel: ViewerRenderModel;
      revision: number;
      preserveViewport: boolean;
      targetLine?: number;
    }
  | {
      type: 'apply-theme';
      themeId: string;
    }
  | {
      type: 'apply-presentation';
      /** Session revision this presentation was computed from (see the assembler's stale-effect guard). */
      revision: number;
      resolvedMode: ViewerResolvedMode;
      tocVisible: boolean;
      predictedHasHeadings?: boolean;
      layoutMode: ViewerLayoutMode;
      zoomPercent: number;
    }
  | {
      type: 'scroll-to-line';
      line: number;
    }
  | {
      type: 'scroll-to-anchor';
      anchor: string;
    }
  | {
      type: 'persist-state';
      state: ViewerPersistedState;
    }
  | {
      type: 'emit-host-event';
      event:
        | 'render-started'
        | 'render-completed'
        | 'mode-changed'
        | 'scroll-line-changed'
        | 'theme-changed';
      payload?: unknown;
    };

export interface ViewerSession {
  dispatch(command: ViewerCommand): ViewerEffect[];
  getSnapshot(): ViewerSessionSnapshot;
}

export interface ViewerSurfacePort {
  render(effect: Extract<ViewerEffect, { type: 'render' }>): Promise<void>;
  applyTheme(themeId: string): Promise<void>;
  applyPresentation(effect: Extract<ViewerEffect, { type: 'apply-presentation' }>): void;
  readCurrentLine(): number | null;
  scrollToLine(line: number): void;
  scrollToAnchor(anchor: string): void;
}

export interface ViewerHostBridge {
  readPersistedState(documentKey: string): Promise<ViewerPersistedState>;
  writePersistedState(documentKey: string, patch: Partial<ViewerPersistedState>): Promise<void>;
  emit(event: Extract<ViewerEffect, { type: 'emit-host-event' }>['event'], payload?: unknown): void;
  resolveRelativeFile?(path: string, binary?: boolean): Promise<string>;
}

export interface ViewerAssembler {
  session: ViewerSession;
  surface: ViewerSurfacePort;
  host: ViewerHostBridge;
}