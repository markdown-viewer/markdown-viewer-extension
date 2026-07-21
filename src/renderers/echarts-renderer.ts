/**
 * ECharts Renderer using BaseRenderer architecture
 *
 * Renders ECharts chart options to PNG images using the canvas renderer.
 * ECharts library is bundled directly (same approach as Vega/Vega-Lite).
 *
 * Render flow:
 * 1. Parse JSON option string → object
 * 2. Extract optional width/height hints from the option
 * 3. Create a hidden container element with the chart dimensions
 * 4. Initialize ECharts (canvas renderer, dark theme when applicable)
 * 5. setOption with animation disabled and theme font applied
 * 6. Export the canvas to a PNG data URL via getDataURL()
 */
import * as echarts from 'echarts';
import { BaseRenderer } from './base-renderer';
import type { RendererThemeConfig, RenderResult } from '../types/index';

/**
 * ECharts option object.
 *
 * `width` and `height` are non-standard top-level hints recognized by this
 * renderer to control the output canvas size. All other keys are passed
 * through to `chart.setOption()` unchanged.
 */
interface EchartsOption {
  width?: number;
  height?: number;
  textStyle?: { fontFamily?: string };
  backgroundColor?: string;
  animation?: boolean;
  [key: string]: unknown;
}

export class EchartsRenderer extends BaseRenderer {
  /** Default chart width when no hint is provided in the option */
  private static readonly DEFAULT_WIDTH = 800;
  /** Default chart height when no hint is provided in the option */
  private static readonly DEFAULT_HEIGHT = 450;

  constructor() {
    super('echarts');
  }

  /**
   * Validate ECharts option
   */
  validateInput(option: unknown): boolean {
    if (!option) {
      throw new Error('Empty echarts option provided');
    }
    return true;
  }

  /**
   * Preprocess input — parse JSON string if needed and validate structure
   */
  preprocessInput(option: string | EchartsOption): EchartsOption {
    let echartsOption: EchartsOption;
    if (typeof option === 'string') {
      try {
        echartsOption = JSON.parse(option);
      } catch (e) {
        throw new Error(`Invalid JSON in echarts option: ${(e as Error).message}`);
      }
    } else {
      echartsOption = option;
    }

    if (!echartsOption || typeof echartsOption !== 'object' || Array.isArray(echartsOption)) {
      throw new Error('Invalid echarts option: must be a JSON object');
    }

    return echartsOption;
  }

  /**
   * Render ECharts option to PNG
   * @param option - ECharts option (JSON string or object)
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, width, height, format
   */
  async render(
    option: string | EchartsOption,
    themeConfig: RendererThemeConfig | null,
  ): Promise<RenderResult> {
    // Ensure renderer is initialized
    if (!this._initialized) {
      await this.initialize(themeConfig);
    }

    // Validate and preprocess input
    this.validateInput(option);
    const processedOption = this.preprocessInput(option);

    // Theme-aware settings
    const isDark = themeConfig?.colorSchema === 'dark';
    const fontFamily =
      themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";

    // Extract optional width/height hints from the option
    const width =
      typeof processedOption.width === 'number' && processedOption.width > 0
        ? processedOption.width
        : EchartsRenderer.DEFAULT_WIDTH;
    const height =
      typeof processedOption.height === 'number' && processedOption.height > 0
        ? processedOption.height
        : EchartsRenderer.DEFAULT_HEIGHT;

    // Create container for this render
    const container = this.createContainer();
    container.style.cssText = `position: absolute; left: -9999px; top: -9999px; width: ${width}px; height: ${height}px; background: transparent; padding: 0; margin: 0;`;

    // Initialize ECharts with canvas renderer and dark theme when applicable
    const chart = echarts.init(container, isDark ? 'dark' : null, {
      renderer: 'canvas',
      width,
      height,
    });

    // Disable animation for static PNG rendering (unless explicitly enabled)
    if (!('animation' in processedOption)) {
      processedOption.animation = false;
    }

    // Apply default font family if not specified in the option
    const textStyle = (processedOption.textStyle || {}) as { fontFamily?: string };
    if (!textStyle.fontFamily) {
      textStyle.fontFamily = fontFamily;
    }
    processedOption.textStyle = textStyle;

    // Keep background transparent so the chart blends into any page color
    processedOption.backgroundColor = 'transparent';

    try {
      // Wait for the chart to finish rendering before exporting
      await this.waitForFinished(chart);

      chart.setOption(processedOption);

      // Wait again after setOption to ensure the canvas is fully painted
      await this.waitForFinished(chart);

      // Calculate scale for PNG dimensions (same formula as Vega/Mermaid)
      const scale = this.calculateCanvasScale(themeConfig);

      // Export the canvas to a PNG data URL
      const dataUrl = chart.getDataURL({
        type: 'png',
        pixelRatio: scale,
        backgroundColor: 'transparent',
      });

      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');

      return {
        base64: base64Data,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        format: 'png',
      };
    } finally {
      chart.dispose();
      this.removeContainer(container);
    }
  }

  /**
   * Wait for ECharts `finished` event (emitted after each render cycle).
   * Falls back to a timeout to avoid hanging on charts that never emit.
   */
  private waitForFinished(chart: echarts.ECharts): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        chart.off('finished', handler);
        clearTimeout(timer);
        resolve();
      };
      const handler = (): void => finish();
      chart.on('finished', handler);
      // Fallback: resolve after 500ms even if finished never fires
      const timer = setTimeout(finish, 500);
    });
  }
}
