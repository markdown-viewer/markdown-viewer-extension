// Clipboard Preview Main - Chrome Extension Entry Point
// Loads clipboard content from storage and uses shared viewer logic

import { platform } from './index';
import { startViewer } from './viewer-main';
import { createPluginRenderer } from '../../../src/core/viewer/viewer-host';

// Storage key for clipboard content
const CLIPBOARD_CONTENT_KEY = 'clipboardPreviewContent';

// Get clipboard content from storage
async function getClipboardContent(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CLIPBOARD_CONTENT_KEY], (result) => {
      const content = result[CLIPBOARD_CONTENT_KEY] || '';
      resolve(content);
    });
  });
}

// Initialize the clipboard preview
async function init(): Promise<void> {
  // Get clipboard content from storage
  const content = await getClipboardContent();
  
  // Set the clipboard content to the page body for viewer-main to process
  const contentElement = document.getElementById('clipboard-content');
  if (contentElement) {
    contentElement.textContent = content;
  }

  // Create plugin renderer using shared utility from viewer-host
  const pluginRenderer = createPluginRenderer(platform);

  // Start the viewer with Chrome-specific configuration
  startViewer({
    platform,
    pluginRenderer,
    themeConfigRenderer: platform.renderer,
  });
}

// Run initialization
init();
