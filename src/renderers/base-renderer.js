/**
 * Base Renderer for diagrams and charts
 * 
 * Each renderer handles one diagram type (mermaid, vega, html, svg, etc.)
 * Renderer instances are shared, so container management must be stateless
 */
export class BaseRenderer {
  /**
   * @param {string} type - Render type identifier (e.g., 'mermaid', 'vega')
   */
  constructor(type) {
    this.type = type;
    this._initialized = false;
  }

  /**
   * Create a new render container element for this render
   * Each render gets its own container to support parallel rendering
   * Caller is responsible for calling removeContainer() after use
   * @returns {HTMLElement} New render container element
   */
  createContainer() {
    const container = document.createElement('div');
    container.id = 'render-container-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    container.style.cssText = 'position: absolute; left: -9999px; top: -9999px;';
    document.body.appendChild(container);
    return container;
  }

  /**
   * Remove a render container from DOM
   * @param {HTMLElement} container - Container to remove
   */
  removeContainer(container) {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }

  /**
   * Initialize renderer (load dependencies, setup environment)
   * Called once before first render
   * Subclasses can override to perform async initialization
   * @param {object} themeConfig - Theme configuration
   * @returns {Promise<void>}
   */
  async initialize(themeConfig = null) {
    this._initialized = true;
  }

  /**
   * Check if renderer is initialized
   * @returns {boolean} True if initialized
   */
  isInitialized() {
    return this._initialized;
  }

  /**
   * Main render method - must be implemented by subclasses
   * @param {string|object} input - Input data for rendering
   * @param {object} themeConfig - Theme configuration
   * @param {object} extraParams - Additional type-specific parameters
   * @param {string} extraParams.outputFormat - Output format: 'png' (default) or 'svg'
   * @returns {Promise<{base64?: string, svg?: string, width: number, height: number, format: string}>}
   */
  async render(input, themeConfig, extraParams = {}) {
    throw new Error('render() must be implemented by subclass');
  }

  /**
   * Validate input data
   * @param {any} input - Input to validate
   * @throws {Error} If input is invalid
   */
  validateInput(input) {
    if (!input || (typeof input === 'string' && input.trim() === '')) {
      throw new Error(`Empty ${this.type} input provided`);
    }
  }

  /**
   * Preprocess input before rendering (can be overridden)
   * @param {any} input - Raw input
   * @param {object} extraParams - Extra parameters
   * @returns {any} Processed input
   */
  preprocessInput(input, extraParams) {
    return input;
  }

  /**
   * Calculate scale for canvas rendering
   * This is used by renderers that render to canvas
   * PNG size will be divided by 4 in DOCX, so we multiply by 4 here
   * Formula: (14/16) * (themeFontSize/12) * 4
   * @param {object} themeConfig - Theme configuration
   * @returns {number} Scale factor for canvas
   */
  calculateCanvasScale(themeConfig) {
    const baseFontSize = 12;
    const themeFontSize = themeConfig?.fontSize || baseFontSize;
    return (14.0 / 16.0) * (themeFontSize / baseFontSize) * 4.0;
  }

  /**
   * Render SVG directly to canvas
   * @param {string} svgContent - SVG content string
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @param {string} fontFamily - Optional font family to set on canvas
   * @returns {Promise<HTMLCanvasElement>} Canvas element
   */
  async renderSvgToCanvas(svgContent, width, height, fontFamily = null) {
    // Log SVG content for debugging
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: 'RENDER_FRAME_LOG',
        args: ['[BaseRenderer] SVG first 800 chars:', svgContent.substring(0, 800)]
      }, '*');
    }
    
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
        
        // Set font on canvas context if provided
        if (fontFamily) {
          ctx.font = `14px ${fontFamily}`;
        }
        
        ctx.fillStyle = 'white'; // Default background
        ctx.fillRect(0, 0, width, height); // Fill background
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas);
      };

      img.onerror = (e) => {
        reject(new Error('Failed to load SVG into image for rendering'));
      };
    });
  }
}
