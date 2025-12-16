// Markdown Viewer Extension - Popup Script
// Main entry point for popup UI

// Initialize platform before using shared modules that depend on globalThis.platform
import '../../platform/chrome/index.js';
import Localization from '../../utils/localization.js';

// Import modular components
import { applyI18nText } from './i18n-helpers.js';
import { showConfirm, showMessage, showError, checkFileAccess } from './ui-helpers.js';
import { createCacheTabManager } from './cache-tab.js';
import { createHistoryTabManager } from './history-tab.js';
import { createSettingsTabManager } from './settings-tab.js';

/**
 * Main popup manager class
 * Coordinates between different tab managers
 */
class PopupManager {
  constructor() {
    this.currentTab = 'history';
    
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

  async init() {
    await this.settingsTab.loadSettings();
    this.setupEventListeners();
    this.cacheTab.initCacheManager();
    checkFileAccess();

    if (this.currentTab === 'cache') {
      this.cacheTab.loadCacheData();
    } else if (this.currentTab === 'history') {
      this.historyTab.loadHistoryData();
    }
  }

  setupEventListeners() {
    // Add click handler for extension title
    const extensionTitle = document.getElementById('extension-title');
    if (extensionTitle) {
      extensionTitle.addEventListener('click', () => {
        chrome.tabs.create({
          url: 'https://chromewebstore.google.com/detail/markdown-viewer/jekhhoflgcfoikceikgeenibinpojaoi'
        });
      });
    }

    // Add click handler for review link
    const reviewLink = document.getElementById('review-link');
    if (reviewLink) {
      reviewLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({
          url: 'https://chromewebstore.google.com/detail/markdown-viewer/jekhhoflgcfoikceikgeenibinpojaoi/reviews'
        });
      });
    }

    // Tab switching
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', (event) => {
        const tabName = event.currentTarget.dataset.tab;
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

    // Settings tab buttons
    const saveBtn = document.getElementById('save-settings');
    const resetBtn = document.getElementById('reset-settings');
    
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.settingsTab.saveSettings());
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.settingsTab.resetSettings());
    }
  }

  switchTab(tabName) {
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
    if (tabName === 'cache') {
      this.cacheTab.loadCacheData();
    } else if (tabName === 'settings') {
      this.settingsTab.loadSettingsUI();
    } else if (tabName === 'history') {
      this.historyTab.loadHistoryData();
    }
  }

  // Expose methods for external access
  showMessage(text, type) {
    showMessage(text, type);
  }

  showError(text) {
    showError(text);
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
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
});
