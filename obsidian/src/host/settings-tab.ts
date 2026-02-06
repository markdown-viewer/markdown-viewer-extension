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

/** Plugin settings stored via Plugin.loadData/saveData */
export interface PluginSettings {
  // Supported file extensions for preview
  supportMermaid: boolean;
  supportVega: boolean;
  supportVegaLite: boolean;
  supportDot: boolean;
  supportInfographic: boolean;
  supportCanvas: boolean;
  supportDrawio: boolean;

  // Behavior
  autoPreviewOnOpen: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  supportMermaid: true,
  supportVega: true,
  supportVegaLite: true,
  supportDot: true,
  supportInfographic: true,
  supportCanvas: true,
  supportDrawio: true,
  autoPreviewOnOpen: false,
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

    this.addFileTypeSetting(containerEl, 'Mermaid (.mermaid, .mmd)', 'supportMermaid',
      'Flowcharts, sequence diagrams, state machines, etc.');

    this.addFileTypeSetting(containerEl, 'Vega (.vega)', 'supportVega',
      'Data-driven visualizations with Vega grammar.');

    this.addFileTypeSetting(containerEl, 'Vega-Lite (.vl)', 'supportVegaLite',
      'Simplified data visualizations with Vega-Lite grammar.');

    this.addFileTypeSetting(containerEl, 'Graphviz (.gv, .dot)', 'supportDot',
      'Directed and undirected graph diagrams.');

    this.addFileTypeSetting(containerEl, 'Infographic (.infographic)', 'supportInfographic',
      'Visual infographic layouts.');

    this.addFileTypeSetting(containerEl, 'Canvas (.canvas)', 'supportCanvas',
      'Spatial node-based diagrams.');

    this.addFileTypeSetting(containerEl, 'DrawIO (.drawio)', 'supportDrawio',
      'General purpose diagrams (draw.io format).');

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
    key: keyof PluginSettings,
    desc: string,
  ): void {
    new Setting(container)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings[key] as boolean)
          .onChange(async (value) => {
            (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
            await this.plugin.savePluginSettings();
          })
      );
  }
}
