/**
 * Vega-Lite Plugin using BasePlugin architecture
 *
 * Supports both `vega-lite` and `vegalite` code block languages via the
 * central CODE_BLOCK_LANGUAGE_MAP (no hard-coded language list here).
 */
import { BasePlugin } from './base-plugin';

export class VegaLitePlugin extends BasePlugin {
  constructor() {
    super('vega-lite');
  }
}
