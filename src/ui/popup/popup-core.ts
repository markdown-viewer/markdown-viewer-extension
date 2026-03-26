/**
 * Shared popup core logic
 * Platform-independent popup implementation
 * Platform must be initialized before importing this module
 */

import Localization from '../../utils/localization';
import { applyI18nText, translate } from './i18n-helpers';
import { isFirefoxPopup } from './platform-detect';
import { showConfirm, showMessage, showError, checkFileAccess } from './ui-helpers';
import { createCacheTabManager, type CacheTabManager } from './cache-tab';
import { createHistoryTabManager, type HistoryTabManager } from './history-tab';
import { createSettingsTabManager, type SettingsTabManager } from './settings-tab';

/**
 * Tab name type
 */
type TabName = 'history' | 'theme' | 'settings' | 'about' | 'cache';

/**
 * Main popup manager class
 * Coordinates between different tab managers
 */
class PopupManager {
  private currentTab: TabName = 'history';
  private cacheTab: CacheTabManager;
  private historyTab: HistoryTabManager;
  private settingsTab: SettingsTabManager;

  constructor() {
    // Create tab managers with shared dependencies
    this.cacheTab = createCacheTabManager({
      showMessage,
      showConfirm
    });
    
    this.historyTab = createHistoryTabManager({
      showMessage,
      showConfirm
    });
    
    this.settingsTab = createSettingsTabManager({
      showMessage,
      showConfirm,
      onReloadCacheData: () => {
        if (this.currentTab === 'cache') {
          this.cacheTab.loadCacheData();
        }
      }
    });

    this.init();
  }

  private async init(): Promise<void> {
    await this.settingsTab.loadSettings();
    this.setupEventListeners();
    checkFileAccess();

    // Initialize language selector in header (always visible)
    this.settingsTab.setupLanguageSelector();

    // Only load data for the active tab
    if (this.currentTab === 'cache') {
      this.cacheTab.loadCacheData();
    } else if (this.currentTab === 'history') {
      this.historyTab.loadHistoryData();
    }
  }

  private setupEventListeners(): void {
    // Add click handler for extension title
    const extensionTitle = document.getElementById('extension-title');
    if (extensionTitle) {
      extensionTitle.addEventListener('click', () => {
        window.open('https://docu.md', '_blank');
      });
    }

    // Add click handler for review link
    const reviewLink = document.getElementById('review-link');
    if (reviewLink) {
      reviewLink.addEventListener('click', (e) => {
        e.preventDefault();
        const reviewUrl = isFirefoxPopup()
          ? 'https://addons.mozilla.org/firefox/addon/markdown-viewer-extension/reviews/'
          : 'https://chromewebstore.google.com/detail/markdown-viewer/jekhhoflgcfoikceikgeenibinpojaoi/reviews';
        window.open(reviewUrl, '_blank');
      });
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', (event) => {
        const target = event.currentTarget as HTMLElement;
        const tabName = target.dataset.tab as TabName;
        this.switchTab(tabName);
      });
    });

    // Cache tab buttons
    const refreshBtn = document.getElementById('refresh-cache');
    const clearBtn = document.getElementById('clear-cache');
    
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.cacheTab.loadCacheData());
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.cacheTab.clearCache());
    }

    // History tab buttons
    const refreshHistoryBtn = document.getElementById('refresh-history');
    const clearHistoryBtn = document.getElementById('clear-history');
    
    if (refreshHistoryBtn) {
      refreshHistoryBtn.addEventListener('click', () => this.historyTab.loadHistoryData());
    }
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => this.historyTab.clearHistory());
    }
  }

  private switchTab(tabName: TabName): void {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.remove('active');
    });

    const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
    if (activeTab) {
      activeTab.classList.add('active');
    }

    // Update tab panels
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.remove('active');
    });

    const activePanel = document.getElementById(tabName);
    if (activePanel) {
      activePanel.classList.add('active');
    }

    this.currentTab = tabName;

    // Load tab-specific data
    if (tabName === 'settings') {
      this.settingsTab.loadSettingsUI();
      this.cacheTab.loadCacheData(); // Load cache stats for settings tab
    } else if (tabName === 'theme') {
      this.settingsTab.loadSettingsUI();
    } else if (tabName === 'history') {
      this.historyTab.loadHistoryData();
    }
  }

  // Expose methods for external access
  public showMessage(text: string, type: 'success' | 'error' | 'info'): void {
    showMessage(text, type);
  }

  public showError(text: string): void {
    showError(text);
  }
}

// Extend Window interface
declare global {
  interface Window {
    popupManager: PopupManager;
  }
}

/**
 * Initialize the popup
 * Call this after platform is initialized
 */
export async function initializePopup(): Promise<void> {
  try {
    await Localization.init();

    // Set version from manifest
    const manifest = chrome.runtime.getManifest();
    
    const versionEl = document.getElementById('version-text');
    if (versionEl && manifest.version) {
      versionEl.dataset.i18nArgs = manifest.version;
    }

    applyI18nText();
    
    const popupManager = new PopupManager();

    window.popupManager = popupManager;
  } catch (error) {
    console.error('Failed to create PopupManager:', error);
  }
}

// Re-export utilities for platform-specific usage
export { translate, applyI18nText, showMessage, showError, showConfirm };
