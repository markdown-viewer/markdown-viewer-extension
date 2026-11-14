/**
 * Image Loader Utilities
 *
 * Load remote images via browser-native <img> tag + canvas,
 * bypassing fetch() and connect-src CSP restrictions.
 * Only requires img-src to allow https: (all platforms do).
 *
 * Every image here is loaded for an export (DOCX fetches buffers, HTML/EPUB
 * inline data URLs), and exports used to wait on a stalled request forever:
 * an `<img>` that receives headers but never a body — a black-holed proxy, a
 * host that hangs — fires neither `load` nor `error`. That froze "Export to
 * DOCX / EPUB / HTML" with the toolbar spinner at 0%, reproduced with a local
 * document whose remote image never arrives. A load therefore has a deadline;
 * a timed-out image is reported as "could not load", exactly like a broken URL.
 */

/**
 * How long a single image may take before the loader gives up on it.
 *
 * Long enough for a slow but working connection to finish a large picture,
 * short enough that a dead host cannot hold an export hostage.
 */
export const IMAGE_LOAD_TIMEOUT_MS = 10_000;

/**
 * Request CORS mode only where CORS exists.
 *
 * A `file:` URL cannot answer a CORS request, so asking for one turns a load
 * that would otherwise succeed into a failure — that is how local images broke
 * in a default Firefox profile, where every file is its own origin. Local
 * origins are handled by the canvas read-back instead, which needs no CORS mode.
 *
 * @param url - Image URL
 * @param img - Image element about to be loaded
 */
function requestCorsWhereSupported(url: string, img: HTMLImageElement): void {
  if (/^https?:/i.test(url)) {
    img.crossOrigin = 'anonymous';
  }
}

/**
 * Load an `<img>` element with a deadline.
 *
 * @param url - Image URL
 * @param timeoutMs - Deadline for the whole load (headers + body)
 * @returns The loaded element, or null when it errors, is blocked, or misses
 *   the deadline
 */
function loadImageElement(url: string, timeoutMs: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    requestCorsWhereSupported(url, img);

    let settled = false;
    const finish = (loaded: HTMLImageElement | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!loaded) {
        // Detach the element so a request that outlives the deadline cannot
        // call back into a resolved loader.
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
      }
      resolve(loaded);
    };

    // The deadline is the point of this module: a stalled response fires
    // neither handler, and every export format reads images through here.
    const timer = setTimeout(() => finish(null), timeoutMs);

    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/**
 * Rasterise a loaded image to a PNG data URL (canvas keeps the pixels, which is
 * what every export needs from an image it cannot fetch).
 */
function drawToDataUrl(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Load remote image via <img> tag, return as base64 data URL.
 * @param url - Remote image URL (http:// or https://)
 * @param timeoutMs - Deadline for the load (defaults to IMAGE_LOAD_TIMEOUT_MS)
 * @returns data:URL string, or null if loading fails or times out
 */
export async function loadImageAsDataUrl(
  url: string,
  timeoutMs: number = IMAGE_LOAD_TIMEOUT_MS,
): Promise<string | null> {
  const img = await loadImageElement(url, timeoutMs);
  return img ? drawToDataUrl(img) : null;
}

/**
 * Load remote image via <img> tag, return as Uint8Array buffer.
 * @param url - Remote image URL (http:// or https://)
 * @param timeoutMs - Deadline for the load (defaults to IMAGE_LOAD_TIMEOUT_MS)
 * @returns PNG buffer with dimensions, or null if loading fails or times out
 */
export async function loadImageAsBuffer(
  url: string,
  timeoutMs: number = IMAGE_LOAD_TIMEOUT_MS,
): Promise<{ buffer: Uint8Array; width: number; height: number } | null> {
  const img = await loadImageElement(url, timeoutMs);
  if (!img) {
    return null;
  }

  const dataUrl = drawToDataUrl(img);
  if (!dataUrl) {
    return null;
  }

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return { buffer, width: img.naturalWidth, height: img.naturalHeight };
}
