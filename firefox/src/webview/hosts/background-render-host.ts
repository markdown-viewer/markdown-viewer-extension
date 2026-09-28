/**
 * Firefox Background Render Host
 * 
 * Similar to Chrome's OffscreenRenderHost, but targets Firefox's background page.
 * Since Firefox MV2 background page has DOM access, we can render directly there.
 */

import type { RenderHost } from '../../../../src/renderers/host/render-host';
import { getWebExtensionApi } from '../../../../src/utils/platform-info';
import { RenderTarget } from '../../../../src/messaging/routing';

type ResponseEnvelope = {
  type: 'RESPONSE';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: { message?: string };
};

function isResponseEnvelope(message: unknown): message is ResponseEnvelope {
  if (!message || typeof message !== 'object') return false;
  const obj = message as Record<string, unknown>;
  return obj.type === 'RESPONSE' && typeof obj.requestId === 'string' && typeof obj.ok === 'boolean';
}

export class BackgroundRenderHost implements RenderHost {
  private source: string;
  private requestCounter = 0;
  private webExtensionApi = getWebExtensionApi();

  constructor(source: string) {
    this.source = source;
  }

  private createRequestId(): string {
    this.requestCounter += 1;
    return `${Date.now()}-${this.requestCounter}`;
  }

  async ensureReady(): Promise<void> {
    // Background page is always ready (persistent in MV2)
  }

  async send<T = unknown>(type: string, payload: unknown, timeoutMs: number = 300000): Promise<T> {
    const requestId = this.createRequestId();
    
    // Create request envelope with __target for routing to render worker
    const request = {
      id: requestId,
      type,
      payload,
      timestamp: Date.now(),
      source: this.source,
      __target: RenderTarget.BackgroundRender,  // Route to render worker in background
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Render request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.webExtensionApi.runtime.sendMessage(request).then((response: unknown) => {
        clearTimeout(timer);
        
        if (isResponseEnvelope(response)) {
          if (response.ok) {
            resolve(response.data as T);
          } else {
            reject(new Error(response.error?.message || `${type} failed`));
          }
        } else {
          // Fallback for non-envelope responses
          resolve(response as T);
        }
      }).catch((error: Error) => {
        clearTimeout(timer);
        reject(new Error(`Render request failed: ${error.message}`));
      });
    });
  }
}

