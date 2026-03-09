/**
 * Image Loader Utilities
 * 
 * Load remote images via browser-native <img> tag + canvas,
 * bypassing fetch() and connect-src CSP restrictions.
 * Only requires img-src to allow https: (all platforms do).
 */

/**
 * Load remote image via <img> tag, return as base64 data URL.
 * @param url - Remote image URL (http:// or https://)
 * @returns data:URL string, or null if loading fails
 */
export function loadImageAsDataUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Load remote image via <img> tag, return as Uint8Array buffer.
 * @param url - Remote image URL (http:// or https://)
 * @returns PNG buffer with dimensions, or null if loading fails
 */
export function loadImageAsBuffer(url: string): Promise<{ buffer: Uint8Array; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);

        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        const binary = atob(base64);
        const buffer = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          buffer[i] = binary.charCodeAt(i);
        }
        resolve({ buffer, width: img.naturalWidth, height: img.naturalHeight });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
