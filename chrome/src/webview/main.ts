// Markdown Viewer Main - Chrome Extension Entry Point
// Uses shared viewer logic with platform renderer

import { platform } from './index';
import { startViewer, createPluginRenderer } from './viewer-main';

// Create plugin renderer using platform.renderer
const pluginRenderer = createPluginRenderer(async (type, content) => {
  const result = await platform.renderer.render(type, content);
  return {
    base64: result.base64 || '',
    width: result.width,
    height: result.height,
    format: result.format,
    error: result.error,
  };
});

// Start the viewer with Chrome-specific configuration
startViewer({
  platform,
  pluginRenderer,
  themeConfigRenderer: platform.renderer,
});
