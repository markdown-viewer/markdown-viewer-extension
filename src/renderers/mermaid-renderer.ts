/**
 * Mermaid Renderer
 * 
 * Renders Mermaid diagrams to PNG images using direct DOM capture.
 * Mermaid library is loaded separately via lib-mermaid.ts and exposed as window.mermaid
 */
import { BaseRenderer } from './base-renderer';
import type { RendererThemeConfig, RenderResult } from '../types/index';
import { applyRoughEffect, type RoughSvgOptions } from './libs/rough-svg';

// Get mermaid from global scope (loaded by lib-mermaid.ts)
type MermaidAPI = {
  initialize: (config: object) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

function getMermaid(): MermaidAPI {
  const mermaid = (window as unknown as { mermaid?: MermaidAPI }).mermaid;
  if (!mermaid) {
    throw new Error('Mermaid library not loaded. Ensure lib-mermaid.js is loaded before render-worker.js');
  }
  return mermaid;
}

export class MermaidRenderer extends BaseRenderer {
  private roughOptions: RoughSvgOptions = {
    roughness: 0.5,
    bowing: 0.5,
  };

  constructor() {
    super('mermaid');
  }

  /**
   * Initialize Mermaid with theme configuration
   * @param themeConfig - Theme configuration
   */
  async initialize(themeConfig: RendererThemeConfig | null = null): Promise<void> {
    // Initialize Mermaid with theme configuration
    this.applyThemeConfig(themeConfig);
    this._initialized = true;
  }

  /**
   * Apply theme configuration to Mermaid
   * This is called on every render to ensure font follows theme changes
   * @param themeConfig - Theme configuration
   */
  applyThemeConfig(themeConfig: RendererThemeConfig | null = null): void {
    // Use theme font or fallback to default
    const fontFamily = themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";
    // Use hand-drawn style only if explicitly set
    const isHandDrawn = themeConfig?.diagramStyle === 'handDrawn';

    getMermaid().initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      look: isHandDrawn ? 'handDrawn' : 'classic',
      themeVariables: {
        fontFamily: fontFamily,
        background: 'transparent'
      },
      flowchart: {
        htmlLabels: true,
        curve: 'basis'
      }
    });
  }

  /**
   * Check if the code is a sequence diagram
   * @param code - Mermaid diagram code
   * @returns true if the code is a sequence diagram
   */
  private isSequenceDiagram(code: string): boolean {
    const trimmed = code.trim().toLowerCase();
    return trimmed.startsWith('sequencediagram');
  }

  /**
   * Check if the diagram type has arrows that need rough processing
   * @param code - Mermaid diagram code
   * @returns true if the diagram has arrows
   */
  private hasArrows(code: string): boolean {
    const trimmed = code.trim().toLowerCase();
    // These diagram types have arrow markers
    return trimmed.startsWith('flowchart') ||
           trimmed.startsWith('graph') ||
           trimmed.startsWith('classdiagram') ||
           trimmed.startsWith('statediagram');
  }

  /**
   * Preprocess Mermaid code to convert \n to <br> for line breaks
   * @param code - Mermaid diagram code
   * @returns Preprocessed code with \n replaced by <br>
   */
  private preprocessCode(code: string): string {
    // Globally replace literal \n with <br> for line breaks in labels
    // This is safe because actual newlines are real line breaks, not \n literals
    return code.replace(/\\n/g, '<br>');
  }

  /**
   * Apply rough.js hand-drawn effect to SVG
   * @param svgString - Original SVG string
   * @param themeConfig - Theme configuration
   * @param markersOnly - Only process markers (arrows), skip other elements
   * @returns SVG with hand-drawn effect
   */
  private applyRoughEffectToSvg(svgString: string, themeConfig: RendererThemeConfig | null, markersOnly = false): string {
    const isHandDrawn = themeConfig?.diagramStyle === 'handDrawn';
    if (!isHandDrawn) return svgString;
    return applyRoughEffect(svgString, { ...this.roughOptions, markersOnly });
  }

  /**
   * Render Mermaid diagram to PNG
   * @param code - Mermaid diagram code
   * @param themeConfig - Theme configuration
   * @returns Render result with base64, width, height, format
   */
  async render(code: string, themeConfig: RendererThemeConfig | null): Promise<RenderResult> {
    // Ensure renderer is initialized
    if (!this._initialized) {
      await this.initialize(themeConfig);
    }

    // Validate input
    this.validateInput(code);

    // Preprocess code to convert \n to <br> in quoted strings
    code = this.preprocessCode(code);

    // Apply theme configuration before each render
    this.applyThemeConfig(themeConfig);

    // Render Mermaid diagram to DOM
    const container = this.createContainer();
    container.style.cssText = 'position: absolute; left: -9999px; top: -9999px; display: inline-block; background: transparent; padding: 0; margin: 0;';

    // Use unique ID with timestamp + random string to support parallel rendering
    const diagramId = 'mermaid-diagram-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const { svg } = await getMermaid().render(diagramId, code);

    // Validate SVG content
    if (!svg || svg.length < 100) {
      throw new Error('Generated SVG is too small or empty');
    }

    if (!svg.includes('<svg') || !svg.includes('</svg>')) {
      throw new Error('Generated content is not valid SVG');
    }

    // Insert SVG into container
    container.innerHTML = svg;

    // Add padding to prevent text clipping
    const svgElement = container.querySelector('svg');
    if (!svgElement) {
      throw new Error('SVG element not found in rendered content');
    }

    // Give layout engine time to process
    container.offsetHeight;
    svgElement.getBoundingClientRect();
    await new Promise(resolve => setTimeout(resolve, 100));

    // Wait for fonts to load
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    // Force another reflow
    container.offsetHeight;
    svgElement.getBoundingClientRect();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get SVG dimensions from viewBox or attributes (not getBoundingClientRect which may be affected by CSS)
    const viewBox = svgElement.getAttribute('viewBox');
    let captureWidth: number, captureHeight: number;

    if (viewBox) {
      const parts = viewBox.split(/\s+/);
      captureWidth = Math.ceil(parseFloat(parts[2]));
      captureHeight = Math.ceil(parseFloat(parts[3]));
    } else {
      captureWidth = Math.ceil(parseFloat(svgElement.getAttribute('width') || '800'));
      captureHeight = Math.ceil(parseFloat(svgElement.getAttribute('height') || '600'));
    }

    // Get font family from theme config
    const fontFamily = themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";

    // Calculate scale for PNG dimensions
    const scale = this.calculateCanvasScale(themeConfig);

    // Apply rough.js hand-drawn effect:
    // - Sequence diagrams: full rough effect (Mermaid's native handDrawn doesn't support them well)
    // - Diagrams with arrows (flowchart, graph, classDiagram, stateDiagram): only process arrow markers
    // - Other diagrams: no processing needed
    let processedSvg = svg;
    if (this.isSequenceDiagram(code)) {
      processedSvg = this.applyRoughEffectToSvg(svg, themeConfig, false);
    } else if (this.hasArrows(code)) {
      processedSvg = this.applyRoughEffectToSvg(svg, themeConfig, true);
    }

    // Render SVG to canvas as PNG
    const canvas = await this.renderSvgToCanvas(processedSvg, captureWidth * scale, captureHeight * scale, fontFamily);

    const pngDataUrl = canvas.toDataURL('image/png', 1.0);
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');

    // Cleanup container
    this.removeContainer(container);

    return {
      base64: base64Data,
      width: canvas.width,
      height: canvas.height,
      format: 'png'
    };
  }
}
