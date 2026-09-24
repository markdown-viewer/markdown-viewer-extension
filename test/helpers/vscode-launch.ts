/**
 * Shared launch harness for the VS Code extension E2E suites
 * (test/suites/vscode-e2e/*).
 *
 * Unlike the installed-Chrome suites, there is no browser to hand a packed
 * extension to: the tests drive the REAL installed VS Code (Electron) through
 * Playwright's Electron support and load the built extension with
 * `--extensionDevelopmentPath` (dist/vscode). Nothing is mocked — the command
 * palette, the webview panel, the host <-> webview bridge and the webview
 * bundle are the same code paths a user runs.
 *
 * Why Playwright instead of `@vscode/test-electron`: the official runner
 * executes tests INSIDE the extension host, so it can only observe the
 * `vscode` API surface (commands registered, message posted). The regressions
 * that reach users live one layer further out — render output inside the
 * webview, theme bundles, resource URIs, palette availability of a command,
 * the panel title, the status bar. Reaching the webview is the whole point:
 * it runs in its own out-of-process frame, which Playwright exposes through
 * `page.frames()` (no selenium-style frame switching).
 *
 * Isolation: every launch gets a throwaway `--user-data-dir` and
 * `--extensions-dir`, so the developer's own VS Code profile, settings and
 * installed extensions are never touched, and a profile written by an earlier
 * run cannot leak into the next one.
 *
 * Environment:
 *   MV_VSCODE_EXECUTABLE  path to the VS Code executable under test
 *                         (defaults to the /Applications install on macOS)
 *   MV_VSCODE_EXTRA_ARGS   extra launch switches, space separated (e.g.
 *                         "--no-sandbox --disable-gpu" on a CI runner that
 *                         restricts user namespaces)
 *   MV_SKIP_VSCODE_TESTS  set to 1 to opt out explicitly
 *   MV_VSCODE_KEEP_PROFILE set to 1 to keep the temp profile for debugging
 *   MV_VSCODE_TRACE       set to 0 to silence the interaction trace
 *
 * ---------------------------------------------------------------------------
 * Writing a new suite — the whole recipe
 *
 * ```ts
 * describe('VS Code extension: <area>', { skip: vscodeUnavailableReason() ?? false }, () => {
 *   let harness: VSCodeHarness;
 *   before(async () => {
 *     harness = await launchVSCode({ workspaceFolder: WORKSPACE });
 *   });
 *   after(async () => {
 *     await captureWorkbench(harness.page, '<area>').catch(() => undefined);
 *     await harness.close();
 *   });
 *
 *   it('<user-visible claim>', async () => {
 *     const { page } = harness;
 *     await previewFile(page, 'smoke.md');                 // open + preview
 *     const frame = await waitForPreviewFrame(page);        // the content frame
 *     await waitFor(frame, `() => Boolean(document.querySelector('.mv-action-menu'))`);
 *     assert.equal(await evalJs<number>(page, PREVIEW_TAB_LABELS_JS.length …), 1);
 *   });
 * });
 * ```
 *
 * Everything below is a component to call, not to re-implement:
 *
 *   launchVSCode / VSCodeHarness.close   throwaway profile, workbench ready
 *   previewFile                          open a file AND preview it
 *   openFileFromQuickOpen                open + activate + focus the editor
 *   focusEditorTab                       bring a tab forward and give it focus
 *   runExtensionCommand(page, key)       drive a contributed command by ID
 *   runPaletteCommand(page, id, label)   drive any command (built-ins included)
 *   paletteRowsFor(page, query)          what the palette is offering
 *   waitForPreviewFrame(page, readyJs?)  the frame that renders the preview
 *   resetWorkbench                       clean slate per case (beforeEach)
 *   describePreviewState / trace         failure diagnostics
 *
 * The traps these components exist to absorb (each cost real debugging time;
 * TESTING.md lists them for reviewers):
 *
 *   1. the quick input encodes its MODE in its value (`>` = commands), so a
 *      plain fill flips it into file search and hides every command;
 *   2. commands are invoked by ID: the palette's fuzzy search reorders under
 *      "recently used", and was measured ranking the neighbouring
 *      `…to the Side` command first for the plain command's own label;
 *   3. results must be read structurally (`role="option"` + `aria-label`),
 *      because `textContent` carries keybinding glyphs and section titles —
 *      and the label comparison has to allow the `<category>: ` prefix and
 *      `, <keybinding>` suffix;
 *   4. a command's `when` clause can exclude it entirely while a webview panel
 *      holds the active tab — the palette then shows "similar commands", and
 *      the driver says so instead of scrolling an unrelated list;
 *   5. an active tab is not keyboard focus; typing before the editor owns the
 *      keyboard loses characters silently.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _electron,
  type ElectronApplication,
  type Frame,
  type Page,
} from 'playwright-core';

import {
  describeFrames,
  evalJs,
  installPageDiagnostics,
  retryInteraction,
  trace,
  waitFor,
} from './page-driver.ts';

// The driver mechanics (evaluate/wait/retry/trace/diagnostics) live in
// ./page-driver.ts and are shared with the installed-extension suites; they are
// re-exported here because the VS Code suites import them from this module.
export {
  describeFrames,
  evalJs,
  retryInteraction,
  trace,
  waitFor,
  waitForFrame,
  waitForStable,
} from './page-driver.ts';

export const SKIP_VSCODE = process.env.MV_SKIP_VSCODE_TESTS === '1';

/** Built extension host + webview (`npm run build:vscode`). */
export const VSCODE_EXT_DIR = path.resolve('dist/vscode');

/** Menu accelerator modifier of the host platform. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Command palette accelerator of the host platform. */
const PALETTE_SHORTCUT = `${MOD}+Shift+P`;

/** Move the cursor to the end of the document (platform default binding). */
export const CURSOR_BOTTOM_SHORTCUT =
  process.platform === 'darwin' ? `${MOD}+ArrowDown` : 'Control+End';

/**
 * Launch switches that make a desktop run behave like the CI one.
 *
 * Electron/Chromium treats a window that is covered by another window as
 * backgrounded and throttles its timers and animation frames. A developer
 * working in another window (or watching the chat panel) then gets a window
 * whose quick input accepts text but never repaints its list — green on CI
 * (xvfb, nothing occludes) and "the test hangs half way" locally, which is the
 * most expensive kind of flake. The editor under test has no need for that
 * optimisation, so it is switched off.
 */
function isolationLaunchArgs(): string[] {
  return [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    // Built-in AI extensions: irrelevant to the suite, and they contribute
    // first-run prompts that steal focus from the palette.
    '--disable-extension=GitHub.copilot',
    '--disable-extension=GitHub.copilot-chat',
  ];
}

/**
 * Extra switches for the editor under test (MV_VSCODE_EXTRA_ARGS). Kept as an
 * environment knob rather than a code path so the suite itself stays
 * platform-agnostic: a runner that restricts user namespaces adds
 * `--no-sandbox` there instead of the test learning about sandboxes.
 */
function extraLaunchArgs(): string[] {
  const raw = process.env.MV_VSCODE_EXTRA_ARGS?.trim();
  return raw ? raw.split(/\s+/) : [];
}

export function assertVscodeBuilt(): void {
  if (!fs.existsSync(path.join(VSCODE_EXT_DIR, 'package.json'))) {
    throw new Error('dist/vscode missing — run "node vscode/build.js" first');
  }
}

/**
 * VS Code executable under test, or null when this machine has no install.
 * Installed builds only: the suites assert against the same binary a user
 * runs, and a CI job can point MV_VSCODE_EXECUTABLE at a downloaded build.
 */
export function resolveVscodeExecutable(): string | null {
  const fromEnv = process.env.MV_VSCODE_EXECUTABLE?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
          path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/MacOS/Code'),
          '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders',
        ]
      : process.platform === 'win32'
        ? [
            path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe'),
            path.join(process.env.ProgramFiles ?? '', 'Microsoft VS Code/Code.exe'),
          ]
        : [
            '/usr/share/code/code',
            '/usr/bin/code',
            '/opt/visual-studio-code/bin/code',
            '/snap/bin/code',
          ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

/** Reason to skip, phrased for a test report; null when VS Code is available. */
export function vscodeUnavailableReason(): string | null {
  if (SKIP_VSCODE) return 'MV_SKIP_VSCODE_TESTS=1';
  if (!resolveVscodeExecutable()) {
    return 'no VS Code install found — set MV_VSCODE_EXECUTABLE=/path/to/Code';
  }
  if (!fs.existsSync(path.join(VSCODE_EXT_DIR, 'package.json'))) {
    return 'dist/vscode missing — run "node vscode/build.js" first';
  }
  return null;
}

export interface VSCodeHarness {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  close(): Promise<void>;
}

export interface VSCodeLaunchOptions {
  /** Folder opened as the workspace (relative paths resolve against it). */
  workspaceFolder: string;
  /** Written to <user-data-dir>/User/settings.json before launch. */
  settings?: Record<string, unknown>;
}

/**
 * Baseline settings for every test window.
 *
 * The fixtures live inside this repository, so VS Code's Git extension offers
 * to open the parent repository right after launch. That prompt (and any other
 * notification carrying buttons) takes focus exactly while the suite is
 * driving the command palette, which surfaces as a test that appears to hang
 * until the toast times out. Git is not what these suites test, and the same
 * reasoning applies to the other network/tip surfaces: a measuring window
 * should have nothing competing with it for focus or CPU.
 */
const TEST_PROFILE_SETTINGS: Record<string, unknown> = {
  'git.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'workbench.tips.enabled': false,
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'security.workspace.trust.enabled': false,
  // The AI surfaces are not under test and they ship first-run prompts that
  // take focus exactly when the suite drives the palette.
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
};

/**
 * Launch an isolated VS Code with the built extension loaded and wait for the
 * workbench to be interactive. The returned page is the workbench renderer;
 * webview content is reachable through `page.frames()`.
 */
export async function launchVSCode(options: VSCodeLaunchOptions): Promise<VSCodeHarness> {
  assertVscodeBuilt();

  const executablePath = resolveVscodeExecutable();
  if (!executablePath) throw new Error(vscodeUnavailableReason() ?? 'VS Code not found');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-vscode-'));
  const workspaceFolder = path.resolve(options.workspaceFolder);

  if (options.settings || Object.keys(TEST_PROFILE_SETTINGS).length > 0) {
    const userDir = path.join(userDataDir, 'User');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'settings.json'),
      JSON.stringify({ ...TEST_PROFILE_SETTINGS, ...options.settings }, null, 2),
    );
  }

  let app: ElectronApplication;
  try {
    app = await _electron.launch({
      executablePath,
      timeout: 120000,
      args: [
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${path.join(userDataDir, 'extensions')}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-crash-reporter',
        '--locale=en',
        ...isolationLaunchArgs(),
        ...extraLaunchArgs(),
        `--extensionDevelopmentPath=${VSCODE_EXT_DIR}`,
        workspaceFolder,
      ],
    });
  } catch (error) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }

  const page = await app.firstWindow();
  installWorkbenchDiagnostics(page);
  await waitFor(page, WORKBENCH_READY_JS, 120000);
  // `visibilityState` is the canary for occlusion throttling: 'hidden' here
  // means the window was considered covered and timers may be throttled.
  const visibility = await evalJs<string>(
    page,
    `() => document.visibilityState + (document.hasFocus() ? ' (focused)' : ' (not focused)')`,
  ).catch(() => 'unknown');
  trace(`workbench ready (${path.basename(executablePath)}, profile ${userDataDir}, ${visibility})`);

  let closed = false;
  return {
    app,
    page,
    userDataDir,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await app.close();
      } finally {
        if (process.env.MV_VSCODE_KEEP_PROFILE === '1') {
          // eslint-disable-next-line no-console
          console.log(`[vscode-e2e] kept profile: ${userDataDir}`);
        } else {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        }
      }
    },
  };
}

/** Workbench shell is loaded and the activity bar exists. */
const WORKBENCH_READY_JS = `() => Boolean(
  document.querySelector('.monaco-workbench') && document.querySelector('.activitybar')
)`;

/**
 * Surface renderer-side failures (including webview console errors such as CSP
 * violations, which are silent in the UI but explain a blank panel) in the test
 * output. The policy lives in the shared driver.
 */
function installWorkbenchDiagnostics(page: Page): void {
  installPageDiagnostics(page, 'vscode');
}

/** The command palette is open with at least one command listed. */
/**
 * The quick input overlay, not one of its lists.
 *
 * The command palette is SECTIONED: commands and file results live in separate
 * `monaco-list` widgets side by side (measured: three lists, eight rows for a
 * query that matches two commands and six files). Scoping a read to a single
 * `.quick-input-list` therefore sees part of the panel — which looks exactly
 * like "the command is missing from the palette".
 */
const PALETTE_SCOPE = '.quick-input-widget';
/**
 * Texts of the palette's empty state, which VS Code renders as rows in the SAME
 * list, so a row count is not a match count.
 *
 * Only the "nothing matched" phrasings belong here. In particular do NOT add
 * the section label ("file results"): the palette renders that label inside the
 * row of the last pick, so filtering on it deletes a real result row — measured
 * as `"Markdown Viewer: docu.md: Open Preview to the Side⇧⌘Vfile results"`,
 * which made a perfectly healthy command look absent.
 */
const PALETTE_MESSAGE_ROW = /no matching|no results|no commands|did not match/i;
/**
 * Labels of the palette's result rows.
 *
 * Real result rows carry `role="option"`; empty-state and section rows do not,
 * so filtering on the role is what separates results from messages. The label
 * is read from `aria-label` rather than `textContent`, which carries the
 * keybinding glyphs ("⇧⌘V") and section titles painted inside the last row.
 */
const PALETTE_RESULT_ROWS_JS = `Array.from(document.querySelectorAll('${PALETTE_SCOPE} .monaco-list-row'))
  .filter((row) => row.getAttribute('role') === 'option')
  .map((row) => (row.getAttribute('aria-label') || row.textContent || '').trim())
  .filter((text) => text && !(${PALETTE_MESSAGE_ROW}).test(text))`;
/** The command palette is open with at least one result listed. */
const PALETTE_LIST_JS = `() => (${PALETTE_RESULT_ROWS_JS}).length > 0`;
/** Text of the palette's highlighted row, i.e. what Enter would run. */
const PALETTE_FOCUSED_TEXT_JS = `() => {
  const row = document.querySelector('${PALETTE_SCOPE} .monaco-list-row.focused');
  return (row?.getAttribute('aria-label') || row?.textContent || '').trim();
}`;

/** Result row labels, for the driver's own diagnostics and row walking. */
const PALETTE_ROWS_JS = `() => (${PALETTE_RESULT_ROWS_JS})`;

/** The webview document is up and the viewer container exists. */
export const WEBVIEW_READY_JS = `() => Boolean(
  globalThis.VSCODE_CONFIG && document.getElementById('markdown-content')
)`;

/**
 * Labels of the open preview tabs. The workbench exposes one tab per open
 * editor/panel; the preview tabs are the ones whose label is a preview title.
 * This is the user-visible form of "the extension reuses a single panel
 * instead of stacking one per document", and it is stable across VS Code UI
 * revisions in a way that DOM ids are not.
 */
export const PREVIEW_TAB_LABELS_JS = `() => Array.from(document.querySelectorAll('.tabs-container .tab'))
  .map((tab) => (tab.textContent || '').trim())
  .filter((label) => label.includes('Preview:'))`;

/** Per-editor-group tab labels, in workbench order (left to right). */
export const EDITOR_GROUP_TABS_JS = `() => Array.from(document.querySelectorAll('.editor-group-container'))
  .map((group) => Array.from(group.querySelectorAll('.tabs-container .tab'))
    .map((tab) => (tab.textContent || '').trim()))`;

/**
 * Palette labels of the commands the extension contributes (package.json).
 * Kept here so every suite drives the same user-visible names, and so a
 * renamed command fails in one obvious place.
 */
export const COMMANDS = {
  /**
   * Commands are invoked by ID (see `runExtensionCommand`): the palette's fuzzy
   * search on a LABEL reorders under "recently used", so the neighbouring
   * `…to the Side` was measured ranking FIRST for the plain command's own
   * label. The label is still carried here, to assert that the row the palette
   * offers is the command we meant.
   *
   * `preview` / `previewToSide` additionally require a supported TEXT EDITOR to
   * be the active editor: their `when` clause keys off `editorLangId` /
   * `resourceExtname`, neither of which exists while a webview panel holds the
   * active tab — the palette then answers with a "similar commands" section.
   */
  preview: { id: 'markdownViewer.preview', label: 'docu.md: Open Preview' },
  previewToSide: {
    id: 'markdownViewer.previewToSide',
    label: 'docu.md: Open Preview to the Side',
  },
  /** Panel-scoped: offered whenever the extension is installed. */
  openSettings: { id: 'markdownViewer.openSettings', label: 'Open Settings' },
  /** Panel-scoped: needs the preview panel, not a text editor. */
  openExportMenu: { id: 'markdownViewer.openExportMenu', label: 'Open Export Menu' },
} as const;

export type CommandKey = keyof typeof COMMANDS;

/** Run one of the extension's commands, by ID. */
export async function runExtensionCommand(page: Page, key: CommandKey): Promise<void> {
  const entry = COMMANDS[key];
  await runPaletteCommand(page, entry.id, entry.label);
}

/**
 * The user flow for one document: open it from the workspace, preview it, then
 * wait until the panel carries that document's title.
 *
 * Callers that preview a SECOND document in the same launch must wait for
 * their own content marker instead: the first document's frame still answers
 * the generic viewer-boot probe (`waitForPreviewFrame`).
 */
export async function previewFile(page: Page, fileName: string): Promise<void> {
  await openFileFromQuickOpen(page, fileName);
  await runExtensionCommand(page, 'preview');
  await waitFor(
    page,
    `() => (${PREVIEW_TAB_LABELS_JS})().includes(${JSON.stringify(`Preview: ${fileName}`)})`,
    30000,
  );
  trace(`preview panel opened for ${fileName}`);
}

/**
 * Interaction trace is shared with the browser suites (see page-driver.ts).
 */

/**
 * The palette's query field — the element that owns the query and the Enter.
 * `.last()` because nested quick picks stack widgets.
 */
function paletteInput(page: Page) {
  return page.locator('.quick-input-box input').last();
}

/**
 * Set the palette query in the requested mode, and make sure it STUCK.
 *
 * VS Code's quick input carries the mode in the VALUE: a leading `>` means
 * command mode, anything else means file search. That is why the mode is set by
 * construction here instead of being inherited from whatever the widget was
 * doing before:
 *
 *   - writing a bare query into a command-mode field wipes the `>` and silently
 *     switches to file search, where a contributed command name matches no file
 *     and the list says "No matching results" for a command that is healthy;
 *   - keeping a stale `>` when the caller wants file search searches commands
 *     for a file name ("No matching commands").
 *
 * Both look like product bugs and are pure harness damage. The value is also
 * read back, because VS Code re-renders its field: a bulk write can land on the
 * input element that is being replaced, leaving only part of the query in place
 * ("the test typed half the command and stopped").
 */
export async function setPaletteQuery(
  page: Page,
  query: string,
  mode: 'command' | 'file',
): Promise<void> {
  const wanted = (mode === 'command' ? '>' : '') + query;
  const input = paletteInput(page);
  await input.waitFor({ state: 'visible', timeout: 30000 });
  let held = '';

  const readBack = async (): Promise<void> => {
    held = await input.inputValue().catch(() => '');
    if (held !== wanted) {
      throw new Error(`field holds "${held}", wanted "${wanted}"`);
    }
  };

  await retryInteraction({
    label: `set ${mode} palette query "${query}"`,
    attempt: async () => {
      await input.fill(wanted).catch(() => undefined);
      await input.press('End').catch(() => undefined);
      if (await input.inputValue().catch(() => '') === wanted) return;
      // Slow path: individual key events, which the field applies one by one
      // instead of receiving as a single insert. This is what survives a field
      // that is re-rendered mid-write.
      await input.fill(wanted.slice(0, wanted.length - query.length)).catch(() => undefined);
      await input.pressSequentially(query, { delay: 10 }).catch(() => undefined);
    },
    check: readBack,
  }).catch(async (error: Error) => {
    throw new Error(
      `palette input never held the ${mode} query "${wanted}" (holds: "${held}")` +
        ` | ui state: ${await describeUiState(page)}`,
      { cause: error },
    );
  });
}

/** Press a key on the palette's input, so it cannot land somewhere else. */
export async function pressInPalette(page: Page, key: string): Promise<void> {
  await paletteInput(page).press(key);
}

/**
 * The workbench state that can explain a palette miss — a modal, a toast, and
 * which tab each editor group is showing. Names are attached to failure
 * messages so that "this command was not in the palette" comes with the reason:
 * stray UI, or an active tab that the command's `when` clause excludes.
 */
function describeUiState(page: Page): Promise<string> {
  return evalJs<string>(
    page,
    `() => {
      const compact = (node) => (node?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) || null;
      return JSON.stringify({
        dialog: compact(document.querySelector('.monaco-dialog-box')),
        toasts: compact(document.querySelector('.notifications-toasts')),
        groups: (${EDITOR_GROUP_TABS_JS})(),
      });
    }`,
  ).catch(() => '<unavailable>');
}

/** Close the palette from within its own input. */
export async function closePalette(page: Page): Promise<void> {
  if ((await paletteInput(page).count()) > 0) {
    await pressInPalette(page, 'Escape').catch(() => undefined);
  }
  await page.waitForSelector('.quick-input-widget', { state: 'hidden', timeout: 15000 });
}

/**
 * Confirm the palette's highlighted row with Enter.
 * Retried because the field can be re-rendered between the highlight check and
 * the key press, which would send Enter nowhere and leave the widget open.
 */
async function confirmPalette(page: Page): Promise<void> {
  await retryInteraction({
    label: 'confirm palette with Enter',
    attempt: () => pressInPalette(page, 'Enter').catch(() => undefined),
    check: () => page.waitForSelector('.quick-input-widget', { state: 'hidden', timeout: 5000 }),
    timeoutMs: 15000,
  }).catch(async (error: Error) => {
    throw new Error(
      `command palette did not close after Enter | ui state: ${await describeUiState(page)}`,
      { cause: error },
    );
  });
}

/**
 * Run a command through the command palette — the path a user takes, so the
 * contribution point (`contributes.commands` + its `when` clauses) is part of
 * what is under test. `expectedLabel` must be the label of the highlighted row
 * before Enter, which turns "the palette filtered to something else" into a
 * readable failure instead of a mystery timeout. `forbiddenLabel` guards
 * against near-identical commands ("…to the Side") satisfying a substring
 * match for the wrong one.
 */
/**
 * Type a query into the palette, select the intended row, press Enter.
 *
 * Retried, because the interactions that fail here are environmental (a stray
 * prompt, a webview re-rendering and taking focus ate the query or the Enter,
 * leaving the palette on its unfiltered list). The retry repeats the
 * interaction — never an assertion — so a real contribution regression still
 * fails, with the blocking UI named.
 *
 * `waitForInitialList` distinguishes the two entry points: the command palette
 * shows its full list before a query, quick open shows nothing until one is
 * typed.
 */
async function submitPaletteQuery(
  page: Page,
  options: {
    query: string;
    rowMatchesJs: string;
    /** Label used for the "not offered at all" diagnosis, when known. */
    targetLabel?: string;
    expectation: string;
    waitForInitialList: boolean;
    mode: 'command' | 'file';
  },
): Promise<void> {
  const { query, rowMatchesJs, targetLabel, expectation, waitForInitialList, mode } = options;
  const widget = mode === 'command' ? 'command palette' : 'quick open';
  trace(`palette (${mode}): "${query}" → expect ${expectation}`);

  await retryInteraction({
    label: `${widget} query "${query}"`,
    attempt: async () => {
      if (mode === 'command') {
        await openCommandPalette(page);
      } else {
        await openFileSearch(page);
      }
      if (waitForInitialList) {
        await waitFor(page, PALETTE_LIST_JS, 30000);
      }
      await setPaletteQuery(page, query, mode);
    },
    check: () => selectPaletteRow(page, rowMatchesJs, { targetLabel }),
  }).catch(async (error: Error) => {
    const focused = await evalJs<string>(page, PALETTE_FOCUSED_TEXT_JS).catch(() => '<none>');
    const value = await paletteInput(page).inputValue().catch(() => '<unknown>');
    throw new Error(
      `${widget} did not highlight ${expectation} for query "${query}"` +
        ` (input: "${value}", highlighted: "${focused.trim()}")` +
        ` | ui state: ${await describeUiState(page)}`,
      { cause: error },
    );
  });

  await confirmPalette(page);
}

/**
 * Raw palette state (unfiltered rows, input value, overlay count) for failure
 * messages: when a read disagrees with what is on screen, the difference is
 * almost always which element was scoped, and this shows it.
 */
export async function describePaletteState(page: Page): Promise<string> {
  return evalJs<string>(
    page,
    `() => JSON.stringify({
      input: document.querySelector('.quick-input-box input')?.value ?? null,
      widgets: Array.from(document.querySelectorAll('${PALETTE_SCOPE}')).map((widget) => ({
        cls: widget.className,
        rows: Array.from(widget.querySelectorAll('.monaco-list-row')).map((row) => (row.textContent || '').trim()),
      })),
      documentRows: Array.from(document.querySelectorAll('.monaco-list-row'))
        .filter((row) => row.closest('${PALETTE_SCOPE}'))
        .map((row) => (row.textContent || '').trim()),
    })`,
  ).catch((error: unknown) => `<unavailable: ${error instanceof Error ? error.message : String(error)}>`);
}

/**
 * The result rows the palette offers for a command query.
 *
 * Waits for the list to *settle* rather than for a specific expectation: the
 * filter is applied by the editor's scheduler, so reading rows straight after
 * the input event can catch the previous state, or the "No matching results"
 * placeholder from before the command list arrived. Suites use this both to
 * assert what IS offered and to assert that nothing is.
 */
export async function paletteRowsFor(
  page: Page,
  query: string,
  options: { expect?: (rows: string[]) => boolean; timeoutMs?: number } = {},
): Promise<string[]> {
  await openCommandPalette(page);
  await waitFor(page, PALETTE_LIST_JS, 30000);
  await setPaletteQuery(page, query, 'command');

  const snapshot = `() => JSON.stringify((${PALETTE_RESULT_ROWS_JS}))`;
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  let previous = '';
  let stableSince = 0;

  for (;;) {
    const current = await evalJs<string>(page, snapshot).catch(() => previous);
    const now = Date.now();

    // The palette fills its list progressively (command section first, then the
    // file section, and rows can arrive after the first paint), so a caller
    // with an expectation waits for it rather than for "the list stopped
    // changing". Without an expectation this is a plain stability settle.
    if (current !== previous) {
      previous = current;
      stableSince = now;
    } else if (now - stableSince >= (options.expect ? 150 : 400)) {
      const rows = JSON.parse(current || '[]') as string[];
      if (!options.expect || options.expect(rows) || now >= deadline) return rows;
    }

    if (now >= deadline) {
      trace(`palette list never settled for "${query}"; reading it as-is`);
      return JSON.parse(previous || '[]') as string[];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
/**
 * Close whatever quick input is open (quick open left over from a previous
 * step, a stale palette). VS Code reuses ONE widget — and keeps it in the DOM
 * while hidden — for file search, the command palette and every other quick
 * pick, and it keeps the mode it was opened in, so a leftover widget decides
 * what the next query means. Existence is therefore not the question here;
 * visibility is.
 */
export async function dismissQuickInput(page: Page): Promise<void> {
  if (!(await isQuickInputVisible(page))) return;
  await page.keyboard.press('Escape');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await isQuickInputVisible(page))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`quick input did not close after Escape | ui state: ${await describeUiState(page)}`);
}

/** Is the quick input widget on screen right now? */
async function isQuickInputVisible(page: Page): Promise<boolean> {
  return paletteInput(page).isVisible().catch(() => false);
}

/** Open the command palette from a clean slate. */
async function openCommandPalette(page: Page): Promise<void> {
  await dismissQuickInput(page);
  await page.keyboard.press(PALETTE_SHORTCUT);
  await paletteInput(page).waitFor({ state: 'visible', timeout: 30000 });
}

/** Open quick open (file search) from a clean slate. */
async function openFileSearch(page: Page): Promise<void> {
  await dismissQuickInput(page);
  await page.keyboard.press(`${MOD}+P`);
  await paletteInput(page).waitFor({ state: 'visible', timeout: 30000 });
}

/** Tab/group counts, which also say whether an editor is dirty. */
const WORKBENCH_EDITORS_JS = `() => ({
  tabs: document.querySelectorAll('.tabs-container .tab').length,
  groups: document.querySelectorAll('.editor-group-container').length,
  dirty: document.querySelectorAll('.tabs-container .tab.dirty').length,
})`;

/**
 * Does the highlighted row name this command?
 *
 * VS Code renders a palette label as "<category>: <title>" and appends the
 * keybinding to `aria-label` ("Markdown Viewer: docu.md: Open Preview,
 * Shift+Command+V"), so neither equality with the bare title nor a substring
 * test is right: the first misses every categorised command, the second also
 * accepts neighbours ("View: Close All Editors in Group"). Compare the visible
 * label — the aria-label minus its keybinding suffix — allowing the category
 * prefix.
 */
function rowLabelMatchesJs(label: string): string {
  const wanted = JSON.stringify(label);
  return `() => {
    const raw = (${PALETTE_FOCUSED_TEXT_JS})();
    const visible = raw.split(', ')[0];
    return visible === ${wanted} || visible.endsWith(': ' + ${wanted});
  }`;
}

/** The same predicate, over every offered row: is the command there at all? */
function anyRowMatchesJs(label: string): string {
  const wanted = JSON.stringify(label);
  return `() => (${PALETTE_RESULT_ROWS_JS}).some((text) => {
    const visible = text.split(', ')[0];
    return visible === ${wanted} || visible.endsWith(': ' + ${wanted});
  })`;
}

/**
 * Walk the palette's highlighted row onto the one the caller means.
 *
 * The palette's ranking is not a contract: fuzzy scoring puts neighbours first
 * and "recently used" reorders across runs (measured: the `…to the Side`
 * command ranked FIRST while the query was the other command's own label).
 * Rather than trusting the order, move the highlight and check each row.
 *
 * Walking is skipped when the command is not offered at all: that is the
 * `when`-clause case, and scrolling through an unrelated list would both hide
 * the reason and waste the budget.
 */
export async function selectPaletteRow(
  page: Page,
  rowMatchesJs: string,
  options: { targetLabel?: string; maxSteps?: number } = {},
): Promise<void> {
  const { targetLabel, maxSteps = 10 } = options;

  if (targetLabel && !(await evalJs<boolean>(page, anyRowMatchesJs(targetLabel)).catch(() => false))) {
    const offered = await evalJs<string[]>(page, PALETTE_ROWS_JS).catch(() => []);
    throw new Error(
      `the palette does not offer "${targetLabel}" at all — a \`when\` clause (active editor, focused panel) decides that; rows offered: ${JSON.stringify(offered)}`,
    );
  }

  for (let step = 0; step <= maxSteps; step += 1) {
    if (await evalJs<boolean>(page, rowMatchesJs).catch(() => false)) return;
    if (step === maxSteps) break;
    trace(`palette: walking to the intended row (step ${step + 1})`);
    await pressInPalette(page, 'ArrowDown').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  const offered = await evalJs<string[]>(page, PALETTE_ROWS_JS).catch(() => []);
  throw new Error(
    `no palette row matched after ${maxSteps} steps down the list; rows offered: ${JSON.stringify(offered)}`,
  );
}

/**
 * Run a built-in VS Code command by its ID.
 *
 * IDs are unique, which is the point: the palette's fuzzy search on a LABEL
 * surfaces neighbours first (querying "Close All Editors" highlights
 * "Git: Close All Unmodified Editors", and "View: Close All Editors in Group"
 * is one arrow away). Querying `workbench.action.closeAllEditors` puts the
 * intended command first, and the label check then has to be exact modulo the
 * keybinding suffix VS Code appends to `aria-label`
 * ("View: Close All Editors, Command+K Command+W").
 */
export async function runPaletteCommand(
  page: Page,
  commandId: string,
  label: string,
): Promise<void> {
  await submitPaletteQuery(page, {
    query: commandId,
    rowMatchesJs: rowLabelMatchesJs(label),
    targetLabel: label,
    expectation: `"${label}"`,
    waitForInitialList: true,
    mode: 'command',
  });
}

/**
 * Return the window to a known state: no open editors, no preview panel, one
 * editor group. Called in `beforeEach` by every VS Code suite.
 *
 * It removes state coupling between cases, and it keeps their timing
 * predictable — without it the quick-open activation fallback is reached far
 * more often, which is what made single cases take 6-12s instead of 1-2s.
 * Both configurations were measured green across five consecutive runs, so
 * this is a stability choice rather than a fix for a specific failure; cases
 * must still open what they need themselves.
 *
 * Closing the preview panel also disposes the webview, so the next case opens a
 * fresh one.
 */
export async function resetWorkbench(page: Page): Promise<void> {
  await dismissQuickInput(page);

  const state = await evalJs<{ tabs: number; groups: number; dirty: number }>(
    page,
    WORKBENCH_EDITORS_JS,
  );

  // Unsaved changes would make "close all" prompt to save. The suites type into
  // fixtures on purpose and never save, so the buffer is dropped first.
  if (state.dirty > 0) {
    await runPaletteCommand(page, 'workbench.action.files.revert', 'File: Revert File');
  }
  if (state.tabs > 0) {
    await runPaletteCommand(page, 'workbench.action.closeAllEditors', 'View: Close All Editors');
  }
  if (state.groups > 1) {
    await runPaletteCommand(
      page,
      'workbench.action.editorLayoutSingle',
      'View: Single Column Editor Layout',
    );
  }

  await waitFor(
    page,
    `() => {
      const current = (${WORKBENCH_EDITORS_JS})();
      return current.tabs === 0 && current.groups === 1;
    }`,
    20000,
  );

  trace('workbench reset (0 tabs, 1 group)');
}

/** Open a workspace file through quick open (Cmd/Ctrl+P), as a user would. */
export async function openFileFromQuickOpen(page: Page, fileName: string): Promise<void> {
  await openFileSearch(page);

  // Quick open lists recently opened files only: with a fresh profile its list
  // stays empty until a query exists, so there is no initial-list wait here.
  await submitPaletteQuery(page, {
    query: fileName,
    rowMatchesJs: `() => (${PALETTE_FOCUSED_TEXT_JS})().includes(${JSON.stringify(fileName)})`,
    expectation: `"${fileName}"`,
    waitForInitialList: false,
    mode: 'file',
  });

  // The editor tab is the observable proof the file is open and active, which
  // is what the preview command's `when` clauses depend on. Matching is exact:
  // a preview tab reads "Preview: <file>", so a substring check would be
  // satisfied by the panel alone.
  await waitFor(
    page,
    `() => Array.from(document.querySelectorAll('.tabs-container .tab'))
      .some((tab) => (tab.textContent || '').trim() === ${JSON.stringify(fileName)})`,
    20000,
  );

  // Activation is not guaranteed by the pick alone: when a panel `reveal()`
  // from the previous command is still in flight, the panel can take the front
  // back right after the pick. Clicking the tab is the user-level retry, via a
  // different mechanism than the picker.
  try {
    await waitForActiveEditorTab(page, fileName, 5000);
  } catch {
    trace(`quick open left "${fileName}" inactive — activating its tab directly`);
    await focusEditorTab(page, fileName);
  }
}

/** Escape a file name for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wait until this file's editor tab is the ACTIVE one.
 *
 * "The tab exists" is not the same claim, and the difference decides whether a
 * palette query works at all: the source-level preview commands carry a `when`
 * clause on `editorLangId`, which is unset while a webview panel holds the
 * active tab — the palette then answers with a "similar commands" section and
 * looks like the command is missing.
 *
 * The check is per-tab rather than "the first `.tab.active` in the document":
 * once a suite opens a preview beside the source there are two editor groups,
 * and the document-wide query returns the other group's active tab.
 */
export async function waitForActiveEditorTab(
  page: Page,
  fileName: string,
  timeoutMs = 20000,
): Promise<void> {
  await waitFor(
    page,
    `() => {
      const tab = Array.from(document.querySelectorAll('.tabs-container .tab'))
        .find((candidate) => (candidate.textContent || '').trim() === ${JSON.stringify(fileName)});
      return Boolean(tab && tab.classList.contains('active'));
    }`,
    timeoutMs,
  );
}

/**
 * Wait until the text editor owns the keyboard.
 *
 * Clicking a tab makes it active, but VS Code hands keyboard focus to the
 * editor a moment later; typing before that loses the leading characters (and
 * the dirty-tab check still passes, so the loss is silent). The editor's live
 * input element is the observable proof that keys will land where intended.
 */
export async function waitForEditorFocus(page: Page, timeoutMs = 15000): Promise<void> {
  await waitFor(
    page,
    `() => Boolean(document.activeElement && document.activeElement.closest('.monaco-editor'))`,
    timeoutMs,
  );
}

/**
 * Bring a file's editor tab to the front AND give it focus, the way a user
 * does before typing.
 *
 * The match is exact on purpose: a preview tab is labelled `Preview: <file>`,
 * so a substring match clicks the PANEL instead, which moves focus into the
 * webview and sends every following keystroke there — a silent no-op that
 * looks like "the preview does not follow the editor".
 *
 * Retried, because the activation is a race with the editor's own async work:
 * a panel `reveal()` that the previous command requested can land after this
 * click and push the panel back to the front. The retry repeats the user
 * interaction; it does not weaken any assertion about the preview.
 */
export async function focusEditorTab(page: Page, fileName: string): Promise<void> {
  await retryInteraction({
    label: `focus editor tab "${fileName}"`,
    attempt: () =>
      page
        .locator('.tabs-container .tab', { hasText: new RegExp(`^${escapeRegExp(fileName)}$`) })
        .first()
        .click(),
    check: async () => {
      await waitForActiveEditorTab(page, fileName, 3000);
      await waitForEditorFocus(page, 3000);
    },
  });
}

/**
 * All frames owned by VS Code webviews. A live webview contributes more than
 * one frame (the host document and the content document), so this is only for
 * diagnostics and counting — never pick a frame by URL shape, pick it by
 * probing what it renders (`waitForPreviewFrame`).
 */
function webviewFrames(page: Page): Frame[] {
  return page.frames().filter((frame) => frame.url().startsWith('vscode-webview://'));
}

/**
 * Wait for the frame that actually renders the preview, and return it.
 * The webview's host document looks like a frame too, and its URL differs
 * between VS Code versions, so every candidate is probed instead.
 *
 * Pass `readyJs` when waiting for a specific document's output rather than the
 * viewer's initial boot (e.g. the second document in a panel reuse test).
 */
export async function waitForPreviewFrame(
  page: Page,
  readyJs: string = WEBVIEW_READY_JS,
  timeoutMs = 60000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  let sawRenderableError: unknown;
  trace('waiting for a preview frame to satisfy the readiness probe');

  for (;;) {
    for (const frame of webviewFrames(page)) {
      try {
        if (await evalJs<boolean>(frame, readyJs)) return frame;
      } catch (error) {
        // A frame mid-navigation throws; keep probing the others.
        sawRenderableError = error;
      }
    }

    if (Date.now() >= deadline) {
      const suffix =
        sawRenderableError instanceof Error ? ` last error: ${sawRenderableError.message}` : '';
      throw new Error(
        `no preview webview frame satisfied the readiness probe within ${timeoutMs}ms` +
          ` | frames: ${await describePreviewState(page)}${suffix}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Save a workbench screenshot next to the other E2E artifacts. Called on
 * failure: a VS Code failure report without a picture of the window is hard to
 * act on, and the webview is the part that usually looks wrong.
 */
export async function captureWorkbench(page: Page, label: string): Promise<void> {
  const artifactDir = process.env.MV_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) return;
  try {
    const name = `${label.replace(/[^a-z0-9_-]/gi, '_')}.png`;
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, name) });
  } catch {
    /* diagnostics are best-effort */
  }
}

/**
 * A compact picture of what every webview frame currently holds, for failure
 * messages — a timeout inside a webview otherwise reports only "the DOM never
 * matched", which says nothing about whether the document rendered without the
 * expected element, rendered an error block, or never rendered at all. A live
 * webview contributes more than one frame, so "which frame" matters.
 */
export async function describePreviewState(page: Page): Promise<string> {
  return describeFrames(
    webviewFrames(page),
    `() => {
      const content = document.getElementById('markdown-content');
      const children = Array.from(content?.children || []);
      return {
        url: location.href.slice(0, 40),
        title: document.title,
        children: children.length,
        blocks: children.map((child) => child.className || child.tagName).slice(0, 8),
        errorBlocks: children.filter((child) => /error|invalid/i.test(child.className)).length,
        iframes: document.querySelectorAll('iframe').length,
        textHead: (content?.textContent || '').trim().slice(0, 100),
      };
    }`,
  );
}
