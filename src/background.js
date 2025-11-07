// Background script for handling messages between content script and offscreen document
import ExtensionCacheManager from './cache-manager.js';

let offscreenCreated = false;
let globalCacheManager = null;

// Initialize the global cache manager
async function initGlobalCacheManager() {
  try {
    globalCacheManager = new ExtensionCacheManager();
    await globalCacheManager.initDB();
    return globalCacheManager;
  } catch (error) {
    return null;
  }
}

// Initialize cache manager when background script loads
initGlobalCacheManager();

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'offscreenReady') {
    offscreenCreated = true;
    return;
  }
  
  if (message.type === 'offscreenDOMReady') {
    return;
  }
  
  if (message.type === 'offscreenError') {
    return;
  }
  
  if (message.type === 'injectContentScript') {
    handleContentScriptInjection(sender.tab.id, sendResponse);
    return true; // Keep message channel open for async response
  }
  
  // Handle cache operations
  if (message.action === 'getCacheStats' || message.action === 'clearCache') {
    handleCacheRequest(message, sendResponse);
    return true; // Keep message channel open for async response
  }
  
  // Handle cache operations for content scripts
  if (message.type === 'cacheOperation') {
    handleContentCacheOperation(message, sendResponse);
    return true; // Keep message channel open for async response
  }
  
  // Forward rendering messages to offscreen document
  if (message.type === 'renderMermaid' || message.type === 'renderHtml' || message.type === 'renderSvg') {
    handleRenderingRequest(message, sendResponse);
    return true; // Keep message channel open for async response
  }
  
  // Handle local file reading
  if (message.type === 'READ_LOCAL_FILE') {
    handleFileRead(message, sendResponse);
    return true; // Keep message channel open for async response
  }
});

async function handleContentCacheOperation(message, sendResponse) {
  try {
    // Ensure global cache manager is initialized
    if (!globalCacheManager) {
      globalCacheManager = await initGlobalCacheManager();
    }
    
    if (!globalCacheManager) {
      sendResponse({ error: 'Cache system initialization failed' });
      return;
    }
    
    switch (message.operation) {
      case 'get':
        const item = await globalCacheManager.get(message.key);
        sendResponse({ result: item });
        break;
        
      case 'set':
        await globalCacheManager.set(message.key, message.value, message.dataType);
        sendResponse({ success: true });
        break;
        
      case 'clear':
        await globalCacheManager.clear();
        sendResponse({ success: true });
        break;
        
      case 'getStats':
        const stats = await globalCacheManager.getStats();
        sendResponse({ result: stats });
        break;
        
      default:
        sendResponse({ error: 'Unknown cache operation' });
    }
    
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

async function handleCacheRequest(message, sendResponse) {
  try {
    // Ensure global cache manager is initialized
    if (!globalCacheManager) {
      globalCacheManager = await initGlobalCacheManager();
    }
    
    if (!globalCacheManager) {
      sendResponse({
        itemCount: 0,
        maxItems: 1000,
        totalSize: 0,
        totalSizeMB: '0.00',
        items: [],
        message: 'Cache system initialization failed'
      });
      return;
    }
    
    if (message.action === 'getCacheStats') {
      const stats = await globalCacheManager.getStats();
      sendResponse(stats);
    } else if (message.action === 'clearCache') {
      await globalCacheManager.clear();
      sendResponse({ success: true, message: 'Cache cleared successfully' });
    } else {
      sendResponse({ error: 'Unknown cache action' });
    }
    
  } catch (error) {
    sendResponse({ 
      error: error.message,
      itemCount: 0,
      maxItems: 1000,
      totalSize: 0,
      totalSizeMB: '0.00',
      items: [],
      message: 'Cache operation failed'
    });
  }
}

async function handleFileRead(message, sendResponse) {
  try {
    // Use fetch to read the file - this should work from background script
    const response = await fetch(message.filePath);
    
    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.status} ${response.statusText}`);
    }
    
    const content = await response.text();
    sendResponse({ content });
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

async function handleRenderingRequest(message, sendResponse) {
  try {
    // Ensure offscreen document exists
    await ensureOffscreenDocument();
    
    // Check offscreen contexts again
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (contexts.length === 0) {
      throw new Error('Offscreen document not found after creation. This may indicate a path or loading issue.');
    }
    
    // Send message to offscreen document
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: `Offscreen communication failed: ${chrome.runtime.lastError.message}` });
      } else if (!response) {
        sendResponse({ error: 'No response from offscreen document. Document may have failed to load.' });
      } else {
        sendResponse(response);
      }
    });
    
  } catch (error) {
    sendResponse({ error: `Offscreen setup failed: ${error.message}` });
  }
}

async function ensureOffscreenDocument() {
  if (offscreenCreated) {
    return;
  }
  
  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }
  
  try {
    // Create new offscreen document
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['DOM_SCRAPING'],
      justification: 'Render Mermaid diagrams, SVG and HTML to PNG'
    });

    offscreenCreated = true;
    
    // Wait a bit for offscreen document to load
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify the document was created successfully
    const verifyContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (verifyContexts.length === 0) {
      throw new Error(`Offscreen document creation verification failed. URL: ${offscreenUrl}`);
    }
    
  } catch (error) {
    offscreenCreated = false;
    throw new Error(`Failed to create offscreen document: ${error.message}`);
  }
}

// Handle dynamic content script injection
async function handleContentScriptInjection(tabId, sendResponse) {
  try {
    // Inject CSS first
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ['styles.css']
    });
    
    // Then inject JavaScript
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    
    sendResponse({ success: true });
    
  } catch (error) {
    sendResponse({ error: error.message });
  }
}