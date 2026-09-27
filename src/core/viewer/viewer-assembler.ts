import type {
  ViewerCommand,
  ViewerDocumentDescriptor,
  ViewerEffect,
  ViewerHostBridge,
  ViewerPersistedState,
  ViewerSession,
  ViewerSessionSnapshot,
  ViewerSurfacePort,
} from './viewer-session-contract';

export interface ViewerAssembler {
  openDocument(input: {
    document: ViewerDocumentDescriptor;
    content: string;
    persistedState?: ViewerPersistedState;
    targetLine?: number;
    anchor?: string;
  }): Promise<ViewerSessionSnapshot>;
  updateContent(content: string, targetLine?: number): Promise<ViewerSessionSnapshot>;
  setModeIntent(modeIntent: 'rendered' | 'source'): Promise<ViewerSessionSnapshot>;
  toggleModeIntent(): Promise<ViewerSessionSnapshot>;
  setTheme(themeId: string): Promise<ViewerSessionSnapshot>;
  setZoom(zoomPercent: number): Promise<ViewerSessionSnapshot>;
  setLayoutMode(layoutMode: 'normal' | 'fullscreen' | 'narrow'): Promise<ViewerSessionSnapshot>;
  setTocVisibility(visible: boolean): Promise<ViewerSessionSnapshot>;
  requestAnchor(anchor: string): Promise<ViewerSessionSnapshot>;
  requestTargetLine(line?: number): Promise<ViewerSessionSnapshot>;
  reportCurrentLine(line?: number): Promise<ViewerSessionSnapshot>;
  reportHeadingPresence(hasHeadings: boolean): Promise<ViewerSessionSnapshot>;
  rerender(reason: 'settings-change' | 'theme-change' | 'explicit'): Promise<ViewerSessionSnapshot>;
  dispatch(command: ViewerCommand): Promise<ViewerSessionSnapshot>;
  getSnapshot(): ViewerSessionSnapshot;
}

export interface ViewerAssemblerOptions {
  session: ViewerSession;
  surface: ViewerSurfacePort;
  host: ViewerHostBridge;
}

async function executeEffect(
  effect: ViewerEffect,
  documentKey: string | undefined,
  surface: ViewerSurfacePort,
  host: ViewerHostBridge,
  session: ViewerSession,
): Promise<void> {
  switch (effect.type) {
    case 'render':
      // Render the model that is *current*: an older command's render can land
      // after a newer one (the initial markdown render after a source toggle
      // clicked while the document was opening) and drawing it would replace the
      // newer view — the click looked ignored. Zoom/layout changes keep the same
      // model object, so they never hit this.
      if (effect.renderModel !== session.getSnapshot().renderModel) {
        return;
      }
      await surface.render(effect);
      return;
    case 'apply-theme':
      await surface.applyTheme(effect.themeId);
      return;
    case 'apply-presentation':
      // Presentation is a repaint, so only the newest one may win: the effects of
      // an older command can land after a newer one (a source toggle clicked
      // while the document is still opening) and applying them flipped the view
      // back, which read as "the button did nothing".
      if (effect.revision < session.getSnapshot().revision) {
        return;
      }
      surface.applyPresentation(effect);
      return;
    case 'scroll-to-line':
      surface.scrollToLine(effect.line);
      return;
    case 'scroll-to-anchor':
      surface.scrollToAnchor(effect.anchor);
      return;
    case 'persist-state':
      if (documentKey) {
        await host.writePersistedState(documentKey, effect.state);
      }
      return;
    case 'emit-host-event':
      host.emit(effect.event, effect.payload);
      return;
  }
}

export function createViewerAssembler(options: ViewerAssemblerOptions): ViewerAssembler {
  const { session, surface, host } = options;

  const dispatch = async (command: ViewerCommand): Promise<ViewerSessionSnapshot> => {
    const effects = session.dispatch(command);
    const snapshot = session.getSnapshot();
    const documentKey = snapshot.document?.documentKey;

    for (const effect of effects) {
      await executeEffect(effect, documentKey, surface, host, session);
    }

    return session.getSnapshot();
  };

  return {
    async openDocument(input) {
      return dispatch({
        type: 'open-document',
        ...input,
      });
    },
    async updateContent(content, targetLine) {
      return dispatch({
        type: 'update-content',
        content,
        targetLine,
      });
    },
    async setModeIntent(modeIntent) {
      return dispatch({
        type: 'set-mode-intent',
        modeIntent,
      });
    },
    async toggleModeIntent() {
      return dispatch({ type: 'toggle-mode-intent' });
    },
    async setTheme(themeId) {
      return dispatch({ type: 'set-theme', themeId });
    },
    async setZoom(zoomPercent) {
      return dispatch({ type: 'set-zoom', zoomPercent });
    },
    async setLayoutMode(layoutMode) {
      return dispatch({ type: 'set-layout-mode', layoutMode });
    },
    async setTocVisibility(visible) {
      return dispatch({ type: 'set-toc-visibility', visible });
    },
    async requestAnchor(anchor) {
      return dispatch({ type: 'request-anchor', anchor });
    },
    async requestTargetLine(line) {
      return dispatch({ type: 'request-target-line', line });
    },
    async reportCurrentLine(line) {
      return dispatch({ type: 'report-current-line', line });
    },
    async reportHeadingPresence(hasHeadings) {
      return dispatch({ type: 'report-heading-presence', hasHeadings });
    },
    async rerender(reason) {
      return dispatch({ type: 'rerender', reason });
    },
    dispatch,
    getSnapshot() {
      return session.getSnapshot();
    },
  };
}