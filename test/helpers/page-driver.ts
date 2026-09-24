/**
 * Shared Playwright driver primitives for every browser/Electron suite in this
 * repository (`test/suites/extension-e2e/*` for the installed Chrome extension,
 * `test/suites/vscode-e2e/*` for VS Code).
 *
 * This module is the canonical home for the mechanics both harnesses need, so a
 * new suite never re-invents them and never re-learns the traps that produced
 * them:
 *
 *   - `evalJs` / `waitFor` — evaluate and poll with a *function body string*
 *     rather than a function. Extension pages and webviews enforce CSP, which
 *     blocks eval'd function sources, and tsx/esbuild injects a `__name` helper
 *     into compiled functions, so serialized closures are not portable. Strings
 *     plus explicit invocation are the only form that works in both hosts.
 *   - `waitForStable` — the bounded "value stopped changing" settle, for lists
 *     and panels that fill in progressively (their own scheduler, not the event
 *     that triggered them).
 *   - `waitForFrame` — frames are created and navigated asynchronously; wait for
 *     the frame to exist rather than assuming it after the action that causes it.
 *   - `retryInteraction` — the repository's documented retry policy in one
 *     place: repeat the *user-level interaction* when a UI race or stall was the
 *     obstacle, never re-check an assertion. Every retry is logged.
 *   - `describeFrames` — failure messages carry what each frame actually holds,
 *     because "the DOM never matched" says nothing about whether the content
 *     rendered without the expected element, rendered an error state, or never
 *     rendered at all.
 *   - `installPageDiagnostics` — renderer errors and warnings (including the CSP
 *     violations that are invisible in the UI but explain a blank surface) reach
 *     the test output.
 *
 * Platform-specific driving (browser profiles vs. an Electron editor, quick
 * input modes, editor tabs, webview frames) stays in `extension-launch.ts`,
 * `extension-e2e.ts` and `vscode-launch.ts`.
 */

import type { Frame, Page } from 'playwright-core';

/** Anything that can evaluate JavaScript: a page or one of its frames. */
export type E2ETarget = Page | Frame;

/**
 * Evaluate a JavaScript function BODY. See the module header for why this is a
 * string and not a function.
 */
export async function evalJs<T>(target: E2ETarget, jsBody: string, arg?: unknown): Promise<T> {
  const source = arg === undefined
    ? `(${jsBody})()`
    : `(${jsBody})(${JSON.stringify(arg)})`;
  return target.evaluate(source) as Promise<T>;
}

/**
 * Poll a browser-side readiness condition without relying on arbitrary sleeps.
 * Transient evaluation failures are tolerated while a frame is navigating.
 */
export async function waitFor(
  target: E2ETarget,
  jsBody: string,
  timeoutMs = 30000,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      if (await evalJs<boolean>(target, jsBody)) return;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      const suffix = lastError instanceof Error ? ` (${lastError.message})` : '';
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${jsBody.slice(0, 120)}${suffix}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Wait until a condition remains true for the requested stability window. */
export async function waitForStable(
  target: E2ETarget,
  jsBody: string,
  stableMs = 250,
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince: number | null = null;

  for (;;) {
    const ready = await evalJs<boolean>(target, jsBody).catch(() => false);
    const now = Date.now();
    if (ready) {
      stableSince ??= now;
      if (now - stableSince >= stableMs) return;
    } else {
      stableSince = null;
    }

    if (now >= deadline) {
      throw new Error(`waitForStable timed out after ${timeoutMs}ms: ${jsBody.slice(0, 120)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, stableMs)));
  }
}

/** Wait until the page exposes a frame whose URL contains this fragment. */
export async function waitForFrame(
  page: Page,
  urlFragment: string,
  timeoutMs = 30000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = page.frames().find((candidate) => candidate.url().includes(urlFragment));
    if (frame) return frame;
    if (Date.now() >= deadline) {
      throw new Error(`frame containing "${urlFragment}" not found after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Interaction trace.
 *
 * Failures in this layer are almost always "the UI was not in the state the
 * driver assumed", and the useful information is *where* it stopped.
 * Interactive local runs print the steps (set MV_VSCODE_TRACE=0 to silence);
 * CI stays quiet so the test output keeps its shape.
 */
export function trace(message: string): void {
  if (process.env.MV_VSCODE_TRACE === '0' || process.env.CI) return;
  // eslint-disable-next-line no-console
  console.log(`[e2e] ${message}`);
}

/**
 * Bounded retry for a UI interaction.
 *
 * TESTING.md permits one retry when a wait times out because of a *stall or a
 * race*, and forbids retrying an assertion. This is that policy, in one place:
 * `attempt` repeats the user-level interaction, `check` verifies the state it
 * was supposed to produce. Callers pass a short per-attempt check so the loop
 * can actually try again; every retry is logged with the reason.
 */
export async function retryInteraction(options: {
  /** What is being attempted, for the retry log. */
  label: string;
  /** The user-level interaction, repeated on each attempt. */
  attempt: () => Promise<void>;
  /** The state the interaction must have produced, with a short timeout. */
  check: () => Promise<void>;
  /** Overall budget for all attempts. */
  timeoutMs?: number;
}): Promise<void> {
  const { label, attempt, check, timeoutMs = 20000 } = options;
  const deadline = Date.now() + timeoutMs;

  for (let round = 1; ; round += 1) {
    await attempt();
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        trace(`${label}: giving up after ${round} attempts`);
        throw error;
      }
      trace(`${label}: attempt ${round} did not settle — retrying`);
    }
  }
}

/**
 * A compact picture of what each matching frame currently holds, for failure
 * messages. Frames are probed with the caller's JavaScript body, so the
 * summary describes the thing under test rather than a generic DOM dump.
 */
export async function describeFrames(
  frames: Frame[],
  probeJsBody: string,
): Promise<string> {
  const summaries: unknown[] = [];

  for (const frame of frames) {
    const summary = await evalJs<unknown>(frame, probeJsBody).catch((error: unknown) => ({
      url: frame.url().slice(0, 40),
      error: error instanceof Error ? error.message : String(error),
    }));
    summaries.push(summary);
  }

  return JSON.stringify(summaries);
}

/**
 * Surface renderer-side failures in the test output: console errors and
 * warnings (including CSP violations, which are silent in the UI but explain a
 * blank surface) plus uncaught page errors. Truncated by design — the full
 * stacks are available via MV_DEBUG_PAGEERR.
 */
export function installPageDiagnostics(page: Page, label: string): void {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    // eslint-disable-next-line no-console
    console.log(`[${label} ${message.type()}]`, message.text().slice(0, 500));
  });
  page.on('pageerror', (error) => {
    const text = process.env.MV_DEBUG_PAGEERR ? error.stack || String(error) : String(error).slice(0, 500);
    // eslint-disable-next-line no-console
    console.log(`[${label} pageerror]`, text.split('\n').slice(0, 6).join('\n  '));
  });
}
