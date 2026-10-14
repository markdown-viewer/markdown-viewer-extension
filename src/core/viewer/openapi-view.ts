/**
 * File-level OpenAPI mounting.
 *
 * An OpenAPI document is a *document* with two faces (its source and this
 * rendered reference), not a markdown construct: the reference is mounted into
 * a host element by the surface that owns the document — the browser/workspace
 * rendered face, a panel preview, the CLI/export renderer — and never by a
 * fenced code block. Embedded ```openapi fences therefore stay ordinary code
 * (R5: what markdown preview shows is what DOCX exports).
 *
 * The mounted element keeps the specification in its **light DOM** as a `<pre>`:
 * script-free exports (HTML/EPUB serialise the content root) and cached blocks
 * then still carry readable YAML instead of an empty box.
 */

import { escapeHtml } from '../markdown-processor';
import { createErrorHTML, createPluginMessageHTML } from '../../plugins/plugin-content-utils';
import { recordRenderDiagnostic } from '../render-diagnostics';

const ELEMENT_NAME = 'documd-openapi';

/**
 * Message level the capability reports when a `.yaml` document is *not* a spec
 * (see mountOpenapiNotice): nothing failed, the file simply has no reference.
 */
export const OPENAPI_NOTICE_LEVEL = 'info' as const;

/**
 * Report "this YAML document is not an OpenAPI document".
 *
 * The capability that owns the reference reports it — the host does not
 * compose the sentence — and it uses the shared message element, so a notice
 * and a render failure are the same element at different levels (R4).
 * Returns the inserted element, or null when there is nothing to attach to.
 */
export function mountOpenapiNotice(host: HTMLElement, message: string): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const holder = document.createElement('div');
  holder.innerHTML = createPluginMessageHTML(escapeHtml(message), {
    level: OPENAPI_NOTICE_LEVEL,
    pluginType: 'openapi',
  });
  const element = holder.firstElementChild as HTMLElement | null;
  if (!element) {
    return null;
  }
  host.prepend(element);
  return element;
}

export interface OpenapiMountOptions {
  /** Source line of the block inside a host document (book chapters). */
  sourceLine?: number | null;
  /** Host block id, when the mount replaces a markdown block. */
  blockId?: string | null;
  /**
   * Caller-provided instance key. Re-mounting the same key into the same host
   * is a no-op, so a host can call this from a re-render path safely.
   */
  key?: string;
}

/**
 * Mount the Redoc reference for `content` into `host`, replacing its children.
 * Returns the mounted element (or null when there is no DOM to mount into).
 */
export async function mountOpenapiDocument(
  host: HTMLElement,
  content: string,
  options: OpenapiMountOptions = {},
): Promise<HTMLElement | null> {
  if (typeof document === 'undefined') {
    return null;
  }

  const { mountOpenapiPreview } = await import('../../ui/openapi-viewer');

  const element = document.createElement(ELEMENT_NAME) as HTMLElement & {
    ready?: Promise<void>;
    error?: Error;
  };
  element.dataset.pluginType = 'openapi';
  element.dataset.pluginRendered = 'true';
  if (options.key) {
    element.dataset.mountKey = options.key;
  }

  const source = document.createElement('pre');
  source.textContent = content;
  element.appendChild(source);

  host.replaceChildren(element);
  await mountOpenapiPreview(element);

  if (!element.isConnected) {
    return null;
  }

  if (element.error) {
    const message = element.error.message;
    element.outerHTML = createErrorHTML(escapeHtml(`OpenAPI: ${message}`), {
      pluginType: 'openapi',
      sourceLine: options.sourceLine ?? null,
      blockId: options.blockId ?? null,
    });
    recordRenderDiagnostic({
      level: 'error',
      kind: 'render-failed',
      type: 'openapi',
      line: options.sourceLine ?? null,
      blockId: options.blockId ?? null,
      message,
    });
    return null;
  }

  return element;
}
