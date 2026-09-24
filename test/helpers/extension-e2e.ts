/**
 * Shared harness for the installed-extension E2E suites
 * (test/suites/extension-e2e/*): the per-suite browser lifecycle plus the
 * evaluate/wait plumbing every suite needs.
 *
 * The browser launch itself lives in ./extension-launch.ts, which owns the
 * version-matrix handling (`MV_CHROME_EXECUTABLE`, `MV_EXT_HEADED`,
 * `--headless=new` for pre-132 builds) and the shared launch arguments. This
 * module only adds what a suite needs on top: a temp profile, the extension
 * id, optional Playwright tracing for CI artifacts, and cleanup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type BrowserContext, type Frame, type Page } from 'playwright-core';

import {
  assertExtensionBuilt,
  launchExtensionContext as launchBrowserContext,
  waitForExtensionId,
} from './extension-launch.ts';

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

// The driver mechanics live in ./page-driver.ts so the VS Code harness uses the
// same ones. Re-exported here because the installed-extension suites import them
// from this module.
export {
  describeFrames,
  evalJs,
  installPageDiagnostics,
  retryInteraction,
  trace,
  waitFor,
  waitForFrame,
  waitForStable,
} from './page-driver.ts';

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

/** The launched browser context plus the extension id under test. */
export interface ExtensionContextHarness {
  context: BrowserContext;
  extensionId: string;
  close(): Promise<void>;
}

export async function launchExtensionContext(
  prefix: string,
  options: ExtensionLaunchOptions = {},
): Promise<ExtensionContextHarness> {
  assertExtensionBuilt();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let context: BrowserContext | undefined;
  let tracePath: string | undefined;
  let tracingStarted = false;

  try {
    // extension-launch.ts resolves the browser (bundled Chromium by default,
    // MV_CHROME_EXECUTABLE for the version matrix) and the headless flags.
    context = await launchBrowserContext(userDataDir, {
      acceptDownloads: options.acceptDownloads,
      headless: options.headless,
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
