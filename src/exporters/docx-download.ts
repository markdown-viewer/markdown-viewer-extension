/**
 * DOCX Download Utilities
 * Functions for downloading DOCX files
 */

import type { PlatformAPI } from '../types/platform';

/**
 * Convert byte array chunk to base64 without exceeding call stack limits
 * @param bytes - Binary chunk
 * @returns Base64 encoded chunk
 */
export function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const sliceSize = 0x8000;
  for (let i = 0; i < bytes.length; i += sliceSize) {
    const slice = bytes.subarray(i, Math.min(i + sliceSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/**
 * Fallback download method using <a> element
 * @param blob - File blob
 * @param filename - Output filename
 */
export function fallbackDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';

  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Progress callback for upload phase
 */
export type UploadProgressCallback = (uploaded: number, total: number) => void;

/**
 * Download blob as file using platform file service
 * @param blob - File blob
 * @param filename - Output filename
 * @param onProgress - Optional progress callback for upload phase
 */
export async function downloadBlob(
  blob: Blob,
  filename: string,
  onProgress?: UploadProgressCallback
): Promise<void> {
  const platform = globalThis.platform as PlatformAPI | undefined;
  
  if (platform?.file?.download) {
    await platform.file.download(blob, filename, {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      onProgress: onProgress
        ? (progress: { uploaded: number; total: number }) => {
            onProgress(progress.uploaded, progress.total);
          }
        : undefined,
    });
    return;
  }

  // Fallback if platform not available
  fallbackDownload(blob, filename);
}
