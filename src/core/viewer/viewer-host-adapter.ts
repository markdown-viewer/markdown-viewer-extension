export type ViewerDisplayMode = 'markdown' | 'source' | 'auto-code';

export type ViewerPersistedState = {
  scrollLine?: number;
  displayMode?: ViewerDisplayMode;
  themeId?: string;
  zoomLevel?: number;
};

export type ViewerHostContext = {
  documentKey?: string;
  filename?: string;
  embedded?: boolean;
  sourceToggleSupported?: boolean;
};

export type ViewerLayoutState = {
  codeView?: boolean;
  hasHeadings?: boolean;
};

export type ViewerKernelEvent =
  | 'render-started'
  | 'render-completed'
  | 'display-mode-changed'
  | 'scroll-line-changed'
  | 'theme-switched';

export interface ViewerHostAdapter {
  getDocumentKey(): string;
  readInitialState(): Promise<ViewerPersistedState>;
  saveState(state: Partial<ViewerPersistedState>): Promise<void> | void;

  readHostContext?(): Promise<ViewerHostContext> | ViewerHostContext;
  patchHostContext?(patch: Partial<ViewerHostContext>): Promise<void> | void;

  getMountContainer(): HTMLElement;
  getScrollContainer(): HTMLElement | undefined;

  applyPredictedTocLayout?(hasHeadings: boolean): void;
  applyFinalTocLayout?(): Promise<void> | void;
  applyHostLayout?(state: ViewerLayoutState): Promise<void> | void;

  openSettingsPanel?(): void;
  openExportMenu?(): void;
  openSearchPanel?(): void;

  resolveRelativeFile?(path: string, binary?: boolean): Promise<string>;
  emit?(event: ViewerKernelEvent, payload?: unknown): void;

  supportsSourceToggle(): boolean;
  isEmbedded(): boolean;
}