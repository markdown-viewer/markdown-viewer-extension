/**
 * Obsidian Plugin Settings Tab
 *
 * Native Obsidian settings page (Settings → Community plugins → Markdown Viewer Enhanced).
 * Provides configuration for supported file types and general plugin behavior.
 *
 * Fine-grained rendering settings (theme, locale, DOCX options) are managed
 * via the in-preview settings panel to stay consistent with other platforms.
 */

import { PluginSettingTab, App, Setting } from 'obsidian';
import type MarkdownViewerPlugin from './main';
import { SUPPORTED_FORMATS } from '../../../src/types/formats';

/** Obsidian settings key for a format (e.g. 'mermaid' → 'support:mermaid') */
function formatSettingsKey(fileType: string): string {
  return `support:${fileType}`;
}

/** Plugin settings stored via Plugin.loadData/saveData */
export interface PluginSettings {
  // Dynamic format support flags (support:mermaid, support:vega, etc.)
  [key: string]: boolean;
}

/** Build default settings from format registry */
function buildDefaultSettings(): PluginSettings {
  const defaults: PluginSettings = { autoPreviewOnOpen: false };
  for (const f of SUPPORTED_FORMATS) {
    defaults[formatSettingsKey(f.fileType)] = true;
  }
  return defaults;
}

export const DEFAULT_SETTINGS: PluginSettings = buildDefaultSettings();

/** Display info for Obsidian settings UI */
const FORMAT_DISPLAY: Record<string, { name: string; desc: string }> = {
  'mermaid':     { name: 'Mermaid (.mermaid, .mmd)',   desc: 'Flowcharts, sequence diagrams, state machines, etc.' },
  'vega':        { name: 'Vega (.vega)',               desc: 'Data-driven visualizations with Vega grammar.' },
  'vega-lite':   { name: 'Vega-Lite (.vl)',            desc: 'Simplified data visualizations with Vega-Lite grammar.' },
  'dot':         { name: 'Graphviz (.gv, .dot)',       desc: 'Directed and undirected graph diagrams.' },
  'infographic': { name: 'Infographic (.infographic)', desc: 'Visual infographic layouts.' },
  'canvas':      { name: 'Canvas (.canvas)',           desc: 'Spatial node-based diagrams.' },
  'drawio':      { name: 'DrawIO (.drawio)',           desc: 'General purpose diagrams (draw.io format).' },
};

export class MarkdownViewerSettingTab extends PluginSettingTab {
  plugin: MarkdownViewerPlugin;

  constructor(app: App, plugin: MarkdownViewerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Supported File Types ---
    containerEl.createEl('h3', { text: 'Supported File Types' });
    containerEl.createEl('p', {
      text: 'Enable or disable preview support for non-Markdown file types. Markdown (.md) is always supported.',
      cls: 'setting-item-description',
    });

    for (const format of SUPPORTED_FORMATS) {
      const display = FORMAT_DISPLAY[format.fileType];
      if (display) {
        this.addFileTypeSetting(containerEl, display.name, formatSettingsKey(format.fileType), display.desc);
      }
    }

    // --- Behavior ---
    containerEl.createEl('h3', { text: 'Behavior' });

    new Setting(containerEl)
      .setName('Auto-preview on file open')
      .setDesc('Automatically open the preview panel when a supported file is opened.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoPreviewOnOpen)
          .onChange(async (value) => {
            this.plugin.settings.autoPreviewOnOpen = value;
            await this.plugin.savePluginSettings();
          })
      );

    // --- Info ---
    containerEl.createEl('h3', { text: 'Preview Settings' });
    containerEl.createEl('p', {
      text: 'Theme, language, DOCX export options, and other rendering settings can be configured via the ⚙ button in the preview panel title bar.',
      cls: 'setting-item-description',
    });
  }

  private addFileTypeSetting(
    container: HTMLElement,
    name: string,
    key: string,
    desc: string,
  ): void {
    new Setting(container)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings[key] as boolean)
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.savePluginSettings();
          })
      );
  }
}
