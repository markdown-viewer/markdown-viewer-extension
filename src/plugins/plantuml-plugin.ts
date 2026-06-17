/**
 * PlantUML Plugin
 *
 * Handles PlantUML diagram processing in content script and DOCX export.
 * Supports `plantuml`, `puml`, and `wsd` code block languages via the
 * central CODE_BLOCK_LANGUAGE_MAP (no hard-coded language list here).
 */
import { BasePlugin } from './base-plugin';

export class PlantumlPlugin extends BasePlugin {
  constructor() {
    super('plantuml');
  }
}
