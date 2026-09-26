import type { ViewerSaveFileMessage } from '../integration/iframe-viewer-host';

export interface FileDelivery {
  filename: string;
  mimeType: string;
  /** Text content, or base64 when `encoding` is 'base64'. */
  content: string;
  encoding?: 'text' | 'base64';
}

function toBlob(file: FileDelivery): Blob {
  if (file.encoding === 'base64') {
    return new Blob([Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))], { type: file.mimeType });
  }
  return new Blob([file.content], { type: file.mimeType });
}

/**
 * Write the file from the current document with an anchor download. Hosts that
 * already run in a page allowed to download (top-level page, content-script
 * page) use this directly; `deliverFile` picks between it and the relay.
 */
export function anchorDownloadFile(file: FileDelivery): void {
  const url = URL.createObjectURL(toBlob(file));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Deliver a generated file to the user (save-file action, "Save Image As",
 * "Save as Excel", …).
 *
 * Chrome refuses an `<a download>` inside the extension-page iframe that hosts
 * the workspace viewer: the click runs, the blob is built, and no download ever
 * starts. An embedded viewer therefore hands the file to the top-level page,
 * which downloads it; every other host (content-script page on file:// or
 * http, extension page) uses the plain anchor download.
 */
export function deliverFile(file: FileDelivery): void {
  if (typeof window !== 'undefined' && window.parent !== window) {
    const message: ViewerSaveFileMessage = {
      type: 'SAVE_FILE',
      filename: file.filename,
      mimeType: file.mimeType,
      content: file.content,
      ...(file.encoding ? { encoding: file.encoding } : {}),
    };
    try {
      window.parent.postMessage(message, '*');
      return;
    } catch {
      // Cross-origin parent — fall through to the anchor download.
    }
  }

  anchorDownloadFile(file);
}
