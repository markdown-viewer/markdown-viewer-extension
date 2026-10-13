import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AppStore, history as redocHistory, Redoc, convertSwagger2OpenAPI } from 'redoc';
import { StyleSheetManager } from 'styled-components';
import { parse } from 'yaml';
import { bundle } from '@redocly/openapi-core/lib/bundle';
import { Config } from '@redocly/openapi-core/lib/config/config';
import type { ResolvedConfig } from '@redocly/openapi-core/lib/config';
import { BaseResolver, Source } from '@redocly/openapi-core/lib/resolve';
import { isSafeUrl } from '../utils/url-safety';
import { isPlatform } from '../utils/platform-info';

export type OpenapiPreview = HTMLElement & { ready?: Promise<void>; error?: Error };

const instances = new Map<OpenapiPreview, () => void>();
let lifecycleObserver: MutationObserver | undefined;

// AppStore reads the shared history during construction. Disable it before
// creating any stores: embedded blocks must not parse or change the host hash.
redocHistory.dispose();
Object.defineProperties(redocHistory, {
  replace: { value: () => {} },
  currentId: { value: '' },
});

export function mountOpenapiPreview(element: OpenapiPreview): Promise<void> {
  if (instances.has(element)) return element.ready ?? Promise.resolve();
  if (!lifecycleObserver) {
    // Content scripts have no customElements registry. Cached blocks remount,
    // and removed blocks release the renderer's listeners through React unmount.
    lifecycleObserver = new MutationObserver(() => {
      for (const [preview, destroy] of instances) {
        if (!preview.isConnected) {
          destroy();
          instances.delete(preview);
        }
      }
      document.querySelectorAll<OpenapiPreview>('documd-openapi').forEach((preview) => {
        if (!instances.has(preview)) void mountOpenapiPreview(preview);
      });
    });
    lifecycleObserver.observe(document.body, { childList: true, subtree: true });
  }

  let instance: Root | undefined;
  let themeObserver: MutationObserver | undefined;
  let linkObserver: MutationObserver | undefined;
  let disposed = false;
  instances.set(element, () => {
    disposed = true;
    themeObserver?.disconnect();
    linkObserver?.disconnect();
    root.removeEventListener('click', blockUnsafeNavigation, true);
    instance?.unmount();
  });

  const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
  // Redoc's Markdown sanitizer does not cover metadata links. Guard actual
  // rendered links, including those introduced by refs or later React updates.
  const sanitizeLinks = () => {
    root.querySelectorAll('a[href]').forEach((link) => {
      if (!isSafeUrl(link.getAttribute('href'))) link.removeAttribute('href');
    });
  };
  const blockUnsafeNavigation = (event: Event) => {
    const link = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (link instanceof HTMLAnchorElement && !isSafeUrl(link.getAttribute('href'))) {
      event.preventDefault();
      link.removeAttribute('href');
    }
  };
  root.addEventListener('click', blockUnsafeNavigation, true);
  linkObserver = new MutationObserver(sanitizeLinks);
  linkObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  element.error = undefined;
  element.style.display = 'block';
  element.style.minWidth = '0';
  element.ready = (async () => {
    const spec = parse(element.textContent ?? '');
    if (!spec || (!/^3\./.test(String(spec.openapi)) && String(spec.swagger) !== '2.0')
      || !spec.info || typeof spec.info.title !== 'string' || typeof spec.info.version !== 'string') {
      throw new Error('Invalid OpenAPI document: a supported API version and info.title/info.version are required.');
    }
    const doc = globalThis.platform?.document;
    // Workspace embeds announce virtual file paths through viewer metadata;
    // their document service has no native file path or resource base URL.
    const documentPath = doc?.documentPath || (!doc?.baseUrl && (
      document.documentElement.dataset.viewerWorkspaceFilePath || document.documentElement.dataset.viewerFilename
    ));
    const localUrl = new URL('file:///');
    localUrl.pathname = (documentPath || '').replace(/\\/g, '/');
    const documentBase = documentPath
      ? (/^(?:https?|file):/i.test(documentPath) ? documentPath : localUrl.href)
      : doc?.baseUrl || location.href;
    const chapterHref = element.closest<HTMLElement>('.book-chapter')?.dataset.href;
    const documentUrl = element.dataset.documentUrl ??= new URL(chapterHref || '', documentBase).href;
    const resolver = new BaseResolver();
    resolver.resolveExternalRef = (base, ref) => {
      const url = new URL(ref, base || documentUrl);
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
        throw new Error(`Unsupported OpenAPI reference protocol: ${url.protocol}`);
      }
      return url.href;
    };
    resolver.loadExternalRef = async (ref) => {
      if (disposed) throw new Error('OpenAPI preview was removed.');
      const target = new URL(ref);
      let content: string;
      if (target.protocol === 'file:') {
        if (!doc) throw new Error('No document service available for OpenAPI references.');
        // The reader is relative to the opened document, while a book chapter
        // can have its own source URL. Keep those two bases separate.
        const base = new URL('.', documentBase);
        if (target.host !== base.host) throw new Error('OpenAPI file references must use the document host.');
        const from = base.pathname.split('/').filter(Boolean);
        const to = target.pathname.split('/').filter(Boolean);
        while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
        content = await doc.readRelativeFile('../'.repeat(from.length) + decodeURIComponent(to.join('/')));
      } else if (doc && (isPlatform('chrome') || isPlatform('firefox'))) {
        // Browser readers preserve page credentials and handle cross-origin extension access.
        content = await doc.readRelativeFile(target.href);
      } else {
        const response = await fetch(target.href);
        if (!response.ok) throw new Error(`Unable to read OpenAPI reference (${response.status}): ${ref}`);
        content = await response.text();
      }
      return new Source(ref, content, 'application/yaml');
    };
    const result = await bundle({
      doc: { source: new Source(documentUrl, element.textContent ?? ''), parsed: spec },
      config: new Config({} as ResolvedConfig),
      externalRefResolver: resolver,
    });
    const problem = result.problems.find((problem) => problem.severity === 'error');
    if (problem) throw new Error(problem.message);
    const bundledSpec = result.bundle.parsed.swagger !== undefined
      ? await convertSwagger2OpenAPI(result.bundle.parsed) : result.bundle.parsed;
    if (disposed) return;
    const styles = document.createElement('div');
    const mount = document.createElement('div');
    root.replaceChildren(styles, mount);
    instance = createRoot(mount);

    const render = (dark: boolean) => {
      const scrollContainer = element.closest<HTMLElement>('#markdown-wrapper');
      const background = dark ? '#1e1e1e' : '#ffffff';
      const foreground = dark ? '#e5e7eb' : '#333333';
      mount.className = dark ? 'dark-mode' : 'light-mode';
      mount.style.backgroundColor = background;
      const store = new AppStore(bundledSpec, undefined, {
        sanitize: true,
        disableSearch: true,
        hideDownloadButtons: true,
        hideFab: true,
        nativeScrollbars: true,
        expandResponses: '200,201',
        scrollYOffset: () => scrollContainer?.getBoundingClientRect().top ?? 0,
        theme: {
          spacing: { sectionHorizontal: 24, sectionVertical: 24 },
          colors: { primary: { main: dark ? '#93c5fd' : '#2563eb' }, text: { primary: foreground } },
          typography: {
            fontFamily: 'system-ui, sans-serif',
            headings: { fontFamily: 'system-ui, sans-serif', fontWeight: '600' },
            code: { fontFamily: 'ui-monospace, monospace' },
          },
          sidebar: { width: '200px', backgroundColor: background, textColor: foreground },
          schema: { nestedBackground: dark ? '#252526' : '#fafafa' },
          rightPanel: { backgroundColor: dark ? '#111827' : '#263238' },
        },
      });

      // Redoc normally searches the whole document and shares URL history.
      // Scope its public menu hooks to this block so duplicate operation IDs
      // in different Markdown fences navigate independently.
      const sectionForId = (id: string) => root.querySelector(`[data-section-id="${CSS.escape(id)}"]`);
      store.menu.getElementAt = (index) => {
        const item = store.menu.flatItems[index];
        return item ? sectionForId(item.id) : null;
      };
      store.menu.getElementAtOrFirstChild = (index) => {
        let item = store.menu.flatItems[index];
        if (item?.type === 'group') item = item.items[0];
        return item ? sectionForId(item.id) : null;
      };
      store.menu.scroll.scrollIntoViewBySelector = (selector) => store.menu.scroll.scrollIntoView(root.querySelector(selector));
      if (scrollContainer) {
        const scroll = store.menu.scroll;
        scroll.scrollY = () => scrollContainer.scrollTop;
        scroll.scrollIntoView = (section) => section?.scrollIntoView({ block: 'start' });
        scroll.bind();
        scrollContainer.addEventListener('scroll', scroll.handleScroll);
        const dispose = scroll.dispose.bind(scroll);
        scroll.dispose = () => {
          scrollContainer.removeEventListener('scroll', scroll.handleScroll);
          dispose();
        };
      }
      flushSync(() => instance!.render(createElement(StyleSheetManager, { target: styles },
        createElement(Redoc, { store, key: dark ? 'dark' : 'light' }))));
      sanitizeLinks();
    };

    render(document.documentElement.classList.contains('dark'));
    themeObserver = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark');
      if (dark !== mount.classList.contains('dark-mode')) render(dark);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  })().catch((error) => {
    element.error = error instanceof Error ? error : new Error(String(error));
    instance?.unmount();
    instance = undefined;
    root.textContent = `OpenAPI: ${element.error.message}`;
  });
  return element.ready;
}
