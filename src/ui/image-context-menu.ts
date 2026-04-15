/**
 * Image Context Menu (Shared)
 *
 * Cross-platform right-click context menu for images in rendered Markdown.
 * Supports downloading PNG for all images, plus SVG/DrawIO for diagrams.
 */

import { getDiagramExport } from './diagram-export-registry';

// ============================================================================
// Types
// ============================================================================

export interface ImageContextMenuOptions {
  /** Container element to listen for contextmenu events */
  container: HTMLElement;
  /** Download callback - platform-specific implementation */
  onDownload: (file: { filename: string; data: string; mimeType: string }) => void;
  /** Optional translation function */
  translate?: (key: string) => string;
}

type DownloadableFile = {
  filename: string;
  data: string;
  mimeType: string;
};

// ============================================================================
// CSS (injected once)
// ============================================================================

let cssInjected = false;

function injectCSS(): void {
  if (cssInjected) return;
  cssInjected = true;

  const style = document.createElement('style');
  style.textContent = `
.image-context-menu {
  position: absolute;
  z-index: 10000;
  background: var(--vscode-menu-background, var(--color-bg-surface, #ffffff));
  color: var(--vscode-menu-foreground, var(--color-text-primary, #1a1a1a));
  border: 1px solid var(--vscode-menu-border, var(--color-border, #e2e8f0));
  border-radius: 4px;
  padding: 4px 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  min-width: 180px;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.image-context-menu-item {
  padding: 6px 20px;
  cursor: pointer;
  white-space: nowrap;
}
.image-context-menu-item:hover {
  background: var(--vscode-menu-selectionBackground, var(--color-primary, #2563eb));
  color: var(--vscode-menu-selectionForeground, #ffffff);
}
.image-context-menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--vscode-menu-separatorBackground, var(--color-border, #e2e8f0));
}
`;
  document.head.appendChild(style);
}

// ============================================================================
// Setup
// ============================================================================

/**
 * Set up image context menu on a container element.
 * Returns a cleanup function to remove event listeners.
 */
export function setupImageContextMenu(options: ImageContextMenuOptions): () => void {
  const { container, onDownload, translate: translateFn } = options;

  injectCSS();

  let contextMenu: HTMLElement | null = null;

  function translate(key: string): string {
    return translateFn?.(key) || fallbackTranslation(key);
  }

  function removeContextMenu(): void {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
  }

  function onDocumentClick(): void {
    removeContextMenu();
  }

  function onScroll(): void {
    removeContextMenu();
  }

  function onContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const img = target.closest('img') as HTMLImageElement | null;
    if (!img) return;

    e.preventDefault();
    removeContextMenu();

    // Detect diagram type from data attributes
    const diagramEl = img.closest('[data-source-hash]') as HTMLElement | null;
    const sourceHash = diagramEl?.dataset?.sourceHash || img.dataset?.sourceHash;
    const pluginType = diagramEl?.dataset?.pluginType || img.dataset?.pluginType;
    const exportData = sourceHash ? getDiagramExport(sourceHash) : undefined;

    // Build context menu
    contextMenu = document.createElement('div');
    contextMenu.className = 'image-context-menu';
    contextMenu.style.left = `${e.pageX}px`;
    contextMenu.style.top = `${e.pageY}px`;

    // Derive base filename from the image alt text or plugin type
    const baseName = pluginType || 'image';

    // PNG download (always available for images)
    addMenuItem(contextMenu, translate('save_as_png'), () => {
      removeContextMenu();
      savePng(img, baseName, onDownload);
    });

    // SVG download (available if diagram has SVG data)
    const svgContent = exportData?.svg;
    if (svgContent) {
      addMenuItem(contextMenu, translate('save_as_svg'), () => {
        removeContextMenu();
        onDownload(createTextDownloadFile(`${baseName}.svg`, svgContent, 'image/svg+xml'));
      });
    }

    // DrawIO download (available for plantuml diagrams)
    if (exportData?.drawioXml) {
      addMenuItem(contextMenu, translate('save_as_drawio'), () => {
        removeContextMenu();
        const drawioData = btoa(unescape(encodeURIComponent(exportData.drawioXml!)));
        onDownload({
          filename: `${baseName}.drawio`,
          data: drawioData,
          mimeType: 'application/xml',
        });
      });
    }

    addMenuItem(contextMenu, translate('copy_as_png'), () => {
      removeContextMenu();
      void copyPng(img).catch((err) => {
        console.error('[ImageContextMenu] Failed to copy PNG:', err);
      });
    });

    // For non-diagram images (regular markdown images), show generic "Save Image As"
    if (!pluginType && !exportData) {
      // Clear the menu items and add a single generic save option
      contextMenu.innerHTML = '';
      addMenuItem(contextMenu, translate('save_image_as'), () => {
        removeContextMenu();
        saveImage(img, onDownload);
      });
      addMenuItem(contextMenu, translate('copy_as_png'), () => {
        removeContextMenu();
        void copyPng(img).catch((err) => {
          console.error('[ImageContextMenu] Failed to copy image:', err);
        });
      });
    }

    document.body.appendChild(contextMenu);

    // Ensure menu stays within viewport
    requestAnimationFrame(() => {
      if (!contextMenu) return;
      const rect = contextMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        contextMenu.style.left = `${e.pageX - rect.width}px`;
      }
      if (rect.bottom > window.innerHeight) {
        contextMenu.style.top = `${e.pageY - rect.height}px`;
      }
    });
  }

  // Event listeners
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('scroll', onScroll, true);
  container.addEventListener('contextmenu', onContextMenu);

  // Return cleanup function
  return () => {
    removeContextMenu();
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('scroll', onScroll, true);
    container.removeEventListener('contextmenu', onContextMenu);
  };
}

// ============================================================================
// Helpers
// ============================================================================

function addMenuItem(menu: HTMLElement, label: string, onClick: () => void): void {
  const item = document.createElement('div');
  item.className = 'image-context-menu-item';
  item.textContent = label;
  item.addEventListener('click', onClick);
  menu.appendChild(item);
}

/**
 * Save diagram PNG from img element
 */
function savePng(
  img: HTMLImageElement,
  baseName: string,
  onDownload: (file: { filename: string; data: string; mimeType: string }) => void
): void {
  const src = img.src;

  if (src.startsWith('data:image/png;base64,')) {
    onDownload(createBinaryDownloadFile(`${baseName}.png`, src, 'image/png'));
    return;
  }

  // Fallback: draw to canvas
  extractImageAsBase64(img).then(({ data, mimeType }) => {
    onDownload({
      filename: `${baseName}.png`,
      data,
      mimeType,
    });
  }).catch(err => {
    console.error('[ImageContextMenu] Failed to save PNG:', err);
  });
}

/**
 * Save a generic (non-diagram) image
 */
function saveImage(
  img: HTMLImageElement,
  onDownload: (file: { filename: string; data: string; mimeType: string }) => void
): void {
  const src = img.src;

  if (src.startsWith('data:')) {
    const match = src.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mimeType = match[1];
      const base64Data = match[2];
      const ext = mimeType.split('/')[1] || 'png';
      onDownload({ filename: `image.${ext}`, data: base64Data, mimeType });
      return;
    }
  }

  // Derive filename from URL
  let filename = 'image.png';
  try {
    const url = new URL(src);
    const segments = url.pathname.split('/');
    filename = decodeURIComponent(segments[segments.length - 1]) || 'image.png';
  } catch { /* use default */ }

  extractImageAsBase64(img).then(({ data, mimeType }) => {
    onDownload({ filename, data, mimeType });
  }).catch(err => {
    console.error('[ImageContextMenu] Failed to save image:', err);
  });
}

async function copyPng(img: HTMLImageElement): Promise<void> {
  const { blob } = await extractImageAsBlob(img);
  await writeClipboardItem({ [blob.type]: blob });
}

function canWriteClipboardItem(): boolean {
  return typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
}

async function writeClipboardItem(items: Record<string, Blob>): Promise<void> {
  if (!canWriteClipboardItem()) {
    throw new Error('ClipboardItem API is not supported in this environment');
  }

  await navigator.clipboard.write([new ClipboardItem(items)]);
}

function createTextDownloadFile(filename: string, content: string, mimeType: string): DownloadableFile {
  return {
    filename,
    data: toBase64(content),
    mimeType,
  };
}

function createBinaryDownloadFile(filename: string, dataUrl: string, mimeType: string): DownloadableFile {
  return {
    filename,
    data: dataUrl.replace(/^data:[^;]+;base64,/, ''),
    mimeType,
  };
}

function toBase64(content: string): string {
  return btoa(unescape(encodeURIComponent(content)));
}

/**
 * Extract image as base64 via canvas
 */
async function extractImageAsBase64(img: HTMLImageElement): Promise<{ data: string; mimeType: string }> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to create canvas context');

  // Wait for image to load
  await new Promise<void>((resolve, reject) => {
    if (img.complete && img.naturalWidth > 0) {
      resolve();
    } else {
      const onLoad = () => { img.removeEventListener('error', onError); resolve(); };
      const onError = () => { img.removeEventListener('load', onLoad); reject(new Error('Image load failed')); };
      img.addEventListener('load', onLoad, { once: true });
      img.addEventListener('error', onError, { once: true });
    }
  });

  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);

  const dataUrl = canvas.toDataURL('image/png');
  return {
    data: dataUrl.split(',')[1],
    mimeType: 'image/png',
  };
}

async function extractImageAsBlob(img: HTMLImageElement): Promise<{ blob: Blob; mimeType: string }> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to create canvas context');

  await new Promise<void>((resolve, reject) => {
    if (img.complete && img.naturalWidth > 0) {
      resolve();
    } else {
      const onLoad = () => { img.removeEventListener('error', onError); resolve(); };
      const onError = () => { img.removeEventListener('load', onLoad); reject(new Error('Image load failed')); };
      img.addEventListener('load', onLoad, { once: true });
      img.addEventListener('error', onError, { once: true });
    }
  });

  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx.drawImage(img, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
        return;
      }
      reject(new Error('Failed to export canvas as blob'));
    }, 'image/png');
  });

  return {
    blob,
    mimeType: 'image/png',
  };
}

/**
 * Fallback translations
 */
function fallbackTranslation(key: string): string {
  const map: Record<string, string> = {
    copy_as_png: 'Copy as PNG',
    save_image_as: 'Save Image As…',
    save_as_png: 'Save as PNG',
    save_as_svg: 'Save as SVG',
    save_as_drawio: 'Save as DrawIO',
  };
  return map[key] || key;
}
