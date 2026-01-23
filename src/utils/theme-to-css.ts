/**
 * Theme to CSS Converter
 * Converts theme configuration to CSS styles
 * 
 * Theme v2.0 Format:
 * - fontScheme: only font families (no sizes)
 * - layoutScheme: all sizes and spacing (absolute pt values)
 * - colorScheme: colors (text, accent, code background)
 * - tableStyle: table styling
 * - codeTheme: code syntax highlighting
 */

import themeManager from './theme-manager';
import { fetchJSON } from './fetch-utils';
import type { PlatformAPI, ColorScheme } from '../types/index';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Get platform instance from global scope
 */
function getPlatform(): PlatformAPI {
  return globalThis.platform as PlatformAPI;
}

/**
 * Heading style configuration (font-related properties only)
 */
interface HeadingConfig {
  fontFamily?: string;
  fontWeight?: string;
}

/**
 * Font scheme configuration (font-related properties only)
 * Layout properties (fontSize, lineHeight, spacing) are in LayoutScheme
 * Color properties are in ColorScheme
 */
interface FontScheme {
  body: {
    fontFamily: string;
  };
  headings: {
    fontFamily: string;
    fontWeight?: string;
    [key: string]: string | HeadingConfig | undefined;
  };
  code: {
    fontFamily: string;
  };
}

/**
 * Theme configuration (v2.0 format)
 */
export interface ThemeConfig {
  fontScheme: FontScheme;
  layoutScheme: string;    // reference to layout-schemes/
  colorScheme: string;     // reference to color-schemes/
  tableStyle: string;
  codeTheme: string;
  /** Diagram rendering style: 'normal' or 'handDrawn' (default: 'handDrawn') */
  diagramStyle?: 'normal' | 'handDrawn';
}

/**
 * Border configuration (layout properties only, color from ColorScheme)
 */
interface BorderConfig {
  style: string;
  width: string;
}

/**
 * Table style configuration (layout properties only, colors from ColorScheme)
 */
export interface TableStyleConfig {
  border?: {
    all?: BorderConfig;
    headerTop?: BorderConfig;
    headerBottom?: BorderConfig;
    rowBottom?: BorderConfig;
    lastRowBottom?: BorderConfig;
  };
  header: {
    fontWeight?: string;
    fontSize?: string;
  };
  cell: {
    padding: string;
  };
  zebra?: {
    enabled: boolean;
  };
}

/**
 * Code theme configuration
 */
export interface CodeThemeConfig {
  colors: Record<string, string>;
  foreground: string;
}

/**
 * Layout scheme heading configuration
 */
interface LayoutHeadingConfig {
  fontSize: string;
  spacingBefore: string;
  spacingAfter: string;
  alignment?: 'left' | 'center' | 'right';
}

/**
 * Layout scheme block configuration
 */
interface LayoutBlockConfig {
  spacingBefore?: string;
  spacingAfter?: string;
  paddingVertical?: string;
  paddingHorizontal?: string;
}

/**
 * Layout scheme configuration (absolute pt values)
 */
export interface LayoutScheme {
  id: string;
  name: string;
  name_en: string;
  description: string;
  description_en?: string;
  
  body: {
    fontSize: string;
    lineHeight: number;
  };
  
  headings: {
    h1: LayoutHeadingConfig;
    h2: LayoutHeadingConfig;
    h3: LayoutHeadingConfig;
    h4: LayoutHeadingConfig;
    h5: LayoutHeadingConfig;
    h6: LayoutHeadingConfig;
  };
  
  code: {
    fontSize: string;
  };
  
  blocks: {
    paragraph: LayoutBlockConfig;
    list: LayoutBlockConfig;
    listItem: LayoutBlockConfig;
    blockquote: LayoutBlockConfig;
    codeBlock: LayoutBlockConfig;
    table: LayoutBlockConfig;
    horizontalRule: LayoutBlockConfig;
  };
}

/**
 * Font configuration for themeManager
 */
export interface FontConfig {
  [key: string]: unknown;
}

// ============================================================================
// CSS Generation Functions
// ============================================================================

/**
 * Convert theme configuration to CSS
 * @param theme - Theme configuration object
 * @param layoutScheme - Layout scheme configuration
 * @param colorScheme - Color scheme configuration
 * @param tableStyle - Table style configuration
 * @param codeTheme - Code highlighting theme
 * @returns CSS string
 */
export function themeToCSS(
  theme: ThemeConfig,
  layoutScheme: LayoutScheme,
  colorScheme: ColorScheme,
  tableStyle: TableStyleConfig,
  codeTheme: CodeThemeConfig
): string {
  const css: string[] = [];

  // Font and layout CSS (combined from fontScheme + layoutScheme)
  css.push(generateFontAndLayoutCSS(theme.fontScheme, layoutScheme, colorScheme));

  // Table style (uses colorScheme for colors)
  css.push(generateTableCSS(tableStyle, colorScheme));

  // Code highlighting (use colorScheme.background.code)
  css.push(generateCodeCSS(theme.fontScheme.code, codeTheme, layoutScheme.code, colorScheme));

  // Block spacing (uses colorScheme for blockquote border)
  css.push(generateBlockSpacingCSS(layoutScheme, colorScheme));

  return css.join('\n\n');
}

/**
 * Generate font and layout CSS
 * @param fontScheme - Font scheme configuration (font families)
 * @param layoutScheme - Layout scheme configuration (sizes and spacing)
 * @param colorScheme - Color scheme configuration
 * @returns CSS string
 */
function generateFontAndLayoutCSS(fontScheme: FontScheme, layoutScheme: LayoutScheme, colorScheme: ColorScheme): string {
  const css: string[] = [];

  // Body font - font family from fontScheme, size from layoutScheme, color from colorScheme
  const bodyFontFamily = themeManager.buildFontFamily(fontScheme.body.fontFamily);
  const bodyFontSize = themeManager.ptToPx(layoutScheme.body.fontSize);
  const bodyLineHeight = layoutScheme.body.lineHeight;

  css.push(`#markdown-content {
  font-family: ${bodyFontFamily};
  font-size: ${bodyFontSize};
  line-height: ${bodyLineHeight};
  color: ${colorScheme.text.primary};
}`);

  // Link colors from colorScheme
  css.push(`#markdown-content a {
  color: ${colorScheme.accent.link};
}`);

  css.push(`#markdown-content a:hover {
  color: ${colorScheme.accent.linkHover};
}`);

  // KaTeX math expressions - use body font size
  css.push(`.katex {
  font-size: ${bodyFontSize};
}`);

  // Headings - font/fontWeight from fontScheme, sizes/alignment/spacing from layoutScheme
  const headingLevels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

  headingLevels.forEach((level) => {
    const fontHeading = fontScheme.headings[level] as { fontFamily?: string; fontWeight?: string } | undefined;
    const layoutHeading = layoutScheme.headings[level];
    
    // Font family priority: h1-h6 specific > headings default > body fallback
    const fontFamily = themeManager.buildFontFamily(
      fontHeading?.fontFamily || 
      fontScheme.headings.fontFamily || 
      fontScheme.body.fontFamily
    );
    const fontSize = themeManager.ptToPx(layoutHeading.fontSize);
    // Font weight priority: h1-h6 specific > headings default > 'bold'
    const fontWeight = fontHeading?.fontWeight || fontScheme.headings.fontWeight || 'bold';
    
    // Heading color: from colorScheme.headings if specified, otherwise inherit text.primary
    const headingColor = colorScheme.headings?.[level] || colorScheme.text.primary;

    const styles = [
      `  font-family: ${fontFamily};`,
      `  font-size: ${fontSize};`,
      `  font-weight: ${fontWeight};`,
      `  color: ${headingColor};`
    ];

    // Add alignment from layoutScheme
    if (layoutHeading.alignment && layoutHeading.alignment !== 'left') {
      styles.push(`  text-align: ${layoutHeading.alignment};`);
    }

    // Add spacing from layoutScheme
    if (layoutHeading.spacingBefore && layoutHeading.spacingBefore !== '0pt') {
      styles.push(`  margin-top: ${themeManager.ptToPx(layoutHeading.spacingBefore)};`);
    }
    if (layoutHeading.spacingAfter && layoutHeading.spacingAfter !== '0pt') {
      styles.push(`  margin-bottom: ${themeManager.ptToPx(layoutHeading.spacingAfter)};`);
    }

    css.push(`#markdown-content ${level} {
${styles.join('\n')}
}`);
  });

  return css.join('\n\n');
}

/**
 * Generate table-related CSS
 * @param tableStyle - Table style configuration (for layout like padding, border width/style)
 * @param colorScheme - Color scheme configuration (for colors)
 * @returns CSS string
 */
function generateTableCSS(tableStyle: TableStyleConfig, colorScheme: ColorScheme): string {
  const css: string[] = [];

  // Base table styles
  css.push(`#markdown-content table {
  border-collapse: collapse;
  margin: 13px auto;
  overflow: auto;
}`);

  // Border styles
  const border = tableStyle.border || {};
  // Use colorScheme for border color
  const borderColor = colorScheme.table.border;
  
  // Convert pt to px for border width
  const convertBorderWidth = (width: string): string => {
    if (width.endsWith('pt')) {
      return width.replace('pt', 'px');
    }
    return width;
  };
  
  // Convert CSS border style
  const convertBorderStyle = (style: string): string => {
    const styleMap: Record<string, string> = {
      'single': 'solid',
      'double': 'double',
      'dashed': 'dashed',
      'dotted': 'dotted',
      'solid': 'solid'
    };
    return styleMap[style] || 'solid';
  };
  
  // Calculate effective border width for CSS
  const calculateCssBorderWidth = (width: string, style: string): string => {
    const convertedWidth = convertBorderWidth(width);
    if (style === 'double') {
      const match = convertedWidth.match(/^(\d+\.?\d*)(.*)$/);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2];
        return `${value * 3}${unit}`; // 3x for double border
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
    // Full borders mode - use colorScheme for color
    const borderWidth = calculateCssBorderWidth(border.all.width, border.all.style);
    const borderStyle = convertBorderStyle(border.all.style);
    const borderValue = `${borderWidth} ${borderStyle} ${borderColor}`;
    css.push(`#markdown-content table th,
#markdown-content table td {
  border: ${borderValue};
}`);
  } else {
    // Horizontal-only mode
    css.push(`#markdown-content table th,
#markdown-content table td {
  border: none;
}`);

    // Special borders - use colorScheme for color
    if (border.headerTop) {
      const width = calculateCssBorderWidth(border.headerTop.width, border.headerTop.style);
      const style = convertBorderStyle(border.headerTop.style);
      css.push(`#markdown-content table th {
  border-top: ${width} ${style} ${borderColor};
}`);
    }

    if (border.headerBottom) {
      const width = calculateCssBorderWidth(border.headerBottom.width, border.headerBottom.style);
      const style = convertBorderStyle(border.headerBottom.style);
      css.push(`#markdown-content table th {
  border-bottom: ${width} ${style} ${borderColor};
}`);
    }

    if (border.rowBottom) {
      const width = calculateCssBorderWidth(border.rowBottom.width, border.rowBottom.style);
      const style = convertBorderStyle(border.rowBottom.style);
      css.push(`#markdown-content table td {
  border-bottom: ${width} ${style} ${borderColor};
}`);
    }

    if (border.lastRowBottom) {
      const width = calculateCssBorderWidth(border.lastRowBottom.width, border.lastRowBottom.style);
      const style = convertBorderStyle(border.lastRowBottom.style);
      css.push(`#markdown-content table tr:last-child td,
#markdown-content table td.merged-to-last {
  border-bottom: ${width} ${style} ${borderColor};
}`);
    }
  }

  // Header styles - use colorScheme for colors
  const header = tableStyle.header;
  const headerStyles: string[] = [];

  // Always use colorScheme for header background and text
  headerStyles.push(`  background-color: ${colorScheme.table.headerBackground};`);
  headerStyles.push(`  color: ${colorScheme.table.headerText};`);

  if (header.fontWeight) {
    const fontWeight = header.fontWeight === 'bold' ? 'bold' : header.fontWeight;
    headerStyles.push(`  font-weight: ${fontWeight};`);
  }

  if (header.fontSize) {
    headerStyles.push(`  font-size: ${header.fontSize};`);
  }

  if (headerStyles.length > 0) {
    css.push(`#markdown-content table th {
${headerStyles.join('\n')}
}`);
  }

  // Zebra stripes - always use colorScheme colors
  if (tableStyle.zebra && tableStyle.zebra.enabled) {
    css.push(`#markdown-content table tr:nth-child(even) {
  background-color: ${colorScheme.table.zebraEven};
}`);

    css.push(`#markdown-content table tr:nth-child(odd) {
  background-color: ${colorScheme.table.zebraOdd};
}`);
  }

  return css.join('\n\n');
}

/**
 * Generate code highlighting CSS
 * @param codeConfig - Code font configuration from fontScheme
 * @param codeTheme - Code highlighting theme
 * @param codeLayout - Code layout configuration from layoutScheme
 * @param colorScheme - Color scheme configuration
 * @returns CSS string
 */
function generateCodeCSS(
  codeConfig: { fontFamily: string },
  codeTheme: CodeThemeConfig,
  codeLayout: { fontSize: string },
  colorScheme: ColorScheme
): string {
  const css: string[] = [];

  // Code font settings - background from colorScheme
  const codeFontFamily = themeManager.buildFontFamily(codeConfig.fontFamily);
  const codeFontSize = themeManager.ptToPx(codeLayout.fontSize);
  const codeBackground = colorScheme.background.code;

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

  // Ensure highlight.js styles work properly
  css.push(`#markdown-content .hljs {
  background: ${codeBackground} !important;
  color: ${codeTheme.foreground};
}`);

  // Generate color mappings for syntax highlighting
  Object.keys(codeTheme.colors).forEach((token) => {
    const color = codeTheme.colors[token];
    // Remove # prefix if present
    const colorValue = color.startsWith('#') ? color.slice(1) : color;
    css.push(`#markdown-content .hljs-${token} {
  color: #${colorValue};
}`);
  });

  return css.join('\n\n');
}

/**
 * Generate block spacing CSS from layout scheme
 * @param layoutScheme - Layout scheme configuration
 * @param colorScheme - Color scheme configuration (for blockquote border)
 * @returns CSS string
 */
function generateBlockSpacingCSS(layoutScheme: LayoutScheme, colorScheme: ColorScheme): string {
  const css: string[] = [];
  const blocks = layoutScheme.blocks;

  // Helper function to convert pt to px
  const toPx = (pt: string | undefined): string => {
    if (!pt || pt === '0pt') return '0';
    return themeManager.ptToPx(pt);
  };

  // Paragraph spacing
  if (blocks.paragraph) {
    const marginBefore = toPx(blocks.paragraph.spacingBefore);
    const marginAfter = toPx(blocks.paragraph.spacingAfter);
    css.push(`#markdown-content p {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
  }

  // List spacing
  if (blocks.list) {
    const marginBefore = toPx(blocks.list.spacingBefore);
    const marginAfter = toPx(blocks.list.spacingAfter);
    css.push(`#markdown-content ul,
#markdown-content ol {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
  }

  // List item spacing
  if (blocks.listItem) {
    const marginBefore = toPx(blocks.listItem.spacingBefore);
    const marginAfter = toPx(blocks.listItem.spacingAfter);
    css.push(`#markdown-content li {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
  }

  // Blockquote spacing and border color from colorScheme
  if (blocks.blockquote) {
    const bq = blocks.blockquote;
    const marginBefore = toPx(bq.spacingBefore);
    const marginAfter = toPx(bq.spacingAfter);
    const paddingVertical = toPx(bq.paddingVertical);
    const paddingHorizontal = toPx(bq.paddingHorizontal);
    css.push(`#markdown-content blockquote {
  margin: ${marginBefore} 0 ${marginAfter} 0;
  padding: ${paddingVertical} ${paddingHorizontal};
  border-left-color: ${colorScheme.blockquote.border};
}`);
  }

  // Code block spacing
  if (blocks.codeBlock) {
    const marginBefore = toPx(blocks.codeBlock.spacingBefore);
    const marginAfter = toPx(blocks.codeBlock.spacingAfter);
    css.push(`#markdown-content pre {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
  }

  // Table spacing
  if (blocks.table) {
    const marginBefore = toPx(blocks.table.spacingBefore);
    const marginAfter = toPx(blocks.table.spacingAfter);
    css.push(`#markdown-content table {
  margin: ${marginBefore} auto ${marginAfter} auto;
}`);
  }

  // Horizontal rule spacing
  if (blocks.horizontalRule) {
    const hr = blocks.horizontalRule;
    const marginBefore = toPx(hr.spacingBefore);
    const marginAfter = toPx(hr.spacingAfter);
    css.push(`#markdown-content hr {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
  }

  return css.join('\n\n');
}

// ============================================================================
// Theme Application Functions
// ============================================================================

/**
 * Apply theme CSS to the page
 * @param css - CSS string to apply
 */
export function applyThemeCSS(css: string): void {
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
 * Load and apply complete theme
 * Platforms only need to call this with themeId - all theme logic is handled internally
 * @param themeId - Theme ID to load
 */
export async function loadAndApplyTheme(themeId: string): Promise<void> {
  try {
    const platform = getPlatform();
    
    // Load theme preset
    const theme = (await themeManager.loadTheme(themeId)) as unknown as ThemeConfig;

    // Load layout scheme
    const layoutSchemeUrl = platform.resource.getURL(`themes/layout-schemes/${theme.layoutScheme}.json`);
    const layoutScheme = await fetchJSON(layoutSchemeUrl) as LayoutScheme;

    // Load color scheme
    const colorSchemeUrl = platform.resource.getURL(`themes/color-schemes/${theme.colorScheme}.json`);
    const colorScheme = await fetchJSON(colorSchemeUrl) as ColorScheme;

    // Load table style
    const tableStyle = await fetchJSON(
      platform.resource.getURL(`themes/table-styles/${theme.tableStyle}.json`)
    ) as TableStyleConfig;

    // Load code theme
    const codeTheme = await fetchJSON(
      platform.resource.getURL(`themes/code-themes/${theme.codeTheme}.json`)
    ) as CodeThemeConfig;

    // Generate and apply CSS
    const css = themeToCSS(theme, layoutScheme, colorScheme, tableStyle, codeTheme);
    applyThemeCSS(css);
    
    // Set renderer theme config for diagrams (Mermaid, Graphviz, etc.)
    const fontFamily = themeManager.buildFontFamily(theme.fontScheme.body.fontFamily);
    const fontSize = parseFloat(layoutScheme.body.fontSize);
    const diagramStyle = theme.diagramStyle || 'normal';
    platform.renderer.setThemeConfig({ fontFamily, fontSize, diagramStyle });
  } catch (error) {
    console.error('[Theme] Error loading theme:', error);
    throw error;
  }
}

/**
 * Switch to a different theme with smooth transition
 * @param themeId - Theme ID to switch to
 * @returns Success status
 */
export async function switchTheme(themeId: string): Promise<boolean> {
  try {
    // Switch theme in manager
    await themeManager.switchTheme(themeId);
    
    // Apply theme CSS
    await loadAndApplyTheme(themeId);
    
    return true;
  } catch (error) {
    console.error('Error switching theme:', error);
    throw error;
  }
}
