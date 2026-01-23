/**
 * Theme Manager for Markdown Viewer Extension
 * Handles loading, applying, and managing themes
 */

import { fetchJSON } from './fetch-utils';
import type { Theme, FontScheme, HeadingConfig } from '../types/theme';
import type { PlatformAPI } from '../types/index';

/**
 * Font configuration for a single font
 */
interface FontConfig {
  webFallback: string;
  docx?: {
    ascii: string;
    eastAsia: string;
  };
}

/**
 * Font configuration file structure
 */
export interface FontConfigFile {
  fonts: Record<string, FontConfig>;
}

/**
 * DOCX font configuration
 */
interface DocxFont {
  ascii: string;
  eastAsia: string;
  hAnsi: string;
  cs: string;
}

/**
 * Theme info in registry
 */
interface ThemeRegistryInfo {
  id: string;
  file: string;
  category: string;
  featured?: boolean;
}

/**
 * Category info in registry
 */
interface CategoryInfo {
  name: string;
  name_en?: string;
  description?: string;
}

/**
 * Theme registry structure
 */
interface ThemeRegistry {
  themes: ThemeRegistryInfo[];
  categories: Record<string, CategoryInfo>;
}

/**
 * Theme metadata
 */
interface ThemeMetadata {
  id: string;
  name: string;
  name_en?: string;
  description?: string;
  description_en?: string;
  category: string;
  featured: boolean;
}

// Theme type is imported from types/theme.ts

/**
 * Category with themes
 */
interface CategoryWithThemes extends CategoryInfo {
  themes: ThemeMetadata[];
}

/**
 * Get platform instance from global scope
 * Platform is set by each platform's index.js before using shared modules
 */
function getPlatform(): PlatformAPI | undefined {
  return globalThis.platform;
}

/**
 * Theme Manager Class
 */
class ThemeManager {
  private currentTheme: Theme | null = null;
  private fontConfig: FontConfigFile | null = null;
  private registry: ThemeRegistry | null = null;
  private initialized: boolean = false;

  constructor() {
    this.currentTheme = null;
    this.fontConfig = null;
    this.registry = null;
    this.initialized = false;
  }

  /**
   * Initialize theme manager with data from Flutter
   * Used on mobile platform where Flutter loads assets and sends to WebView
   * @param fontConfig - Font configuration object
   * @param theme - Theme object
   */
  initializeWithData(fontConfig: FontConfigFile, theme?: Theme | null): void {
    this.fontConfig = fontConfig;
    if (theme) {
      this.currentTheme = theme;
    }
    this.initialized = true;
  }

  /**
   * Initialize theme manager by loading font config and registry
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      const platform = getPlatform();
      if (!platform) {
        throw new Error('Platform not available');
      }
      
      // Load font config
      const fontConfigUrl = platform.resource.getURL('themes/font-config.json');
      this.fontConfig = await fetchJSON(fontConfigUrl) as FontConfigFile;
      
      // Load theme registry
      const registryUrl = platform.resource.getURL('themes/registry.json');
      this.registry = await fetchJSON(registryUrl) as ThemeRegistry;
      
      this.initialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to initialize theme manager:', message);
      throw error;
    }
  }

  /**
   * Get font config for a given font name
   * @param fontName - Font name (e.g., 'SimSun', 'Times New Roman')
   * @returns Font fallback chain (CSS font-family string)
   */
  getFontFallback(fontName: string): string {
    if (!this.fontConfig) {
      console.warn('Font config not loaded yet');
      return fontName;
    }
    
    const font = this.fontConfig.fonts[fontName];
    
    if (!font) {
      console.warn(`Font '${fontName}' not found in font-config.json, using as-is`);
      return fontName;
    }
    
    return font.webFallback;
  }

  /**
   * Build complete font family stack
   * @param fontName - Font name
   * @returns Complete CSS font-family string
   */
  buildFontFamily(fontName: string): string {
    if (typeof fontName === 'string') {
      return this.getFontFallback(fontName);
    }
    
    // Fallback for unexpected input
    return String(fontName);
  }

  /**
   * Get DOCX font configuration for a given font name
   * @param fontName - Font name
   * @returns Complete DOCX font object with ascii, eastAsia, hAnsi, cs properties
   */
  getDocxFont(fontName: string): DocxFont {
    if (!this.fontConfig) {
      console.warn('Font config not loaded yet');
      return { ascii: fontName, eastAsia: fontName, hAnsi: fontName, cs: fontName };
    }
    
    const font = this.fontConfig.fonts[fontName];
    
    if (!font || !font.docx) {
      console.warn(`DOCX font config for '${fontName}' not found, using as-is`);
      return { ascii: fontName, eastAsia: fontName, hAnsi: fontName, cs: fontName };
    }
    
    const docxFont = font.docx;
    return {
      ascii: docxFont.ascii,
      eastAsia: docxFont.eastAsia,
      hAnsi: docxFont.ascii,
      cs: docxFont.ascii
    };
  }

  /**
   * Load a theme configuration from a JSON file
   * @param themeId - Theme ID (e.g., 'default', 'academic')
   * @returns Theme configuration object
   */
  async loadTheme(themeId: string): Promise<Theme> {
    // Ensure font fallbacks are loaded
    await this.initialize();
    
    try {
      const platform = getPlatform();
      if (!platform) {
        throw new Error('Platform not available');
      }
      const theme = await fetchJSON(platform.resource.getURL(`themes/presets/${themeId}.json`)) as Theme;
      this.currentTheme = theme;
      return theme;
    } catch (error) {
      console.error('Error loading theme:', error);
      throw error;
    }
  }

  /**
   * Load theme from storage
   * @returns Theme ID
   */
  async loadSelectedTheme(): Promise<string> {
    const platform = getPlatform();
    if (!platform) {
      return 'default';
    }
    try {
      // Prefer settings service
      if (platform.settings) {
        const theme = await platform.settings.get('themeId');
        return theme || 'default';
      }
    } catch {
      // fallthrough to default
    }
    return 'default';
  }

  /**
   * Save selected theme to storage
   * @param themeId - Theme ID to save
   */
  async saveSelectedTheme(themeId: string): Promise<void> {
    const platform = getPlatform();
    if (!platform) {
      return;
    }
    try {
      if (platform.settings) {
        await platform.settings.set('themeId', themeId, { refresh: false });
        return;
      }
    } catch (e) {
      // ignore and fallthrough
    }
  }

  /**
   * Get current theme configuration
   * @returns Current theme object
   */
  getCurrentTheme(): Theme | null {
    return this.currentTheme;
  }

  /**
   * Convert point size to pixels (for CSS)
   * @param ptSize - Size in points (e.g., '12pt')
   * @returns Size in pixels (e.g., '16px')
   */
  ptToPx(ptSize: string): string {
    const pt = parseFloat(ptSize);
    const px = pt * 4 / 3; // 1pt = 4/3 px (at 96 DPI)
    return `${px}px`;
  }

  /**
   * Convert point size to half-points (for DOCX)
   * @param ptSize - Size in points (e.g., '12pt')
   * @returns Size in half-points (e.g., 24)
   */
  ptToHalfPt(ptSize: string): number {
    const pt = parseFloat(ptSize);
    return pt * 2;
  }

  /**
   * Convert point size to twips (for DOCX spacing)
   * @param ptSize - Size in points (e.g., '13pt')
   * @returns Size in twips (e.g., 260)
   */
  ptToTwips(ptSize: string): number {
    const pt = parseFloat(ptSize);
    return Math.round(pt * 20); // 1pt = 20 twips
  }

  /**
   * Get all available themes from registry
   * @returns List of theme metadata
   */
  async getAvailableThemes(): Promise<ThemeMetadata[]> {
    await this.initialize();
    
    if (!this.registry) {
      return [];
    }
    
    const platform = getPlatform();
    if (!platform) {
      return [];
    }
    
    // Load theme names and descriptions
    const themes = await Promise.all(
      this.registry.themes.map(async (themeInfo): Promise<ThemeMetadata | null> => {
        try {
          const response = await fetch(
            platform.resource.getURL(`themes/presets/${themeInfo.file}`)
          );
          const theme = await response.json() as Theme;
          
          return {
            id: theme.id,
            name: theme.name,
            name_en: theme.name_en,
            description: theme.description,
            description_en: theme.description_en,
            category: themeInfo.category,
            featured: themeInfo.featured || false
          };
        } catch (error) {
          console.error(`Failed to load theme metadata for ${themeInfo.id}:`, error);
          return null;
        }
      })
    );
    
    return themes.filter((t): t is ThemeMetadata => t !== null);
  }

  /**
   * Get themes grouped by category
   * @returns Themes grouped by category
   */
  async getThemesByCategory(): Promise<Record<string, CategoryWithThemes>> {
    await this.initialize();
    
    const themes = await this.getAvailableThemes();
    const grouped: Record<string, CategoryWithThemes> = {};
    
    if (!this.registry) {
      return grouped;
    }
    
    // Initialize categories
    Object.keys(this.registry.categories).forEach(catId => {
      grouped[catId] = {
        ...this.registry!.categories[catId],
        themes: []
      };
    });
    
    // Group themes
    themes.forEach(theme => {
      if (grouped[theme.category]) {
        grouped[theme.category].themes.push(theme);
      }
    });
    
    return grouped;
  }

  /**
   * Switch to a different theme
   * @param themeId - Theme ID to switch to
   * @returns The loaded theme
   */
  async switchTheme(themeId: string): Promise<Theme> {
    // Load the new theme
    const theme = await this.loadTheme(themeId);
    
    // Save selection
    await this.saveSelectedTheme(themeId);
    
    return theme;
  }
}

// Create and export singleton instance
const themeManager = new ThemeManager();

export default themeManager;
