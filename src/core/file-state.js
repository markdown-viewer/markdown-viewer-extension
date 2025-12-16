// File State Manager
// Handles saving and loading file-specific state (scroll, TOC, zoom, layout)

/**
 * Get current document URL without hash/anchor
 * @returns {string} Current document URL without hash
 */
export function getCurrentDocumentUrl() {
  const url = document.location.href;
  try {
    const urlObj = new URL(url);
    // Remove hash/anchor
    urlObj.hash = '';
    return urlObj.href;
  } catch (e) {
    // Fallback: simple string removal
    const hashIndex = url.indexOf('#');
    return hashIndex >= 0 ? url.substring(0, hashIndex) : url;
  }
}

/**
 * Creates a file state manager for handling file-specific state persistence.
 * @param {Object} platform - Platform API for messaging
 * @returns {Object} File state manager instance
 */
export function createFileStateManager(platform) {
  /**
   * Save file state to background script
   * @param {Object} state - State object containing scrollPosition, tocVisible, zoom, layoutMode
   */
  function saveFileState(state) {
    try {
      platform.message.send({
        type: 'saveFileState',
        url: getCurrentDocumentUrl(),
        state: state
      }).catch(() => {}); // Fire and forget
    } catch (e) {
      console.error('[FileState] Save error:', e);
    }
  }

  /**
   * Get saved file state from background script
   * @returns {Promise<Object>} State object
   */
  async function getFileState() {
    try {
      const response = await platform.message.send({
        type: 'getFileState',
        url: getCurrentDocumentUrl()
      });
      return response?.state || {};
    } catch (e) {
      console.error('[FileState] Get error:', e);
      return {};
    }
  }

  return {
    saveFileState,
    getFileState
  };
}

/**
 * Get filename from URL with proper decoding and hash removal
 * @returns {string} Filename from URL
 */
export function getFilenameFromURL() {
  const url = getCurrentDocumentUrl();
  const urlParts = url.split('/');
  let fileName = urlParts[urlParts.length - 1] || 'document.md';

  // Decode URL encoding
  try {
    fileName = decodeURIComponent(fileName);
  } catch (e) {
    // Ignore decoding errors
  }

  return fileName;
}

/**
 * Get document filename for export (DOCX)
 * @returns {string} Document filename with .docx extension
 */
export function getDocumentFilename() {
  // Get base filename
  const fileName = getFilenameFromURL();

  // Remove .md or .markdown extension and add .docx
  const nameWithoutExt = fileName.replace(/\.(md|markdown)$/i, '');
  if (nameWithoutExt) {
    return nameWithoutExt + '.docx';
  }

  // Try to get from first h1 heading
  const firstH1 = document.querySelector('#markdown-content h1');
  if (firstH1) {
    const title = firstH1.textContent.trim()
      .replace(/[^\w\s\u4e00-\u9fa5-]/g, '') // Keep alphanumeric, spaces, Chinese chars, and dashes
      .replace(/\s+/g, '-') // Replace spaces with dashes
      .substring(0, 50); // Limit length

    if (title) {
      return title + '.docx';
    }
  }

  // Default fallback
  return 'document.docx';
}

/**
 * Extract filename from URL
 * @param {string} url - URL to extract filename from
 * @returns {string} Extracted filename
 */
export function extractFileName(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const fileName = pathname.split('/').pop();
    return decodeURIComponent(fileName);
  } catch (error) {
    return url;
  }
}

/**
 * Save current document to history
 * @param {Object} platform - Platform API for storage
 */
export async function saveToHistory(platform) {
  try {
    const url = getCurrentDocumentUrl();
    const title = document.title || extractFileName(url);
    
    const result = await platform.storage.get(['markdownHistory']);
    const history = result.markdownHistory || [];
    
    // Remove existing entry for this URL
    const filteredHistory = history.filter(item => item.url !== url);
    
    // Add new entry at the beginning
    filteredHistory.unshift({
      url: url,
      title: title,
      lastAccess: new Date().toISOString()
    });
    
    // Keep only last 100 items
    const trimmedHistory = filteredHistory.slice(0, 100);
    
    await platform.storage.set({ markdownHistory: trimmedHistory });
  } catch (error) {
    console.error('Failed to save to history:', error);
  }
}
