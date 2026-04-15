/**
 * Infographic Renderer
 * 
 * Renders AntV Infographic syntax to PNG images using SVG output
 * Similar to DOT renderer, uses the library's SVG output capability
 */
import { BaseRenderer } from './base-renderer';
import { Infographic, setDefaultFont } from '@antv/infographic';
import type { RendererThemeConfig, RenderResult } from '../types/index';

// Default font stack for Infographic diagrams
const DEFAULT_FONT_FAMILY = "'SimSun', 'Times New Roman', Times, serif";

export class InfographicRenderer extends BaseRenderer {

  constructor() {
    super('infographic');
  }

  /**
   * Initialize the renderer
   * @param themeConfig - Theme configuration
   */
  async initialize(themeConfig: RendererThemeConfig | null = null): Promise<void> {
    this._initialized = true;
  }

  /**
   * Apply theme configuration to Infographic
   * @param themeConfig - Theme configuration
   */
  applyThemeConfig(themeConfig: RendererThemeConfig | null = null): void {
    const fontFamily = themeConfig?.fontFamily || DEFAULT_FONT_FAMILY;
    setDefaultFont(fontFamily);
  }

  /**
   * Render Infographic syntax to PNG
   * @param code - Infographic syntax code
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, width, height, format
   */
  async render(code: string, themeConfig: RendererThemeConfig | null): Promise<RenderResult> {
    // Ensure renderer is initialized
    if (!this._initialized) {
      await this.initialize(themeConfig);
    }

    // Apply theme config on every render to ensure font follows theme changes
    this.applyThemeConfig(themeConfig);

    // Validate input
    this.validateInput(code);

    // Create a temporary container
    const container = this.createContainer();
    
    // Check if hand-drawn style should be applied
    const isHandDrawn = themeConfig?.diagramStyle === 'handDrawn';
    
    try {
      // Build Infographic options
      const infographicOptions: {
        container: HTMLElement;
        width: number;
        height: number;
        padding: number;
        themeConfig?: {
          stylize: {
            type: 'rough';
            roughness: number;
            bowing: number;
          };
        };
      } = {
        container: container,
        width: 900,
        height: 600,
        padding: 24,
      };

      // Add rough stylize config for hand-drawn style
      if (isHandDrawn) {
        infographicOptions.themeConfig = {
          stylize: {
            type: 'rough',
            roughness: 0.5,
            bowing: 0.5,
          },
        };
      }

      // Create Infographic instance
      const infographic = new Infographic(infographicOptions);

      // Wait for rendering to complete using the 'rendered' event
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Infographic render timeout after 10s'));
        }, 10000);

        infographic.on('rendered', () => {
          clearTimeout(timeout);
          resolve();
        });
        infographic.on('error', (err: unknown) => {
          clearTimeout(timeout);
          let errorMessage: string;
          
          // Handle array of parse errors from Infographic
          if (Array.isArray(err)) {
            const parseErrors = err.map((e: { message?: string; raw?: string; line?: number }) => 
              `Line ${e.line || '?'}: ${e.message || 'Unknown error'}${e.raw ? ` (${e.raw})` : ''}`
            ).join('\n');
            errorMessage = `Syntax error:\n${parseErrors}\n\nExpected format:\ninfographic <template-name>\ndata\n  title Your Title\n  items\n    - label Item 1\n    - label Item 2`;
          } else if (err instanceof Error) {
            errorMessage = err.message;
          } else if (typeof err === 'string') {
            errorMessage = err;
          } else {
            errorMessage = JSON.stringify(err);
          }
          
          console.error('[Infographic] Render error:', err);
          reject(new Error(errorMessage));
        });

        // Render the syntax
        try {
          infographic.render(code);
        } catch (e) {
          clearTimeout(timeout);
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.error('[Infographic] Sync render error:', e);
          reject(new Error(`Infographic render failed: ${errorMessage}`));
        }
      });

      // Get SVG data URL with embedded resources
      const svgDataUrl = await infographic.toDataURL({ type: 'svg', embedResources: true });

      // Extract SVG content from data URL
      const svgContent = decodeURIComponent(svgDataUrl.replace('data:image/svg+xml;charset=utf-8,', ''));

      // Parse SVG to get dimensions
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
      const svgElement = svgDoc.documentElement;

      // Get dimensions from SVG
      let captureWidth: number, captureHeight: number;
      const viewBox = svgElement.getAttribute('viewBox');
      
      if (viewBox) {
        const parts = viewBox.split(/\s+/);
        captureWidth = Math.ceil(parseFloat(parts[2]));
        captureHeight = Math.ceil(parseFloat(parts[3]));
      } else {
        captureWidth = Math.ceil(parseFloat(svgElement.getAttribute('width') || '900'));
        captureHeight = Math.ceil(parseFloat(svgElement.getAttribute('height') || '600'));
      }

      // Calculate scale for PNG dimensions
      const scale = this.calculateCanvasScale(themeConfig);

      // Render SVG to canvas as PNG
      const canvas = await this.renderSvgToCanvas(
        svgContent, 
        captureWidth * scale, 
        captureHeight * scale
      );

      const pngDataUrl = canvas.toDataURL('image/png', 1.0);
      const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');

      // Cleanup
      infographic.destroy();

      return {
        base64: base64Data,
        width: canvas.width,
        height: canvas.height,
        format: 'png',
        svg: svgContent
      };
    } finally {
      // Always remove the container
      this.removeContainer(container);
    }
  }
}
