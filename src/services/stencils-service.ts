/**
 * Stencils Service
 * 
 * Provides DrawIO stencil loading using platform resource fetch API.
 * Similar pattern to i18n locale loading - fetches stencil JSON files on demand.
 */

import { createStencilBundle, type StencilBundle, type StencilGroupSource } from '@markdown-viewer/drawio2svg';
import type { PlatformAPI } from '../types/platform';

/**
 * Get platform instance from global scope
 * Platform is set by each platform's index.js before using shared modules
 */
function getPlatform(): PlatformAPI | undefined {
  return globalThis.platform;
}

/**
 * Stencil manifest entry
 */
export interface StencilManifestEntry {
  group: string;
  file: string;
  count: number;
  size: number;
}

/**
 * Stencil manifest structure (index.json)
 */
export interface StencilManifest {
  generatedAt: string;
  totalShapes: number;
  totalGroups: number;
  totalFiles: number;
  groups: StencilManifestEntry[];
}

/**
 * Stencil data file structure
 */
interface StencilDataFile {
  group: string;
  count: number;
  data: string; // base64 encoded, deflate compressed
}

// Singleton instance
let stencilsService: StencilsService | null = null;

/**
 * Get the singleton stencils service instance
 */
export function getStencilsService(): StencilsService {
  if (!stencilsService) {
    stencilsService = new StencilsService();
  }
  return stencilsService;
}

/**
 * StencilsService - manages DrawIO stencil loading
 */
export class StencilsService {
  private manifest: StencilManifest | null = null;
  private groupFiles: Map<string, string> = new Map();
  private dataCache: Map<string, string> = new Map();
  private loadingPromises: Map<string, Promise<string | null>> = new Map(); // Prevent duplicate loading
  private bundle: StencilBundle | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the stencils service by loading the manifest
   */
  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const platform = getPlatform();
      if (!platform) return;

      // Fetch manifest
      const manifestJson = await platform.resource.fetch('stencils/index.json');
      this.manifest = JSON.parse(manifestJson) as StencilManifest;

      // Build group -> file mapping
      for (const entry of this.manifest.groups) {
        if (entry && entry.group && entry.file) {
          this.groupFiles.set(entry.group, entry.file);
        }
      }
    } catch (error) {
      // Failed to load manifest - stencils will not be available
      this.manifest = null;
    }
  }

  /**
   * Get the stencil bundle (lazy-loading)
   * Call init() first to load the manifest
   */
  getBundle(): StencilBundle | null {
    if (this.bundle) {
      return this.bundle;
    }

    if (!this.manifest) {
      return null;
    }

    const source: StencilGroupSource = {
      groups: () => this.manifest!.groups.map(g => g.group),
      load: (group: string) => this.loadGroupSync(group)
    };

    this.bundle = createStencilBundle(source);
    return this.bundle;
  }

  /**
   * Preload specific stencil groups (for async loading)
   */
  async preloadGroups(groups: string[]): Promise<void> {
    const platform = getPlatform();
    if (!platform) return;

    const promises = groups.map(async (group) => {
      if (this.dataCache.has(group)) return;
      
      const file = this.groupFiles.get(group);
      if (!file) return;

      try {
        const json = await platform.resource.fetch(`stencils/${file}`);
        const payload = JSON.parse(json) as StencilDataFile;
        if (payload && payload.data) {
          this.dataCache.set(group, payload.data);
        }
      } catch (error) {
        // Silently fail - stencil will just not render
      }
    });

    await Promise.all(promises);
  }

  /**
   * Load a stencil group synchronously (returns null if not cached)
   * This is called by the StencilBundle during rendering
   */
  private loadGroupSync(group: string): string | null {
    // Return from cache if available
    if (this.dataCache.has(group)) {
      return this.dataCache.get(group)!;
    }

    // Trigger async load for next time (fire and forget)
    this.loadGroupAsync(group).catch(() => {});

    return null;
  }

  /**
   * Load a stencil group asynchronously
   */
  private async loadGroupAsync(group: string): Promise<string | null> {
    if (this.dataCache.has(group)) {
      return this.dataCache.get(group)!;
    }

    // Check if already loading - prevent duplicate requests
    const existingPromise = this.loadingPromises.get(group);
    if (existingPromise) {
      return existingPromise;
    }

    const platform = getPlatform();
    if (!platform) {
      return null;
    }

    const file = this.groupFiles.get(group);
    if (!file) {
      return null;
    }
    
    // Create loading promise and store it
    const loadPromise = (async () => {
      try {
        const json = await platform.resource.fetch(`stencils/${file}`);
        const payload = JSON.parse(json) as StencilDataFile;
        if (payload && payload.data) {
          this.dataCache.set(group, payload.data);
          return payload.data;
        }
      } catch (error) {
        // Silently fail
      } finally {
        // Remove from loading promises when done
        this.loadingPromises.delete(group);
      }
      return null;
    })();

    this.loadingPromises.set(group, loadPromise);
    return loadPromise;
  }

  /**
   * Get list of available stencil groups
   */
  getGroups(): string[] {
    return this.manifest ? this.manifest.groups.map(g => g.group) : [];
  }

  /**
   * Check if a group is loaded in cache
   */
  isGroupLoaded(group: string): boolean {
    return this.dataCache.has(group);
  }

  /**
   * Get manifest info
   */
  getManifest(): StencilManifest | null {
    return this.manifest;
  }
}
