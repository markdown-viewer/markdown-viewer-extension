/**
 * Resource Service
 * 
 * Unified interface for accessing bundled extension resources (assets).
 * Provides two implementations:
 * - DirectResourceService: Direct access via browser APIs (Chrome/Firefox)
 * - ProxyResourceService: Proxy access via postMessage (Mobile/VSCode iframe)
 */

// =============================================================================
// Interface
// =============================================================================

/**
 * Resource service interface for accessing bundled extension assets.
 * This matches the PlatformResourceAPI interface in types/platform.ts
 */
export interface ResourceService {
  /**
   * Get the full URL for a bundled resource path.
   * @param path - Relative path to the resource (e.g., 'themes/registry.json')
   * @returns Full URL that can be used in fetch or as src attribute
   */
  getURL(path: string): string;

  /**
   * Fetch the content of a bundled resource.
   * @param path - Relative path to the resource
   * @returns Content as string
   */
  fetch(path: string): Promise<string>;
}

// =============================================================================
// Direct Resource Service (Chrome/Firefox)
// =============================================================================

/**
 * Direct resource service for environments with full API access.
 * Used in Chrome offscreen document and Firefox background page.
 */
export class DirectResourceService implements ResourceService {
  private readonly getUrlFn: (path: string) => string;

  /**
   * @param getUrlFn - Function to convert path to full URL
   *                   Chrome: (path) => chrome.runtime.getURL(path)
   *                   Firefox: (path) => browser.runtime.getURL(path)
   */
  constructor(getUrlFn: (path: string) => string) {
    this.getUrlFn = getUrlFn;
  }

  getURL(path: string): string {
    return this.getUrlFn(path);
  }

  async fetch(path: string): Promise<string> {
    const url = this.getURL(path);
    const response = await globalThis.fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}

// =============================================================================
// Proxy Resource Service (Mobile/VSCode iframe)
// =============================================================================

/**
 * Proxy resource service for sandboxed iframe environments.
 * Uses postMessage to request resources from parent window.
 * Compatible with IframeRenderHost's serviceRequestHandler.
 */
export class ProxyResourceService implements ResourceService {
  private readonly parentWindow: Window;
  private readonly pendingRequests = new Map<string, { 
    resolve: (value: string) => void; 
    reject: (error: Error) => void;
  }>();
  private readonly timeoutMs: number;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private requestCounter = 0;

  /**
   * @param parentWindow - Parent window to send requests to (usually window.parent)
   * @param timeoutMs - Request timeout in milliseconds (default: 10000)
   */
  constructor(parentWindow: Window = window.parent, timeoutMs = 10000) {
    this.parentWindow = parentWindow;
    this.timeoutMs = timeoutMs;
    this.setupMessageHandler();
  }

  private setupMessageHandler(): void {
    this.messageHandler = (event: MessageEvent) => {
      const data = event.data as {
        __serviceResponse?: boolean;
        id?: string;
        ok?: boolean;
        data?: unknown;
        error?: string | { message?: string };
      } | null;
      
      if (!data || !data.__serviceResponse || !data.id) return;
      
      const pending = this.pendingRequests.get(data.id);
      if (!pending) return;
      
      this.pendingRequests.delete(data.id);
      
      if (data.ok) {
        pending.resolve(data.data as string);
      } else {
        const errorMsg = typeof data.error === 'string' 
          ? data.error 
          : data.error?.message || 'Service request failed';
        pending.reject(new Error(errorMsg));
      }
    };
    
    window.addEventListener('message', this.messageHandler);
  }

  getURL(path: string): string {
    // In sandboxed iframe, we can't get a direct URL
    // Return the path as-is; actual fetching goes through proxy
    return path;
  }

  async fetch(path: string): Promise<string> {
    const id = `res-${Date.now()}-${++this.requestCounter}`;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      // Set timeout
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout fetching resource: ${path}`));
        }
      }, this.timeoutMs);
      
      // Wrap resolve/reject to clear timeout
      const wrappedResolve = (value: string) => {
        clearTimeout(timeoutId);
        resolve(value);
      };
      const wrappedReject = (error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      };
      this.pendingRequests.set(id, { resolve: wrappedResolve, reject: wrappedReject });
      
      // Send request to parent
      try {
        this.parentWindow.postMessage({
          __serviceRequest: true,
          type: 'FETCH_RESOURCE',
          id,
          payload: { path },
        }, '*');
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeoutId);
        reject(error as Error);
      }
    });
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.pendingRequests.clear();
  }
}
