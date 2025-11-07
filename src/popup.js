// Markdown Viewer Extension - Popup Script

// Note: Popup cannot access IndexedDB directly due to security restrictions
// We use BackgroundCacheProxy to communicate with content scripts through background script

// Backup proxy for cache operations via background script
class BackgroundCacheProxy {
  constructor() {
    this.maxItems = 1000;
  }

  async getStats() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getCacheStats'
      });
      
      if (response && response.error) {
        throw new Error(response.error);
      }
      
      return response || {
        itemCount: 0,
        maxItems: this.maxItems,
        totalSize: 0,
        totalSizeMB: '0.00',
        items: [],
        message: 'No cache data available - please open a Markdown file first'
      };
    } catch (error) {
      console.error('Failed to get cache stats via background:', error);
      return {
        itemCount: 0,
        maxItems: this.maxItems,
        totalSize: 0,
        totalSizeMB: '0.00',
        items: [],
        message: 'Cache communication failed - please open a Markdown file first'
      };
    }
  }

  async clear() {
    try {
      return await chrome.runtime.sendMessage({
        action: 'clearCache'
      });
    } catch (error) {
      console.error('Failed to clear cache via background:', error);
      throw error;
    }
  }
}

class PopupManager {
  constructor() {
    this.cacheManager = null;
    this.currentTab = 'overview';
    this.settings = {
      maxCacheItems: 1000
    };
    
    this.init();
  }

  async init() {
    await this.loadSettings();
    this.setupEventListeners();
    this.initCacheManager();
    
    // If cache tab is active, load cache data
    if (this.currentTab === 'cache') {
      this.loadCacheData();
    }
  }

  async initCacheManager() {
        // Use BackgroundCacheProxy directly since popup can't access IndexedDB
        this.cacheManager = new BackgroundCacheProxy();
        
        try {
            // Load initial cache data
            await this.loadCacheData();
        } catch (error) {
            console.error('Failed to load cache data:', error);
            this.showError('Cache system unavailable - please open a Markdown file first');
            this.showManualCacheInfo();
        }
    }

  setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabName = e.target.dataset.tab;
        this.switchTab(tabName);
      });
    });

    // Cache management buttons
    const refreshBtn = document.getElementById('refresh-cache');
    const clearBtn = document.getElementById('clear-cache');
    const saveBtn = document.getElementById('save-settings');
    const resetBtn = document.getElementById('reset-settings');
    const demoBtn = document.getElementById('demo-link');

    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.loadCacheData();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearCache();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        this.saveSettings();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.resetSettings();
      });
    }

    if (demoBtn) {
      demoBtn.addEventListener('click', () => {
        this.openDemo();
      });
    }
  }

  switchTab(tabName) {
    // Update active tab button
    document.querySelectorAll('.tab').forEach(tab => {
      tab.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Update active tab panel
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    document.getElementById(tabName).classList.add('active');

    this.currentTab = tabName;

    // Load data for specific tabs
    if (tabName === 'cache') {
      this.loadCacheData();
    } else if (tabName === 'settings') {
      this.loadSettingsUI();
    }
  }

  async loadCacheData() {
    const loadingEl = document.getElementById('cache-loading');
    const contentEl = document.getElementById('cache-content');
    
    if (loadingEl) loadingEl.style.display = 'block';
    if (contentEl) contentEl.style.display = 'none';

    try {
      if (!this.cacheManager) {
        await this.initCacheManager();
      }

      if (!this.cacheManager) {
        throw new Error('Cache manager initialization failed');
      }

      const stats = await this.cacheManager.getStats();
      
      this.renderCacheStats(stats);
      
      // Handle items for new two-layer cache structure
      let items = [];
      if (stats.indexedDBCache?.items) {
        items = stats.indexedDBCache.items;
      } else if (stats.items) {
        items = stats.items;
      }
      
      this.renderCacheItems(items);

      if (loadingEl) loadingEl.style.display = 'none';
      if (contentEl) contentEl.style.display = 'block';
    } catch (error) {
      console.error('Failed to load cache data:', error);
      if (loadingEl) {
        loadingEl.textContent = '加载缓存信息失败: ' + error.message;
      }
    }
  }

  renderCacheStats(stats) {
    const statsEl = document.getElementById('cache-stats');
    
    // Handle new two-layer cache structure, but only show meaningful data to users
    let itemCount = 0;
    let totalSizeMB = '0.00';
    let maxItems = 1000;
    
    if (stats.indexedDBCache) {
      // Use IndexedDB cache as the source of truth
      itemCount = stats.indexedDBCache.itemCount || 0;
      totalSizeMB = stats.indexedDBCache.totalSizeMB || '0.00';
      maxItems = stats.indexedDBCache.maxItems || 1000;
    } else {
      // Fallback for old structure
      itemCount = stats.itemCount || 0;
      totalSizeMB = stats.totalSizeMB || '0.00';
      maxItems = stats.maxItems || 1000;
    }
    
    // Show message if cache is empty or unavailable
    if (itemCount === 0 && stats.message) {
      statsEl.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 15px;">
          <div style="font-size: 14px; margin-bottom: 8px;">💡 ${stats.message}</div>
          <div style="font-size: 12px; opacity: 0.8;">
            缓存功能在 Markdown 文件页面中正常工作
          </div>
        </div>
      `;
      return;
    }
    
    const usagePercent = Math.round((itemCount / maxItems) * 100);
    
    statsEl.innerHTML = `
      <div class="stat-item">
        <div class="stat-value">${itemCount}</div>
        <div class="stat-label">缓存项目</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${totalSizeMB}MB</div>
        <div class="stat-label">占用空间</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${usagePercent}%</div>
        <div class="stat-label">容量使用</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${maxItems}</div>
        <div class="stat-label">最大容量</div>
      </div>
    `;
  }

  renderCacheItems(items) {
    const itemsEl = document.getElementById('cache-items');
    
    // Handle new two-layer cache structure, but only show IndexedDB items
    let allItems = [];
    
    if (Array.isArray(items)) {
      // Old structure - items is directly an array
      allItems = items;
    } else if (items && typeof items === 'object') {
      // New structure - only show IndexedDB items (persistent cache)
      if (items.indexedDBCache?.items) {
        allItems = items.indexedDBCache.items;
      }
    }
    
    if (allItems.length === 0) {
      itemsEl.innerHTML = '<div class="cache-item">暂无缓存项目</div>';
      return;
    }

    itemsEl.innerHTML = allItems.map(item => `
      <div class="cache-item">
        <div class="cache-item-key">
          ${item.key}
        </div>
        <div class="cache-item-info">
          <span>类型: ${item.type || 'unknown'}</span>
          <span>大小: ${item.sizeMB || (item.size ? (item.size / (1024 * 1024)).toFixed(3) : '0.000')}MB</span>
        </div>
        ${item.created ? `
        <div class="cache-item-info">
          <span>创建: ${new Date(item.created).toLocaleString('zh-CN')}</span>
        </div>
        ` : ''}
        ${item.lastAccess ? `
        <div class="cache-item-info">
          <span>访问: ${new Date(item.lastAccess).toLocaleString('zh-CN')}</span>
        </div>
        ` : ''}
      </div>
    `).join('');
  }

  async clearCache() {
    if (!confirm('确定要清空所有缓存吗？这个操作不可撤销。')) {
      return;
    }

    try {
      if (!this.cacheManager) {
        await this.initCacheManager();
      }

      await this.cacheManager.clear();
      this.loadCacheData(); // Refresh display
      this.showMessage('缓存已清空', 'success');
    } catch (error) {
      console.error('Failed to clear cache:', error);
      this.showMessage('清空缓存失败', 'error');
    }
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.local.get(['markdownViewerSettings']);
      if (result.markdownViewerSettings) {
        this.settings = { ...this.settings, ...result.markdownViewerSettings };
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  loadSettingsUI() {
    const maxCacheItemsEl = document.getElementById('max-cache-items');
    if (maxCacheItemsEl) {
      maxCacheItemsEl.value = this.settings.maxCacheItems;
    }
  }

  async saveSettings() {
    try {
      const maxCacheItemsEl = document.getElementById('max-cache-items');
      const maxCacheItems = parseInt(maxCacheItemsEl.value, 10);

      if (isNaN(maxCacheItems) || maxCacheItems < 100 || maxCacheItems > 5000) {
        this.showMessage('请输入有效的缓存项目数 (100-5000)', 'error');
        return;
      }

      this.settings.maxCacheItems = maxCacheItems;
      
      await chrome.storage.local.set({
        markdownViewerSettings: this.settings
      });

      // Update cache manager if needed
      if (this.cacheManager && this.cacheManager.maxItems !== maxCacheItems) {
        this.cacheManager.maxItems = maxCacheItems;
      }

      this.showMessage('设置已保存', 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showMessage('保存设置失败', 'error');
    }
  }

  async resetSettings() {
    if (!confirm('确定要重置所有设置为默认值吗？')) {
      return;
    }

    try {
      this.settings = {
        maxCacheItems: 1000
      };

      await chrome.storage.local.set({
        markdownViewerSettings: this.settings
      });

      this.loadSettingsUI();
      this.showMessage('设置已重置', 'success');
    } catch (error) {
      console.error('Failed to reset settings:', error);
      this.showMessage('重置设置失败', 'error');
    }
  }

  showMessage(text, type = 'info') {
    // Create a simple toast message
    const message = document.createElement('div');
    message.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: ${type === 'success' ? '#27ae60' : type === 'error' ? '#e74c3c' : '#3498db'};
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 12px;
      z-index: 1000;
      opacity: 0;
      transition: opacity 0.3s;
    `;
    message.textContent = text;
    
    document.body.appendChild(message);
    
    // Animate in
    setTimeout(() => {
      message.style.opacity = '1';
    }, 100);
    
    // Animate out and remove
    setTimeout(() => {
      message.style.opacity = '0';
      setTimeout(() => {
        document.body.removeChild(message);
      }, 300);
    }, 2000);
  }

  showError(text) {
    console.error('Popup Error:', text);
    this.showMessage(`❌ ${text}`);
  }

  async openDemo() {
    try {
      const demoUrl = 'https://raw.githubusercontent.com/xicilion/markdown-viewer-extension/refs/heads/main/test/test.md';
      
      // Create a new tab with the demo URL
      await chrome.tabs.create({
        url: demoUrl,
        active: true
      });
      
      // Close the popup window after opening the demo
      window.close();
    } catch (error) {
      console.error('Failed to open demo:', error);
      this.showMessage('打开演示文档失败', 'error');
    }
  }

  showManualCacheInfo() {
    const loadingEl = document.getElementById('cache-loading');
    const contentEl = document.getElementById('cache-content');
    
    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) {
      contentEl.style.display = 'block';
      contentEl.innerHTML = `
        <div class="info-section">
          <h3>⚠️ 缓存访问限制</h3>
          <p>由于浏览器安全限制，popup 窗口无法直接访问 IndexedDB 缓存。</p>
          <p>缓存功能在页面渲染中正常工作，但无法在此处显示详细信息。</p>
        </div>
        
        <div class="info-section">
          <h3>📊 缓存状态检查</h3>
          <p>要查看缓存是否工作：</p>
          <ul style="list-style: none; padding-left: 0;">
            <li>✓ 打开一个 Markdown 文件</li>
            <li>✓ 观察渲染速度（有缓存时更快）</li>
            <li>✓ 在开发者工具中查看 "⚡ Using cached" 信息</li>
          </ul>
        </div>
        
        <div class="info-section">
          <h3>🧹 清空缓存</h3>
          <p>如需清空缓存，请：</p>
          <ol style="list-style: none; padding-left: 0;">
            <li>1. 打开任意 Markdown 文件</li>
            <li>2. 按 F12 打开开发者工具</li>
            <li>3. 在控制台执行：<code style="background: rgba(255,255,255,0.2); padding: 2px 4px; border-radius: 2px;">window.extensionRenderer?.cacheManager?.clear()</code></li>
          </ol>
        </div>
      `;
    }
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  try {
    const popupManager = new PopupManager();
    
    // Store reference globally for debugging
    window.popupManager = popupManager;
  } catch (error) {
    console.error('Failed to create PopupManager:', error);
  }
});