// Workspace viewer — directory picker + file tree + preview

import '../webview/index';
import { getWebExtensionApi } from '../../../src/utils/platform-info';
import Localization from '../../../src/utils/localization';
import { applyI18nText } from '../../../src/ui/popup/i18n-helpers';
import { chevronRight, chevronDown, folderClosed, folderOpen, folderPlus, getFileIcon } from './file-icons';

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
}

// ─── DOM refs ───
const $landing = document.getElementById('landing')!;
const $workspace = document.getElementById('workspace')!;
const $pickBtn = document.getElementById('pick-directory')!;
const $changeBtn = document.getElementById('change-directory')!;
const $workspaceName = document.getElementById('workspace-name')!;
const $fileTree = document.getElementById('file-tree')!;
const $previewEmpty = document.getElementById('preview-empty')!;
const $previewFrame = document.getElementById('preview-frame') as HTMLIFrameElement;
const $recentWorkspaces = document.getElementById('recent-workspaces')!;
const $recentList = document.getElementById('recent-list')!;

let activeItem: HTMLElement | null = null;

// Inject folder icons into buttons
document.getElementById('pick-icon')!.innerHTML = folderPlus;
$changeBtn.innerHTML = folderPlus;

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

// ─── Code file → markdown language id ───
const CODE_LANG_MAP: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  jsx: 'jsx', tsx: 'tsx',
  py: 'python', pyw: 'python',
  rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', fs: 'fsharp',
  swift: 'swift', dart: 'dart', lua: 'lua', zig: 'zig',
  r: 'r', pl: 'perl', pm: 'perl',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  ps1: 'powershell', bat: 'batch', cmd: 'batch',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  vue: 'vue', svelte: 'svelte',
  json: 'json', jsonc: 'jsonc', json5: 'json5',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  xml: 'xml', xsl: 'xml', xslt: 'xml',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  makefile: 'makefile', cmake: 'cmake',
  tf: 'hcl', hcl: 'hcl',
  proto: 'protobuf',
  tex: 'latex', bib: 'bibtex',
  diff: 'diff', patch: 'diff',
  log: 'log', conf: 'ini', cfg: 'ini', env: 'bash',
};

const CODE_NAME_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  CMakeLists: 'cmake',
  Vagrantfile: 'ruby',
  Rakefile: 'ruby',
  Gemfile: 'ruby',
};

function getCodeLang(name: string): string | null {
  // Check special filenames
  if (CODE_NAME_MAP[name]) return CODE_NAME_MAP[name];
  const base = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  if (CODE_NAME_MAP[base]) return CODE_NAME_MAP[base];
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return CODE_LANG_MAP[name.slice(dot + 1).toLowerCase()] || null;
}

// ─── Directory traversal (single level) ───
async function readDirectory(dirHandle: FileSystemDirectoryHandle): Promise<TreeNode[]> {
  const entries: TreeNode[] = [];
  for await (const [name, handle] of dirHandle as any) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    entries.push({ name, kind: handle.kind, handle });
  }
  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

// ─── File tree rendering ───
function renderTree(nodes: TreeNode[], container: HTMLElement, depth = 0) {
  for (const node of nodes) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = `${14 + depth * 16}px`;

    const icon = document.createElement('span');
    icon.className = 'tree-icon';

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;

    if (node.kind === 'directory') {
      const chevronEl = document.createElement('span');
      chevronEl.className = 'tree-chevron';
      chevronEl.innerHTML = chevronRight;

      icon.innerHTML = folderClosed;
      item.appendChild(chevronEl);
      item.appendChild(icon);
      item.appendChild(label);
      container.appendChild(item);

      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      container.appendChild(childContainer);

      let loaded = false;
      item.addEventListener('click', async () => {
        const isOpen = childContainer.classList.toggle('open');
        chevronEl.innerHTML = isOpen ? chevronDown : chevronRight;
        icon.innerHTML = isOpen ? folderOpen : folderClosed;
        if (isOpen && !loaded) {
          loaded = true;
          const children = await readDirectory(node.handle as FileSystemDirectoryHandle);
          renderTree(children, childContainer, depth + 1);
        }
      });
    } else {
      icon.innerHTML = getFileIcon(node.name);
      item.appendChild(icon);
      item.appendChild(label);
      container.appendChild(item);

      item.addEventListener('click', () => {
        if (activeItem) activeItem.classList.remove('active');
        item.classList.add('active');
        activeItem = item;
        openFile(node.handle as FileSystemFileHandle);
      });
    }
  }
}

// ─── File preview via embedded viewer ───
function sendToViewer(content: string, filename: string) {
  $previewEmpty.style.display = 'none';
  $previewFrame.style.display = 'block';
  $previewFrame.src = VIEWER_URL;

  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === 'VIEWER_READY' && event.source === $previewFrame.contentWindow) {
      window.removeEventListener('message', onMessage);
      $previewFrame.contentWindow!.postMessage({
        type: 'RENDER_FILE',
        content,
        filename,
      }, '*');
    }
  };
  window.addEventListener('message', onMessage);
}

async function openFile(fileHandle: FileSystemFileHandle) {
  const file = await fileHandle.getFile();
  const name = fileHandle.name;

  if (isSupportedFile(name)) {
    // Supported formats: render via viewer-embed as-is
    const text = await file.text();
    sendToViewer(text, name);
    return;
  }

  const lang = getCodeLang(name);
  if (lang) {
    // Code files: wrap in markdown code block, same as mermaid/puml
    const text = await file.text();
    sendToViewer(`\`\`\`${lang}\n${text}\n\`\`\``, 'code.md');
    return;
  }

  // Other files: display directly via blob URL
  $previewEmpty.style.display = 'none';
  $previewFrame.style.display = 'block';
  const url = URL.createObjectURL(file);
  $previewFrame.src = url;
}

// ─── Open workspace ───
async function openWorkspace(dirHandle: FileSystemDirectoryHandle) {
  $landing.style.display = 'none';
  $workspace.style.display = 'flex';
  $workspaceName.textContent = dirHandle.name;
  $fileTree.innerHTML = '';
  activeItem = null;
  $previewEmpty.style.display = '';
  $previewFrame.style.display = 'none';
  $previewFrame.src = 'about:blank';

  const tree = await readDirectory(dirHandle);
  renderTree(tree, $fileTree);

  // Save to recent workspaces
  saveRecentWorkspace(dirHandle);
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

// ─── Init ───
Localization.init().then(() => {
  applyI18nText();
  loadRecentWorkspaces();
});
