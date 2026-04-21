// Workspace viewer — directory picker + file tree + preview

import '../webview/index';
import { fileTypeFromBuffer } from 'file-type';
import { getWebExtensionApi } from '../../../src/utils/platform-info';
import Localization, { DEFAULT_SETTING_LOCALE } from '../../../src/utils/localization';
import { applyI18nText } from '../../../src/ui/popup/i18n-helpers';
import { chevronRight, chevronDown, folderClosed, folderOpen, folderPlus, searchIcon, fileSearchIcon, textSearchIcon, getFileIcon } from './file-icons';
import themeManager from '../../../src/utils/theme-manager';

const webExtensionApi = getWebExtensionApi();
const VIEWER_URL = webExtensionApi.runtime.getURL('ui/workspace/viewer-embed.html');

const SUPPORTED_EXTENSIONS = new Set([
  'md', 'markdown', 'slides.md',
  'mermaid', 'mmd',
  'plantuml', 'puml',
  'vega', 'vl', 'vega-lite',
  'gv', 'dot',
  'infographic', 'canvas', 'drawio'
]);

interface TreeNode {
  name: string;
  kind: 'file' | 'directory';
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  path: string;
  children?: TreeNode[];
}

interface ContentSearchResult {
  node: TreeNode;
  snippet: string;
}

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
let workspaceTree: TreeNode[] = [];
const expandedPaths = new Set<string>();
let currentSearchMode: SearchMode = 'filename';
let contentSearchResults: ContentSearchResult[] = [];
let lastExecutedContentQuery = '';
let contentSearchInProgress = false;
let contentSearchRunId = 0;

function applyWorkspacePanelSide(swapped: boolean): void {
  swapPanelSide = swapped;
  $workspace.classList.toggle('sidebar-left', swapped);
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
const SIDEBAR_WIDTH_KEY = 'workspace-sidebar-width';
const $resizeHandle = document.getElementById('resize-handle')!;
const $sidebar = document.querySelector('.sidebar') as HTMLElement;

// Restore saved width
const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
if (savedWidth) {
  $sidebar.style.width = savedWidth + 'px';
}

$resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault();
  $resizeHandle.classList.add('active');
  $previewFrame.style.pointerEvents = 'none';
  const startX = e.clientX;
  const startWidth = $sidebar.offsetWidth;

  const onMouseMove = (e: MouseEvent) => {
    const deltaX = e.clientX - startX;
    const newWidth = swapPanelSide ? startWidth + deltaX : startWidth - deltaX;
    if (newWidth >= 160 && newWidth <= window.innerWidth * 0.5) {
      $sidebar.style.width = newWidth + 'px';
    }
  };

  const onMouseUp = () => {
    $resizeHandle.classList.remove('active');
    $previewFrame.style.pointerEvents = '';
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String($sidebar.offsetWidth));
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

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

  for (const entry of entries) {
    if (entry.kind === 'directory') {
      entry.children = await readDirectory(entry.handle as FileSystemDirectoryHandle, entry.path);
    }
  }

  return entries;
}

// ─── File tree rendering ───
function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function getParentDirFromPath(path: string): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex === -1 ? '' : path.slice(0, slashIndex + 1);
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

function flattenFileNodes(nodes: TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];

  for (const node of nodes) {
    if (node.kind === 'file') {
      files.push(node);
      continue;
    }

    if (node.children) {
      files.push(...flattenFileNodes(node.children));
    }
  }

  return files;
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

async function runContentSearch(): Promise<void> {
  const query = currentSearchQuery;
  lastExecutedContentQuery = query;
  contentSearchRunId += 1;
  const runId = contentSearchRunId;

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
  const files = flattenFileNodes(workspaceTree);

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
      });
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

  if (contentSearchInProgress) {
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
    title.textContent = result.node.name;
    item.appendChild(title);

    const path = document.createElement('div');
    path.className = 'search-result-path';
    path.textContent = result.node.path;
    item.appendChild(path);

    if (result.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'search-result-snippet';
      snippet.textContent = result.snippet;
      item.appendChild(snippet);
    }

    item.addEventListener('click', () => {
      activeFilePath = result.node.path;
      currentFileDir = getParentDirFromPath(result.node.path);
      renderTreeView();
      openFile(result.node.handle as FileSystemFileHandle);
    });

    container.appendChild(item);
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

      item.addEventListener('click', () => {
        if (expandedPaths.has(node.path)) {
          expandedPaths.delete(node.path);
        } else {
          expandedPaths.add(node.path);
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
        renderTreeView();
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

// ─── File preview via embedded viewer ───
function sendToViewer(content: string, filename: string, codeView = false) {
  // Hide the iframe while it navigates + renders. The iframe element's blank
  // frame during src reset would otherwise flash the default UA white (or
  // the iframe body's unthemed background). The preview-pane behind it is
  // already themed, so the user sees a stable surface until VIEWER_RENDERED.
  $previewEmpty.style.display = 'none';
  $previewFrame.style.visibility = 'hidden';
  $previewFrame.style.display = 'block';
  $previewFrame.src = VIEWER_URL;

  const onMessage = (event: MessageEvent) => {
    if (event.source !== $previewFrame.contentWindow) return;
    if (event.data?.type === 'VIEWER_READY') {
      $previewFrame.contentWindow!.postMessage({
        type: 'RENDER_FILE',
        content,
        filename,
        fileDir: currentFileDir,
        codeView,
      }, '*');
      return;
    }
    if (event.data?.type === 'VIEWER_RENDERED') {
      // Theme applied and body opacity=1 — safe to reveal the iframe.
      window.removeEventListener('message', onMessage);
      $previewFrame.style.visibility = '';
    }
  };
  window.addEventListener('message', onMessage);
}

async function openFile(fileHandle: FileSystemFileHandle) {
  const file = await fileHandle.getFile();
  const name = fileHandle.name;

  // Save last opened file path
  localStorage.setItem(`workspace-last-file:${rootDirHandle?.name}`, currentFileDir + name);

  if (isSupportedFile(name)) {
    const text = await file.text();
    sendToViewer(text, name);
    return;
  }

  if (isTextFile(name) && await canPreviewAsText(file)) {
    // Code/text files: wrap in code block using extension as language tag
    const text = await file.text();
    const ext = name.slice(name.lastIndexOf('.') + 1);
    sendToViewer(`\`\`\`${ext}\n${text.trimEnd()}\n\`\`\``, name, true);
    return;
  }

  showBinaryFileMessage();
}

// ─── Open workspace ───
async function openWorkspace(dirHandle: FileSystemDirectoryHandle) {
  $landing.style.display = 'none';
  $workspace.style.display = 'flex';
  $workspaceName.textContent = dirHandle.name;
  clearSearch(true);
  expandedPaths.clear();
  activeFilePath = '';
  currentSearchMode = 'filename';
  $previewEmpty.style.display = '';
  $previewFrame.style.display = 'none';
  $previewFrame.src = 'about:blank';

  rootDirHandle = dirHandle;
  workspaceTree = await readDirectory(dirHandle, '');
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

async function loadRecentWorkspaces() {
  try {
    const db = await openDB();
    const tx = db.transaction('recent', 'readonly');
    const store = tx.objectStore('recent');
    const req = store.getAll();
    req.onsuccess = () => {
      const items = (req.result || []).sort((a: any, b: any) => b.time - a.time).slice(0, 5);
      if (items.length === 0) return;

      $recentWorkspaces.style.display = '';
      $recentList.innerHTML = '';
      for (const item of items) {
        const btn = document.createElement('button');
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
        $recentList.appendChild(btn);
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
    renderTreeView();
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
            const lastFile = localStorage.getItem(`workspace-last-file:${item.handle.name}`);
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

// ─── Init ───
// Dark-mode sync: read the currently selected theme's category from the
// registry and toggle `.dark` on <html>. Doing this eagerly (not via the
// iframe-written localStorage flag) guarantees the outer workspace surface
// is already dark on first paint after refresh, and stays consistent while
// switching files — otherwise .preview-pane flashes white behind the iframe
// element during its navigation blank frame.
async function syncDarkClassFromSelectedTheme(): Promise<void> {
  try {
    const themeId = await themeManager.loadSelectedTheme();
    await themeManager.initialize();
    const isDark = themeManager.getThemeCategory(themeId) === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    try { localStorage.setItem('mdv-dark', isDark ? '1' : '0'); } catch { /* storage disabled */ }
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

      const oldSettings = changes.markdownViewerSettings.oldValue as { swapPanelSide?: boolean; preferredLocale?: string } | undefined;
      const nextSettings = changes.markdownViewerSettings.newValue as { swapPanelSide?: boolean; preferredLocale?: string } | undefined;
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
  const restored = await restoreLastWorkspace();
  if (!restored) {
    loadRecentWorkspaces();
  }
});
