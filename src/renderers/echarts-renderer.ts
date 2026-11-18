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
  /** Extra breathing room added when content extends beyond the requested frame */
  private static readonly EXPORT_PADDING = 8;

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

    // Initialize ECharts with the SVG renderer: it produces an SVG string
    // (renderToSVGString) while still supporting PNG export (getDataURL
    // converts internally), so both representations are available.
    const chart = echarts.init(container, isDark ? 'dark' : null, {
      renderer: 'svg',
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

    // Default to a transparent background so the chart blends into any page
    // color. An author-specified background (e.g. "white") is respected so
    // the exported PNG/SVG is fully opaque.
    if (!processedOption.backgroundColor) {
      processedOption.backgroundColor = 'transparent';
    }

    try {
      // Wait for the chart to finish rendering before exporting
      await this.waitForFinished(chart);

      chart.setOption(processedOption);

      // Wait again after setOption to ensure the canvas is fully painted
      await this.waitForFinished(chart);

      const svgElement = container.querySelector('svg');
      const exportBounds = svgElement
        ? this.measureSvgContentBounds(svgElement, width, height)
        : { minX: 0, minY: 0, maxX: width, maxY: height };
      const adjustedExport = this.expandSvgExport(
        chart.renderToSVGString(),
        exportBounds,
        width,
        height,
        processedOption.backgroundColor,
      );

      // Calculate scale for PNG dimensions (clamped to canvas limits)
      const scale = this.clampCanvasDimensions(
        adjustedExport.width,
        adjustedExport.height,
        this.calculateCanvasScale(themeConfig),
      );

      // Render the SVG to a canvas for the PNG (same path as PlantUML/Mermaid:
      // the svg renderer's own getDataURL('png') does not produce a valid
      // bitmap).
      const canvas = await this.renderSvgToCanvas(
        adjustedExport.svg,
        Math.round(adjustedExport.width * scale),
        Math.round(adjustedExport.height * scale),
      );
      const pngDataUrl = canvas.toDataURL('image/png', 1.0);
      const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');

      return {
        base64: base64Data,
        width: Math.round(adjustedExport.width * scale),
        height: Math.round(adjustedExport.height * scale),
        format: 'png',
        svg: adjustedExport.svg,
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

  /**
   * Measure the union bbox of rendered SVG elements so exports can include
   * content that ECharts paints beyond the nominal canvas height/width.
   */
  private measureSvgContentBounds(
    svgElement: SVGSVGElement,
    fallbackWidth: number,
    fallbackHeight: number,
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = 0;
    let minY = 0;
    let maxX = fallbackWidth;
    let maxY = fallbackHeight;

    const graphicNodes = svgElement.querySelectorAll(
      'path, rect, circle, ellipse, line, polyline, polygon, text, image, g',
    );

    for (const node of graphicNodes) {
      if (!(node instanceof SVGGraphicsElement)) {
        continue;
      }
      try {
        const box = node.getBBox();
        if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) {
          continue;
        }
        if (box.width === 0 && box.height === 0) {
          continue;
        }
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
      } catch {
        // Some SVG nodes do not support getBBox in all cases; ignore them.
      }
    }

    return { minX, minY, maxX, maxY };
  }

  /**
   * Expand the exported SVG root box when the rendered content exceeds the
   * requested width/height. This keeps PNG rasterization from clipping.
   *
   * When the chart has an opaque background, the expanded area is filled with
   * that same color: ECharts only emits a background rect for the nominal
   * canvas, so the padding/overflow region would otherwise stay transparent.
   */
  private expandSvgExport(
    svgContent: string,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    fallbackWidth: number,
    fallbackHeight: number,
    backgroundColor: string | undefined,
  ): { svg: string; width: number; height: number } {
    const padding = EchartsRenderer.EXPORT_PADDING;
    const viewBoxX = Math.floor(Math.min(0, bounds.minX) - padding);
    const viewBoxY = Math.floor(Math.min(0, bounds.minY) - padding);
    const maxX = Math.ceil(Math.max(fallbackWidth, bounds.maxX) + padding);
    const maxY = Math.ceil(Math.max(fallbackHeight, bounds.maxY) + padding);
    const exportWidth = maxX - viewBoxX;
    const exportHeight = maxY - viewBoxY;

    if (exportWidth === fallbackWidth && exportHeight === fallbackHeight && viewBoxX === 0 && viewBoxY === 0) {
      return { svg: svgContent, width: fallbackWidth, height: fallbackHeight };
    }

    const doc = new DOMParser().parseFromString(svgContent, 'image/svg+xml');
    const svgRoot = doc.documentElement;
    svgRoot.setAttribute('width', String(exportWidth));
    svgRoot.setAttribute('height', String(exportHeight));
    svgRoot.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${exportWidth} ${exportHeight}`);

    // Repaint the area added by the expansion with the author's background
    // color (when opaque). ECharts' own background rect only covers the
    // nominal canvas, so the padding/overflow region would otherwise stay
    // transparent. The fill is laid out as four bands around the canvas
    // instead of one full-box rect so semi-transparent colors (rgba) are not
    // composited twice over the chart area.
    const fill = typeof backgroundColor === 'string' ? backgroundColor.trim() : '';
    if (fill && !/^(transparent|none)$/i.test(fill)) {
      const bands: Array<[number, number, number, number]> = [];
      if (viewBoxY < 0) {
        bands.push([viewBoxX, viewBoxY, exportWidth, -viewBoxY]);
      }
      if (maxY > fallbackHeight) {
        bands.push([viewBoxX, fallbackHeight, exportWidth, maxY - fallbackHeight]);
      }
      if (viewBoxX < 0) {
        bands.push([viewBoxX, 0, -viewBoxX, fallbackHeight]);
      }
      if (maxX > fallbackWidth) {
        bands.push([fallbackWidth, 0, maxX - fallbackWidth, fallbackHeight]);
      }
      for (const [x, y, bandWidth, bandHeight] of bands) {
        if (bandWidth <= 0 || bandHeight <= 0) {
          continue;
        }
        const band = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
        band.setAttribute('x', String(x));
        band.setAttribute('y', String(y));
        band.setAttribute('width', String(bandWidth));
        band.setAttribute('height', String(bandHeight));
        band.setAttribute('fill', fill);
        // Background must stay behind all rendered chart content.
        svgRoot.insertBefore(band, svgRoot.firstChild);
      }
    }

    return {
      svg: new XMLSerializer().serializeToString(doc),
      width: exportWidth,
      height: exportHeight,
    };
  }
}
