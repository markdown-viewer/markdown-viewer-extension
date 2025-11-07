// Offscreen document script for rendering
import mermaid from 'mermaid';

// Add error listeners for debugging
window.addEventListener('error', (event) => {
  chrome.runtime.sendMessage({
    type: 'offscreenError',
    error: event.error?.message || 'Unknown error',
    filename: event.filename,
    lineno: event.lineno
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', (event) => {
  chrome.runtime.sendMessage({
    type: 'offscreenError',
    error: `Unhandled promise rejection: ${event.reason}`,
    filename: 'Promise',
    lineno: 0
  }).catch(() => {});
});

// Optimize canvas performance on page load
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('png-canvas');
  if (canvas) {
    // Pre-initialize context with willReadFrequently for better performance
    canvas.getContext('2d', { willReadFrequently: true });
  }
  
  // Send ready signal when DOM is loaded
  chrome.runtime.sendMessage({
    type: 'offscreenDOMReady'
  }).catch(() => {});
});

// Import Mermaid dynamically to handle potential import issues
async function initializeMermaid() {
  try {
    mermaid.initialize({ 
      startOnLoad: false,
      securityLevel: 'loose',
      lineHeight: 1.6,
      themeVariables: {
        fontSize: '14px',
        fontFamily: "'SimSun', 'Times New Roman', Times, serif"
      },
      flowchart: {
        htmlLabels: true,
        curve: 'basis'
      }
    });
    
    return true;
  } catch (error) {
    return false;
  }
}

// Initialize Mermaid when script loads
let mermaidReady = false;
initializeMermaid().then(success => {
  mermaidReady = success;
  
  // Notify background script that offscreen document is ready
  chrome.runtime.sendMessage({
    type: 'offscreenReady',
    mermaidReady: mermaidReady
  }).catch(() => {
    // Ignore errors if background script isn't ready
  });
});

// Message handler for rendering requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'renderMermaid') {
    renderMermaidToPng(message.mermaid).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ error: error.message });
    });
    return true; // Keep the message channel open for async response
  } else if (message.type === 'renderHtml') {
    renderHtmlToPng(message.html, message.width).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ error: error.message });
    });
    return true;
  } else if (message.type === 'renderSvg') {
    renderSvgToPng(message.svg).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ error: error.message });
    });
    return true;
  }
});

// Render Mermaid to PNG
async function renderMermaidToPng(code) {
  try {
    if (!mermaidReady || !mermaid) {
      const initSuccess = await initializeMermaid();
      if (!initSuccess || !mermaid) {
        throw new Error('Mermaid initialization failed. Library may not be loaded correctly.');
      }
      mermaidReady = true;
    }
    
    if (!code || code.trim() === '') {
      throw new Error('Empty Mermaid code provided');
    }
    
    const { svg } = await mermaid.render('mermaid-diagram-' + Date.now(), code);
    
    // Pre-process SVG to prevent text clipping before conversion
    const processedSvg = preventTextClipping(svg);
        
    // Validate SVG content
    if (!processedSvg || processedSvg.length < 100) {
      throw new Error('Generated SVG is too small or empty');
    }
    
    if (!processedSvg.includes('<svg') || !processedSvg.includes('</svg>')) {
      throw new Error('Generated content is not valid SVG');
    }
    
    const result = await renderSvgToPng(processedSvg);
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

// Render HTML to PNG
async function renderHtmlToPng(htmlContent, targetWidth = 1200) {
  try {
    if (typeof html2canvas === 'undefined') {
      throw new Error('html2canvas not loaded');
    }
    
    const container = document.getElementById('html-container');
    container.style.cssText = `display: block; position: relative; background: white; padding: 0; margin: 0; width: ${targetWidth}px;`;
    container.innerHTML = htmlContent;
    
    // Wait for rendering
    container.offsetHeight; // Force reflow
    
    // Use html2canvas to capture
    const canvas = await html2canvas(container, {
      backgroundColor: '#ffffff',
      scale: 2,
      logging: false,
      useCORS: true,
      allowTaint: true,
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
    container.style.cssText = 'display: block;';
    
    return { base64: base64Data };
  } catch (error) {
    // Cleanup on error
    const container = document.getElementById('html-container');
    container.innerHTML = '';
    return { error: error.message };
  }
}

// Render SVG to PNG
async function renderSvgToPng(svgContent) {
  try {
    const container = document.getElementById('svg-container');
    container.innerHTML = svgContent;
    
    const svgEl = container.querySelector('svg');
    if (!svgEl) {
      throw new Error('No SVG element found');
    }

    // Critical fix: Add more robust waiting for layout completion
    // Force multiple reflows to ensure layout is stable
    container.offsetHeight;
    svgEl.getBoundingClientRect();
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Wait for fonts to load if needed
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
    
    // Force another reflow after font loading
    container.offsetHeight;
    svgEl.getBoundingClientRect();
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Get dimensions
    const viewBox = svgEl.getAttribute('viewBox');
    let width, height;
    
    if (viewBox) {
      const parts = viewBox.split(/\s+/);
      width = Math.ceil(parseFloat(parts[2]));
      height = Math.ceil(parseFloat(parts[3]));
    } else {
      width = Math.ceil(parseFloat(svgEl.getAttribute('width')) || 800);
      height = Math.ceil(parseFloat(svgEl.getAttribute('height')) || 600);
    }
    
    // Create canvas
    const canvas = document.getElementById('png-canvas');
    const scale = 4;
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.scale(scale, scale);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    
    // Convert SVG to image
    const svgString = new XMLSerializer().serializeToString(svgEl);
    
    // Use blob URL instead of data URL for large SVGs to avoid length limits
    let imgSrc;
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    
    if (svgString.length > 500000) { // 500KB threshold
      imgSrc = URL.createObjectURL(svgBlob);
    } else {
      const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
      imgSrc = dataUrl;
    }
    
    const img = new Image();
    await new Promise((resolve, reject) => {
      // Add timeout to handle hanging image loads
      const timeout = setTimeout(() => {
        reject(new Error('Image loading timeout'));
      }, 10000); // 10 second timeout
      
      img.onload = () => {
        clearTimeout(timeout);
        // Cleanup blob URL if used
        if (imgSrc.startsWith('blob:')) {
          URL.revokeObjectURL(imgSrc);
        }
        resolve();
      };
      img.onerror = (error) => {
        clearTimeout(timeout);
        
        // Cleanup blob URL if used
        if (imgSrc.startsWith('blob:')) {
          URL.revokeObjectURL(imgSrc);
        }
        reject(new Error(`Image loading failed: ${error.message || 'Unknown error'}`));
      };
      img.src = imgSrc;
    });

    // Validate image dimensions before drawing
    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      throw new Error('Invalid image dimensions: ' + img.naturalWidth + 'x' + img.naturalHeight);
    }
    
    ctx.drawImage(img, 0, 0, width, height);
    
    // Enhanced content verification with pixel sampling
    const sampleRegions = [
      { name: 'top-left', x: 0, y: 0, size: Math.min(width, height, 100) },
      { name: 'center', x: Math.floor(width/2) - 50, y: Math.floor(height/2) - 50, size: 100 },
      { name: 'bottom-right', x: Math.max(0, width - 100), y: Math.max(0, height - 100), size: 100 }
    ];
    
    let totalNonWhitePixels = 0;
    let totalSampledPixels = 0;
    
    sampleRegions.forEach(region => {
      const startX = Math.max(0, region.x);
      const startY = Math.max(0, region.y);
      const endX = Math.min(width, startX + region.size);
      const endY = Math.min(height, startY + region.size);
      const regionWidth = endX - startX;
      const regionHeight = endY - startY;
      
      if (regionWidth > 0 && regionHeight > 0) {
        const imageData = ctx.getImageData(startX * scale, startY * scale, regionWidth * scale, regionHeight * scale);
        let regionNonWhite = 0;
        let regionTotal = 0;
        
        for (let i = 0; i < imageData.data.length; i += 4) {
          const r = imageData.data[i];
          const g = imageData.data[i + 1];
          const b = imageData.data[i + 2];
          const alpha = imageData.data[i + 3];
          
          // Skip transparent pixels
          if (alpha < 10) continue;
          
          regionTotal++;
          totalSampledPixels++;
          
          // Check if pixel is not white/near-white
          if (r < 240 || g < 240 || b < 240) {
            regionNonWhite++;
            totalNonWhitePixels++;
          }
        }
      }
    });
        
    const pngDataUrl = canvas.toDataURL('image/png', 1.0);
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');
    
    // Cleanup
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    container.innerHTML = '';
    
    return { base64: base64Data };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Prevent text clipping in SVG by modifying styles and dimensions
 */
function preventTextClipping(svgContent) {
  const antiClippingStyles = `
      /* The key fix: prevent foreignObject from clipping text */
      foreignObject {
        overflow: visible !important;
      }
  `;
  
  // Insert styles inside the existing <style> tag or create new one
  if (svgContent.includes('</style>')) {
    svgContent = svgContent.replace('</style>', antiClippingStyles + '</style>');
  } else if (svgContent.includes('<svg')) {
    svgContent = svgContent.replace('>', '><style>' + antiClippingStyles + '</style>');
  }
  
  return svgContent;
}

// Signal that the offscreen document is ready
chrome.runtime.sendMessage({ type: 'offscreenReady' }).then(() => {
}).catch(error => {
});