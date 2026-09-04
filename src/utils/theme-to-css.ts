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
import type { Theme, LayoutBlockConfig } from '../types/theme';

/**
 * Content-root selectors. Theme CSS is generated against `#markdown-content`
 * and then expanded to also cover `.markdown-viewer-content` (embed/book
 * hosts). The expansion is explicit dual selectors — NOT `:is(...)` — because
 * EPUB readers and older CSS engines do not support `:is()` reliably, and the
 * shared content CSS must stay within the weakest consumer's compatibility
 * boundary.
 */
const CONTENT_ROOT_SELECTOR = '#markdown-content';
const CONTENT_ROOT_ALTERNATE = '.markdown-viewer-content';

/**
 * Expand a CSS selector list: every selector that targets `#markdown-content`
 * is duplicated with `#markdown-content` replaced by the alternate content
 * root class, producing explicit dual selectors with equivalent semantics.
 * Selectors without the content root are kept byte-for-byte.
 */
function expandContentRootSelectors(selectorList: string): string {
  const expanded = selectorList
    .split(',')
    .map((raw) => raw.trim())
    .map((selector) => {
      if (!selector.includes(CONTENT_ROOT_SELECTOR)) {
        return selector;
      }
      const alternate = selector.replace(/#markdown-content/g, CONTENT_ROOT_ALTERNATE);
      // Hosts that render into a child `.markdown-viewer-content` inside
      // #markdown-content (content-script takeover, embed, GitBook panel)
      // carry the layout classes on the child only. For classed/id/attr
      // content-root selectors (`#markdown-content.foo ...`) also emit the
      // nested child branch so the variant keeps at least the specificity of
      // the base rules (which include the #markdown-content id).
      const nested = selector.replace(
        /#markdown-content([.#\[])/g,
        `#markdown-content ${CONTENT_ROOT_ALTERNATE}$1`,
      );
      return `${selector}, ${alternate}${nested !== selector ? `, ${nested}` : ''}`;
    })
    .join(',\n');
  return `${expanded} `;
}

/**
 * Expand every rule in a generated CSS string whose selector(s) target
 * `#markdown-content`. Rules without the content root are left untouched.
 */
function expandCssContentRoots(css: string): string {
  return css.replace(/([^{}]+)\{/g, (match: string, selectors: string) => {
    return `${expandContentRootSelectors(selectors)}{`;
  });
}

// ============================================================================
// Color Mixing (no color-mix())
// ============================================================================

interface RgbColor {
  r: number;
  g: number;
  b: number;
  /** 0..1; 1 = fully opaque */
  a: number;
}

function parseColor(input: string): RgbColor | null {
  const value = input.trim().toLowerCase();
  if (value === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3
      ? raw.split('').map((ch) => ch + ch).join('')
      : raw;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((part) => part.trim());
    if (parts.length < 3) {
      return null;
    }
    return {
      r: Number(parts[0]),
      g: Number(parts[1]),
      b: Number(parts[2]),
      a: parts.length >= 4 ? Number(parts[3]) : 1,
    };
  }

  return null;
}

function formatColor(color: RgbColor): string {
  if (color.a >= 1) {
    const hex = [color.r, color.g, color.b]
      .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${color.a})`;
}

/**
 * Mix two colors in sRGB and return a concrete CSS color, replicating
 * `color-mix(in srgb, first W%, second)` without relying on color-mix() —
 * EPUB readers and older CSS engines do not support it reliably.
 *
 * When `second` is transparent the result keeps the first color and uses the
 * first color's weight as the alpha channel.
 */
function mixColors(first: string, firstWeightPercent: number, second: string): string {
  const firstColor = parseColor(first);
  const secondColor = parseColor(second);
  if (!firstColor || !secondColor) {
    return first;
  }

  const weight = Math.max(0, Math.min(100, firstWeightPercent)) / 100;

  if (secondColor.a === 0) {
    // Over transparent: keep the first color, alpha = weight.
    return formatColor({ r: firstColor.r, g: firstColor.g, b: firstColor.b, a: weight });
  }

  // Straight sRGB interpolation of two opaque colors.
  const r = firstColor.r * weight + secondColor.r * (1 - weight);
  const g = firstColor.g * weight + secondColor.g * (1 - weight);
  const b = firstColor.b * weight + secondColor.b * (1 - weight);
  return formatColor({ r, g, b, a: 1 });
}

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
  /** Registry id — present on loaded/bundled theme records (not on raw config subsets). */
  id?: string;
  fontScheme: FontScheme;
  layoutScheme: string;    // reference to layout-schemes/
  colorScheme: string;     // reference to color-schemes/
  tableStyle: string;
  codeTheme: string;
  /** Diagram rendering style: 'normal' or 'handDrawn' (default: 'handDrawn') */
  diagramStyle?: 'normal' | 'handDrawn';
}

interface ResolvedThemeBundle {
  theme: ThemeConfig;
  layoutScheme: LayoutScheme;
  colorScheme: ColorScheme;
  tableStyle: TableStyleConfig;
  codeTheme: CodeThemeConfig;
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
  /** Optional unitless line-height override (e.g. 1.25) */
  lineHeight?: number;
  /** Optional bottom border (e.g. for VSCode-style underlined h1/h2). Color comes from colorScheme.headings.border. */
  borderBottom?: {
    width: string;          // e.g. "1px"
    style?: string;         // default 'solid'
    paddingBottom?: string; // e.g. "0.3em"
  };
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
  codeTheme: CodeThemeConfig,
  firstLineIndent = 0
): string {
  const css: string[] = [];

  // Font and layout CSS (combined from fontScheme + layoutScheme)
  css.push(generateFontAndLayoutCSS(theme.fontScheme, layoutScheme, colorScheme));

  // Table style (uses colorScheme for colors)
  css.push(generateTableCSS(tableStyle, colorScheme));

  // Code highlighting (use colorScheme.background.code)
  css.push(generateCodeCSS(theme.fontScheme.code, codeTheme, layoutScheme.code, layoutScheme.body.fontSize, colorScheme));

  // Block spacing (uses colorScheme for blockquote border)
  css.push(generateBlockSpacingCSS(layoutScheme, colorScheme, firstLineIndent));

  css.push(generateFootnoteCSS());

  // GitHub-style alerts (blockquote.markdown-alert)
  css.push(generateAlertCSS(colorScheme));

  return expandCssContentRoots(css.join('\n\n'));
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
  color: ${colorScheme.text.primary};${colorScheme.background.page ? `
  background-color: ${colorScheme.background.page};` : ''}
}`);

  // Expose theme colors as global CSS variables for viewer chrome and custom blocks.
  if (colorScheme.background.page || colorScheme.background.surface || colorScheme.accent.link || colorScheme.accent.linkHover) {
    const vars: string[] = [];
    if (colorScheme.background.page) vars.push(`  --md-page-bg: ${colorScheme.background.page};`);
    if (colorScheme.background.surface) vars.push(`  --md-surface: ${colorScheme.background.surface};`);
    if (colorScheme.accent.link) {
      const accentBase = colorScheme.accent.link;
      const accentSurface = colorScheme.background.surface || colorScheme.background.page || 'transparent';
      vars.push(`  --md-accent: ${accentBase};`);
      // Concrete colors instead of color-mix(): EPUB readers don't support it.
      vars.push(`  --md-accent-bg: ${mixColors(accentBase, 16, accentSurface)};`);
      vars.push(`  --md-accent-subtle: ${mixColors(accentBase, 22, 'transparent')};`);
    }
    if (colorScheme.accent.linkHover) vars.push(`  --md-accent-hover: ${colorScheme.accent.linkHover};`);
    css.push(`:root {\n${vars.join('\n')}\n}`);
    css.push(`#markdown-content {\n${vars.join('\n')}\n}`);
  }

  // Blockquote background (optional)
  if (colorScheme.background.blockquote) {
    css.push(`#markdown-content blockquote {
  background-color: ${colorScheme.background.blockquote};
}`);
  }

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

    // Optional unitless line-height (e.g. VSCode preset uses 1.25 on all headings)
    if (layoutHeading.lineHeight !== undefined) {
      styles.push(`  line-height: ${layoutHeading.lineHeight};`);
    }

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

    // Optional bottom border (VSCode-style underlined h1/h2)
    if (layoutHeading.borderBottom) {
      const bb = layoutHeading.borderBottom;
      const borderColor = colorScheme.headings?.border || colorScheme.table.border;
      const borderStyle = bb.style || 'solid';
      styles.push(`  border-bottom: ${bb.width} ${borderStyle} ${borderColor};`);
      if (bb.paddingBottom) {
        styles.push(`  padding-bottom: ${bb.paddingBottom};`);
      }
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

  // Base table styles - display:table + width:auto gives the classic
  // content-width table (narrow tables size to their content, wide tables are
  // constrained by max-width). width:fit-content is intentionally avoided:
  // EPUB readers and older CSS engines do not support it, and display:table
  // provides the same content-width behavior everywhere.
  css.push(`#markdown-content table {
  border-collapse: collapse;
  display: table;
  width: auto;
  max-width: 100%;
  margin: 13px auto;
}

/* Table layout: left alignment */
#markdown-content.table-layout-left table {
  margin-left: 0;
  margin-right: auto;
}

/* Table layout: centered auto width (explicit; base rule already auto) */
#markdown-content.table-layout-center table {
  width: auto;
}

/* Table layout: full width */
#markdown-content.table-layout-center-full-width table {
  width: 100%;
  margin-left: auto;
  margin-right: auto;
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
  bodyFontSize: string,
  colorScheme: ColorScheme
): string {
  const css: string[] = [];

  // Code font settings - background from colorScheme
  const codeFontFamily = themeManager.buildFontFamily(codeConfig.fontFamily);
  const codeFontSize = themeManager.ptToPx(codeLayout.fontSize);
  const bodyFontSizePt = parseFloat(bodyFontSize);
  const codeFontSizePt = parseFloat(codeLayout.fontSize);
  const inlineCodeScale = bodyFontSizePt > 0
    ? Number((codeFontSizePt / bodyFontSizePt).toFixed(4))
    : 1;
  const codeBackground = colorScheme.background.code;

  css.push(`#markdown-content code {
  font-family: ${codeFontFamily};
  font-size: ${inlineCodeScale}em;
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
function generateBlockSpacingCSS(layoutScheme: LayoutScheme, colorScheme: ColorScheme, firstLineIndent = 0): string {
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
    const styles: string[] = [
      `  margin: ${marginBefore} 0 ${marginAfter} 0;`
    ];
    // First-line indent: only if theme supports it AND user has enabled it.
    // Plain text-indent only — the `each-line` keyword (indent every wrapped
    // line) is not supported by EPUB readers and older CSS engines.
    if (blocks.paragraph.firstLineIndent && firstLineIndent > 0) {
      styles.push(`  text-indent: ${firstLineIndent}em;`);
    }
    css.push(`#markdown-content p {
${styles.join('\n')}
}`);
    // Override text-indent on paragraphs inside list items.
    // Loose lists (blank line between items) wrap content in <p>, which would
    // inherit the paragraph first-line indent and create a gap between the
    // list marker and the text. List markers already provide visual hierarchy.
    if (blocks.paragraph.firstLineIndent && firstLineIndent > 0) {
      css.push(`#markdown-content li p {
  text-indent: 0;
}`);
    }
  }

  // List spacing
  if (blocks.list) {
    const marginBefore = toPx(blocks.list.spacingBefore);
    const marginAfter = toPx(blocks.list.spacingAfter);
    css.push(`#markdown-content ul,
#markdown-content ol {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
    // When the body uses a first-line indent (clreq: 2em is the standard for
    // Chinese publications), shift the FIRST-LEVEL list as a whole by the same
    // amount so the marker starts at the body's first-line position (the
    // "tupai/itemization" convention for numbered lists: the marker sits at
    // the line start, text follows and wrapped lines align). Applied as
    // "every list shifts, nested lists and blockquote-internal lists reset" —
    // a top-level list cannot be targeted with `#markdown-content > ul`
    // because the document renderer wraps every block in a
    // `<div class="md-block">`. Putting the offset on li instead would
    // compound on every nesting level.
    if (blocks.paragraph?.firstLineIndent && firstLineIndent > 0) {
      css.push(`#markdown-content ul,
#markdown-content ol {
  margin-left: ${firstLineIndent}em;
}
#markdown-content li ul,
#markdown-content li ol,
#markdown-content blockquote ul,
#markdown-content blockquote ol {
  margin-left: 0;
}`);
    }
  }

  // List item spacing
  if (blocks.listItem) {
    const marginBefore = toPx(blocks.listItem.spacingBefore);
    const marginAfter = toPx(blocks.listItem.spacingAfter);
    css.push(`#markdown-content li {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
    // Note: list indentation is intentionally decoupled from the paragraph
    // first-line indent. Lists already carry their own hierarchy via the
    // ul/ol 2em padding step; adding margin-left here would COMPOUND on
    // every nesting level (each li matches) and balloon the indent step
    // to ~3em per level.
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
    // Override text-indent on paragraphs inside blockquote (blockquotes are already visually distinct)
    if (blocks.paragraph.firstLineIndent && firstLineIndent > 0) {
      css.push(`#markdown-content blockquote p {
  text-indent: 0;
}`);
    }
  }

  // Code block spacing
  if (blocks.codeBlock) {
    const marginBefore = toPx(blocks.codeBlock.spacingBefore);
    const marginAfter = toPx(blocks.codeBlock.spacingAfter);
    css.push(`#markdown-content pre {
  margin: ${marginBefore} 0 ${marginAfter} 0;
}`);
  }

  // Table text is scaled down from the body font (default 0.85×) with a
  // tighter line-height so tables read as a distinct, data-dense block across
  // every theme. blocks.table.fontScale / lineHeight override per theme.
  if (blocks.table) {
    const marginBefore = toPx(blocks.table.spacingBefore);
    const marginAfter = toPx(blocks.table.spacingAfter);
    const bodyPt = parseFloat(layoutScheme.body.fontSize);
    const tableScale = blocks.table.fontScale ?? 0.85;
    const tableLineHeight = blocks.table.lineHeight ?? 1.15;
    const tableStyles: string[] = [
      `  margin: ${marginBefore} auto ${marginAfter} auto;`,
      `  font-size: ${themeManager.ptToPx(`${bodyPt * tableScale}pt`)};`,
      `  line-height: ${tableLineHeight};`,
    ];
    css.push(`#markdown-content table {
${tableStyles.join('\n')}
}`);
  }

  // Horizontal rule spacing (and optional color/width)
  if (blocks.horizontalRule) {
    const hr = blocks.horizontalRule;
    const marginBefore = toPx(hr.spacingBefore);
    const marginAfter = toPx(hr.spacingAfter);
    const hrStyles: string[] = [
      `  margin: ${marginBefore} 0 ${marginAfter} 0;`
    ];
    // Only override hr rendering when explicitly configured; falling back to
    // colorScheme.table.border (always present) would affect all themes.
    if (hr.borderWidth !== undefined || colorScheme.rule?.color !== undefined) {
      const width = hr.borderWidth ?? '1px';
      const hrColor = colorScheme.rule?.color;
      hrStyles.push(`  background-color: transparent;`);
      hrStyles.push(`  border: 0;`);
      hrStyles.push(`  height: 0;`);
      hrStyles.push(`  border-top: ${width} solid ${hrColor || 'currentColor'};`);
    }
    css.push(`#markdown-content hr {
${hrStyles.join('\n')}
}`);
  }

  return css.join('\n\n');
}

function generateFootnoteCSS(): string {
  return `
#markdown-content sup.footnote-ref {
  font-size: 0.8em;
  line-height: 0;
  position: relative;
  vertical-align: baseline;
  top: -0.5em;
}
#markdown-content sup.footnote-ref a {
  text-decoration: none;
  color: var(--md-accent, #0366d6);
  font-weight: 600;
}
#markdown-content sup.footnote-ref a:hover {
  text-decoration: underline;
}
#markdown-content section.footnotes {
  font-size: 0.9em;
}
#markdown-content section.footnotes ul {
  list-style: disc;
  padding-left: 1.5em;
  margin: 0;
}
#markdown-content section.footnotes .footnote-item {
  margin: 0.3em 0;
  line-height: 1.5;
}
#markdown-content section.footnotes .footnote-label {
  font-weight: 600;
  color: var(--md-accent, #0366d6);
  margin-right: 0.35em;
}
#markdown-content section.footnotes .footnote-item > .footnote-content > :first-child {
  margin-top: 0;
}
#markdown-content section.footnotes .footnote-item > .footnote-content > :last-child {
  margin-bottom: 0;
}
`.trim();
}

/**
 * Generate CSS for GitHub-style alerts.
 *
 * Alerts are blockquotes tagged with `markdown-alert` (+ a per-kind class) by
 * the remark-github-alerts plugin. Each kind gets a signature border/background
 * colour; backgrounds are tinted against the page colour so they adapt to both
 * light and dark themes without extra rules. Tints are materialized as
 * concrete colors (no color-mix()) for EPUB reader compatibility.
 *
 * @param colorScheme - Color scheme configuration (page/surface colours)
 * @returns CSS string for alert styling
 */
function generateAlertCSS(colorScheme: ColorScheme): string {
  const page = colorScheme.background?.page || '#ffffff';

  // GitHub's canonical alert palette.
  const alertKinds: { key: string; color: string }[] = [
    { key: 'note', color: '#0969da' },
    { key: 'tip', color: '#1a7f37' },
    { key: 'important', color: '#8250df' },
    { key: 'warning', color: '#9a6700' },
    { key: 'caution', color: '#cf222e' },
  ];

  const rules: string[] = [];

  rules.push(`#markdown-content blockquote.markdown-alert {
  margin: 0.6em 0;
  padding: 0.4em 0.9em;
  border-left: 4px solid var(--md-alert-border, #d0d7de);
  background-color: var(--md-alert-bg, transparent);
  color: inherit;
}`);

  // Tighten paragraph spacing inside alerts so the title sits close to the body.
  rules.push(`#markdown-content blockquote.markdown-alert > p {
  margin: 0.25em 0;
}`);
  rules.push(`#markdown-content blockquote.markdown-alert > p:first-child {
  margin-top: 0;
}`);
  rules.push(`#markdown-content blockquote.markdown-alert > p:last-child {
  margin-bottom: 0;
}`);

  rules.push(`#markdown-content .markdown-alert-title {
  font-weight: 600;
  line-height: 1.3;
}`);
  rules.push(`#markdown-content blockquote.markdown-alert > .markdown-alert-title {
  margin-bottom: 0.35em;
}`);

  for (const kind of alertKinds) {
    const bg = mixColors(kind.color, 10, page);
    rules.push(`#markdown-content blockquote.markdown-alert-${kind.key} {
  border-left-color: ${kind.color};
  background-color: ${bg};
}`);
    rules.push(`#markdown-content blockquote.markdown-alert-${kind.key} > .markdown-alert-title {
  color: ${kind.color};
}`);
  }

  return rules.join('\n\n');
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
    const bundleSupported = platform.platform === 'vscode';

    let theme: ThemeConfig;
    let layoutScheme: LayoutScheme;
    let colorScheme: ColorScheme;
    let tableStyle: TableStyleConfig;
    let codeTheme: CodeThemeConfig;

    if (bundleSupported) {
      await themeManager.initialize();

      try {
        const bundle = await fetchJSON(platform.resource.getURL(`themes/bundles/${themeId}.json`)) as ResolvedThemeBundle;
        theme = bundle.theme;
        layoutScheme = bundle.layoutScheme;
        colorScheme = bundle.colorScheme;
        tableStyle = bundle.tableStyle;
        codeTheme = bundle.codeTheme;
        // The bundle theme record is the full registry Theme (id/name included),
        // while ThemeConfig models the config subset consumed here.
        themeManager.setCurrentTheme(theme as unknown as Theme);
      } catch {
        theme = (await themeManager.loadTheme(themeId)) as unknown as ThemeConfig;
        [layoutScheme, colorScheme, tableStyle, codeTheme] = await loadThemeParts(theme, platform);
      }
    } else {
      theme = (await themeManager.loadTheme(themeId)) as unknown as ThemeConfig;
      [layoutScheme, colorScheme, tableStyle, codeTheme] = await loadThemeParts(theme, platform);
    }

    // Generate and apply CSS
    let firstLineIndent = 0;
    try {
      const settings = platform?.settings;
      if (settings) {
        firstLineIndent = await settings.get('firstLineIndent');
      }
    } catch { /* use default 0 */ }
    const css = themeToCSS(theme, layoutScheme, colorScheme, tableStyle, codeTheme, firstLineIndent);
    applyThemeCSS(css);
    
    // Set renderer theme config for diagrams (Mermaid, Graphviz, etc.)
    const fontFamily = themeManager.buildFontFamily(theme.fontScheme.body.fontFamily);
    // Diagram font size is intentionally FIXED and decoupled from the theme
    // body font size: external SVGs (e.g. shields.io badges) render with their
    // own fixed internal sizes, so a body-driven diagram font would break row
    // height consistency (a 16pt body made diagrams and badges visually
    // incompatible; badges only line up with PNGs at 12pt).
    const fontSize = 12;
    const diagramStyle = theme.diagramStyle || 'normal';
    // Derive colorSchema from the theme's registry category. Dark presets live
    // under the 'dark' category so downstream renderers (mermaid, vega, dot,
    // infographic) can switch to dark styling. Mirrors the slidev mechanism.
    const category = theme.id ? themeManager.getThemeCategory(theme.id) : null;
    const colorSchema: 'light' | 'dark' = category === 'dark' ? 'dark' : 'light';
    platform.renderer.setThemeConfig({ fontFamily, fontSize, diagramStyle, colorSchema });

    // Toggle a root-level class so frame CSS (toolbar, TOC, scrollbars) can
    // follow the theme's color scheme. Mirrors the slidev-shell mechanism.
    // Guarded for non-DOM contexts (e.g. worker bootstraps that import this
    // module path transitively).
    if (typeof document !== 'undefined' && document.documentElement) {
      const root = document.documentElement;
      root.classList.toggle('dark', colorSchema === 'dark');
      root.classList.toggle('light', colorSchema !== 'dark');
      // Persist the scheme so the workspace outer page (same origin) can
      // read it synchronously via an inline preload script before CSS
      // parses — prevents a white flash during iframe navigation.
      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('mdv-dark', colorSchema === 'dark' ? '1' : '0');
        }
      } catch { /* storage disabled */ }
    }
  } catch (error) {
    console.error('[Theme] Error loading theme:', error);
    throw error;
  }
}

async function loadThemeParts(
  theme: ThemeConfig,
  platform: PlatformAPI,
): Promise<[LayoutScheme, ColorScheme, TableStyleConfig, CodeThemeConfig]> {
  const [layoutScheme, colorScheme, tableStyle, codeTheme] = await Promise.all([
    fetchJSON(platform.resource.getURL(`themes/layout-schemes/${theme.layoutScheme}.json`)) as Promise<LayoutScheme>,
    fetchJSON(platform.resource.getURL(`themes/color-schemes/${theme.colorScheme}.json`)) as Promise<ColorScheme>,
    fetchJSON(platform.resource.getURL(`themes/table-styles/${theme.tableStyle}.json`)) as Promise<TableStyleConfig>,
    fetchJSON(platform.resource.getURL(`themes/code-themes/${theme.codeTheme}.json`)) as Promise<CodeThemeConfig>,
  ]);
  return [layoutScheme, colorScheme, tableStyle, codeTheme];
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
