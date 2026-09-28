/**
 * Message Routing
 *
 * Where a message is *for*, when more than one render surface lives in the same
 * runtime. Every platform that hosts a render worker next to its UI (a Chrome
 * service worker + offscreen document, Firefox's background page, the mobile
 * app's display WebView + hidden render WebView) needs the same thing: a field
 * the receiver can filter on, because all of them share one message bus.
 *
 * The field is `__target`, and it is deliberately outside the envelope types:
 * it is transport-level routing, not part of the request contract, so a message
 * forwarded between surfaces keeps its payload untouched.
 */

/** Surfaces a render message can be addressed to. */
export const RenderTarget = {
  /** Chrome/Edge offscreen document. */
  Offscreen: 'offscreen',
  /** Firefox background-page render worker. */
  BackgroundRender: 'background-render',
  /** Mobile hidden render WebView (see plans/mobile-render-view-webview-plan.md). */
  RenderView: 'render-view',
  /** Mobile display WebView (responses and pushes coming back from a render surface). */
  Display: 'display',
  /** Host services: storage, files, assets (answered by the supervisor, not a surface). */
  Host: 'host',
} as const;

export type RenderTarget = typeof RenderTarget[keyof typeof RenderTarget];

/** Reads the routing hint off a raw message, when it carries one. */
export function getRenderTarget(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const target = (message as { __target?: unknown }).__target;
  return typeof target === 'string' ? target : undefined;
}

/**
 * Whether a message is addressed to [target].
 *
 * An unaddressed message is never "for" a specific surface: without the hint
 * there is nothing that says which surface should answer it, and guessing is how
 * two surfaces end up answering the same request.
 */
export function isTargetedAt(message: unknown, target: string): boolean {
  return getRenderTarget(message) === target;
}
