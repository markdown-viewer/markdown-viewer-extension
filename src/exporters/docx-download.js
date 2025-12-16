// DOCX Download Utilities
// Functions for downloading DOCX files

import { uploadInChunks, abortUpload } from '../utils/upload-manager.js';

/**
 * Convert byte array chunk to base64 without exceeding call stack limits
 * @param {Uint8Array} bytes - Binary chunk
 * @returns {string} Base64 encoded chunk
 */
export function encodeBytesToBase64(bytes) {
  let binary = '';
  const sliceSize = 0x8000;
  for (let i = 0; i < bytes.length; i += sliceSize) {
    const slice = bytes.subarray(i, Math.min(i + sliceSize, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

/**
 * Wrapper for chrome.runtime.sendMessage with Promise interface
 * @param {Object} message - Message payload
 * @returns {Promise<any>} - Response from background script
 */
export function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Fallback download method using <a> element
 * @param {Blob} blob - File blob
 * @param {string} filename - Output filename
 */
export function fallbackDownload(blob, filename) {
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
 * Download blob as file using chunked upload to background script
 * @param {Blob} blob - File blob
 * @param {string} filename - Output filename
 */
export async function downloadBlob(blob, filename) {
  let token = null;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const uploadResult = await uploadInChunks({
      sendMessage: (payload) => runtimeSendMessage(payload),
      purpose: 'docx-download',
      encoding: 'base64',
      totalSize: bytes.length,
      metadata: {
        filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      },
      getChunk: (offset, size) => {
        const end = Math.min(offset + size, bytes.length);
        const chunkBytes = bytes.subarray(offset, end);
        return encodeBytesToBase64(chunkBytes);
      }
    });

    token = uploadResult.token;

    const finalizeResponse = await runtimeSendMessage({
      type: 'DOCX_DOWNLOAD_FINALIZE',
      token
    });

    if (!finalizeResponse || !finalizeResponse.success) {
      throw new Error(finalizeResponse?.error || 'Download finalize failed');
    }
  } catch (error) {
    console.error('Download failed:', error);
    if (token) {
      abortUpload((payload) => runtimeSendMessage(payload), token);
    }
    fallbackDownload(blob, filename);
  }
}
