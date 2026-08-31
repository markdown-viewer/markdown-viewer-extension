// Register markdown-viewer custom element for HTML pages.
// This script only exposes element capabilities and does not replace page content.

import type { PluginRenderer } from '../../../src/types/index';
import { attachMarkdownViewerElementRuntime, bindThemeSyncFromSettingsBroadcast } from '../../../src/integration/element';
import { initializeViewerCore } from '../../../src/core/viewer/viewer-bootstrap';
import { platform } from './index';

export async function initializeElementRuntime(): Promise<PluginRenderer> {
  const options = await initializeViewerCore(platform);
  const controllers = new Map<HTMLElement, ReturnType<typeof attachMarkdownViewerElementRuntime>>();

  const attachIfNeeded = (element: HTMLElement): void => {
    if (controllers.has(element)) return;
    controllers.set(element, attachMarkdownViewerElementRuntime(element, options));
    // Signal the MAIN-world proxy that this element's runtime is attached, so
    // render()/scrollToAnchor() calls made before attachment (same-tick
    // insertion, SPA frameworks) flush their queued requests instead of
    // hanging forever on a response that never comes.
    element.setAttribute('data-mv-ready', '1');
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

  return options.renderer;
}
