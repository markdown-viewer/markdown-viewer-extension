/**
 * DrawIO Renderer
 * 
 * Renders DrawIO diagrams to PNG images using @markdown-viewer/drawio2svg
 */
import { BaseRenderer } from './base-renderer';
import { convert } from '@markdown-viewer/drawio2svg';
import { applyRoughEffect, type RoughSvgOptions } from './libs/rough-svg';
import { getStencilsService } from '../services/stencils-service';
import type { RendererThemeConfig, RenderResult } from '../types/index';

/**
 * Extract stencil group names from DrawIO XML
 * Stencil shapes are in format: mxgraph.{group}.{key}
 */
function extractStencilGroups(xml: string): string[] {
  const groups = new Set<string>();
  // Match shape="mxgraph.xxx.yyy" patterns
  const regex = /shape=["']?mxgraph\.([a-zA-Z0-9_]+)\./g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    let group = match[1];
    // Normalize group names
    if (group === 'ios7ui') {
      group = 'ios7';
    }
    groups.add(group);
  }
  return Array.from(groups);
}

function getPrimaryFontFamily(fontFamily?: string): string | undefined {
  if (!fontFamily) return undefined;
  const first = fontFamily.split(',')[0]?.trim();
  if (!first) return undefined;
  return first.replace(/^['"]|['"]$/g, '');
}

export class DrawioRenderer extends BaseRenderer {
  private roughOptions: RoughSvgOptions = {
    roughness: 0.5,
    bowing: 0.5,
  };
  private stencilsInitialized = false;

  constructor() {
    super('drawio');
  }

  /**
   * Initialize stencils service (lazy loading)
   */
  private async ensureStencils(): Promise<void> {
    if (this.stencilsInitialized) return;
    
    try {
      const service = getStencilsService();
      await service.init();
      this.stencilsInitialized = true;
    } catch (error) {
      // Continue without stencils - basic shapes will still work
      this.stencilsInitialized = true;
    }
  }

  /**
   * Validate DrawIO XML input
   */
  validateInput(input: string): boolean {
    if (!input || typeof input !== 'string') {
      throw new Error('DrawIO input must be a non-empty string');
    }
    // DrawIO files contain mxfile or mxGraphModel
    if (!input.includes('<mxfile') && !input.includes('<mxGraphModel')) {
      throw new Error('Invalid DrawIO: missing <mxfile> or <mxGraphModel> tag');
    }
    return true;
  }

  /**
   * Render DrawIO diagram to PNG
   * @param xml - DrawIO XML content
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, width, height, format
   */
  async render(xml: string, themeConfig: RendererThemeConfig | null): Promise<RenderResult> {
    // Validate input
    this.validateInput(xml);

    // Ensure stencils manifest is loaded
    await this.ensureStencils();

    // Extract and preload stencil groups used in this diagram
    const stencilsService = getStencilsService();
    const groups = extractStencilGroups(xml);
    if (groups.length > 0) {
      await stencilsService.preloadGroups(groups);
    }

    // Get stencils bundle (now with preloaded data)
    const stencils = stencilsService.getBundle();

    // Convert DrawIO XML to SVG with stencils and font family support
    let svg = convert(xml, {
      stencils,
      fontFamily: themeConfig?.fontFamily ? getPrimaryFontFamily(themeConfig.fontFamily) : undefined
    });

    // Parse SVG to get dimensions
    const parser = new DOMParser();
    const doc = parser.parseFromString(svg, 'image/svg+xml');
    const svgEl = doc.querySelector('svg');

    if (!svgEl) {
      throw new Error('DrawIO conversion failed: no SVG element generated');
    }

    // Get SVG dimensions from viewBox or attributes
    const viewBox = svgEl.getAttribute('viewBox');
    let captureWidth: number, captureHeight: number;

    if (viewBox) {
      const parts = viewBox.split(/\s+/);
      captureWidth = Math.ceil(parseFloat(parts[2]));
      captureHeight = Math.ceil(parseFloat(parts[3]));
    } else {
      captureWidth = Math.ceil(parseFloat(svgEl.getAttribute('width') || '800'));
      captureHeight = Math.ceil(parseFloat(svgEl.getAttribute('height') || '600'));
    }

    // Apply rough.js hand-drawn effect if enabled
    const isHandDrawn = themeConfig?.diagramStyle === 'handDrawn';
    if (isHandDrawn) {
      svg = applyRoughEffect(svg, this.roughOptions);
    }

    // Calculate scale for PNG dimensions
    const scale = this.calculateCanvasScale(themeConfig);

    // Render SVG to canvas as PNG
    const canvas = await this.renderSvgToCanvas(svg, captureWidth * scale, captureHeight * scale);

    const pngDataUrl = canvas.toDataURL('image/png', 1.0);
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');

    return {
      base64: base64Data,
      width: canvas.width,
      height: canvas.height,
      format: 'png'
    };
  }
}
