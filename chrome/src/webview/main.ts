// Markdown Viewer Main - Chrome Extension Entry Point
import { platform } from './index';
import { startViewer } from './viewer-main';
import { initializeViewerBase } from '../../../src/core/viewer/viewer-bootstrap';

declare global {
  interface Window {
    __markdownViewerOriginalScroll?: { x: number; y: number };
    __markdownViewerInjected?: boolean;
    __markdownViewerRestoreHandler?: (message: any) => void;
  }
}

if (window.__markdownViewerInjected) {
  console.log('[main] Markdown Viewer already injected.');
} else {
  window.__markdownViewerInjected = true;
  // Save original DOM and scroll position BEFORE viewer replaces the body
  window.__markdownViewerOriginalScroll = { x: window.scrollX, y: window.scrollY };

  // Listen for restore message
  const handleMessage = (message: any) => {
    if (message?.type === 'RESTORE_ORIGINAL_VIEW') {
      // Cleanup
      window.__markdownViewerInjected = false;
      chrome.runtime.onMessage.removeListener(handleMessage);
      
      // Set override flag for content-detector so it doesn't automatically re-inject on reload
      try {
        sessionStorage.setItem('markdownViewerRawOverride', '1');
      } catch (e) {
        // storage access might be blocked by restrictive settings
      }

      // Instead of complex DOM manipulation which breaks React and Next.js, 
      // the safest way to restore complex JS applications is natively reloading the page.
      window.location.reload();
    }
  };
  chrome.runtime.onMessage.addListener(handleMessage);

  void initializeViewerBase(platform).then((pluginRenderer) => {
    return startViewer({
      platform,
      pluginRenderer,
      themeConfigRenderer: platform.renderer,
    });
  }).catch((error) => {
    console.error('[main] viewer init failed', error);
  });
}
