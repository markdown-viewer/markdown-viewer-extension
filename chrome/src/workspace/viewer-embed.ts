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

  const { content, filename, fileDir, codeView } = event.data;

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
  if (codeView) {
    document.documentElement.dataset.codeView = '1';
    // Add line numbers after code block is rendered with highlighting
    const observer = new MutationObserver(() => {
      const code = document.querySelector('#markdown-content pre code.hljs');
      if (!code) return;
      observer.disconnect();
      requestAnimationFrame(() => {
        // Count lines from the actual rendered text — always in sync
        const text = code.textContent || '';
        const lines = text.replace(/\n+$/, '').split('\n');
        const nums = lines.map((_, i) => i + 1).join('\n');
        (code as HTMLElement).dataset.lineNumbers = nums;
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Run the standard viewer pipeline (identical to main.ts)
  const pluginRenderer = createPluginRenderer(platform);
  startViewer({
    platform,
    pluginRenderer,
    themeConfigRenderer: platform.renderer,
  });

  // Resolve relative images via parent workspace
  if (fileDir !== undefined) {
    resolveWorkspaceImages(fileDir);
  }
}

window.addEventListener('message', onMessage);

// ─── Resolve relative images via parent workspace ───
function isRelativeSrc(src: string): boolean {
  return !!src && !src.startsWith('http://') && !src.startsWith('https://') &&
    !src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('file:') &&
    !src.includes('://');
}

function resolveWorkspaceImages(fileDir: string) {
  let idCounter = 0;
  const pending = new Map<number, HTMLImageElement>();

  // Listen for resolved blob URLs from parent
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type !== 'IMAGE_RESOLVED') return;
    const img = pending.get(e.data.id);
    if (img) {
      img.src = e.data.url;
      pending.delete(e.data.id);
    }
  });

  function requestImage(img: HTMLImageElement) {
    const src = img.getAttribute('src');
    if (!src || !isRelativeSrc(src)) return;
    const id = ++idCounter;
    pending.set(id, img);
    window.parent.postMessage({ type: 'RESOLVE_IMAGE', src, id }, '*');
  }

  // Watch for img elements added by the rendering pipeline
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLImageElement) {
          requestImage(node);
        } else if (node instanceof HTMLElement) {
          for (const img of node.querySelectorAll<HTMLImageElement>('img')) {
            requestImage(img);
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also handle images already in the DOM
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    requestImage(img);
  }
}

// Notify parent that the viewer frame is ready to receive content
window.parent.postMessage({ type: 'VIEWER_READY' }, '*');
