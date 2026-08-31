const RENDER_REQUEST_EVENT = 'mv:render-request';
const ANCHOR_REQUEST_EVENT = 'mv:scroll-to-anchor-request';
const EXPORT_REQUEST_EVENT = 'mv:export-request';
const RESPONSE_EVENT = 'mv:response';
const READY_ATTRIBUTE = 'data-mv-ready';
// The isolated-world runtime attaches asynchronously (platform/localization
// init), so a page calling render() before attachment would otherwise wait
// forever for a response nobody will ever send. Bound the wait and reject
// with a clear error instead.
const READY_TIMEOUT_MS = 10000;

export {};

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function waitForResponse(target: HTMLElement, requestId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onResponse = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string; ok?: boolean; error?: string }>).detail;
      if (!detail || detail.requestId !== requestId) return;
      target.removeEventListener(RESPONSE_EVENT, onResponse as EventListener);
      if (detail.ok) {
        resolve();
        return;
      }
      reject(new Error(detail.error || 'Unknown markdown-viewer error'));
    };
    target.addEventListener(RESPONSE_EVENT, onResponse as EventListener);
  });
}

type PendingRequest = () => void;

class MarkdownViewerElementProxy extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['value', 'scroll-line', 'mode', READY_ATTRIBUTE];
  }

  private attached = false;
  private pending: PendingRequest[] = [];

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === READY_ATTRIBUTE && newValue !== null) {
      this.flushPending();
    }
  }

  connectedCallback(): void {
    // Covers the case where the runtime attached before this element was
    // upgraded (the ready attribute is already present when we start).
    if (this.hasAttribute(READY_ATTRIBUTE)) {
      this.flushPending();
    }
  }

  /**
   * The extension's runtime (isolated world) attaches asynchronously after
   * this proxy is defined. render()/scrollToAnchor() called before attachment
   * used to dispatch events nobody listened to — render() hung forever.
   * Queue those calls and flush them as soon as the runtime signals
   * attachment via the data-mv-ready attribute.
   */
  private waitForRuntime(): Promise<void> {
    if (this.attached) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onReady: PendingRequest = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        const index = this.pending.indexOf(onReady);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error(
          'markdown-viewer runtime not attached: the extension did not initialize this element. ' +
          'Make sure the Markdown Viewer extension is installed and active on this page.',
        ));
      }, READY_TIMEOUT_MS);
      this.pending.push(onReady);
    });
  }

  private flushPending(): void {
    this.attached = true;
    const pending = this.pending.splice(0);
    for (const onReady of pending) onReady();
  }

  async render(markdown: string): Promise<void> {
    await this.waitForRuntime();
    const requestId = createRequestId();
    const response = waitForResponse(this, requestId);
    this.dispatchEvent(new CustomEvent(RENDER_REQUEST_EVENT, {
      detail: { requestId, markdown },
      bubbles: true,
      composed: true,
    }));
    await response;
  }

  scrollToAnchor(anchor: string): void {
    void this.waitForRuntime().then(() => {
      this.dispatchEvent(new CustomEvent(ANCHOR_REQUEST_EVENT, {
        detail: { anchor },
        bubbles: true,
        composed: true,
      }));
    }).catch(() => {
      // Runtime never attached — the anchor navigation cannot be delivered.
    });
  }

  /**
   * Export the current document, mirroring the standalone preview toolbar's
   * export menu. Supported formats:
   * 'docx' | 'epub' | 'html' | 'pdf' (print) | 'save' (raw markdown file);
   * 'docs' is accepted as an alias for 'docx'.
   * Resolves when the export completes; rejects on failure.
   */
  async export(
    format: 'docx' | 'docs' | 'epub' | 'html' | 'pdf' | 'save',
    options?: { filename?: string; title?: string },
  ): Promise<void> {
    await this.waitForRuntime();
    const requestId = createRequestId();
    const response = waitForResponse(this, requestId);
    this.dispatchEvent(new CustomEvent(EXPORT_REQUEST_EVENT, {
      detail: { requestId, format, ...(options || {}) },
      bubbles: true,
      composed: true,
    }));
    await response;
  }

  getCurrentLine(): number | null {
    const raw = this.getAttribute('data-mv-current-line');
    if (!raw) return null;
    const line = Number.parseInt(raw, 10);
    return Number.isFinite(line) ? line : null;
  }

  get value(): string | undefined {
    return this.getAttribute('value') ?? undefined;
  }

  set value(markdown: string | undefined) {
    if (markdown === undefined) {
      this.removeAttribute('value');
      return;
    }
    this.setAttribute('value', markdown);
  }

  get mode(): 'inline' | 'iframe' | undefined {
    const value = this.getAttribute('mode');
    return value === 'inline' || value === 'iframe' ? value : undefined;
  }

  set mode(mode: 'inline' | 'iframe' | undefined) {
    if (mode === undefined) {
      this.removeAttribute('mode');
      return;
    }
    this.setAttribute('mode', mode);
  }

  get scrollLine(): number | undefined {
    const raw = this.getAttribute('scroll-line');
    if (!raw) return undefined;
    const line = Number.parseInt(raw, 10);
    return Number.isFinite(line) ? line : undefined;
  }

  set scrollLine(line: number | undefined) {
    if (line === undefined || Number.isNaN(line)) {
      this.removeAttribute('scroll-line');
      return;
    }
    this.setAttribute('scroll-line', String(line));
  }
}

if (globalThis.customElements && !globalThis.customElements.get('markdown-viewer')) {
  globalThis.customElements.define('markdown-viewer', MarkdownViewerElementProxy);
}