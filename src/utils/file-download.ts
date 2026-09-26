import type { ViewerSaveFileMessage } from '../integration/iframe-viewer-host';
import type { PlatformAPI } from '../types/platform';

export interface FileDelivery {
  filename: string;
  mimeType: string;
  /** Text content, or base64 when `encoding` is 'base64'. */
  content: string;
  encoding?: 'text' | 'base64';
}

/**
 * Type declared for a platform download.
 *
 * Chrome rewrites the extension of a download whose declared type disagrees
 * with the name: a `text/plain` document called `notes.ts` is saved as
 * `notes.txt` (`.ts` belongs to video/mp2t, and text/plain's preferred
 * extension is `.txt`). A generic type owns no extension, so the document's
 * own name survives — which is the whole point of saving it under its name.
 */
const GENERIC_DOWNLOAD_MIME = 'application/octet-stream';

function toBlob(file: FileDelivery, mimeType: string = file.mimeType): Blob {
  const bytes: BlobPart = file.encoding === 'base64'
    ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
    : file.content;
  return new Blob([bytes], { type: mimeType });
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
 * True when this document cannot download at all.
 *
 * A document served with `Content-Security-Policy: sandbox`
 * (raw.githubusercontent.com does exactly that) or framed with a `sandbox`
 * attribute loses its origin: Chrome blocks `<a download>` outright — the
 * click runs, the blob is built, and nothing happens, with no error to react
 * to. The opaque origin is the observable part of that: `window.origin`
 * serializes it as "null" (`location.origin` still reports the URL's origin,
 * so it cannot be used here).
 *
 * `file://` documents are opaque too, but they do download with an anchor.
 */
function documentCannotDownload(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location?.protocol === 'file:') return false;
  return String(window.origin) === 'null';
}

/**
 * Deliver a generated file to the user (save-file action, "Save Image As",
 * "Save as Excel", …).
 *
 * Three hosts, three ways out:
 *   - embedded viewer → hand the file to the top-level page (Chrome refuses an
 *     `<a download>` inside the extension-page iframe that hosts it);
 *   - sandboxed document → the platform file service, i.e. the background
 *     writing the file with chrome.downloads. That needs the optional
 *     "downloads" permission, so it is requested first (once per install — the
 *     export menu asks for it the same way);
 *   - everything else → the plain anchor download.
 */
export async function deliverFile(file: FileDelivery): Promise<void> {
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

  const platform = (globalThis as { platform?: PlatformAPI }).platform;
  if (documentCannotDownload() && platform?.file?.download) {
    try {
      await platform.file.requestDownloadPermission?.();
      // The blob type matters as much as the option: FileService lets the blob
      // win over `mimeType` (src/services/file-service.ts).
      await platform.file.download(toBlob(file, GENERIC_DOWNLOAD_MIME), file.filename, {
        mimeType: GENERIC_DOWNLOAD_MIME,
      });
      return;
    } catch (error) {
      console.warn('[deliverFile] platform download failed:', error);
    }
  }

  anchorDownloadFile(file);
}
