import type { RenderHost } from './render-host';

import { RenderChannel } from '../../messaging/channels/render-channel';
import { WindowPostMessageTransport } from '../../messaging/transports/window-postmessage-transport';

/**
 * Service request handler for proxying service calls from render worker
 * Used when render worker cannot directly access certain resources (e.g., VSCode CSP)
 */
export type ServiceRequestHandler = (type: string, payload: unknown) => Promise<unknown>;

export type IframeRenderHostOptions = {
  /** URL to load in iframe (for normal browser environments) */
  iframeUrl?: string;
  /** HTML content to load via blob URL (for VSCode webview to bypass CSP) */
  htmlContent?: string;
  /** Async function to fetch HTML content */
  fetchHtmlContent?: () => Promise<string>;
  /** Nonce for script tags (required for VSCode webview CSP) */
  nonce?: string;
  source: string;
  timeoutMs?: number;
  readyTimeoutMs?: number;
  /**
   * Handler for service requests from render worker.
   * When set, the host will listen for service requests and proxy them.
   * Used in VSCode to proxy fetch requests through extension host.
   */
  serviceRequestHandler?: ServiceRequestHandler;
};

export class IframeRenderHost implements RenderHost {
  private iframe: HTMLIFrameElement | null = null;
  private iframeCreationPromise: Promise<HTMLIFrameElement> | null = null;
  private readyPromise: Promise<void> | null = null;
  private renderChannel: RenderChannel | null = null;
  private blobUrl: string | null = null;
  private serviceMessageHandler: ((event: MessageEvent) => void) | null = null;

  private readonly iframeUrl?: string;
  private readonly htmlContent?: string;
  private readonly fetchHtmlContent?: () => Promise<string>;
  private readonly nonce?: string;
  private readonly source: string;
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly serviceRequestHandler?: ServiceRequestHandler;

  constructor(options: IframeRenderHostOptions) {
    this.iframeUrl = options.iframeUrl;
    this.htmlContent = options.htmlContent;
    this.fetchHtmlContent = options.fetchHtmlContent;
    this.nonce = options.nonce;
    this.source = options.source;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    this.serviceRequestHandler = options.serviceRequestHandler;
  }

  private async ensureIframeCreated(): Promise<HTMLIFrameElement> {
    // Return existing iframe
    if (this.iframe) {
      return this.iframe;
    }
    
    // Return existing creation promise to avoid creating multiple iframes
    if (this.iframeCreationPromise) {
      return this.iframeCreationPromise;
    }

    // Create new iframe (only once)
    this.iframeCreationPromise = this.createIframe();
    return this.iframeCreationPromise;
  }

  private async createIframe(): Promise<HTMLIFrameElement> {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.position = 'fixed';
    iframe.style.left = '-99999px';
    iframe.style.top = '-99999px';
    iframe.style.width = '10px';
    iframe.style.height = '10px';
    iframe.style.border = '0';
    iframe.style.opacity = '0';

    // Determine how to load iframe content
    if (this.htmlContent || this.fetchHtmlContent) {
      // For VSCode/srcdoc mode: use sandbox to restrict iframe capabilities
      // This is safe because we control the HTML content
      iframe.setAttribute('sandbox', 'allow-scripts');
      
      // Use srcdoc to create a completely independent iframe document
      // This bypasses parent CSP entirely since srcdoc creates a fresh document
      let html = this.htmlContent;
      if (!html && this.fetchHtmlContent) {
        html = await this.fetchHtmlContent();
      }
      if (html) {
        // If nonce is provided (VSCode webview), add it to all script tags
        // This allows scripts to execute under parent's CSP
        if (this.nonce) {
          // Add nonce to all script tags (both inline and external)
          html = html.replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${this.nonce}"`);
        }
        // Use srcdoc instead of blob URL - srcdoc creates independent document without inheriting parent CSP
        iframe.srcdoc = html;
        // Don't set src when using srcdoc
        iframe.src = '';
      }
    } else if (this.iframeUrl) {
      // For URL mode (Mobile/Chrome): don't use sandbox as it breaks same-origin iframe loading
      iframe.src = this.iframeUrl;
    } else {
      throw new Error('IframeRenderHost: either iframeUrl, htmlContent, or fetchHtmlContent is required');
    }

    (document.documentElement || document.body).appendChild(iframe);
    this.iframe = iframe;
    return iframe;
  }

  private async getOrCreateRenderChannel(): Promise<RenderChannel> {
    const iframe = await this.ensureIframeCreated();
    const targetWindow = iframe.contentWindow;
    if (!targetWindow) {
      throw new Error('Render frame not available');
    }

    if (!this.renderChannel) {
      this.renderChannel = new RenderChannel(
        new WindowPostMessageTransport(targetWindow, {
          targetOrigin: '*',
          acceptSource: targetWindow,
        }),
        {
          source: this.source,
          timeoutMs: this.timeoutMs,
        }
      );
    }

    return this.renderChannel;
  }

  async ensureReady(): Promise<void> {
    const iframe = await this.ensureIframeCreated();
    
    const targetWindow = iframe.contentWindow;
    if (!targetWindow) {
      throw new Error('Render frame not available');
    }

    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        // In VSCode webview with blob URL, event.source may not match targetWindow
        // So we only check the message type for RENDER_FRAME_READY
        const data = event.data as { type?: unknown } | null;
        if (data && data.type === 'RENDER_FRAME_READY') {
          try {
            targetWindow.postMessage({ type: 'READY_ACK' }, '*');
          } catch (e) {
            // Ignore errors sending READY_ACK
          }

          window.removeEventListener('message', onMessage);
          resolve();
        }
      };

      window.addEventListener('message', onMessage);

      // Also listen for iframe error event
      iframe.addEventListener('error', (e) => {
        console.error('[IframeRenderHost] iframe error event:', e);
      });

      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('Render frame load timeout'));
      }, this.readyTimeoutMs);
    });

    // Set up service request handler if provided
    // This allows render worker to proxy requests through host
    if (this.serviceRequestHandler && !this.serviceMessageHandler) {
      this.setupServiceMessageHandler(targetWindow);
    }

    return this.readyPromise;
  }

  /**
   * Set up message handler for service requests from render worker
  /**
   * Setup handler for service requests from iframe (e.g., FETCH_RESOURCE)
   */
  private setupServiceMessageHandler(targetWindow: Window): void {
    this.serviceMessageHandler = async (event: MessageEvent) => {
      // Only handle messages from our iframe
      if (event.source !== targetWindow) return;
      
      const data = event.data as { 
        type?: string; 
        id?: string; 
        payload?: unknown;
        __serviceRequest?: boolean;
      } | null;
      
      // Only handle service requests
      if (!data || !data.__serviceRequest || !data.type || !data.id) return;
      
      try {
        const result = await this.serviceRequestHandler!(data.type, data.payload);
        
        // Send response back to iframe
        targetWindow.postMessage({
          __serviceResponse: true,
          id: data.id,
          ok: true,
          data: result,
        }, '*');
      } catch (error) {
        targetWindow.postMessage({
          __serviceResponse: true,
          id: data.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, '*');
      }
    };
    
    window.addEventListener('message', this.serviceMessageHandler);
  }

  async send<T = unknown>(type: string, payload: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureReady();
    const channel = await this.getOrCreateRenderChannel();
    return (await channel.send(type, payload, { timeoutMs: timeoutMs ?? this.timeoutMs })) as T;
  }

  async cleanup(): Promise<void> {
    // Remove service message handler
    if (this.serviceMessageHandler) {
      window.removeEventListener('message', this.serviceMessageHandler);
      this.serviceMessageHandler = null;
    }
    
    this.renderChannel?.close();
    this.renderChannel = null;
    this.readyPromise = null;

    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
    this.iframe = null;

    // Clean up blob URL if created
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}
