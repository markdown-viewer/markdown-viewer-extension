// Lightweight content script for detecting Markdown files
// This script runs on all pages to check if they are Markdown files

// Check if this is a markdown file (local or remote)
function isMarkdownFile() {
  const path = document.location.pathname;
  const url = document.location.href;
  
  console.log('[Markdown Detector] Checking URL:', url);
  console.log('[Markdown Detector] Path:', path);
  
  // First check file extension
  if (!(path.endsWith('.md') || path.endsWith('.markdown'))) {
    console.log('[Markdown Detector] ❌ Not a markdown file - wrong extension');
    return false;
  }
  
  console.log('[Markdown Detector] ✅ File extension check passed');
  
  // Check content type from document if available
  const contentType = document.contentType || document.mimeType;
  console.log('[Markdown Detector] Content-Type:', contentType);
  
  if (contentType) {
    // If content type is HTML, this page has already been processed
    if (contentType.includes('text/html')) {
      console.log('[Markdown Detector] ❌ Content-Type is HTML - skipping');
      return false;
    }
    // Only process if content type is plain text or unknown
    if (contentType.includes('text/plain') || contentType.includes('application/octet-stream')) {
      console.log('[Markdown Detector] ✅ Content-Type is plain text - processing');
      return true;
    }
  }
  
  // For local files or when content type is not available, check if body contains raw markdown
  const bodyText = document.body ? document.body.textContent : '';
  const bodyHTML = document.body ? document.body.innerHTML : '';
  
  console.log('[Markdown Detector] Body text preview:', bodyText.substring(0, 100));
  console.log('[Markdown Detector] Body HTML preview:', bodyHTML.substring(0, 200));
  
  // If the body is already heavily structured HTML (not just pre-wrapped text), 
  // it's likely already processed
  if (bodyHTML.includes('<div') || bodyHTML.includes('<p>') || bodyHTML.includes('<h1') || 
      bodyHTML.includes('<nav') || bodyHTML.includes('<header') || bodyHTML.includes('<footer')) {
    console.log('[Markdown Detector] ❌ Complex HTML structure detected - skipping');
    return false;
  }
  
  console.log('[Markdown Detector] ✅ No complex HTML structure');
  
  // If body text looks like raw markdown (contains markdown syntax), process it
  if (bodyText.includes('# ') || bodyText.includes('## ') || bodyText.includes('```') || 
      bodyText.includes('- ') || bodyText.includes('* ') || bodyText.includes('[') && bodyText.includes('](')) {
    console.log('[Markdown Detector] ✅ Markdown syntax detected - processing');
    return true;
  }
  
  // If it's a .md/.markdown file with plain text content, assume it's markdown
  console.log('[Markdown Detector] ✅ Fallback - assuming markdown file');
  return true;
}

// Only run the main content script if this is a Markdown file
console.log('[Markdown Detector] Starting detection...');
if (isMarkdownFile()) {
  console.log('[Markdown Detector] ✅ Markdown file detected, injecting content script...');
  // Dynamically inject the original content script
  chrome.runtime.sendMessage({
    type: 'injectContentScript',
    url: document.location.href
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[Markdown Detector] ❌ Failed to inject content script:', chrome.runtime.lastError);
    } else {
      console.log('[Markdown Detector] ✅ Content script injection response:', response);
    }
  });
} else {
  console.log('[Markdown Detector] ❌ Not a markdown file, skipping injection');
}