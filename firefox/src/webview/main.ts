// Markdown Viewer Main - Firefox Extension Entry Point
// Uses shared viewer logic from Chrome with Firefox-specific renderer (Background Page DOM)

import { platform } from './index';
import { startViewer } from '../../../chrome/src/webview/viewer-main';
import { initializeViewerBase } from '../../../src/core/viewer/viewer-bootstrap';

void initializeViewerBase(platform).then((pluginRenderer) => {
  return startViewer({
    platform,
    pluginRenderer,
    themeConfigRenderer: platform.renderer,
  });
}).catch((error) => {
  console.error('[main] viewer init failed', error);
});
