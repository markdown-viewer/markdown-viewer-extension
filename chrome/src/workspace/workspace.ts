// Workspace viewer — directory picker + file tree + preview

import '../webview/index';
import { fileTypeFromBuffer } from 'file-type';
import { getWebExtensionApi } from '../../../src/utils/platform-info';
import Localization, { DEFAULT_SETTING_LOCALE } from '../../../src/utils/localization';
import { applyI18nText } from '../../../src/ui/popup/i18n-helpers';
import { ALL_SUPPORTED_EXTENSIONS } from '../../../src/types/formats';
import { chevronRight, chevronDown, folderClosed, folderOpen, folderPlus, searchIcon, fileSearchIcon, textSearchIcon, arrowLeft, arrowRight, getFileIcon } from './file-icons';
import themeManager from '../../../src/utils/theme-manager';
import { createViewerIframeHostBridge } from '../../../src/integration/iframe-viewer-host';
import type { ViewerIframeMessage } from '../../../src/integration/iframe-viewer-host';

const webExtensionApi = getWebExtensionApi();
const VIEWER_URL = webExtensionApi.runtime.getURL('ui/workspace/viewer-embed.html');

const SUPPORTED_EXTENSIONS = new Set(
  ALL_SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1).toLowerCase())
);

interface TreeNode {
  name: string;
  kind: 'file' | 'directory';
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  path: string;
  children?: TreeNode[];
  childrenLoaded?: boolean;
  childrenLoading?: boolean;
}

interface ContentSearchResult {
  node: TreeNode;
  snippet: string;
  lineNumber: number;
}

interface RecentWorkspaceItem {
  name: string;
  handle: FileSystemDirectoryHandle;
  time: number;
}

interface PendingWorkspaceOpenRequest {
  workspaceName: string;
  filePath: string;
  requestedAt: number;
}

const PENDING_WORKSPACE_OPEN_KEY = 'markdownViewerPendingWorkspaceOpen';

type SearchMode = 'filename' | 'content';

// ─── DOM refs ───
const $landing = document.getElementById('landing')!;
const $workspace = document.getElementById('workspace')!;
const $pickBtn = document.getElementById('pick-directory')!;
const $changeBtn = document.getElementById('change-directory')!;
const $toggleSearchBtn = document.getElementById('toggle-search')!;
const $workspaceName = document.getElementById('workspace-name')!;
const $fileTree = document.getElementById('file-tree')!;
const $sidebarSearch = document.getElementById('sidebar-search')!;
const $searchModeToggle = document.getElementById('search-mode-toggle')!;
const $fileSearchInput = document.getElementById('file-search-input') as HTMLInputElement;
const $previewEmpty = document.getElementById('preview-empty')!;
const $previewFrame = document.getElementById('preview-frame') as HTMLIFrameElement;
const $previewEmptyText = $previewEmpty.querySelector('p');
const $recentWorkspaces = document.getElementById('recent-workspaces')!;
const $recentList = document.getElementById('recent-list')!;

let rootDirHandle: FileSystemDirectoryHandle | null = null;
let currentFileDir = '';
let swapPanelSide = false;
let activeFilePath = '';
let currentSearchQuery = '';

// ─── Navigation history ───
const navHistory: string[] = [];
let navIndex = -1;
let navInProgress = false;
let workspaceTree: TreeNode[] = [];
const expandedPaths = new Set<string>();
let currentSearchMode: SearchMode = 'filename';
let contentSearchResults: ContentSearchResult[] = [];
let lastExecutedContentQuery = '';
let contentSearchInProgress = false;
let contentSearchRunId = 0;
const directoryReadCache = new Map<string, Promise<TreeNode[]>>();

function postToPreviewFrame(message: ViewerIframeMessage | { type: string; [key: string]: unknown }): void {
  $previewFrame.contentWindow?.postMessage(message, '*');
}

function syncWorkspaceHistoryUiToViewer(): void {
  postToPreviewFrame({
    type: 'SYNC_WORKSPACE_HISTORY_UI',
    visible: navHistory.length > 1,
    canGoBack: navIndex > 0,
    canGoForward: navIndex >= 0 && navIndex < navHistory.length - 1,
  });
}

const previewFrameBridge = createViewerIframeHostBridge((message) => {
  postToPreviewFrame(message);
});

function updateResizeHandlePosition(): void {
  const workspaceWidth = $workspace.clientWidth;
  const sidebarWidth = $sidebar.offsetWidth;
  const handleWidth = $resizeHandle.offsetWidth || 4;
  if (workspaceWidth <= 0 || sidebarWidth <= 0) {
    return;
  }

  const seamX = swapPanelSide ? sidebarWidth : workspaceWidth - sidebarWidth;
  const handleLeft = Math.max(0, Math.min(workspaceWidth - handleWidth, seamX - handleWidth / 2));
  $resizeHandle.style.left = `${handleLeft}px`;
}

function applyWorkspacePanelSide(swapped: boolean): void {
  swapPanelSide = swapped;
  $workspace.classList.toggle('sidebar-left', swapped);
  updateResizeHandlePosition();
}

async function loadWorkspacePanelSide(): Promise<void> {
  try {
    const result = await webExtensionApi.storage.local.get(['markdownViewerSettings']);
    const stored = result.markdownViewerSettings as { swapPanelSide?: boolean } | undefined;
    applyWorkspacePanelSide(Boolean(stored?.swapPanelSide));
  } catch {
    applyWorkspacePanelSide(false);
  }
}

// ─── Resize handle ───
const $resizeHandle = document.getElementById('resize-handle')!;
const $sidebar = document.querySelector('.sidebar') as HTMLElement;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 560;

function constrainSidebarWidth(width: number): number {
  const maxWidth = Math.min(window.innerWidth * 0.5, MAX_SIDEBAR_WIDTH);
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, width));
}

function notifyPreviewLayoutChanged(): void {
  previewFrameBridge.syncHostUi({ containerMode: 'browser', layoutChanged: true });
}

let previewFrameReady = false;
let previewFrameReadyPromise: Promise<void> | null = null;

function resetPreviewFrameState(): void {
  previewFrameReady = false;
  previewFrameReadyPromise = null;
  previewFrameBridge.reset();
}

function ensureViewerFrameReady(): Promise<void> {
  if (previewFrameReady && $previewFrame.src === VIEWER_URL) {
    return Promise.resolve();
  }

  if (previewFrameReadyPromise) {
    return previewFrameReadyPromise;
  }

  $previewEmpty.style.display = 'none';
  $previewFrame.style.visibility = '';
  $previewFrame.style.display = 'block';

  previewFrameReadyPromise = new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== $previewFrame.contentWindow) return;
      if (event.data?.type !== 'VIEWER_READY') return;
      window.removeEventListener('message', onMessage);
      previewFrameReady = true;
      previewFrameReadyPromise = null;
      resolve();
    };

    window.addEventListener('message', onMessage);

    if ($previewFrame.src !== VIEWER_URL) {
      resetPreviewFrameState();
      $previewFrame.src = VIEWER_URL;
      return;
    }

    previewFrameReady = true;
    previewFrameReadyPromise = null;
    window.removeEventListener('message', onMessage);
    resolve();
  });

  return previewFrameReadyPromise;
}

async function getStoredSidebarWidth(): Promise<number | null> {
  try {
    const result = await webExtensionApi.storage.local.get(['markdownViewerSettings']);
    const stored = result.markdownViewerSettings as { readerSidebarWidth?: number } | undefined;
    if (typeof stored?.readerSidebarWidth !== 'number' || Number.isNaN(stored.readerSidebarWidth)) {
      return null;
    }
    return stored.readerSidebarWidth;
  } catch {
    return null;
  }
}

async function setStoredSidebarWidth(width: number): Promise<void> {
  try {
    const storageLocal = webExtensionApi.storage.local as {
      get: (keys: string | string[] | Record<string, unknown>) => Promise<Record<string, unknown>>;
      set?: (items: Record<string, unknown>) => Promise<void>;
    };

    const result = await storageLocal.get(['markdownViewerSettings']);
    const current = (result.markdownViewerSettings as Record<string, unknown>) || {};
    if (typeof storageLocal.set === 'function') {
      await storageLocal.set({
        markdownViewerSettings: {
          ...current,
          readerSidebarWidth: width,
        },
      });
    }
  } catch {
    // Ignore persistence failures to avoid blocking resize interactions.
  }
}

void (async () => {
  const savedWidth = await getStoredSidebarWidth();
  if (savedWidth !== null) {
    $sidebar.style.width = `${constrainSidebarWidth(savedWidth)}px`;
  }
  updateResizeHandlePosition();
})();

$resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault();
  $resizeHandle.classList.add('active');
  $previewFrame.style.pointerEvents = 'none';
  const startX = e.clientX;
  const startWidth = $sidebar.offsetWidth;

  const onMouseMove = (e: MouseEvent) => {
    const deltaX = e.clientX - startX;
    const newWidth = swapPanelSide ? startWidth + deltaX : startWidth - deltaX;
    const constrained = constrainSidebarWidth(newWidth);
    $sidebar.style.width = `${constrained}px`;
    updateResizeHandlePosition();
  };

  const onMouseUp = () => {
    $resizeHandle.classList.remove('active');
    $previewFrame.style.pointerEvents = '';
    void setStoredSidebarWidth($sidebar.offsetWidth);
    requestAnimationFrame(() => {
      notifyPreviewLayoutChanged();
    });
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

window.addEventListener('resize', updateResizeHandlePosition);

// Inject folder icons into buttons
document.getElementById('pick-icon')!.innerHTML = folderPlus;
$changeBtn.innerHTML = folderPlus;
$toggleSearchBtn.innerHTML = searchIcon;

// ─── Extension matching ───
function isSupportedFile(name: string): boolean {
  // Check compound extension first (e.g. slides.md)
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (ext.includes('.') && name.endsWith('.' + ext)) return true;
  }
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return SUPPORTED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return !IMAGE_EXTENSIONS.has(ext);
}

// Image extensions the browser can render natively (shown directly in iframe)
const PREVIEW_IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
]);

const DIRECT_HTML_PREVIEW_EXTENSIONS = new Set([
  'html', 'htm',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov',
  'pdf', 'zip', 'gz', 'tar', 'rar', '7z',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

const TEXT_LIKE_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-javascript',
  'application/x-sh',
  'application/sql',
  'image/svg+xml',
]);

function isTextMimeType(mime: string): boolean {
  return mime.startsWith('text/') || TEXT_LIKE_MIME_TYPES.has(mime);
}

function hasNullByte(sample: Uint8Array): boolean {
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

async function canPreviewAsText(file: File): Promise<boolean> {
  const sampleSize = Math.min(file.size, 8192);
  if (sampleSize === 0) return true;

  const sample = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
  const detected = await fileTypeFromBuffer(sample);

  if (!detected) {
    // Unknown signature: treat as text unless null bytes are present.
    return !hasNullByte(sample);
  }

  return isTextMimeType(detected.mime);
}

function showBinaryFileMessage(): void {
  resetPreviewFrameState();
  $previewFrame.src = 'about:blank';
  $previewFrame.style.display = 'none';
  $previewEmpty.style.display = '';
  if ($previewEmptyText) {
    $previewEmptyText.textContent = Localization.translate('workspace_binary_file_cannot_preview');
  }
}

// ─── Directory traversal (single level) ───
async function readDirectory(dirHandle: FileSystemDirectoryHandle, parentPath = ''): Promise<TreeNode[]> {
  const entries: TreeNode[] = [];
  for await (const [name, handle] of dirHandle as any) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const path = parentPath + name + (handle.kind === 'directory' ? '/' : '');
    entries.push({ name, kind: handle.kind, handle, path });
  }
  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function getCachedDirectoryEntries(dirHandle: FileSystemDirectoryHandle, parentPath = ''): Promise<TreeNode[]> {
  const key = parentPath;
  const cached = directoryReadCache.get(key);
  if (cached) {
    return cached;
  }

  const pending = readDirectory(dirHandle, parentPath)
    .catch((error) => {
      directoryReadCache.delete(key);
      throw error;
    });
  directoryReadCache.set(key, pending);
  return pending;
}

async function collectFileNodesRecursively(
  dirHandle: FileSystemDirectoryHandle,
  parentPath: string,
  shouldCancel: () => boolean,
): Promise<TreeNode[]> {
  const files: TreeNode[] = [];
  const stack: Array<{ dirHandle: FileSystemDirectoryHandle; parentPath: string }> = [
    { dirHandle, parentPath },
  ];

  while (stack.length > 0) {
    if (shouldCancel()) {
      return [];
    }

    const current = stack.pop()!;
    const entries = await getCachedDirectoryEntries(current.dirHandle, current.parentPath);
    for (const entry of entries) {
      if (entry.kind === 'file') {
        files.push(entry);
      } else {
        stack.push({
          dirHandle: entry.handle as FileSystemDirectoryHandle,
          parentPath: entry.path,
        });
      }
    }
  }

  return files;
}

// ─── File tree rendering ───
function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function getParentDirFromPath(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1 ? '' : path.slice(0, slashIndex + 1);
}

function getAncestorDirectoryPaths(filePath: string): string[] {
  const segments = filePath.split('/').filter(Boolean);
  const paths: string[] = [];

  for (let i = 0; i < segments.length - 1; i++) {
    paths.push(segments.slice(0, i + 1).join('/') + '/');
  }

  return paths;
}

async function ensureTreePathExpanded(filePath: string): Promise<void> {
  if (!rootDirHandle || !filePath) {
    return;
  }

  const ancestorPaths = getAncestorDirectoryPaths(filePath);
  if (ancestorPaths.length === 0) {
    return;
  }

  let currentNodes = workspaceTree;

  for (const dirPath of ancestorPaths) {
    const directoryNode = currentNodes.find((node) => node.kind === 'directory' && node.path === dirPath);
    if (!directoryNode) {
      return;
    }

    expandedPaths.add(dirPath);

    if (!directoryNode.childrenLoaded && !directoryNode.childrenLoading) {
      directoryNode.childrenLoading = true;
      try {
        directoryNode.children = await getCachedDirectoryEntries(directoryNode.handle as FileSystemDirectoryHandle, directoryNode.path);
        directoryNode.childrenLoaded = true;
      } catch {
        directoryNode.children = [];
        directoryNode.childrenLoaded = true;
      } finally {
        directoryNode.childrenLoading = false;
      }
    }

    currentNodes = directoryNode.children || [];
  }
}

function revealActiveTreeItem(): void {
  requestAnimationFrame(() => {
    const activeItem = $fileTree.querySelector('.tree-item.active') as HTMLElement | null;
    activeItem?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

async function syncTreeToActiveFile(filePath: string): Promise<void> {
  if (!filePath) {
    return;
  }

  await ensureTreePathExpanded(filePath);
  renderTreeView();
  revealActiveTreeItem();
}

function nodeNameMatches(node: TreeNode, query: string): boolean {
  return node.name.toLowerCase().includes(query);
}

function nodeMatchesSearch(node: TreeNode, query: string): boolean {
  if (currentSearchMode !== 'filename') {
    return true;
  }

  if (!query) {
    return true;
  }

  if (nodeNameMatches(node, query)) {
    return true;
  }

  if (node.kind === 'directory' && node.children) {
    return node.children.some((child) => nodeMatchesSearch(child, query));
  }

  return false;
}

function extractContentSnippet(content: string, query: string): string {
  const normalizedContent = content.toLowerCase();
  const matchIndex = normalizedContent.indexOf(query);
  if (matchIndex === -1) {
    return '';
  }

  const lineStart = content.lastIndexOf('\n', matchIndex);
  const lineEnd = content.indexOf('\n', matchIndex);
  const rawLine = content.slice(lineStart === -1 ? 0 : lineStart + 1, lineEnd === -1 ? content.length : lineEnd).trim();
  if (rawLine.length <= 140) {
    return rawLine;
  }

  const localIndex = rawLine.toLowerCase().indexOf(query);
  const snippetStart = Math.max(0, localIndex - 40);
  const snippetEnd = Math.min(rawLine.length, localIndex + query.length + 60);
  const prefix = snippetStart > 0 ? '...' : '';
  const suffix = snippetEnd < rawLine.length ? '...' : '';
  return prefix + rawLine.slice(snippetStart, snippetEnd) + suffix;
}

function getMatchedLineNumber(content: string, query: string): number {
  const normalizedContent = content.toLowerCase();
  const matchIndex = normalizedContent.indexOf(query);
  if (matchIndex === -1) {
    return 1;
  }

  let lineNumber = 1;
  for (let i = 0; i < matchIndex; i++) {
    if (content.charCodeAt(i) === 10) {
      lineNumber += 1;
    }
  }
  return lineNumber;
}

function appendHighlightedText(container: HTMLElement, text: string, query: string): void {
  if (!query) {
    container.textContent = text;
    return;
  }

  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let from = 0;

  while (from < text.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, from);
    if (matchIndex === -1) {
      container.append(document.createTextNode(text.slice(from)));
      break;
    }

    if (matchIndex > from) {
      container.append(document.createTextNode(text.slice(from, matchIndex)));
    }

    const mark = document.createElement('mark');
    mark.className = 'search-highlight';
    mark.textContent = text.slice(matchIndex, matchIndex + query.length);
    container.append(mark);
    from = matchIndex + query.length;
  }
}

async function runContentSearch(): Promise<void> {
  const query = currentSearchQuery;
  lastExecutedContentQuery = query;
  contentSearchRunId += 1;
  const runId = contentSearchRunId;
  let lastRenderAt = 0;

  if (!query) {
    contentSearchResults = [];
    contentSearchInProgress = false;
    renderTreeView();
    return;
  }

  contentSearchInProgress = true;
  contentSearchResults = [];
  renderTreeView();

  const results: ContentSearchResult[] = [];
  const files = rootDirHandle
    ? await collectFileNodesRecursively(rootDirHandle, '', () => runId !== contentSearchRunId)
    : [];

  if (runId !== contentSearchRunId) {
    return;
  }

  for (const node of files) {
    if (runId !== contentSearchRunId) {
      return;
    }

    if (!isSupportedFile(node.name) && !isTextFile(node.name)) {
      continue;
    }

    try {
      const file = await (node.handle as FileSystemFileHandle).getFile();
      const text = await file.text();
      if (!text.toLowerCase().includes(query)) {
        continue;
      }

      results.push({
        node,
        snippet: extractContentSnippet(text, query),
        lineNumber: getMatchedLineNumber(text, query),
      });

      const now = Date.now();
      // Throttle UI updates while still allowing near real-time incremental results.
      if (now - lastRenderAt >= 120) {
        contentSearchResults = results.slice();
        renderTreeView();
        lastRenderAt = now;
      }
    } catch {
      // Ignore unreadable files and continue searching.
    }
  }

  if (runId !== contentSearchRunId) {
    return;
  }

  contentSearchResults = results;
  contentSearchInProgress = false;
  renderTreeView();
}

function renderContentSearchResults(container: HTMLElement): void {
  if (!currentSearchQuery) {
    renderTree(workspaceTree, container, 0);
    return;
  }

  if (currentSearchQuery !== lastExecutedContentQuery) {
    const hint = document.createElement('div');
    hint.className = 'tree-empty';
    hint.textContent = Localization.translate('workspace_search_content_hint');
    container.appendChild(hint);
    return;
  }

  if (contentSearchInProgress && contentSearchResults.length === 0) {
    const searching = document.createElement('div');
    searching.className = 'tree-empty';
    searching.textContent = Localization.translate('workspace_search_content_searching');
    container.appendChild(searching);
    return;
  }

  if (contentSearchResults.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = Localization.translate('workspace_search_content_no_results');
    container.appendChild(empty);
    return;
  }

  for (const result of contentSearchResults) {
    const item = document.createElement('div');
    item.className = 'search-result-item';

    const title = document.createElement('div');
    title.className = 'search-result-title';
    appendHighlightedText(title, result.node.name, currentSearchQuery);
    item.appendChild(title);

    const path = document.createElement('div');
    path.className = 'search-result-path';
    path.textContent = `${result.node.path}:${result.lineNumber}`;
    item.appendChild(path);

    if (result.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'search-result-snippet';
      appendHighlightedText(snippet, result.snippet, currentSearchQuery);
      item.appendChild(snippet);
    }

    item.addEventListener('click', () => {
      activeFilePath = result.node.path;
      currentFileDir = getParentDirFromPath(result.node.path);
      void syncTreeToActiveFile(result.node.path);
      openFile(result.node.handle as FileSystemFileHandle, { targetLine: Math.max(0, result.lineNumber - 1) });
    });

    container.appendChild(item);
  }

  if (contentSearchInProgress) {
    const searchingMore = document.createElement('div');
    searchingMore.className = 'tree-empty';
    searchingMore.textContent = Localization.translate('workspace_search_content_searching');
    container.appendChild(searchingMore);
  }
}

function renderTree(nodes: TreeNode[], container: HTMLElement, depth = 0, forceVisible = false): number {
  let visibleCount = 0;

  for (const node of nodes) {
    const isDirectoryMatch = currentSearchMode === 'filename'
      && Boolean(currentSearchQuery)
      && node.kind === 'directory'
      && nodeNameMatches(node, currentSearchQuery);

    if (!forceVisible && !nodeMatchesSearch(node, currentSearchQuery)) {
      continue;
    }

    visibleCount += 1;

    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = `${14 + depth * 16}px`;

    const icon = document.createElement('span');
    icon.className = 'tree-icon';

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;

    if (node.kind === 'directory') {
      const isOpen = expandedPaths.has(node.path);
      const chevronEl = document.createElement('span');
      chevronEl.className = 'tree-chevron';
      chevronEl.innerHTML = isOpen ? chevronDown : chevronRight;

      icon.innerHTML = isOpen ? folderOpen : folderClosed;
      item.appendChild(chevronEl);
      item.appendChild(icon);
      item.appendChild(label);
      container.appendChild(item);

      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      if (isOpen) {
        childContainer.classList.add('open');
      }
      container.appendChild(childContainer);

      if (isOpen && node.children) {
        visibleCount += renderTree(node.children, childContainer, depth + 1, forceVisible || isDirectoryMatch);
      }

      item.addEventListener('click', async () => {
        const isExpanded = expandedPaths.has(node.path);
        if (isExpanded) {
          expandedPaths.delete(node.path);
          renderTreeView();
          return;
        }

        expandedPaths.add(node.path);
        if (!node.childrenLoaded && !node.childrenLoading) {
          node.childrenLoading = true;
          try {
            node.children = await getCachedDirectoryEntries(node.handle as FileSystemDirectoryHandle, node.path);
            node.childrenLoaded = true;
          } catch {
            node.children = [];
            node.childrenLoaded = true;
          } finally {
            node.childrenLoading = false;
          }
        }

        renderTreeView();
      });
    } else {
      icon.innerHTML = getFileIcon(node.name);
      item.appendChild(icon);
      item.appendChild(label);
      container.appendChild(item);

      if (activeFilePath === node.path) {
        item.classList.add('active');
      }

      item.addEventListener('click', () => {
        activeFilePath = node.path;
        currentFileDir = getParentDirFromPath(node.path);
        void syncTreeToActiveFile(node.path);
        openFile(node.handle as FileSystemFileHandle);
      });
    }
  }

  return visibleCount;
}

function renderTreeView(): void {
  $fileTree.innerHTML = '';

  if (currentSearchMode === 'content') {
    renderContentSearchResults($fileTree);
    return;
  }

  const visibleCount = renderTree(workspaceTree, $fileTree, 0);

  if (visibleCount === 0 && currentSearchQuery) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = Localization.translate('workspace_search_no_results');
    $fileTree.appendChild(empty);
  }
}

function updateSearchUI(): void {
  const isContentMode = currentSearchMode === 'content';
  $searchModeToggle.innerHTML = isContentMode ? textSearchIcon : fileSearchIcon;
  $searchModeToggle.title = isContentMode
    ? Localization.translate('workspace_search_mode_content_title')
    : Localization.translate('workspace_search_mode_filename_title');
  $searchModeToggle.setAttribute('aria-label', $searchModeToggle.title);
  $fileSearchInput.placeholder = isContentMode
    ? Localization.translate('workspace_search_content_placeholder')
    : Localization.translate('workspace_search_placeholder');
  $fileSearchInput.setAttribute('aria-label', $fileSearchInput.placeholder);
}

function clearSearch(closePanel = false): void {
  if ($fileSearchInput.value || currentSearchQuery) {
    $fileSearchInput.value = '';
    currentSearchQuery = '';
    lastExecutedContentQuery = '';
    contentSearchResults = [];
    contentSearchInProgress = false;
    contentSearchRunId += 1;
    updateSearchUI();
    renderTreeView();
  }

  if (closePanel) {
    $sidebarSearch.classList.add('hidden');
  }
}

function openSearch(): void {
  $sidebarSearch.classList.remove('hidden');
  updateSearchUI();
  $fileSearchInput.focus();
  $fileSearchInput.select();
}

function toggleSearch(): void {
  if ($sidebarSearch.classList.contains('hidden')) {
    openSearch();
    return;
  }

  clearSearch(true);
}

function toggleSearchMode(): void {
  currentSearchMode = currentSearchMode === 'filename' ? 'content' : 'filename';
  lastExecutedContentQuery = '';
  contentSearchResults = [];
  contentSearchInProgress = false;
  contentSearchRunId += 1;
  updateSearchUI();
  renderTreeView();
  $fileSearchInput.focus();
  $fileSearchInput.select();
}

// ─── Navigation history ───
function pushNavHistory(filePath: string): void {
  if (navInProgress) return;
  if (navHistory[navIndex] === filePath) return;
  navHistory.splice(navIndex + 1);
  navHistory.push(filePath);
  navIndex = navHistory.length - 1;
  updateNavButtons();
}

function updateNavButtons(): void {
  syncWorkspaceHistoryUiToViewer();
}

async function navigateHistory(index: number): Promise<void> {
  if (index < 0 || index >= navHistory.length) return;
  const filePath = navHistory[index];
  navIndex = index;
  navInProgress = true;
  updateNavButtons();
  try {
    await navigateToWorkspaceFile(filePath);
  } finally {
    navInProgress = false;
  }
}

// ─── Resolve relative path against file directory ───
function resolveRelativePath(fileDir: string, relativePath: string): string {
  const parts = fileDir.split('/').filter(Boolean);
  for (const seg of relativePath.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function resolveFileFromRoot(path: string): Promise<File | null> {
  if (!rootDirHandle) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  let dir = rootDirHandle;
  for (let i = 0; i < segments.length - 1; i++) {
    try { dir = await dir.getDirectoryHandle(segments[i]); }
    catch { return null; }
  }
  try {
    const fh = await dir.getFileHandle(segments[segments.length - 1]);
    return await fh.getFile();
  } catch { return null; }
}

// ─── Image preview via markdown pipeline ───
async function showImagePreview(_file: File, name: string, _ext: string): Promise<void> {
  // Pass a relative reference so resolveWorkspaceImages in viewer-embed
  // can resolve it via the parent's File System Access API — no base64 needed.
  await sendToViewer(`![${name}](./${name})`, name + '.md');
}

// ─── File preview via embedded viewer ───
async function sendToViewer(content: string, filename: string, codeView = false, targetLine?: number, workspaceFilePath?: string) {
  await ensureViewerFrameReady();

  const nextWorkspaceFilePath = workspaceFilePath || '';
  previewFrameBridge.syncDocument({
    documentKey: nextWorkspaceFilePath || filename,
    content,
    filename,
    fileDir: currentFileDir,
    workspaceName: rootDirHandle?.name || '',
    workspaceFilePath: nextWorkspaceFilePath,
    codeView,
    targetLine,
  });
  void postHostUiToViewer();
}

async function postHostUiToViewer(input: { themeId?: string } = {}): Promise<void> {
  const { themeId } = input;
  const targetThemeId = themeId ?? await themeManager.loadSelectedTheme();
  previewFrameBridge.syncHostUi({
    containerMode: 'browser',
    themeId: targetThemeId,
  });
  syncWorkspaceHistoryUiToViewer();
}

async function openFile(fileHandle: FileSystemFileHandle, options?: { targetLine?: number }) {
  const file = await fileHandle.getFile();
  const name = fileHandle.name;
  const workspaceFilePath = currentFileDir + name;

  pushNavHistory(workspaceFilePath);

  // Save last opened file path
  sessionStorage.setItem(`workspace-last-file:${rootDirHandle?.name}`, workspaceFilePath);

  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();

  if (PREVIEW_IMAGE_EXTENSIONS.has(ext)) {
    await showImagePreview(file, name, ext);
    return;
  }

  if (DIRECT_HTML_PREVIEW_EXTENSIONS.has(ext)) {
    $previewEmpty.style.display = 'none';
    $previewFrame.style.display = 'block';
    resetPreviewFrameState();
    $previewFrame.src = URL.createObjectURL(file);
    return;
  }

  if (isSupportedFile(name)) {
    const text = await file.text();
    sendToViewer(text, name, false, options?.targetLine, workspaceFilePath);
    return;
  }

  if (isTextFile(name) && await canPreviewAsText(file)) {
    // Text/code files: pass raw content; reader-side shared module decides
    // whether to render in code-reading mode.
    const text = await file.text();
    sendToViewer(text, name, false, options?.targetLine, workspaceFilePath);
    return;
  }

  showBinaryFileMessage();
}

// ─── Open workspace ───
async function openWorkspace(dirHandle: FileSystemDirectoryHandle) {
  $landing.style.display = 'none';
  $workspace.style.display = 'flex';
  requestAnimationFrame(updateResizeHandlePosition);
  $workspaceName.textContent = dirHandle.name;
  clearSearch(true);
  expandedPaths.clear();
  activeFilePath = '';
  currentSearchMode = 'filename';
  $previewEmpty.style.display = '';
  $previewFrame.style.display = 'none';
  resetPreviewFrameState();
  $previewFrame.src = 'about:blank';

  // Reset navigation history
  navHistory.length = 0;
  navIndex = -1;
  navInProgress = false;
  updateNavButtons();

  rootDirHandle = dirHandle;
  directoryReadCache.clear();
  workspaceTree = await getCachedDirectoryEntries(dirHandle, '');
  renderTreeView();

  // Save to recent workspaces
  saveRecentWorkspace(dirHandle);

  // Mark this tab as having an active workspace (for refresh detection)
  sessionStorage.setItem('workspace-active', dirHandle.name);
}

// ─── Recent workspaces (IndexedDB) ───
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('workspace-viewer', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recent')) {
        db.createObjectStore('recent', { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveRecentWorkspace(handle: FileSystemDirectoryHandle) {
  try {
    const db = await openDB();
    const tx = db.transaction('recent', 'readwrite');
    tx.objectStore('recent').put({ name: handle.name, handle, time: Date.now() });
  } catch { /* ignore */ }
}

async function deleteRecentWorkspace(name: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('recent', 'readwrite');
  tx.objectStore('recent').delete(name);

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function loadRecentWorkspaces() {
  try {
    const db = await openDB();
    const tx = db.transaction('recent', 'readonly');
    const store = tx.objectStore('recent');
    const req = store.getAll();
    req.onsuccess = () => {
      const items = ((req.result || []) as RecentWorkspaceItem[])
        .sort((a, b) => b.time - a.time)
        .slice(0, 5);

      $recentList.innerHTML = '';

      if (items.length === 0) {
        $recentWorkspaces.style.display = 'none';
        return;
      }

      $recentWorkspaces.style.display = '';
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'recent-item-row';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'recent-item';
        btn.textContent = '📁 ' + item.name;
        btn.addEventListener('click', async () => {
          try {
            const perm = await item.handle.requestPermission({ mode: 'read' });
            if (perm === 'granted') {
              openWorkspace(item.handle);
            }
          } catch {
            // User denied or handle expired
          }
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'recent-item-remove';
        removeBtn.textContent = '×';
        const removeLabel = Localization.translate('remove_from_list');
        removeBtn.title = removeLabel;
        removeBtn.setAttribute('aria-label', removeLabel);
        removeBtn.addEventListener('click', async (event) => {
          event.stopPropagation();

          try {
            await deleteRecentWorkspace(item.name);
            if (sessionStorage.getItem('workspace-active') === item.name) {
              sessionStorage.removeItem('workspace-active');
            }
            await loadRecentWorkspaces();
          } catch {
            // Ignore deletion failures to avoid interrupting the workspace UI.
          }
        });

        row.appendChild(btn);
        row.appendChild(removeBtn);
        $recentList.appendChild(row);
      }
    };
  } catch { /* ignore */ }
}

// ─── Event handlers ───
async function pickAndOpen() {
  try {
    const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
    openWorkspace(dirHandle);
  } catch {
    // User cancelled picker
  }
}

$pickBtn.addEventListener('click', pickAndOpen);
$changeBtn.addEventListener('click', pickAndOpen);
$toggleSearchBtn.addEventListener('click', toggleSearch);
$searchModeToggle.addEventListener('click', toggleSearchMode);
$fileSearchInput.addEventListener('input', () => {
  currentSearchQuery = normalizeSearchQuery($fileSearchInput.value);
  if (currentSearchMode === 'content') {
    contentSearchRunId += 1;
    contentSearchInProgress = false;
  }
  updateSearchUI();
  renderTreeView();
});
$fileSearchInput.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    clearSearch(true);
    return;
  }

  if (event.key === 'Enter' && currentSearchMode === 'content') {
    event.preventDefault();
    void runContentSearch();
  }
});

// ─── Image resolution for iframe ───
window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== $previewFrame.contentWindow) return;

  if (event.data?.type === 'WORKSPACE_HISTORY_NAVIGATE') {
    const delta = Number(event.data.delta);
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    void navigateHistory(navIndex + (delta < 0 ? -1 : 1));
    return;
  }

  if (event.data?.type === 'RESOLVE_IMAGE') {
    const { src, id } = event.data;
    const resolved = resolveRelativePath(currentFileDir, src);
    const file = await resolveFileFromRoot(resolved);
    if (file) {
      const url = URL.createObjectURL(file);
      $previewFrame.contentWindow!.postMessage({ type: 'IMAGE_RESOLVED', id, url }, '*');
    }
    return;
  }

  // Relative link clicks from the rendered markdown inside the iframe
  if (event.data?.type === 'WORKSPACE_NAVIGATE') {
    const rawPath = String(event.data.path || '');
    const hashIndex = rawPath.indexOf('#');
    const pathOnly = hashIndex >= 0 ? rawPath.slice(0, hashIndex) : rawPath;
    if (pathOnly) {
      const resolved = resolveRelativePath(currentFileDir, pathOnly);
      void navigateToWorkspaceFile(resolved);
    }
    return;
  }

  // File read requests from DocumentService.readRelativeFile (SVG plugin, DOCX export, etc.)
  if (event.data?.type === 'RESOLVE_FILE') {
    const { path, id, binary } = event.data;
    const resolved = resolveRelativePath(currentFileDir, path);
    const file = await resolveFileFromRoot(resolved);
    if (file) {
      try {
        let content: string;
        if (binary) {
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binaryString = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            binaryString += String.fromCharCode(bytes[i]);
          }
          content = btoa(binaryString);
        } else {
          content = await file.text();
        }
        $previewFrame.contentWindow!.postMessage({ type: 'FILE_RESOLVED', id, content }, '*');
      } catch (err) {
        $previewFrame.contentWindow!.postMessage({ type: 'FILE_RESOLVED', id, error: (err as Error).message }, '*');
      }
    } else {
      $previewFrame.contentWindow!.postMessage({ type: 'FILE_RESOLVED', id, error: `File not found: ${path}` }, '*');
    }
  }
});

// ─── Navigate to a workspace file (from markdown link click) ───
async function navigateToWorkspaceFile(filePath: string): Promise<void> {
  if (!rootDirHandle) return;
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length === 0) return;
  const fileName = segments[segments.length - 1];
  const dirPath = segments.length > 1 ? segments.slice(0, -1).join('/') + '/' : '';

  let dir = rootDirHandle;
  for (let i = 0; i < segments.length - 1; i++) {
    try { dir = await dir.getDirectoryHandle(segments[i]); }
    catch { return; }
  }
  try {
    const fh = await dir.getFileHandle(fileName);
    activeFilePath = filePath;
    currentFileDir = dirPath;
    void syncTreeToActiveFile(filePath);
    openFile(fh);
  } catch { /* file not found */ }
}

// ─── Restore last file ───
async function restoreLastFile(filePath: string): Promise<void> {
  if (!rootDirHandle) return;
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length === 0) return;
  const fileName = segments[segments.length - 1];
  const dirPath = segments.length > 1 ? segments.slice(0, -1).join('/') + '/' : '';

  let dir = rootDirHandle;
  for (let i = 0; i < segments.length - 1; i++) {
    try { dir = await dir.getDirectoryHandle(segments[i]); }
    catch { return; }
  }
  try {
    const fh = await dir.getFileHandle(fileName);
    currentFileDir = dirPath;
    activeFilePath = filePath;
    await syncTreeToActiveFile(filePath);
    await openFile(fh);
  } catch { /* file no longer exists */ }
}

// ─── Restore last workspace on refresh ───
async function restoreLastWorkspace(): Promise<boolean> {
  // Only restore if this is a refresh (sessionStorage survives refresh but not new tabs)
  const activeWorkspace = sessionStorage.getItem('workspace-active');
  if (!activeWorkspace) return false;

  try {
    const db = await openDB();
    const tx = db.transaction('recent', 'readonly');
    const store = tx.objectStore('recent');
    const req = store.get(activeWorkspace);
    return new Promise((resolve) => {
      req.onsuccess = async () => {
        const item = req.result;
        if (!item) { resolve(false); return; }
        try {
          const perm = await item.handle.queryPermission({ mode: 'read' });
          if (perm === 'granted') {
            await openWorkspace(item.handle);
            // Restore last opened file
            const lastFile = sessionStorage.getItem(`workspace-last-file:${item.handle.name}`);
            if (lastFile) {
              await restoreLastFile(lastFile);
            }
            resolve(true);
            return;
          }
        } catch { /* handle expired */ }
        resolve(false);
      };
      req.onerror = () => resolve(false);
    });
  } catch { return false; }
}

async function consumePendingWorkspaceOpen(): Promise<boolean> {
  try {
    const storageLocal = webExtensionApi.storage.local as {
      get: (keys: string | string[] | Record<string, unknown>) => Promise<Record<string, unknown>>;
      remove?: (keys: string | string[]) => Promise<void>;
      set?: (items: Record<string, unknown>) => Promise<void>;
    };

    const result = await storageLocal.get([PENDING_WORKSPACE_OPEN_KEY]);
    const pending = result[PENDING_WORKSPACE_OPEN_KEY] as PendingWorkspaceOpenRequest | undefined;

    if (!pending?.workspaceName || !pending?.filePath) {
      return false;
    }

    if (typeof storageLocal.remove === 'function') {
      await storageLocal.remove(PENDING_WORKSPACE_OPEN_KEY);
    } else if (typeof storageLocal.set === 'function') {
      await storageLocal.set({ [PENDING_WORKSPACE_OPEN_KEY]: null });
    }

    const db = await openDB();
    const tx = db.transaction('recent', 'readonly');
    const store = tx.objectStore('recent');
    const req = store.get(pending.workspaceName);

    return await new Promise<boolean>((resolve) => {
      req.onsuccess = async () => {
        const item = req.result as RecentWorkspaceItem | undefined;
        if (!item) {
          resolve(false);
          return;
        }

        try {
          const perm = await item.handle.queryPermission({ mode: 'read' });
          if (perm !== 'granted') {
            resolve(false);
            return;
          }

          await openWorkspace(item.handle);
          await restoreLastFile(pending.filePath);
          resolve(true);
        } catch {
          resolve(false);
        }
      };
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

// ─── Init ───
// Dark-mode sync: read the currently selected theme's category from the
// registry and toggle `.dark` on <html>. Doing this eagerly (not via the
// iframe-written sessionStorage flag) guarantees the outer workspace surface
// is already dark on first paint after refresh, and stays consistent while
// switching files — otherwise .preview-pane flashes white behind the iframe
// element during its navigation blank frame.
async function syncDarkClassFromSelectedTheme(): Promise<void> {
  try {
    const themeId = await themeManager.loadSelectedTheme();
    await themeManager.initialize();
    const isDark = themeManager.getThemeCategory(themeId) === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    try { sessionStorage.setItem('mdv-dark', isDark ? '1' : '0'); } catch { /* storage disabled */ }
  } catch { /* keep default light */ }
}

Localization.init().then(async () => {
  await syncDarkClassFromSelectedTheme();
  await loadWorkspacePanelSide();

  if (webExtensionApi.storage?.onChanged) {
    webExtensionApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.markdownViewerSettings) {
        return;
      }

      const oldSettings = changes.markdownViewerSettings.oldValue as { swapPanelSide?: boolean; preferredLocale?: string; themeId?: string } | undefined;
      const nextSettings = changes.markdownViewerSettings.newValue as { swapPanelSide?: boolean; preferredLocale?: string; themeId?: string } | undefined;
      applyWorkspacePanelSide(Boolean(nextSettings?.swapPanelSide));

      const oldLocale = oldSettings?.preferredLocale ?? DEFAULT_SETTING_LOCALE;
      const nextLocale = nextSettings?.preferredLocale ?? DEFAULT_SETTING_LOCALE;
      if (oldLocale !== nextLocale) {
        void Localization.setPreferredLocale(nextLocale)
          .then(() => {
            applyI18nText();
            updateSearchUI();
            renderTreeView();
            if (activeFilePath) {
              void restoreLastFile(activeFilePath);
            }
          })
          .catch((error) => {
            console.error('[Workspace] Failed to update locale:', error);
          });
      }

      if (typeof nextSettings?.themeId === 'string' && nextSettings.themeId !== oldSettings?.themeId) {
        void postHostUiToViewer({ themeId: nextSettings.themeId });
      }

      // Theme may have changed in the popup; re-sync dark class so the outer
      // surface follows without waiting for the next iframe render.
      void syncDarkClassFromSelectedTheme();
    });
  }

  // Cross-document sync of dark-mode flag. The embedded viewer writes
  // `mdv-dark` to localStorage whenever it applies a theme; since iframe and
  // workspace share the same extension origin, this `storage` event fires on
  // the outer page and lets us update the surface color immediately.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'mdv-dark') return;
    document.documentElement.classList.toggle('dark', e.newValue === '1');
  });

  applyI18nText();
  const restored = await consumePendingWorkspaceOpen() || await restoreLastWorkspace();
  if (!restored) {
    loadRecentWorkspaces();
  }
});
