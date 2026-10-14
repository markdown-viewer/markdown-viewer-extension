import { toFencedCode } from '../../utils/code-preview';
import { hasHeadingBlocks, splitMarkdownIntoBlocksWithLines } from '../markdown-block-splitter';
import { wrapFileContent } from '../../utils/file-wrapper';
import type {
  ViewerCommand,
  ViewerDocumentDescriptor,
  ViewerEffect,
  ViewerLayoutMode,
  ViewerModeIntent,
  ViewerPersistedState,
  ViewerRenderModel,
  ViewerResolvedMode,
  ViewerSession,
  ViewerSessionSnapshot,
} from './viewer-session-contract';
import { resolveDefaultTocVisibility } from './viewer-session-contract';

type SessionState = ViewerSessionSnapshot & {
  rawContent: string;
};

const DEFAULT_LAYOUT_MODE: ViewerLayoutMode = 'normal';
const DEFAULT_MODE_INTENT: ViewerModeIntent = 'rendered';
const DEFAULT_ZOOM_PERCENT = 100;

function createInitialState(): SessionState {
  return {
    document: null,
    revision: 0,
    modeIntent: DEFAULT_MODE_INTENT,
    resolvedMode: 'rendered',
    renderModel: null,
    targetLine: undefined,
    currentLine: undefined,
    pendingAnchor: undefined,
    themeId: undefined,
    zoomPercent: DEFAULT_ZOOM_PERCENT,
    tocVisible: true,
    predictedHasHeadings: undefined,
    layoutMode: DEFAULT_LAYOUT_MODE,
    rawContent: '',
  };
}

function resolveMode(document: ViewerDocumentDescriptor | null, modeIntent: ViewerModeIntent): ViewerResolvedMode {
  if (!document) {
    return 'rendered';
  }

  if (document.format === 'code') {
    return 'code-reading';
  }

  if (modeIntent === 'source' && document.sourceToggleSupported) {
    return 'source';
  }

  return 'rendered';
}

function buildRenderModel(
  document: ViewerDocumentDescriptor | null,
  rawContent: string,
  resolvedMode: ViewerResolvedMode,
): ViewerRenderModel | null {
  if (!document) {
    return null;
  }

  if (resolvedMode === 'source') {
    return {
      // Markdown source mode has no rendered representation to keep: the
      // rendered form of the document is the page that is already mounted and
      // is only hidden (see viewer-host), so `markdown` stays empty.
      markdown: '',
      source: {
        content: rawContent,
        // A markdown document's source is markdown; an OpenAPI document's is
        // YAML (its descriptor carries the language).
        language: document.language ?? 'markdown',
      },
    };
  }

  if (resolvedMode === 'code-reading') {
    const language = document.language || 'text';
    return {
      // A code-reading document does have one: its fenced block. It is rendered
      // into the (hidden) rendered surface, which is what print and the
      // DOM-serialising exporters read — and rendering it replaces the previous
      // document's DOM, so no stale page survives a file switch.
      markdown: toFencedCode(rawContent, language),
      source: {
        content: rawContent,
        language,
      },
    };
  }

  if (document.format === 'openapi') {
    // The rendered face of an OpenAPI file is its Redoc reference, mounted
    // directly into the content root — the spec is not crammed into an
    // `openapi` fence for a plugin to pick up, so an embedded ```openapi fence
    // in markdown stays ordinary code (R5).
    return {
      markdown: '',
      openapi: { content: rawContent },
    };
  }

  if (document.format === 'diagram') {
    return {
      markdown: wrapFileContent(rawContent, document.sourcePath || document.displayName),
    };
  }

  return {
    markdown: rawContent,
  };
}

function syncDerivedState(state: SessionState): void {
  state.resolvedMode = resolveMode(state.document, state.modeIntent);
  state.renderModel = buildRenderModel(state.document, state.rawContent, state.resolvedMode);
  state.predictedHasHeadings = state.renderModel && state.resolvedMode === 'rendered'
    ? hasHeadingBlocks(splitMarkdownIntoBlocksWithLines(state.renderModel.markdown))
    : false;
}

function createPresentationEffect(state: SessionState): Extract<ViewerEffect, { type: 'apply-presentation' }> {
  return {
    type: 'apply-presentation',
    revision: state.revision,
    resolvedMode: state.resolvedMode,
    tocVisible: state.tocVisible,
    predictedHasHeadings: state.predictedHasHeadings,
    layoutMode: state.layoutMode,
    zoomPercent: state.zoomPercent,
  };
}

function createRenderEffect(
  state: SessionState,
  preserveViewport: boolean,
): Extract<ViewerEffect, { type: 'render' }> | null {
  if (!state.renderModel) {
    return null;
  }

  return {
    type: 'render',
    renderModel: state.renderModel,
    revision: state.revision,
    preserveViewport,
    targetLine: state.targetLine,
  };
}

function createPersistEffect(state: SessionState): Extract<ViewerEffect, { type: 'persist-state' }> {
  const persistedState: ViewerPersistedState = {
    scrollLine: state.currentLine ?? state.targetLine,
    themeId: state.themeId,
    zoomPercent: state.zoomPercent,
    tocVisible: state.tocVisible,
    layoutMode: state.layoutMode,
    modeIntent: state.modeIntent,
  };

  return {
    type: 'persist-state',
    state: persistedState,
  };
}

function createViewportRestoreEffect(
  state: SessionState,
): Extract<ViewerEffect, { type: 'scroll-to-line' }> | null {
  const line = state.currentLine ?? state.targetLine;
  if (typeof line !== 'number' || Number.isNaN(line)) {
    return null;
  }

  state.targetLine = line;
  return {
    type: 'scroll-to-line',
    line,
  };
}

function createModeChangedEffect(state: SessionState): Extract<ViewerEffect, { type: 'emit-host-event' }> {
  return {
    type: 'emit-host-event',
    event: 'mode-changed',
    payload: {
      modeIntent: state.modeIntent,
      resolvedMode: state.resolvedMode,
    },
  };
}

function createRenderLifecycleEffects(): Array<Extract<ViewerEffect, { type: 'emit-host-event' }>> {
  return [
    { type: 'emit-host-event', event: 'render-started' },
    { type: 'emit-host-event', event: 'render-completed' },
  ];
}

function openDocument(
  state: SessionState,
  command: Extract<ViewerCommand, { type: 'open-document' }>,
): ViewerEffect[] {
  // The toolbar is interactive before the first document is dispatched (the
  // viewer wires it as soon as its markup exists, so its buttons are not dead
  // while the page boots). A source-toggle click in that window has to survive
  // the open that follows — resetting the intent here discarded it, which read
  // as "the button does nothing" and needed a second click. Only a *changed*
  // intent counts as such a click: the initial value is the viewer default, and
  // treating it as a click would shadow the document's own default (an OpenAPI
  // file opens as source) on every first open.
  const pendingIntent = state.document === null && state.modeIntent !== DEFAULT_MODE_INTENT
    ? state.modeIntent
    : undefined;

  state.document = command.document;
  state.rawContent = command.content;
  state.revision += 1;
  // Precedence: the user's persisted choice for this file, an early click's
  // intent, the document's own default (OpenAPI opens as source), then the
  // viewer default.
  state.modeIntent = command.persistedState?.modeIntent
    ?? pendingIntent
    ?? command.document.defaultModeIntent
    ?? DEFAULT_MODE_INTENT;
  state.targetLine = command.targetLine ?? command.persistedState?.scrollLine;
  state.currentLine = undefined;
  state.pendingAnchor = command.anchor;
  state.themeId = command.persistedState?.themeId;
  state.zoomPercent = command.persistedState?.zoomPercent ?? DEFAULT_ZOOM_PERCENT;
  state.tocVisible = command.persistedState?.tocVisible ?? resolveDefaultTocVisibility(command.document.containerMode);
  state.layoutMode = command.persistedState?.layoutMode ?? DEFAULT_LAYOUT_MODE;
  syncDerivedState(state);

  const effects: ViewerEffect[] = [createPresentationEffect(state)];
  if (state.themeId) {
    effects.push({ type: 'apply-theme', themeId: state.themeId });
  }
  effects.push(...createRenderLifecycleEffects());
  const renderEffect = createRenderEffect(state, false);
  if (renderEffect) {
    effects.push(renderEffect);
  }
  if (state.pendingAnchor) {
    effects.push({ type: 'scroll-to-anchor', anchor: state.pendingAnchor });
  }
  effects.push(createPersistEffect(state));
  return effects;
}

function updateContent(
  state: SessionState,
  command: Extract<ViewerCommand, { type: 'update-content' }>,
): ViewerEffect[] {
  state.rawContent = command.content;
  state.revision += 1;
  state.targetLine = command.targetLine ?? state.currentLine ?? state.targetLine;
  syncDerivedState(state);

  const effects: ViewerEffect[] = [createPresentationEffect(state), ...createRenderLifecycleEffects()];
  const renderEffect = createRenderEffect(state, true);
  if (renderEffect) {
    effects.push(renderEffect);
  }
  effects.push(createPersistEffect(state));
  return effects;
}

function setModeIntent(
  state: SessionState,
  modeIntent: ViewerModeIntent,
): ViewerEffect[] {
  state.targetLine = state.currentLine ?? state.targetLine;
  state.modeIntent = modeIntent;
  state.revision += 1;
  syncDerivedState(state);

  const effects: ViewerEffect[] = [createModeChangedEffect(state), createPresentationEffect(state), ...createRenderLifecycleEffects()];
  const renderEffect = createRenderEffect(state, false);
  if (renderEffect) {
    effects.push(renderEffect);
  }
  effects.push(createPersistEffect(state));
  return effects;
}

export function createViewerSession(): ViewerSession {
  const state = createInitialState();

  return {
    dispatch(command): ViewerEffect[] {
      switch (command.type) {
        case 'open-document':
          return openDocument(state, command);
        case 'update-content':
          return updateContent(state, command);
        case 'set-mode-intent':
          return setModeIntent(state, command.modeIntent);
        case 'toggle-mode-intent':
          return setModeIntent(state, state.modeIntent === 'source' ? 'rendered' : 'source');
        case 'set-theme':
          state.themeId = command.themeId;
          return [
            { type: 'apply-theme', themeId: state.themeId },
            createPersistEffect(state),
            { type: 'emit-host-event', event: 'theme-changed', payload: { themeId: state.themeId } },
          ];
        case 'set-zoom':
          state.zoomPercent = command.zoomPercent;
          return [createPresentationEffect(state), createPersistEffect(state)];
        case 'set-layout-mode':
          state.layoutMode = command.layoutMode;
        {
          const effects: ViewerEffect[] = [createPresentationEffect(state)];
          const restoreEffect = createViewportRestoreEffect(state);
          if (restoreEffect) {
            effects.push(restoreEffect);
          }
          effects.push(createPersistEffect(state));
          return effects;
        }
        case 'set-toc-visibility':
          state.tocVisible = command.visible;
        {
          const effects: ViewerEffect[] = [createPresentationEffect(state)];
          const restoreEffect = createViewportRestoreEffect(state);
          if (restoreEffect) {
            effects.push(restoreEffect);
          }
          effects.push(createPersistEffect(state));
          return effects;
        }
        case 'request-anchor':
          state.pendingAnchor = command.anchor;
          return [{ type: 'scroll-to-anchor', anchor: command.anchor }];
        case 'request-target-line':
          state.targetLine = command.line;
          return typeof command.line === 'number'
            ? [{ type: 'scroll-to-line', line: command.line }, createPersistEffect(state)]
            : [createPersistEffect(state)];
        case 'report-current-line':
          state.currentLine = command.line;
          return [
            createPersistEffect(state),
            { type: 'emit-host-event', event: 'scroll-line-changed', payload: { line: command.line } },
          ];
        case 'report-heading-presence':
          state.predictedHasHeadings = command.hasHeadings;
          return [createPresentationEffect(state)];
        case 'rerender': {
          state.targetLine = state.currentLine ?? state.targetLine;
          state.revision += 1;
          syncDerivedState(state);
          const effects: ViewerEffect[] = [createPresentationEffect(state), ...createRenderLifecycleEffects()];
          const renderEffect = createRenderEffect(state, true);
          if (renderEffect) {
            effects.push(renderEffect);
          }
          return effects;
        }
      }
    },
    getSnapshot(): ViewerSessionSnapshot {
      const { rawContent: _rawContent, ...snapshot } = state;
      return { ...snapshot };
    },
  };
}