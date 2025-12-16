/**
 * HTML Renderer
 * 
 * Renders HTML code blocks to PNG images using SVG foreignObject
 * Simple and reliable: large canvas + trim whitespace
 */
import { BaseRenderer } from './base-renderer.js';
import { sanitizeHtml, hasHtmlContent } from '../utils/html-sanitizer.js';

export class HtmlRenderer extends BaseRenderer {
  constructor() {
    super('html');
  }

  /**
   * Render HTML to PNG
   * @param {string} input - HTML content to render
   * @param {object} themeConfig - Theme configuration
   * @param {object} extraParams - Extra parameters
   * @returns {Promise<{base64: string, width: number, height: number, format: string}>}
   */
  async render(input, themeConfig, extraParams = {}) {
    this.validateInput(input);
    return await this.renderHtmlToPng(input, themeConfig, extraParams);
  }

  /**
   * Render HTML to PNG using SVG foreignObject
   * Strategy: 
   * 1. Render at high resolution (scale x) from the start
   * 2. Use red outline marker to detect content bounds
   * 3. Remove outline and crop to content bounds
   * @param {string} htmlContent - HTML content to render
   * @param {object} themeConfig - Theme configuration
   * @param {object} extraParams - Extra parameters (width)
   * @returns {Promise<{base64: string, width: number, height: number}>}
   */
  async renderHtmlToPng(htmlContent, themeConfig, extraParams = {}) {
    // Sanitize HTML before rendering
    const sanitizedHtml = sanitizeHtml(htmlContent);
    
    // Check if there's any visible content after sanitization
    if (!hasHtmlContent(sanitizedHtml)) {
      return null;
    }

    const fontFamily = themeConfig?.fontFamily || "'SimSun', 'Times New Roman', Times, serif";
    const scale = this.calculateCanvasScale(themeConfig);
    
    const svgNS = 'http://www.w3.org/2000/svg';
    // Use large canvas, scaled up for high resolution
    const bigWidth = 2000 * scale;
    const bigHeight = 2000 * scale;
    
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('width', bigWidth);
    svg.setAttribute('height', bigHeight);
    
    const fo = document.createElementNS(svgNS, 'foreignObject');
    fo.setAttribute('width', bigWidth);
    fo.setAttribute('height', bigHeight);
    
    // Wrapper with red outline markers (outline is outside element, doesn't affect layout)
    // Apply scale via CSS transform for high-res rendering
    const wrapper = document.createElement('div');
    wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrapper.style.cssText = `display: inline-block; outline: 1px solid #ff0000; outline-offset: 0; transform: scale(${scale}); transform-origin: top left;`;
    
    const container = document.createElement('div');
    container.style.cssText = `display: inline-block; font-family: ${fontFamily};`;
    container.innerHTML = sanitizedHtml;
    
    wrapper.appendChild(container);
    fo.appendChild(wrapper);
    svg.appendChild(fo);
    
    // Serialize to data URL
    const svgString = new XMLSerializer().serializeToString(svg);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
    
    // Load image at high resolution
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.naturalWidth;
    tempCanvas.height = img.naturalHeight;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    tempCtx.drawImage(img, 0, 0);
    
    const w = tempCanvas.width;
    const h = tempCanvas.height;
    
    // Only scan first row (y=0) to find right edge - red outline is a vertical line
    const firstRow = tempCtx.getImageData(0, 0, w, 1).data;
    let rightEdge = 1;
    for (let x = w - 1; x >= 0; x--) {
      const idx = x * 4;
      // Red: R > 200, G < 50, B < 50
      if (firstRow[idx] > 200 && firstRow[idx + 1] < 50 && firstRow[idx + 2] < 50) {
        rightEdge = x;
        break;
      }
    }
    
    // Only scan first column (x=0) to find bottom edge - red outline is a horizontal line
    const firstCol = tempCtx.getImageData(0, 0, 1, h).data;
    let bottomEdge = 1;
    for (let y = h - 1; y >= 0; y--) {
      const idx = y * 4;
      if (firstCol[idx] > 200 && firstCol[idx + 1] < 50 && firstCol[idx + 2] < 50) {
        bottomEdge = y;
        break;
      }
    }
    
    // Outline is 1px, scaled to ~scale px. Subtract outline width to get content only.
    const outlineWidth = Math.ceil(scale);
    const contentWidth = Math.max(1, rightEdge - outlineWidth);
    const contentHeight = Math.max(1, bottomEdge - outlineWidth);
    
    // Crop directly without re-rendering (outline is outside content area)
    const canvas = document.createElement('canvas');
    canvas.width = contentWidth;
    canvas.height = contentHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(tempCanvas, 0, 0, contentWidth, contentHeight, 0, 0, contentWidth, contentHeight);
    
    const base64Data = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

    return {
      base64: base64Data,
      width: canvas.width,
      height: canvas.height
    };
  }
}
