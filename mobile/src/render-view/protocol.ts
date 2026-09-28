/**
 * Mobile render-surface protocol.
 *
 * The render surface is the app's second, hidden WebView; Dart relays between it
 * and the display WebView (see plans/mobile-render-view-webview-plan.md §5).
 *
 * The render request/response types themselves come from the shared render
 * worker protocol (`src/renderers/worker/protocol.ts`); this file only adds the
 * lifecycle and transport-level messages the relay needs, and names them after
 * the Chrome offscreen document's OFFSCREEN_* events so the two supervisors read
 * the same way (see §12.3 C4 of the plan).
 */

export const RenderSurfaceMessageTypes = {
  /** Surface -> host: the worker is initialised and can render. */
  READY: 'RENDER_SURFACE_READY',
  /** Surface -> host: the DOM is usable (separate from READY to tell "script up" from "DOM up"). */
  DOM_READY: 'RENDER_SURFACE_DOM_READY',
  /** Surface -> host: an uncaught error while booting or rendering. */
  ERROR: 'RENDER_SURFACE_ERROR',
  /** Host -> surface: release resources for a rendered result that has been delivered. */
  RELEASE_RESULT: 'RENDER_SURFACE_RELEASE_RESULT',
  /** Surface -> host: transport-level failure reporting (diagnostics only). */
  LOG: 'RENDER_SURFACE_LOG',
} as const;

export type RenderSurfaceMessageType = typeof RenderSurfaceMessageTypes[keyof typeof RenderSurfaceMessageTypes];

export type RenderSurfaceReadyPayload = {
  /** Renderer types this surface can render (from the shared registry). */
  renderers: string[];
  /** Virtual layout width the surface renders at, for diagnostics. */
  bodyWidth: number;
};

export type RenderSurfaceErrorPayload = {
  message: string;
  filename?: string;
  lineno?: number;
  stack?: string;
};
