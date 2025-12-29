/**
 * Unified File Service
 *
 * Provides consistent file download/save API across all platforms using ServiceChannel.
 * Supports chunked upload for large files (Chrome requires this due to message size limits).
 * 
 * Each platform's backend handles the actual file operation:
 * - Chrome: uploadInChunks → background script → chrome.downloads API
 * - VSCode: DOWNLOAD_FILE → extension host → vscode.workspace.fs
 * - Mobile: DOWNLOAD_FILE → Flutter → Share.shareXFiles
 */

import { ServiceChannel } from '../messaging/channels/service-channel';

// Default chunk size for large file uploads (255KB, aligned for base64)
const DEFAULT_CHUNK_SIZE = 255 * 1024;

// Threshold for using chunked upload (1MB)
const CHUNK_UPLOAD_THRESHOLD = 1 * 1024 * 1024;

export interface DownloadOptions {
  mimeType?: string;
  useChunkedUpload?: boolean; // Force chunked upload even for small files
  chunkSize?: number;
  onProgress?: (progress: { uploaded: number; total: number }) => void;
}

interface UploadInitResponse {
  token: string;
  chunkSize: number;
}

export class FileService {
  constructor(
    private channel: ServiceChannel,
    private options: {
      forceChunkedUpload?: boolean; // Platform-specific: Chrome needs chunked upload
    } = {}
  ) {}

  /**
   * Download/save a file
   * @param data - Blob or base64 string
   * @param filename - File name to save as
   * @param options - Download options
   */
  async download(data: Blob | string, filename: string, options: DownloadOptions = {}): Promise<void> {
    let base64Data: string;
    let mimeType = options.mimeType || 'application/octet-stream';

    if (data instanceof Blob) {
      base64Data = await this.blobToBase64(data);
      mimeType = data.type || mimeType;
    } else {
      base64Data = data;
    }

    const totalSize = base64Data.length;
    const useChunked = options.useChunkedUpload || 
                       this.options.forceChunkedUpload || 
                       totalSize > CHUNK_UPLOAD_THRESHOLD;

    if (useChunked) {
      await this.downloadWithChunks(base64Data, filename, mimeType, options);
    } else {
      await this.downloadDirect(base64Data, filename, mimeType);
    }
  }

  /**
   * Direct download - send entire file in one message
   */
  private async downloadDirect(base64Data: string, filename: string, mimeType: string): Promise<void> {
    await this.channel.send('DOWNLOAD_FILE', {
      filename,
      data: base64Data,
      mimeType
    });
  }

  /**
   * Chunked download - upload file in chunks, then finalize
   * Required for Chrome due to message size limits between content script and service worker
   */
  private async downloadWithChunks(
    base64Data: string,
    filename: string,
    mimeType: string,
    options: DownloadOptions
  ): Promise<void> {
    const totalSize = base64Data.length;
    let chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;

    // Ensure chunk size is divisible by 3 for base64 encoding
    const remainder = chunkSize % 3;
    if (remainder !== 0) {
      chunkSize -= remainder;
    }
    if (chunkSize <= 0) {
      chunkSize = 3;
    }

    // 1. Initialize upload session
    const initResponse = await this.channel.send('UPLOAD_OPERATION', {
      operation: 'init',
      purpose: 'file-download',
      encoding: 'base64',
      expectedSize: totalSize,
      chunkSize,
      metadata: {
        filename,
        mimeType,
      },
    }) as UploadInitResponse;

    if (!initResponse || !initResponse.token) {
      throw new Error('Upload initialization failed');
    }

    const token = initResponse.token;
    const serverChunkSize = initResponse.chunkSize || chunkSize;

    // 2. Upload chunks
    let uploaded = 0;
    for (let offset = 0; offset < totalSize; offset += serverChunkSize) {
      const chunk = base64Data.slice(offset, offset + serverChunkSize);

      await this.channel.send('UPLOAD_OPERATION', {
        operation: 'chunk',
        token,
        chunk,
      });

      uploaded = Math.min(totalSize, offset + serverChunkSize);
      if (options.onProgress) {
        try {
          options.onProgress({ uploaded, total: totalSize });
        } catch (error) {
          console.warn('Download progress callback error:', error);
        }
      }
    }

    // 3. Finalize upload
    await this.channel.send('UPLOAD_OPERATION', {
      operation: 'finalize',
      token,
    });

    // 4. Trigger actual download
    // Chrome: handled via DOCX_DOWNLOAD_FINALIZE in background script
    // VSCode/Mobile: the finalize step above triggers the download
    await this.channel.send('DOCX_DOWNLOAD_FINALIZE', { token });
  }

  /**
   * Convert Blob to base64 string
   */
  private async blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/octet-stream;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
