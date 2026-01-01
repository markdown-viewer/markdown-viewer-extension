/**
 * Theme to DOCX Converter
 * Converts theme configuration to DOCX styles
 */

import themeManager from '../utils/theme-manager';
import { BorderStyle } from 'docx';
import type {
  DOCXThemeStyles,
  DOCXRunStyle,
  DOCXParagraphStyle,
  DOCXParagraphSpacing,
  DOCXHeadingStyle,
  DOCXCharacterStyle,
  DOCXTableStyle,
  DOCXTableBorders,
  DOCXBorder,
  DOCXCodeColors,
  BorderStyleValue,
} from '../types/docx';

// Re-export DOCXThemeStyles for backward compatibility
export type { DOCXThemeStyles };

// ============================================================================
// Input Type Definitions (from theme files)
// ============================================================================

/**
 * Font scheme heading configuration (from theme JSON)
 */
interface HeadingConfig {
  fontFamily?: string;
  fontSize: string;
  fontWeight?: string;
  alignment?: 'left' | 'center' | 'right';
  spacing?: {
    before?: string;
    after?: string;
  };
}

/**
 * Font scheme configuration (from theme JSON)
 */
interface FontScheme {
  body: {
    fontFamily: string;
    fontSize: string;
    lineHeight: number;
  };
  headings: Record<string, HeadingConfig>;
  code: {
    fontFamily: string;
    fontSize: string;
    background: string;
  };
}

/**
 * Theme configuration (from theme JSON)
 */
interface ThemeConfig {
  fontScheme: FontScheme;
  tableStyle: string;
  codeTheme: string;
  spacing: string;
}

/**
 * Border configuration (from table style JSON)
 */
interface BorderConfig {
  style: string;
  width: string;
  color: string;
}

/**
 * Table style configuration (from table style JSON)
 */
interface TableStyleConfig {
  border?: {
    all?: BorderConfig;
    headerTop?: BorderConfig;
    headerBottom?: BorderConfig;
    rowBottom?: BorderConfig;
    lastRowBottom?: BorderConfig;
  };
  header: {
    background?: string;
    fontWeight?: string;
  };
  cell: {
    padding: string;
  };
  zebra?: {
    enabled: boolean;
    evenBackground: string;
    oddBackground: string;
  };
}

/**
 * Code theme configuration (from code theme JSON)
 */
interface CodeThemeConfig {
  colors: Record<string, string>;
  foreground?: string;
}

/**
 * Spacing scheme configuration (from spacing JSON)
 */
interface SpacingScheme {
  paragraph: number;
  [key: string]: number;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Convert theme configuration to DOCX styles object
 * @param theme - Theme configuration object
 * @param tableStyle - Table style configuration
 * @param codeTheme - Code highlighting theme
 * @param spacingScheme - Spacing scheme configuration
 * @returns DOCX styles configuration
 */
export function themeToDOCXStyles(
  theme: ThemeConfig,
  tableStyle: TableStyleConfig,
  codeTheme: CodeThemeConfig,
  spacingScheme: SpacingScheme
): DOCXThemeStyles {
  const codeBackground = theme.fontScheme.code.background;
  return {
    default: generateDefaultStyle(theme.fontScheme, spacingScheme),
    paragraphStyles: generateParagraphStyles(theme.fontScheme, spacingScheme),
    characterStyles: generateCharacterStyles(theme.fontScheme),
    tableStyles: generateTableStyles(tableStyle),
    codeColors: generateCodeColors(codeTheme, codeBackground)
  };
}

/**
 * Generate default document style
 * @param fontScheme - Font scheme configuration
 * @param spacingScheme - Spacing scheme configuration (ratios relative to body font size)
 * @returns Default style configuration
 */
function generateDefaultStyle(
  fontScheme: FontScheme,
  spacingScheme: SpacingScheme
): { run: DOCXRunStyle; paragraph: DOCXParagraphStyle } {
  const bodyFont = fontScheme.body.fontFamily;
  const fontSize = themeManager.ptToHalfPt(fontScheme.body.fontSize);
  const baseFontSizePt = parseFloat(fontScheme.body.fontSize);
  
  // Line spacing in DOCX: 240 = single spacing, 360 = 1.5 spacing, 480 = double spacing
  const lineSpacing = Math.round(fontScheme.body.lineHeight * 240);
  
  // Calculate the extra space added by line spacing (beyond 100%)
  const lineSpacingExtra = lineSpacing - 240;
  
  // Calculate actual spacing from ratio - split evenly between before and after
  const paragraphSpacingPt = baseFontSizePt * spacingScheme.paragraph;
  const halfSpacing = themeManager.ptToTwips((paragraphSpacingPt / 2) + 'pt');
  
  // Compensate for line spacing being applied to bottom
  const beforeSpacing = halfSpacing + lineSpacingExtra / 2;
  const afterSpacing = Math.max(0, halfSpacing - lineSpacingExtra / 2);
  
  // For DOCX: get font configuration from font-config.json
  const docxFont = themeManager.getDocxFont(bodyFont);

  return {
    run: {
      font: docxFont,
      size: fontSize
    },
    paragraph: {
      spacing: {
        line: lineSpacing,
        before: beforeSpacing,
        after: afterSpacing
      }
    }
  };
}

/**
 * Generate paragraph styles for headings
 * @param fontScheme - Font scheme configuration
 * @param _spacingScheme - Spacing scheme configuration (unused but kept for API consistency)
 * @returns Paragraph styles
 */
function generateParagraphStyles(
  fontScheme: FontScheme,
  _spacingScheme: SpacingScheme
): Record<string, DOCXHeadingStyle> {
  const styles: Record<string, DOCXHeadingStyle> = {};

  // Generate heading styles
  Object.keys(fontScheme.headings).forEach((level, index) => {
    const heading = fontScheme.headings[level];
    const headingLevel = index + 1; // h1 = 1, h2 = 2, etc.

    // Inherit font from body if not specified
    const font = heading.fontFamily || fontScheme.body.fontFamily;
    const docxFont = themeManager.getDocxFont(font);

    // Get heading's own spacing (before/after from theme), split evenly
    const headingBeforePt = heading.spacing?.before ? parseFloat(heading.spacing.before) : 0;
    const headingAfterPt = heading.spacing?.after ? parseFloat(heading.spacing.after) : 0;
    
    const halfBeforePt = headingBeforePt / 2;
    const halfAfterPt = headingAfterPt / 2;
    
    // Compensate for line spacing in before
    // Headings use 1.5x line spacing = 360, extra = 120
    const lineSpacingExtra = 360 - 240;
    
    const totalBefore = themeManager.ptToTwips(halfBeforePt + 'pt') + lineSpacingExtra / 2;
    const totalAfter = Math.max(0, themeManager.ptToTwips(halfAfterPt + 'pt') - lineSpacingExtra / 2);

    styles[`heading${headingLevel}`] = {
      id: `Heading${headingLevel}`,
      name: `Heading ${headingLevel}`,
      basedOn: 'Normal',
      next: 'Normal',
      run: {
        size: themeManager.ptToHalfPt(heading.fontSize),
        bold: heading.fontWeight === 'bold',
        font: docxFont
      },
      paragraph: {
        spacing: {
          before: totalBefore,
          after: totalAfter,
          line: 360 // 1.5 line spacing for headings
        },
        alignment: heading.alignment === 'center' ? 'center' : 'left'
      }
    };
  });

  return styles;
}

/**
 * Generate character styles (for inline elements)
 * @param fontScheme - Font scheme configuration
 * @returns Character styles
 */
function generateCharacterStyles(fontScheme: FontScheme): { code: DOCXCharacterStyle } {
  const codeFont = fontScheme.code.fontFamily;
  const codeBackground = fontScheme.code.background.replace('#', ''); // Remove # for DOCX
  const docxFont = themeManager.getDocxFont(codeFont);

  return {
    code: {
      font: docxFont,
      size: themeManager.ptToHalfPt(fontScheme.code.fontSize),
      background: codeBackground
    }
  };
}

/**
 * Generate table styles for DOCX
 * @param tableStyle - Table style configuration
 * @returns Table style configuration
 */
function generateTableStyles(tableStyle: TableStyleConfig): DOCXTableStyle {
  const docxTableStyle: DOCXTableStyle = {
    borders: {},
    header: {},
    cell: {},
    zebra: tableStyle.zebra?.enabled || false
  };

  // Convert borders based on what's defined in the border object
  const border = tableStyle.border || {};

  // If border.all is defined, apply to all borders
  if (border.all) {
    docxTableStyle.borders.all = {
      style: convertBorderStyle(border.all.style),
      size: parseBorderWidth(border.all.width, border.all.style),
      color: border.all.color.replace('#', '')
    };
  }

  // Override with specific borders if defined
  if (border.headerTop) {
    docxTableStyle.borders.headerTop = {
      style: convertBorderStyle(border.headerTop.style),
      size: parseBorderWidth(border.headerTop.width, border.headerTop.style),
      color: border.headerTop.color.replace('#', '')
    };
  }
  if (border.headerBottom) {
    docxTableStyle.borders.headerBottom = {
      style: convertBorderStyle(border.headerBottom.style),
      size: parseBorderWidth(border.headerBottom.width, border.headerBottom.style),
      color: border.headerBottom.color.replace('#', '')
    };
  }
  if (border.rowBottom) {
    docxTableStyle.borders.insideHorizontal = {
      style: convertBorderStyle(border.rowBottom.style),
      size: parseBorderWidth(border.rowBottom.width, border.rowBottom.style),
      color: border.rowBottom.color.replace('#', '')
    };
  }
  if (border.lastRowBottom) {
    docxTableStyle.borders.lastRowBottom = {
      style: convertBorderStyle(border.lastRowBottom.style),
      size: parseBorderWidth(border.lastRowBottom.width, border.lastRowBottom.style),
      color: border.lastRowBottom.color.replace('#', '')
    };
  }

  // Header styles
  if (tableStyle.header.background) {
    docxTableStyle.header.shading = {
      fill: tableStyle.header.background.replace('#', '')
    };
  }
  if (tableStyle.header.fontWeight) {
    docxTableStyle.header.bold = tableStyle.header.fontWeight === 'bold';
  }

  // Cell padding
  const paddingTwips = themeManager.ptToTwips(tableStyle.cell.padding);
  docxTableStyle.cell.margins = {
    top: paddingTwips,
    bottom: paddingTwips,
    left: paddingTwips,
    right: paddingTwips
  };

  // Zebra stripes
  if (tableStyle.zebra?.enabled) {
    docxTableStyle.zebra = {
      even: tableStyle.zebra.evenBackground.replace('#', ''),
      odd: tableStyle.zebra.oddBackground.replace('#', '')
    };
  }

  return docxTableStyle;
}

/**
 * Generate code color mappings for DOCX export
 * @param codeTheme - Code highlighting theme
 * @param codeBackground - Code background color from theme
 * @returns Code color mappings
 */
function generateCodeColors(codeTheme: CodeThemeConfig, codeBackground: string): DOCXCodeColors {
  const colorMap: Record<string, string> = {};

  // Convert color mappings
  Object.keys(codeTheme.colors).forEach((token) => {
    colorMap[token] = codeTheme.colors[token];
  });

  return {
    background: codeBackground?.replace('#', '') || 'f6f8fa',
    foreground: codeTheme.foreground?.replace('#', '') || '24292e',
    colors: colorMap
  };
}

/**
 * Convert CSS border style to DOCX border style
 * @param cssStyle - CSS border style (e.g., 'solid', 'dashed')
 * @returns DOCX BorderStyle enum value
 */
function convertBorderStyle(cssStyle: string): BorderStyleValue {
  const styleMap: Record<string, BorderStyleValue> = {
    'none': BorderStyle.NONE,
    'solid': BorderStyle.SINGLE,
    'dashed': BorderStyle.DASHED,
    'dotted': BorderStyle.DOTTED,
    'double': BorderStyle.DOUBLE
  };

  return styleMap[cssStyle] || BorderStyle.SINGLE;
}

/**
 * Parse border width from CSS value to DOCX eighths of a point
 * @param width - CSS width (e.g., '1pt', '2px')
 * @param _style - Border style (optional, for future use)
 * @returns Width in eighths of a point
 */
function parseBorderWidth(width: string, _style: string = 'single'): number {
  const match = width.match(/^(\d+\.?\d*)(pt|px)$/);
  if (!match) return 8; // Default 1pt = 8 eighths

  const value = parseFloat(match[1]);
  const unit = match[2];

  // Keep original width for all border styles
  // DOCX will handle the double border rendering internally

  if (unit === 'pt') {
    return Math.round(value * 8);
  } else if (unit === 'px') {
    // Convert px to pt first (96 DPI: 1px = 0.75pt)
    const pt = value * 0.75;
    return Math.round(pt * 8);
  }

  return 8;
}

/**
 * Load and prepare complete theme configuration for DOCX export
 * @param themeId - Theme ID to load
 * @returns DOCX styles configuration
 */
export async function loadThemeForDOCX(themeId: string): Promise<DOCXThemeStyles> {
  try {
    // Initialize theme manager first
    await themeManager.initialize();
    
    // Load theme
    const theme = (await themeManager.loadTheme(themeId)) as unknown as ThemeConfig;

    // Get platform for resource loading
    const platform = globalThis.platform as { 
      platform?: string;
      resource: { 
        getURL: (path: string) => string;
        fetch: (path: string) => Promise<string>;
      } 
    } | undefined;
    
    if (!platform?.resource) {
      throw new Error('Platform resource service not available');
    }

    // Helper to fetch JSON resource
    // Each platform's ResourceService.fetch() handles platform-specific differences
    const fetchResource = async <T>(path: string): Promise<T> => {
      const content = await platform.resource.fetch(path);
      return JSON.parse(content) as T;
    };

    // Load table style
    const tableStyle = await fetchResource<TableStyleConfig>(
      `themes/table-styles/${theme.tableStyle}.json`
    );

    // Load code theme
    const codeTheme = await fetchResource<CodeThemeConfig>(
      `themes/code-themes/${theme.codeTheme}.json`
    );

    // Load spacing scheme
    const spacingScheme = await fetchResource<SpacingScheme>(
      `themes/spacing-schemes/${theme.spacing}.json`
    );

    // Generate DOCX styles
    return themeToDOCXStyles(theme, tableStyle, codeTheme, spacingScheme);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Error loading theme for DOCX:', errMsg);
    throw error;
  }
}
