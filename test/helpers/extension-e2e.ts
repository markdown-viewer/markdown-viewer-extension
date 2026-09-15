import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContext, type Frame, type Page } from 'playwright-core';

export const EXT_DIR = path.resolve('dist/chrome');
export const VIEWPORT = { width: 1440, height: 900 } as const;

export const FIXED_SETTINGS = {
  themeId: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
} as const;

export const SET_STORAGE_JS = `(settings) => chrome.storage.local.set({ markdownViewerSettings: settings })`;
export const POST_OPEN_DOCUMENT_JS = `(msg) => window.postMessage(msg, '*')`;
export const VIEWER_EMBED_READY_JS = `() => document.documentElement.dataset.viewerEmbedReady === '1'`;
export const WAIT_RENDERED_JS = `() => {
  const c = document.getElementById('markdown-content');
  return Boolean(c && c.children.length > 0);
}`;
export const WAIT_STANDALONE_READY_JS = `() => {
  const c = document.getElementById('markdown-content');
  return Boolean(c && c.children.length > 0 && document.getElementById('mv-content-styles'));
}`;

export type E2ETarget = Page | Frame;

export interface ExtensionLaunchOptions {
  acceptDownloads?: boolean;
  headless?: boolean;
}

export interface ExtensionContextHarness {
  context: BrowserContext;
  extensionId: string;
  close(): Promise<void>;
}

export function waitImagesJs(rootSelector: string): string {
  const selector = JSON.stringify(`${rootSelector} img`);
  return `() => {
    const images = Array.from(document.querySelectorAll(${selector}));
    return Promise.all(images.map((img) => {
      if (typeof img.decode === 'function') return img.decode().catch(() => undefined);
      return new Promise((resolve) => {
        if (img.complete) { resolve(); return; }
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });
    })).then(() => true);
  }`;
}

/**
 * Evaluate a JavaScript function BODY. Extension pages block unsafe-eval, so
 * this deliberately uses Playwright's function-body string semantics and
 * invokes the body explicitly.
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

export async function waitForExtensionId(context: BrowserContext, timeoutMs = 40000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = context.serviceWorkers().map((worker) => worker.url().split('/')[2]).find(Boolean);
    if (id) return id;
    if (Date.now() >= deadline) {
      throw new Error(`extension service worker not registered after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function waitForFrame(page: Page, urlFragment: string, timeoutMs = 30000): Promise<Frame> {
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

export function installPageDiagnostics(page: Page, label: string): void {
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    // eslint-disable-next-line no-console
    console.log(`[${label} ${message.type()}]`, message.text().slice(0, 500));
  });
  page.on('pageerror', (error) => {
    const text = process.env.MV_DEBUG_PAGEERR ? (error.stack || String(error)) : String(error).slice(0, 500);
    // eslint-disable-next-line no-console
    console.log(`[${label} pageerror]`, text.split('\n').slice(0, 6).join('\n  '));
  });
}

export async function launchExtensionContext(
  prefix: string,
  options: ExtensionLaunchOptions = {},
): Promise<ExtensionContextHarness> {
  await fs.promises.access(path.join(EXT_DIR, 'manifest.json')).catch(() => {
    throw new Error('dist/chrome missing — run "npm run build:chrome" first');
  });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let context: BrowserContext | undefined;
  let tracePath: string | undefined;
  let tracingStarted = false;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: options.headless ?? true,
      acceptDownloads: options.acceptDownloads,
      viewport: VIEWPORT,
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--no-first-run',
        '--disable-default-apps',
        '--allow-file-access-from-files',
      ],
    });

    const artifactDir = process.env.MV_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      const traceName = prefix.replace(/[^a-z0-9_-]/gi, '_').replace(/[-_]+$/, '') || 'extension-e2e';
      tracePath = path.join(artifactDir, `${traceName}.zip`);
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      // Keep diagnostics lightweight: DOM snapshots materially slow down the
      // renderer-heavy suite and can change the timing being diagnosed.
      await context.tracing.start({ screenshots: true, snapshots: false, sources: false });
      tracingStarted = true;
    }

    const extensionId = await waitForExtensionId(context);
    let closed = false;
    return {
      context,
      extensionId,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          if (tracingStarted && tracePath) {
            await context.tracing.stop({ path: tracePath });
          }
        } finally {
          try {
            await context?.close();
          } finally {
            fs.rmSync(userDataDir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    if (tracingStarted && tracePath) {
      await context?.tracing.stop({ path: tracePath }).catch(() => undefined);
    }
    await context?.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}
