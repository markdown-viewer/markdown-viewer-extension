// Theme to CSS Converter
// Converts theme configuration to CSS styles

import themeManager from './theme-manager.js';
import { fetchJSON } from './fetch-utils.js';

/**
 * Get platform instance from global scope
 * Platform is set by each platform's index.js before using shared modules
 */
function getPlatform() {
  return globalThis.platform;
}

/**
 * Convert theme configuration to CSS
 * @param {Object} theme - Theme configuration object
 * @param {Object} tableStyle - Table style configuration
 * @param {Object} codeTheme - Code highlighting theme
 * @param {Object} spacingScheme - Spacing scheme configuration
 * @returns {string} CSS string
 */
export function themeToCSS(theme, tableStyle, codeTheme, spacingScheme) {
  const css = [];

  // Font scheme
  css.push(generateFontCSS(theme.fontScheme));

  // Table style
  css.push(generateTableCSS(tableStyle));

  // Code highlighting
  css.push(generateCodeCSS(theme.fontScheme.code, codeTheme));

  // Spacing (pass body font size for ratio calculation)
  css.push(generateSpacingCSS(spacingScheme, theme.fontScheme.body.fontSize));

  return css.join('\n\n');
}

/**
 * Generate font-related CSS
 * @param {Object} fontScheme - Font scheme configuration
 * @returns {string} CSS string
 */
function generateFontCSS(fontScheme) {
  const css = [];

  // Body font
  const bodyFontFamily = themeManager.buildFontFamily(fontScheme.body.fontFamily);
  const bodyFontSize = themeManager.ptToPx(fontScheme.body.fontSize);
  const bodyLineHeight = fontScheme.body.lineHeight;

  css.push(`#markdown-content {
  font-family: ${bodyFontFamily};
  font-size: ${bodyFontSize};
  line-height: ${bodyLineHeight};
}`);

  // KaTeX math expressions - use body font size
  css.push(`.katex {
  font-size: ${bodyFontSize};
}`);

  // Headings
  const headings = fontScheme.headings;
  Object.keys(headings).forEach((level) => {
    const heading = headings[level];
    // Inherit font from body if not specified
    const fontFamily = themeManager.buildFontFamily(heading.fontFamily || fontScheme.body.fontFamily);
    const fontSize = themeManager.ptToPx(heading.fontSize);
    const fontWeight = heading.fontWeight || 'normal';
    const alignment = heading.alignment || 'left';

    const styles = [
      `  font-family: ${fontFamily};`,
      `  font-size: ${fontSize};`,
      `  font-weight: ${fontWeight};`
    ];

    if (alignment !== 'left') {
      styles.push(`  text-align: ${alignment};`);
    }

    if (heading.spacing) {
      if (heading.spacing.before && heading.spacing.before !== '0pt') {
        styles.push(`  margin-top: ${themeManager.ptToPx(heading.spacing.before)};`);
      }
      if (heading.spacing.after) {
        styles.push(`  margin-bottom: ${themeManager.ptToPx(heading.spacing.after)};`);
      }
    }

    css.push(`#markdown-content ${level} {
${styles.join('\n')}
}`);
  });

  // Code font
  const codeFontFamily = themeManager.buildFontFamily(fontScheme.code.fontFamily);
  const codeFontSize = themeManager.ptToPx(fontScheme.code.fontSize);
  const codeBackground = fontScheme.code.background;

  css.push(`#markdown-content code {
  font-family: ${codeFontFamily};
  font-size: ${codeFontSize};
  background-color: ${codeBackground};
}`);

  css.push(`#markdown-content pre {
  background-color: ${codeBackground};
}`);

  css.push(`#markdown-content pre code {
  font-family: ${codeFontFamily};
  font-size: ${codeFontSize};
  background-color: transparent;
}`);

  return css.join('\n\n');
}

/**
 * Generate table-related CSS
 * @param {Object} tableStyle - Table style configuration
 * @returns {string} CSS string
 */
function generateTableCSS(tableStyle) {
  const css = [];

  // Base table styles
  css.push(`#markdown-content table {
  border-collapse: collapse;
  margin: 13px auto;
  overflow: auto;
}`);

  // Border styles
  const border = tableStyle.border || {};
  
  // Convert pt to px for border width
  const convertBorderWidth = (width) => {
    if (width.endsWith('pt')) {
      return width.replace('pt', 'px');
    }
    return width;
  };
  
  // Convert CSS border style and calculate actual width for double borders
  const convertBorderStyle = (style) => {
    // Map config style to CSS style
    const styleMap = {
      'single': 'solid',
      'double': 'double',
      'dashed': 'dashed',
      'dotted': 'dotted',
      'solid': 'solid'
    };
    return styleMap[style] || 'solid';
  };
  
  // Calculate effective border width for CSS
  // For double borders: CSS needs 3x the line width (2 lines + 1 gap)
  const calculateCssBorderWidth = (width, style) => {
    const convertedWidth = convertBorderWidth(width);
    if (style === 'double') {
      // Extract numeric value and unit
      const match = convertedWidth.match(/^(\d+\.?\d*)(.*)$/);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2];
        return `${value * 3}${unit}`; // 3x for double border (2 lines + 1 gap)
      }
    }
    return convertedWidth;
  };
  
  // Base cell styling
  css.push(`#markdown-content table th,
#markdown-content table td {
  padding: ${tableStyle.cell.padding};
}`);

  if (border.all) {
    // Full borders mode (grid, simple-border)
    const borderWidth = calculateCssBorderWidth(border.all.width, border.all.style);
    const borderStyle = convertBorderStyle(border.all.style);
    const borderValue = `${borderWidth} ${borderStyle} ${border.all.color}`;
    css.push(`#markdown-content table th,
#markdown-content table td {
  border: ${borderValue};
}`);
  } else {
    // Horizontal-only mode (professional, borderless)
    css.push(`#markdown-content table th,
#markdown-content table td {
  border: none;
}`);

    // Special borders
    if (border.headerTop) {
      const width = calculateCssBorderWidth(border.headerTop.width, border.headerTop.style);
      const style = convertBorderStyle(border.headerTop.style);
      css.push(`#markdown-content table th {
  border-top: ${width} ${style} ${border.headerTop.color};
}`);
    }

    if (border.headerBottom) {
      const width = calculateCssBorderWidth(border.headerBottom.width, border.headerBottom.style);
      const style = convertBorderStyle(border.headerBottom.style);
      css.push(`#markdown-content table th {
  border-bottom: ${width} ${style} ${border.headerBottom.color};
}`);
    }

    if (border.rowBottom) {
      const width = calculateCssBorderWidth(border.rowBottom.width, border.rowBottom.style);
      const style = convertBorderStyle(border.rowBottom.style);
      css.push(`#markdown-content table td {
  border-bottom: ${width} ${style} ${border.rowBottom.color};
}`);
    }

    if (border.lastRowBottom) {
      const width = calculateCssBorderWidth(border.lastRowBottom.width, border.lastRowBottom.style);
      const style = convertBorderStyle(border.lastRowBottom.style);
      css.push(`#markdown-content table tr:last-child td {
  border-bottom: ${width} ${style} ${border.lastRowBottom.color};
}`);
    }
  }

  // Header styles
  const header = tableStyle.header;
  const headerStyles = [];

  if (header.background) {
    headerStyles.push(`  background-color: ${header.background};`);
  }

  if (header.fontWeight) {
    const fontWeight = header.fontWeight === 'bold' ? 'bold' : header.fontWeight;
    headerStyles.push(`  font-weight: ${fontWeight};`);
  }

  if (header.color) {
    headerStyles.push(`  color: ${header.color};`);
  }

  if (header.fontSize) {
    headerStyles.push(`  font-size: ${header.fontSize};`);
  }

  if (headerStyles.length > 0) {
    css.push(`#markdown-content table th {
${headerStyles.join('\n')}
}`);
  }

  // Zebra stripes
  if (tableStyle.zebra && tableStyle.zebra.enabled) {
    css.push(`#markdown-content table tr:nth-child(even) {
  background-color: ${tableStyle.zebra.evenBackground};
}`);

    css.push(`#markdown-content table tr:nth-child(odd) {
  background-color: ${tableStyle.zebra.oddBackground};
}`);
  }

  return css.join('\n\n');
}

/**
 * Generate code highlighting CSS
 * @param {Object} codeConfig - Code font configuration
 * @param {Object} codeTheme - Code highlighting theme
 * @returns {string} CSS string
 */
function generateCodeCSS(codeConfig, codeTheme) {
  const css = [];

  // Ensure highlight.js styles work properly
  css.push(`#markdown-content .hljs {
  background: ${codeConfig.background} !important;
  color: ${codeTheme.foreground};
}`);

  // Generate color mappings for syntax highlighting
  Object.keys(codeTheme.colors).forEach((token) => {
    const color = codeTheme.colors[token];
    // Remove # prefix if present, since we add it in CSS
    const colorValue = color.startsWith('#') ? color.slice(1) : color;
    // Keep underscore format to match highlight.js HTML output (e.g., hljs-built_in)
    // Do NOT convert underscores to hyphens
    css.push(`#markdown-content .hljs-${token} {
  color: #${colorValue};
}`);
  });

  return css.join('\n\n');
}

/**
 * Generate spacing-related CSS
 * @param {Object} spacingScheme - Spacing scheme configuration (ratios relative to body font size)
 * @param {string} bodyFontSize - Body font size (e.g., "12pt")
 * @returns {string} CSS string
 */
function generateSpacingCSS(spacingScheme, bodyFontSize) {
  const css = [];
  
  // Parse body font size to get base value in pt
  const baseFontSizePt = parseFloat(bodyFontSize);

  // Helper function to calculate spacing based on ratio
  const calcSpacing = (ratio) => {
    if (ratio === 0) return '0';
    const ptValue = baseFontSizePt * ratio;
    return themeManager.ptToPx(ptValue + 'pt');
  };

  // Paragraph spacing
  css.push(`#markdown-content p {
  margin: ${calcSpacing(spacingScheme.paragraph)} 0;
}`);

  // List spacing
  css.push(`#markdown-content ul,
#markdown-content ol {
  margin: ${calcSpacing(spacingScheme.list)} 0;
}`);

  css.push(`#markdown-content li {
  margin: ${calcSpacing(spacingScheme.listItem)} 0;
}`);

  // Blockquote spacing
  if (spacingScheme.blockquote) {
    const bq = spacingScheme.blockquote;
    const margins = [];
    
    margins.push(calcSpacing(bq.before));
    margins.push('0'); // right
    margins.push(calcSpacing(bq.after));
    margins.push('0'); // left

    const paddingVertical = calcSpacing(bq.padding.vertical);
    const paddingHorizontal = calcSpacing(bq.padding.horizontal);

    css.push(`#markdown-content blockquote {
  margin: ${margins.join(' ')};
  padding: ${paddingVertical} ${paddingHorizontal};
}`);
  }

  // Horizontal rule spacing
  if (spacingScheme.horizontalRule) {
    const hr = spacingScheme.horizontalRule;
    css.push(`#markdown-content hr {
  margin: ${calcSpacing(hr.before)} 0 ${calcSpacing(hr.after)} 0;
}`);
  }

  return css.join('\n\n');
}

/**
 * Apply theme CSS to the page
 * @param {string} css - CSS string to apply
 */
export function applyThemeCSS(css) {
  // Remove existing theme style
  const existingStyle = document.getElementById('theme-dynamic-style');
  if (existingStyle) {
    existingStyle.remove();
  }

  // Create and append new style element
  const styleElement = document.createElement('style');
  styleElement.id = 'theme-dynamic-style';
  styleElement.textContent = css;
  document.head.appendChild(styleElement);
}

/**
 * Apply theme from pre-loaded data (used by mobile when Flutter sends theme data)
 * @param {Object} theme - Theme configuration
 * @param {Object} tableStyle - Table style configuration
 * @param {Object} codeTheme - Code theme configuration
 * @param {Object} spacingScheme - Spacing scheme configuration
 * @param {Object} fontConfig - Font configuration (for themeManager)
 */
export function applyThemeFromData(theme, tableStyle, codeTheme, spacingScheme, fontConfig) {
  try {
    // Ensure themeManager has fontConfig before generating CSS
    // This is needed because themeToCSS uses themeManager.buildFontFamily() etc.
    if (fontConfig) {
      // Always update fontConfig to ensure it's current
      themeManager.fontConfig = fontConfig;
    }
    themeManager.currentTheme = theme;

    // Generate CSS
    const css = themeToCSS(theme, tableStyle, codeTheme, spacingScheme);

    // Apply CSS
    applyThemeCSS(css);
  } catch (error) {
    console.error('Error applying theme from data:', error);
    throw error;
  }
}

/**
 * Load and apply complete theme
 * @param {string} themeId - Theme ID to load
 */
export async function loadAndApplyTheme(themeId) {
  try {
    const platform = getPlatform();
    
    // Load theme
    const theme = await themeManager.loadTheme(themeId);

    // Load table style
    const tableStyle = await fetchJSON(
      platform.resource.getURL(`themes/table-styles/${theme.tableStyle}.json`)
    );

    // Load code theme
    const codeTheme = await fetchJSON(
      platform.resource.getURL(`themes/code-themes/${theme.codeTheme}.json`)
    );

    // Load spacing scheme
    const spacingScheme = await fetchJSON(
      platform.resource.getURL(`themes/spacing-schemes/${theme.spacing}.json`)
    );

    // Generate CSS
    const css = themeToCSS(theme, tableStyle, codeTheme, spacingScheme);

    // Apply CSS
    applyThemeCSS(css);
  } catch (error) {
    console.error('Error loading theme:', error);
    throw error;
  }
}

/**
 * Switch to a different theme with smooth transition
 * @param {string} themeId - Theme ID to switch to
 */
export async function switchTheme(themeId) {
  try {
    // Switch theme in manager
    await themeManager.switchTheme(themeId);
    
    // Apply theme CSS
    await loadAndApplyTheme(themeId);
    
    console.log('Theme switched successfully:', themeId);
    
    return true;
  } catch (error) {
    console.error('Error switching theme:', error);
    throw error;
  }
}
