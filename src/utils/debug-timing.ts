// Debug timing instrumentation shared by the webview viewer, the workspace
// parent page and the embed bridge.
//
// Enabled via one of:
//   - `?mvDebug=1` URL query parameter (extension pages / e2e driver)
//   - `localStorage.mvDebug === '1'` (content-script takeover of file:// or
//     http(s) pages, where the URL cannot carry a query parameter)
//
// Every mark is emitted as:
//   console.info('[MV-TIME]', scope, { t0, dt, ...payload })
// and appended to window.__mvTimeline so an e2e driver can harvest the full
// ordered timeline either from the console or from the page.

declare global {
  interface Window {
    __mvTimeline?: Array<Record<string, unknown>>;
  }
}

let enabled: boolean | null = null;

/**
 * Whether MV-TIME instrumentation is active. Result is cached for the page
 * lifetime; on content-script pages the flag is read after the document body
 * exists, so an init-script seeding localStorage is picked up reliably.
 */
export function mvDebugEnabled(): boolean {
  if (enabled !== null) {
    return enabled;
  }
  try {
    if (new URLSearchParams(window.location.search).has('mvDebug')) {
      enabled = true;
      return true;
    }
  } catch { /* malformed URL — fall through */ }
  try {
    if (localStorage.getItem('mvDebug') === '1') {
      enabled = true;
      return true;
    }
  } catch { /* storage blocked */ }
  enabled = false;
  return false;
}

/** Page-load origin (performance.timeOrigin) for stable, comparable timestamps. */
function pageOrigin(): number {
  try {
    return performance.timeOrigin;
  } catch {
    return Date.now();
  }
}

function pushTimeline(entry: Record<string, unknown>): void {
  try {
    const timeline = (window.__mvTimeline ??= []);
    timeline.push(entry);
  } catch { /* cross-origin / frozen window — ignore */ }
}

function emit(scope: string, payload: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.info('[MV-TIME]', scope, payload);
  pushTimeline({ scope, ...payload });
}

/**
 * Record a point-in-time mark. `dt` is milliseconds since page load
 * (performance.timeOrigin).
 */
export function mvMark(scope: string, payload: Record<string, unknown> = {}): void {
  if (!mvDebugEnabled()) {
    return;
  }
  const t0 = pageOrigin();
  const now = performance.now();
  emit(scope, {
    t0,
    dt: Number(now.toFixed(2)),
    ...payload,
  });
}

/**
 * Start a timed section. The returned function ends it and logs
 * `{ t0, dt, durationMs, ...extra }`; call it in a finally block or
 * immediately after the awaited work.
 */
export function mvBegin(scope: string): (extra?: Record<string, unknown>) => void {
  const t0 = pageOrigin();
  const start = performance.now();
  return (extra: Record<string, unknown> = {}) => {
    if (!mvDebugEnabled()) {
      return;
    }
    const now = performance.now();
    const duration = now - start;
    emit(scope, {
      t0,
      dt: Number(start.toFixed(2)),
      endDt: Number(now.toFixed(2)),
      durationMs: Number(duration.toFixed(2)),
      ...extra,
    });
  };
}
