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
   * Override render to use direct DOM capture instead of SVG pipeline
   * @param {string} code - Mermaid diagram code
   * @param {object} themeConfig - Theme configuration
   * @param {object} extraParams - Extra parameters
   * @returns {Promise<{base64: string, width: number, height: number}>}
   */
  async render(code, themeConfig, extraParams = {}) {
    // Ensure renderer is initialized
    if (!this._initialized) {
      await this.initialize(themeConfig);
    }
    
    // Validate input
    this.validateInput(code);
    
    // Apply theme configuration before each render
    this.applyThemeConfig(themeConfig);
    
    // Render Mermaid diagram to DOM
    const container = this.getContainer();
    container.innerHTML = '';
    container.style.cssText = 'display: inline-block; background: transparent; padding: 0; margin: 0;';
    
    const { svg } = await mermaid.render('mermaid-diagram-' + Date.now(), code);
    
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
    
    // Set container size to match SVG intrinsic size
    container.style.width = `${captureWidth}px`;
    container.style.height = `${captureHeight}px`;
    
    // Calculate scale
    const scale = this.calculateCanvasScale(themeConfig);
    
    // Capture using html2canvas
    if (typeof html2canvas === 'undefined') {
      throw new Error('html2canvas not loaded');
    }
    
    const canvas = await html2canvas(container, {
      backgroundColor: null,
      scale: scale,
      logging: false,
      useCORS: true,
      allowTaint: true,
      width: captureWidth,
      height: captureHeight,
      windowWidth: captureWidth,
      windowHeight: captureHeight,
      x: 0,
      y: 0,
      scrollX: 0,
      scrollY: 0,
      onclone: (clonedDoc, element) => {
        // Set willReadFrequently for better performance
        const canvases = clonedDoc.getElementsByTagName('canvas');
        for (let canvas of canvases) {
          if (canvas.getContext) {
            canvas.getContext('2d', { willReadFrequently: true });
          }
        }
      }
    });
    
    const pngDataUrl = canvas.toDataURL('image/png', 1.0);
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');
    
    // Cleanup
    container.innerHTML = '';
    container.style.cssText = 'display: block; background: transparent;';
    
    return {
      base64: base64Data,
      width: canvas.width,
      height: canvas.height
    };
  }
}
