/**
 * Mermaid Renderer
 * 
 * Renders Mermaid diagrams to PNG images using direct DOM capture
 */
import { BaseRenderer } from './base-renderer.js';
import mermaid from 'mermaid';

export class MermaidRenderer extends BaseRenderer {
  constructor() {
    super('mermaid');
  }

  /**
   * Initialize Mermaid with theme configuration
   * @param {object} themeConfig - Theme configuration
   * @returns {Promise<void>}
   */
  async initialize(themeConfig = null) {
    // Initialize Mermaid with theme configuration
    this.applyThemeConfig(themeConfig);
    this._initialized = true;
  }

  /**
   * Apply theme configuration to Mermaid
   * This is called on every render to ensure font follows theme changes
   * @param {object} themeConfig - Theme configuration
   */
  applyThemeConfig(themeConfig = null) {
    // Use theme font or fallback to default
    const fontFamily = themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      lineHeight: 1.6,
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
   * Override render to support both SVG and PNG output
   * @param {string} code - Mermaid diagram code
   * @param {object} themeConfig - Theme configuration
   * @param {object} extraParams - Extra parameters
   * @param {string} extraParams.outputFormat - 'svg' or 'png' (default: 'png')
   * @returns {Promise<{base64?: string, svg?: string, width: number, height: number, format: string}>}
   */
  async render(code, themeConfig, extraParams = {}) {
    const outputFormat = extraParams.outputFormat || 'png';
    
    // Ensure renderer is initialized
    if (!this._initialized) {
      await this.initialize(themeConfig);
    }

    // Validate input
    this.validateInput(code);

    // Apply theme configuration before each render
    this.applyThemeConfig(themeConfig);

    // Render Mermaid diagram to DOM
    const container = this.createContainer();
    container.style.cssText = 'position: absolute; left: -9999px; top: -9999px; display: inline-block; background: transparent; padding: 0; margin: 0;';

    // Use unique ID with timestamp + random string to support parallel rendering
    const diagramId = 'mermaid-diagram-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const { svg } = await mermaid.render(diagramId, code);

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

    // Fix foreignObject overflow to prevent text clipping
    const foreignObjects = svgElement.querySelectorAll('foreignObject');
    foreignObjects.forEach(fo => {
      fo.style.overflowX = 'visible';
      fo.style.overflowY = 'visible';
    });

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
    let captureWidth, captureHeight;

    if (viewBox) {
      const parts = viewBox.split(/\s+/);
      captureWidth = Math.ceil(parseFloat(parts[2]));
      captureHeight = Math.ceil(parseFloat(parts[3]));
    } else {
      captureWidth = Math.ceil(parseFloat(svgElement.getAttribute('width')) || 800);
      captureHeight = Math.ceil(parseFloat(svgElement.getAttribute('height')) || 600);
    }

    // Get font family from theme config
    const fontFamily = themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";

    // Inject font style into SVG
    const styledSvg = this.injectFontStyleToSvg(svg, fontFamily);

    // Calculate scale (same as PNG for consistent dimensions)
    const scale = this.calculateCanvasScale(themeConfig);

    // If SVG format requested, return SVG string directly
    if (outputFormat === 'svg') {
      // Cleanup container
      this.removeContainer(container);

      // Return scaled dimensions (same as PNG for consistent display)
      return {
        svg: styledSvg,
        width: Math.round(captureWidth * scale),
        height: Math.round(captureHeight * scale),
        format: 'svg'
      };
    }

    // PNG format: render SVG to canvas

    // Render SVG directly to canvas with font family
    const canvas = await this.renderSvgToCanvas(styledSvg, captureWidth * scale, captureHeight * scale, fontFamily);

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

  /**
   * Inject font style into SVG content
   * @param {string} svgContent - Original SVG content
   * @param {string} fontFamily - Font family to inject
   * @returns {string} SVG with injected font style
   */
  injectFontStyleToSvg(svgContent, fontFamily) {
    // Create a style element with font-family for SVG internal elements only
    // Use :scope to limit styles to SVG content and avoid affecting page elements
    const styleContent = `
      <style>
        :root, :host, svg * { font-family: ${fontFamily} !important; }
        text { font-family: ${fontFamily} !important; }
        foreignObject { font-family: ${fontFamily} !important; }
        foreignObject * { font-family: ${fontFamily} !important; }
        .node { font-family: ${fontFamily} !important; }
        .label { font-family: ${fontFamily} !important; }
        .edgeLabel { font-family: ${fontFamily} !important; }
        foreignObject span { font-family: ${fontFamily} !important; }
        foreignObject div { font-family: ${fontFamily} !important; }
        foreignObject p { font-family: ${fontFamily} !important; }
      </style>
    `;

    // Insert style after opening svg tag
    return svgContent.replace(/(<svg[^>]*>)/, `$1${styleContent}`);
  }
}
