/**
 * Image Context Menu (Shared)
 *
 * Cross-platform right-click context menu for images in rendered Markdown.
 * Supports downloading PNG for all images, plus SVG/DrawIO for diagrams.
 */

import { getDiagramExport } from './diagram-export-registry';
import { showActionMenu } from './action-menu';

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
// Setup
// ============================================================================

/**
 * Set up image context menu on a container element.
 * Returns a cleanup function to remove event listeners.
 */
export function setupImageContextMenu(options: ImageContextMenuOptions): () => void {
  const { container, onDownload, translate: translateFn } = options;

  let hideMenu: (() => void) | null = null;

  function translate(key: string): string {
    return translateFn?.(key) || fallbackTranslation(key);
  }

  function removeContextMenu(): void {
    hideMenu?.();
    hideMenu = null;
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

    const baseName = pluginType || 'image';
    const items: Array<{ label: string; onSelect: () => void }> = [];

    items.push({
      label: translate('save_as_png'),
      onSelect: () => savePng(img, baseName, onDownload),
    });

    const svgContent = exportData?.svg;
    if (svgContent) {
      items.push({
        label: translate('save_as_svg'),
        onSelect: () => onDownload(createTextDownloadFile(`${baseName}.svg`, svgContent, 'image/svg+xml')),
      });
    }

    if (exportData?.drawioXml) {
      items.push({
        label: translate('save_as_drawio'),
        onSelect: () => {
          const drawioData = btoa(unescape(encodeURIComponent(exportData.drawioXml!)));
          onDownload({
            filename: `${baseName}.drawio`,
            data: drawioData,
            mimeType: 'application/xml',
          });
        },
      });
    }

    items.push({
      label: translate('copy_as_png'),
      onSelect: () => {
        void copyPng(img).catch((err) => {
          console.error('[ImageContextMenu] Failed to copy PNG:', err);
        });
      },
    });

    if (!pluginType && !exportData) {
      items.length = 0;
      items.push({
        label: translate('save_image_as'),
        onSelect: () => saveImage(img, onDownload),
      });
      items.push({
        label: translate('copy_as_png'),
        onSelect: () => {
          void copyPng(img).catch((err) => {
            console.error('[ImageContextMenu] Failed to copy image:', err);
          });
        },
      });
    }

    const handle = showActionMenu({
      x: e.clientX,
      y: e.clientY,
      items,
    });
    hideMenu = handle.hide;
  }

  // Event listeners
  document.addEventListener('scroll', onScroll, true);
  container.addEventListener('contextmenu', onContextMenu);

  // Return cleanup function
  return () => {
    removeContextMenu();
    document.removeEventListener('scroll', onScroll, true);
    container.removeEventListener('contextmenu', onContextMenu);
  };
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
