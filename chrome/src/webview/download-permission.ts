/**
 * Ask the background for the optional "downloads" permission — without ever
 * letting the answer block the caller.
 *
 * The permission is only needed by the sandboxed-document fallback in
 * `deliverFile` (a document Chrome refuses to download from, e.g. a
 * `Content-Security-Policy: sandbox` page): there the file has to be written
 * by the background with `chrome.downloads`. Everything else downloads through
 * an `<a download>` anchor and needs no permission at all.
 *
 * `chrome.permissions.request()` must run in a user gesture and shows a prompt.
 * The request travels to the service worker, where neither exists, so Chrome
 * can neither grant nor deny it — the `sendMessage` callback is simply never
 * invoked. Awaiting that message unbounded leaves the export spinner running
 * forever (observed for DOCX, EPUB and HTML exports of remote documents), so
 * the request is a best-effort probe with a deadline: try, then continue.
 */

/** How long an export waits for the permission answer before starting. */
export const DOWNLOAD_PERMISSION_TIMEOUT_MS = 1500;

interface PermissionResponse {
  granted?: boolean;
}

/**
 * Resolve to whether the optional "downloads" permission is held, giving up
 * after `timeoutMs`. Never rejects: a missing Chrome runtime, an unanswered
 * message and a refused prompt all mean "not granted".
 */
export function requestDownloadsPermission(
  timeoutMs: number = DOWNLOAD_PERMISSION_TIMEOUT_MS,
): Promise<boolean> {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (!runtime?.sendMessage) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (granted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(granted);
    };
    // The deadline is the point of this function: a prompt the service worker
    // cannot show leaves the callback pending forever.
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      runtime.sendMessage({ type: 'REQUEST_DOWNLOADS_PERMISSION' }, (response) => {
        // Read lastError so Chrome does not log an unchecked error; a closed
        // port is just "no permission".
        void runtime.lastError;
        finish(Boolean((response as PermissionResponse | undefined)?.granted));
      });
    } catch {
      finish(false);
    }
  });
}
