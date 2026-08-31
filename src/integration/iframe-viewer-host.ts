
export type ViewerIframeContainerMode = Extract<ViewerContainerMode, 'browser' | 'panel'>;

export interface ViewerOpenDocumentMessage {
  type: 'OPEN_DOCUMENT';
  content?: string;
  filename?: string;
  fileDir?: string;
  workspaceName?: string;
  workspaceFilePath?: string;
  codeView?: boolean;
  targetLine?: number;
}

export interface ViewerUpdateContentMessage {
  type: 'UPDATE_CONTENT';
  content?: string;
  targetLine?: number;
}

export interface ViewerSyncHostUiMessage {
  type: 'SYNC_HOST_UI';
  themeId?: string;
  containerMode?: ViewerIframeContainerMode;
  tocDepth?: number;
  layoutChanged?: boolean;
}

export interface ViewerSyncHostNavigationMessage {
  type: 'SYNC_HOST_NAVIGATION';
  anchor?: string;
  line?: number;
}

export interface ViewerExportRequestMessage {
  type: 'EXPORT_REQUEST';
  /** Export format: 'docx' | 'epub' | 'html' | 'pdf' | 'save' */
  format: string;
  /** Optional request id echoed back in EXPORT_RESULT. */
  requestId?: string;
  /** Optional base filename override. */
  filename?: string;
  /** Optional document title override. */
  title?: string;
}

export interface ViewerExportResultMessage {
  type: 'EXPORT_RESULT';
  /** Echoed from the matching EXPORT_REQUEST. */
  requestId?: string;
  ok: boolean;
  error?: string;
  /** Final exported filename when the export succeeded. */
  filename?: string;
}

export type ViewerIframeMessage =
  | ViewerOpenDocumentMessage
  | ViewerUpdateContentMessage
  | ViewerSyncHostUiMessage
  | ViewerSyncHostNavigationMessage
  | ViewerExportRequestMessage
  | ViewerExportResultMessage;

export interface ViewerIframeDocumentSyncInput {
  documentKey: string;
  content: string;
  filename: string;
  fileDir?: string;
  workspaceName?: string;
  workspaceFilePath?: string;
  codeView?: boolean;
  targetLine?: number;
}

export interface ViewerIframeExportRequestInput {
  format: string;
  requestId?: string;
  filename?: string;
  title?: string;
}

export interface ViewerIframeHostBridge {
  reset(): void;
  syncDocument(input: ViewerIframeDocumentSyncInput): void;
  syncHostUi(input: Omit<ViewerSyncHostUiMessage, 'type'>): void;
  syncHostNavigation(input: Omit<ViewerSyncHostNavigationMessage, 'type'>): void;
  /** Ask the embedded viewer to run an export (docx/epub/html/pdf/save). */
  requestExport(input: ViewerIframeExportRequestInput): void;
}

export function createViewerIframeHostBridge(
  postMessage: (message: ViewerIframeMessage) => void,
): ViewerIframeHostBridge {
  let openedDocumentKey = '';

  return {
    reset(): void {
      openedDocumentKey = '';
    },

    syncDocument(input: ViewerIframeDocumentSyncInput): void {
      const {
        documentKey,
        content,
        filename,
        fileDir,
        workspaceName,
        workspaceFilePath,
        codeView,
        targetLine,
      } = input;

      if (openedDocumentKey && openedDocumentKey === documentKey) {
        postMessage({
          type: 'UPDATE_CONTENT',
          content,
          targetLine,
        });
        return;
      }

      openedDocumentKey = documentKey;
      postMessage({
        type: 'OPEN_DOCUMENT',
        content,
        filename,
        fileDir,
        workspaceName,
        workspaceFilePath,
        codeView,
        targetLine,
      });
    },

    syncHostUi(input: Omit<ViewerSyncHostUiMessage, 'type'>): void {
      postMessage({
        type: 'SYNC_HOST_UI',
        ...input,
      });
    },

    syncHostNavigation(input: Omit<ViewerSyncHostNavigationMessage, 'type'>): void {
      postMessage({
        type: 'SYNC_HOST_NAVIGATION',
        ...input,
      });
    },

    requestExport(input: ViewerIframeExportRequestInput): void {
      postMessage({
        type: 'EXPORT_REQUEST',
        ...input,
      });
    },
  };
}