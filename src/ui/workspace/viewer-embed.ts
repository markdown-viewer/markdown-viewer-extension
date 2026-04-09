// Embedded viewer for workspace mode
// Receives file content via postMessage, then runs the full viewer pipeline

import { platform } from '../webview/index';
import { startViewer } from '../webview/viewer-main';
import { createPluginRenderer } from '../../../src/core/viewer/viewer-host';

// Wait for content from parent (workspace page)
function onMessage(event: MessageEvent) {
  if (!event.data || event.data.type !== 'RENDER_FILE') return;

  // Remove listener once we get our message
  window.removeEventListener('message', onMessage);

  const { content, filename } = event.data;

  // Hide content to prevent flash of unstyled text (same as content-detector)
  const style = document.createElement('style');
  style.id = 'markdown-viewer-preload';
  style.textContent = `
    body {
      opacity: 0 !important;
      overflow: hidden !important;
    }
  `;
  document.head.insertBefore(style, document.head.firstChild);

  // Simulate how Chrome opens a plain text file:
  // body contains raw text inside a <pre> element
  document.body.textContent = content;

  // Override location-based URL detection by setting a data attribute
  // so the viewer can determine file type from filename
  document.documentElement.dataset.viewerFilename = filename;

  // Run the standard viewer pipeline (identical to main.ts)
  const pluginRenderer = createPluginRenderer(platform);
  startViewer({
    platform,
    pluginRenderer,
    themeConfigRenderer: platform.renderer,
  });
}
window.addEventListener('message', onMessage);

// Notify parent that the viewer frame is ready to receive content
window.parent.postMessage({ type: 'VIEWER_READY' }, '*');
