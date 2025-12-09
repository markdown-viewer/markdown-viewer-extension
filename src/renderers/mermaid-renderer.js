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
   * Render SVG directly to canvas as fallback
   * @param {string} svgContent - SVG content string
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @returns {Promise<HTMLCanvasElement>} Canvas element
   */
  async renderSvgToCanvas(svgContent, width, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';

      // Convert SVG to base64
      const base64Svg = btoa(unescape(encodeURIComponent(svgContent)));
      img.src = `data:image/svg+xml;base64,${base64Svg}`;

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white'; // Default background
        ctx.fillRect(0, 0, width, height); // Fill background
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas);
      };

      img.onerror = (e) => {
        reject(new Error('Failed to load SVG into image for fallback rendering'));
      };
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

    // Capture using html2canvas with timeout
    if (typeof html2canvas === 'undefined') {
      throw new Error('html2canvas not loaded');
    }

    let canvas;

    try {
      // Create a promise that rejects after timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('html2canvas timeout')), 3000); // 3s timeout
      });

      const html2canvasPromise = html2canvas(container, {
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

      // Race between html2canvas and timeout
      canvas = await Promise.race([html2canvasPromise, timeoutPromise]);

    } catch (error) {
      console.warn('html2canvas failed or timed out, falling back to SVG rendering:', error);

      // Fallback: Render SVG directly to canvas
      // Note: We need to use the computed style of the SVG element from the DOM
      // to capture any CSS styles applied by Mermaid

      // For the fallback, we use the original SVG string we generated
      // But we might need to modify it to include styles if they were external?
      // Mermaid puts styles in a <style> tag inside the SVG usually.

      canvas = await this.renderSvgToCanvas(svg, captureWidth * scale, captureHeight * scale);
    }

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
