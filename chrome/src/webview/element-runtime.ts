// Register markdown-viewer custom element for HTML pages.
// This script only exposes element capabilities and does not replace page content.

import type { PluginRenderer } from '../../../src/types/index';
import { attachMarkdownViewerElementRuntime, bindThemeSyncFromSettingsBroadcast, type MarkdownViewerElementFactoryOptions } from '../../../src/integration/element';
import { initializeViewerCore } from '../../../src/core/viewer/viewer-bootstrap';
import { createDiagramCodeBlockScanner, type DiagramCodeBlockScanner } from '../../../src/integration/host-page/code-block-scanner';
import { platform } from './index';

export async function initializeElementRuntime(): Promise<PluginRenderer> {
  const options = await initializeViewerCore(platform);
  const controllers = new Map<HTMLElement, ReturnType<typeof attachMarkdownViewerElementRuntime>>();

  const attachIfNeeded = (element: HTMLElement): void => {
    if (controllers.has(element)) return;
    controllers.set(element, attachMarkdownViewerElementRuntime(element, options));
  };
  bindThemeSyncFromSettingsBroadcast(platform, controllers);

  document.querySelectorAll('markdown-viewer').forEach((element) => {
    attachIfNeeded(element as HTMLElement);
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches('markdown-viewer')) {
          attachIfNeeded(node);
        }
        node.querySelectorAll?.('markdown-viewer').forEach((element) => {
          attachIfNeeded(element as HTMLElement);
        });
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Scan for diagram code blocks (PlantUML, Mermaid, Vega, DOT, etc.) on the
  // host page and render them via the offscreen pipeline. The scanner is
  // idempotent — if no diagram blocks are present, it does nothing.
  const diagramScanner: DiagramCodeBlockScanner = createDiagramCodeBlockScanner({
    renderer: options.renderer,
    setThemeConfig: (config) => platform.renderer.setThemeConfig(config),
  });
  diagramScanner.scan();

  return options.renderer;
}
