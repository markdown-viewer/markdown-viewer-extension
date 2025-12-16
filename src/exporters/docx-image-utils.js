// DOCX Image Utilities
// Functions for handling images in DOCX export

import {
  Paragraph,
  TextRun,
  ImageRun,
  AlignmentType,
} from 'docx';

/**
 * Calculate appropriate image dimensions for DOCX to fit within page constraints
 * Maximum width: 6 inches (page width with 1 inch margins on letter size)
 * Maximum height: 9.5 inches (page height with 1 inch margins on letter size)
 * @param {number} originalWidth - Original image width in pixels
 * @param {number} originalHeight - Original image height in pixels
 * @returns {Object} - {width: number, height: number} in pixels
 */
export function calculateImageDimensions(originalWidth, originalHeight) {
  const maxWidthInches = 6;    // 8.5 - 1 - 1 = 6.5, use 6 for safety
  const maxHeightInches = 9.5; // 11 - 1 - 1 = 9, use 9.5 to maximize vertical space
  const maxWidthPixels = maxWidthInches * 96;  // 96 DPI = 576 pixels
  const maxHeightPixels = maxHeightInches * 96; // 96 DPI = 912 pixels

  // If image is smaller than both max width and height, use original size
  if (originalWidth <= maxWidthPixels && originalHeight <= maxHeightPixels) {
    return { width: originalWidth, height: originalHeight };
  }

  // Calculate scaling ratios for both dimensions
  const widthRatio = maxWidthPixels / originalWidth;
  const heightRatio = maxHeightPixels / originalHeight;

  // Use the smaller ratio to ensure the image fits within both constraints
  const ratio = Math.min(widthRatio, heightRatio);

  return {
    width: Math.round(originalWidth * ratio),
    height: Math.round(originalHeight * ratio)
  };
}

/**
 * Convert unified plugin render result to DOCX elements
 * @param {object} renderResult - Unified render result from plugin.renderToCommon()
 * @param {string} pluginType - Plugin type for alt text
 * @returns {object} DOCX Paragraph or ImageRun
 */
export function convertPluginResultToDOCX(renderResult, pluginType = 'diagram') {
  if (renderResult.type === 'empty') {
    return new Paragraph({
      children: [],
    });
  }

  if (renderResult.type === 'error') {
    const inline = renderResult.display.inline;
    if (inline) {
      return new TextRun({
        text: renderResult.content.text,
        italics: true,
        color: 'FF0000',
      });
    }
    return new Paragraph({
      children: [
        new TextRun({
          text: renderResult.content.text,
          italics: true,
          color: 'FF0000',
        }),
      ],
      alignment: AlignmentType.LEFT,
      spacing: { before: 240, after: 240 },
    });
  }

  if (renderResult.type === 'image') {
    const { data, width, height } = renderResult.content;
    const { inline, alignment } = renderResult.display;

    // Calculate display size (1/4 of original PNG size)
    const scaledWidth = Math.round(width / 4);
    const scaledHeight = Math.round(height / 4);

    // Apply max-width and max-height constraints
    const { width: displayWidth, height: displayHeight } = calculateImageDimensions(scaledWidth, scaledHeight);

    const imageRun = new ImageRun({
      data: data,
      transformation: {
        width: displayWidth,
        height: displayHeight,
      },
      type: 'png',
      altText: {
        title: `${pluginType} Image`,
        description: `${pluginType} image`,
        name: `${pluginType}-image`,
      },
    });

    // Return ImageRun directly for inline, or wrapped in Paragraph for block
    if (inline) {
      return imageRun;
    }

    const alignmentMap = {
      'center': AlignmentType.CENTER,
      'right': AlignmentType.RIGHT,
      'left': AlignmentType.LEFT
    };

    return new Paragraph({
      children: [imageRun],
      alignment: alignmentMap[alignment] || AlignmentType.CENTER,
      spacing: { before: 240, after: 240 },
    });
  }

  // Fallback for unknown types
  return new Paragraph({
    children: [],
  });
}

/**
 * Get image dimensions from buffer
 * @param {Uint8Array} buffer - Image buffer
 * @param {string} contentType - Image content type
 * @returns {Promise<{width: number, height: number}>}
 */
export async function getImageDimensions(buffer, contentType) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: contentType });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

/**
 * Determine image type from content type or URL
 * @param {string} contentType - Image content type
 * @param {string} url - Image URL
 * @returns {string} Image type for docx
 */
export function determineImageType(contentType, url) {
  let imageType = 'png'; // default
  
  if (contentType) {
    if (contentType.includes('jpeg') || contentType.includes('jpg')) {
      imageType = 'jpg';
    } else if (contentType.includes('png')) {
      imageType = 'png';
    } else if (contentType.includes('gif')) {
      imageType = 'gif';
    } else if (contentType.includes('bmp')) {
      imageType = 'bmp';
    }
  } else if (url) {
    // Fallback: determine from URL extension
    const ext = url.toLowerCase().split('.').pop().split('?')[0];
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(ext)) {
      imageType = ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  
  return imageType;
}
