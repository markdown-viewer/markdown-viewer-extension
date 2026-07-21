/**
 * ECharts Plugin using BasePlugin architecture
 *
 * Supports `echarts` code block language and `.echarts` standalone files.
 * The central CODE_BLOCK_LANGUAGE_MAP resolves the language alias to this
 * plugin's type.
 */
import { BasePlugin } from './base-plugin';

/**
 * ECharts Plugin implementation
 */
export class EchartsPlugin extends BasePlugin {
  constructor() {
    super('echarts');
  }
}
