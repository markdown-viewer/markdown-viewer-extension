/**
 * VS Code extension E2E: the command surface and the panels it drives.
 *
 * The preview panel suite (preview-panel.test.ts) covers what a document looks
 * like once it is on screen. This suite covers the parts of the VS Code
 * contribution surface that a browser-hosted test cannot see at all:
 *
 *   - `ViewColumn.Beside` placement is real layout, not a flag;
 *   - the settings panel and export menu are webview surfaces fed by the
 *     extension host, so "the command ran" and "the user saw something" are
 *     two different claims;
 *   - `when` clauses decide whether a command is offered AT ALL, a regression
 *     class that produces no error anywhere.
 *
 * One launch, ordered cases: each case builds on the panel the previous one
 * left open.
 *
 * Run: `npm run test:e2e:vscode` (needs `npm run build:vscode` first).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  COMMANDS,
  EDITOR_GROUP_TABS_JS,
  PREVIEW_TAB_LABELS_JS,
  captureWorkbench,
  closePalette,
  evalJs,
  focusEditorTab,
  launchVSCode,
  openFileFromQuickOpen,
  paletteRowsFor,
  previewFile,
  resetWorkbench,
  runExtensionCommand,
  vscodeUnavailableReason,
  waitFor,
  waitForPreviewFrame,
  type VSCodeHarness,
} from '../../helpers/vscode-launch.ts';

const WORKSPACE = path.resolve('test/fixtures/vscode');

/**
 * Visibility that survives fixed positioning: `offsetParent` is null for every
 * `position: fixed` element, which would make a "is it hidden?" assertion pass
 * for the wrong reason.
 */
const VISIBLE_JS = `(node) => Boolean(node && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0)`;

/** Theme selector of the settings panel, when that panel is on screen. */
const SETTINGS_PANEL_JS = `() => {
  const isVisible = ${VISIBLE_JS};
  const panel = document.querySelector('.vscode-settings-panel');
  if (!isVisible(panel)) return null;
  const select = panel.querySelector('select[data-setting="theme"]');
  return { themeValues: Array.from(select?.querySelectorAll('option') || []).map((o) => o.value) };
}`;

/** The visible export menu and its item labels. */
const EXPORT_MENU_JS = `() => {
  const isVisible = ${VISIBLE_JS};
  const menu = Array.from(document.querySelectorAll('.mv-action-menu')).find(isVisible);
  if (!menu) return null;
  return {
    labels: Array.from(menu.querySelectorAll('.mv-action-menu-item'))
      .map((item) => (item.textContent || '').trim()),
  };
}`;

const reason = vscodeUnavailableReason();

describe('VS Code extension: commands and panels', { skip: reason ?? false }, () => {
  let harness: VSCodeHarness;

  before(async () => {
    harness = await launchVSCode({ workspaceFolder: WORKSPACE });
  });

  // Every case starts from the same clean window: no open editors, no preview
  // panel, one editor group. Cases also open what they need themselves, so this
  // only removes state coupling — it is not a substitute for setup.
  beforeEach(async () => {
    await resetWorkbench(harness.page);
  });

  after(async () => {
    await captureWorkbench(harness.page, 'vscode-commands-and-panels').catch(() => undefined);
    await harness.close();
  });

  it('opens the preview beside the source in a second editor group', async () => {
    const { page } = harness;

    await previewFile(page, 'smoke.md');

    // `docu.md: Open Preview to the Side` is only offered while a supported
    // TEXT EDITOR is the active editor (its `when` clause keys off
    // `editorLangId` / `resourceExtname`, which are unset for a webview panel).
    // The preview above left the panel holding the active tab, so the source
    // tab is brought back to the front first — the same step a user takes.
    await focusEditorTab(page, 'smoke.md');
    await runExtensionCommand(page, 'previewToSide');
    await waitForPreviewFrame(page);

    // `ViewColumn.Beside` is a layout claim: the source keeps its group and the
    // preview lands in a new group next to it.
    await waitFor(
      page,
      `() => {
        const groups = (${EDITOR_GROUP_TABS_JS})();
        return groups.length === 2
          && groups[0].some((tab) => tab.includes('smoke.md'))
          && !groups[0].some((tab) => tab.includes('Preview:'))
          && groups[1].some((tab) => tab.includes('Preview:'));
      }`,
      30000,
    );

    const groups = await evalJs<string[][]>(page, EDITOR_GROUP_TABS_JS);
    assert.ok(
      groups[1].some((tab) => tab.includes('Preview: smoke.md')),
      `preview group: ${JSON.stringify(groups[1])}`,
    );
    assert.deepEqual(
      await evalJs<string[]>(page, PREVIEW_TAB_LABELS_JS),
      ['Preview: smoke.md'],
      'beside-preview reuses the open panel instead of adding a second one',
    );
  });

  it('opens the settings panel with the bundled theme registry in its selector', async () => {
    const { page } = harness;

    await previewFile(page, 'smoke.md');

    // The panel and its menu are webview DOM, not workbench DOM: they have to
    // be read from the preview frame.
    const frame = await waitForPreviewFrame(page);
    await runExtensionCommand(page, 'openSettings');
    await waitFor(frame, `() => Boolean((${SETTINGS_PANEL_JS})())`, 30000);

    // "The panel is visible" is not "the registry has landed": the theme list
    // arrives through one fetch for registry.json plus one per preset, all
    // after the panel opens. A slow runner read the selector while it still
    // held only the template's placeholder option (measured on CI: 1 option),
    // so the populated state is waited for — the assertion below still pins the
    // contract, it just no longer races the fetch.
    await waitFor(
      frame,
      `() => ((${SETTINGS_PANEL_JS})()?.themeValues.length || 0) >= 25`,
      30000,
    );

    const panel = await evalJs<{ themeValues: string[] }>(frame, SETTINGS_PANEL_JS);
    assert.ok(
      panel.themeValues.length >= 25,
      `theme selector should be populated from the bundled registry (got ${panel.themeValues.length})`,
    );
    for (const themeId of ['default', 'dracula', 'nord']) {
      assert.ok(
        panel.themeValues.includes(themeId),
        `theme "${themeId}" missing from the selector (${panel.themeValues.length} options)`,
      );
    }

    // The command toggles the panel — asserted, because a toggle that only ever
    // opens is a visible bug with no failing API call behind it.
    await runExtensionCommand(page, 'openSettings');
    await waitFor(frame, `() => (${SETTINGS_PANEL_JS})() === null`, 15000);
  });

  it('opens the export menu with the formats the panel can produce', async () => {
    const { page } = harness;

    await previewFile(page, 'smoke.md');

    const frame = await waitForPreviewFrame(page);
    await runExtensionCommand(page, 'openExportMenu');
    await waitFor(frame, `() => Boolean((${EXPORT_MENU_JS})())`, 30000);

    const menu = await evalJs<{ labels: string[] }>(frame, EXPORT_MENU_JS);
    assert.ok(menu.labels.length >= 3, `export items: ${JSON.stringify(menu.labels)}`);
    for (const format of ['docx', 'epub', 'html']) {
      assert.ok(
        menu.labels.some((label) => label.toLowerCase().includes(format)),
        `export menu is missing the ${format.toUpperCase()} entry (${JSON.stringify(menu.labels)})`,
      );
    }
  });

  it('does not offer the preview commands for an unsupported document', async () => {
    const { page } = harness;

    await openFileFromQuickOpen(page, 'notes.txt');

    // Absence is the assertion. It is phrased against the command label rather
    // than "no rows at all", because the palette also lists file results and
    // empty-state rows in the same widget. The query is the command ID.
    const rows = await paletteRowsFor(page, COMMANDS.preview.id);
    await closePalette(page);

    assert.ok(
      !rows.some((row) => row.includes(COMMANDS.preview.label)),
      `"${COMMANDS.preview.label}" must not be offered for a .txt file (rows: ${JSON.stringify(rows)})`,
    );
  });
});
