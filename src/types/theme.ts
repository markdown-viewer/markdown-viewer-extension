/**
 * Theme Type Definitions
 * Types for theme system
 */

// =============================================================================
// Color Scheme Types
// =============================================================================

/**
 * Color scheme configuration
 * Manages all color-related settings for a theme
 */
export interface ColorScheme {
  id: string;
  name: string;
  name_en: string;
  description: string;
  description_en?: string;
  
  text: {
    primary: string;    // Main text color
    secondary: string;  // Secondary text (captions, etc.)
    muted: string;      // Muted text (footnotes, etc.)
  };
  
  accent: {
    link: string;       // Link color
    linkHover: string;  // Link hover color
  };
  
  background: {
    code: string;       // Code block background
    /** Page background color. Falls back to #ffffff when absent. */
    page?: string;
    /** Surface color for cards / callouts. Falls back to page when absent. */
    surface?: string;
    /** Blockquote background. Falls back to transparent when absent. */
    blockquote?: string;
  };
  
  blockquote: {
    border: string;     // Blockquote left border color
  };
  
  table: {
    border: string;           // Table and cell border color
    headerBackground: string; // Table header background
    headerText: string;       // Table header text color
    zebraEven: string;        // Even row background (zebra stripes)
    zebraOdd: string;         // Odd row background (zebra stripes)
  };
  
  /** Optional per-heading colors for colorful themes like rainbow */
  headings?: {
    h1?: string;
    h2?: string;
    h3?: string;
    h4?: string;
    h5?: string;
    h6?: string;
    /** Optional border color used when a layout scheme defines headings[level].borderBottom */
    border?: string;
  };

  /** Optional horizontal rule color. Web preview only — not applied by DOCX/other renderers. */
  rule?: {
    color?: string;
  };
}

// =============================================================================
// Font Configuration Types
// =============================================================================

/**
 * Heading style configuration (font-related properties only)
 * Layout properties (fontSize, alignment, spacing) are in LayoutScheme
 */
export interface HeadingConfig {
  fontFamily?: string;
  fontWeight?: string;
}

/**
 * Font scheme configuration (font-related properties only)
 * Layout properties (fontSize, lineHeight, spacing) are in LayoutScheme
 * Color properties are in ColorScheme
 */
export interface FontScheme {
  body: {
    fontFamily: string;
  };
  headings: HeadingsConfig;
  code: {
    fontFamily: string;
  };
}

/**
 * Headings font configuration
 * Top-level fontFamily/fontWeight apply to all headings (h1-h6)
 * Individual h1-h6 configs can override the defaults
 */
export interface HeadingsConfig {
  /** Default font family for all headings (h1-h6) */
  fontFamily?: string;
  /** Default font weight for all headings (h1-h6) */
  fontWeight?: string;
  /** Individual heading overrides */
  h1?: HeadingConfig;
  h2?: HeadingConfig;
  h3?: HeadingConfig;
  h4?: HeadingConfig;
  h5?: HeadingConfig;
  h6?: HeadingConfig;
  /** Allow dynamic access by level name */
  [key: string]: HeadingConfig | string | undefined;
}

// =============================================================================
// Table Style Types
// =============================================================================

/**
 * Border configuration (layout properties only)
 * Color is from ColorScheme
 */
export interface BorderConfig {
  style: string;
  width: string;
}

/**
 * Table style configuration (layout properties only)
 * Color properties are in ColorScheme
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
  };
  cell: {
    padding: string;
  };
  zebra?: {
    enabled: boolean;
  };
}

// =============================================================================
// Code Theme Types
// =============================================================================

/**
 * Code theme color configuration
 */
export interface CodeThemeConfig {
  colors: Record<string, string>;
  foreground?: string;
}

// =============================================================================
// Layout Types
// =============================================================================

/**
 * Layout scheme heading configuration
 */
export interface LayoutHeadingConfig {
  fontSize: string;
  spacingBefore: string;
  spacingAfter: string;
  alignment?: 'left' | 'center' | 'right';
  /** Optional unitless line-height override (e.g. 1.25). Web preview only — not applied by DOCX/other renderers. */
  lineHeight?: number;
  /** Optional bottom border (e.g. VSCode-style h1/h2 underline). Color from colorScheme.headings.border.
   *  Web preview only — not applied by DOCX/other renderers. */
  borderBottom?: {
    width: string;
    style?: string;
    paddingBottom?: string;
  };
}

/**
 * Layout scheme block configuration
 */
export interface LayoutBlockConfig {
  spacingBefore?: string;
  spacingAfter?: string;
  paddingVertical?: string;
  paddingHorizontal?: string;
  /** Optional border width for horizontal rule. Color from colorScheme.rule.color.
   *  Web preview only — not applied by DOCX/other renderers. */
  borderWidth?: string;
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

// =============================================================================
// Theme Types
// =============================================================================

/**
 * Complete theme definition (loaded from theme files)
 */
export interface Theme {
  id: string;
  name: string;
  name_en?: string;
  description?: string;
  description_en?: string;
  author?: string;
  version?: string;
  fontScheme: FontScheme;
  layoutScheme: string;   // Reference to layout scheme
  colorScheme: string;    // Reference to color scheme
  tableStyle: string;     // Reference to table style
  codeTheme: string;      // Reference to code theme
}

/**
 * Theme definition from registry
 */
export interface ThemeDefinition {
  id: string;
  name: string;
  name_en: string;
  description?: string;
  description_en?: string;
  category: string;
  featured?: boolean;
}

/**
 * Theme category info
 */
export interface ThemeCategoryInfo {
  name: string;
  name_en: string;
  order?: number;
}

/**
 * Theme registry structure
 */
export interface ThemeRegistry {
  categories: Record<string, ThemeCategoryInfo>;
  themes: Array<{
    id: string;
    file: string;
    category: string;
    featured?: boolean;
  }>;
}

/**
 * Theme registry info (cached version)
 */
export interface ThemeRegistryInfo {
  id: string;
  name: string;
  category: string;
}
