/**
 * Inject ui/styles.css as a real <style> element on content-script-hosted
 * pages (file:// markdown preview etc.).
 *
 * Why not chrome.scripting.insertCSS? Styles injected via insertCSS do NOT
 * appear in document.styleSheets (verified in a real-extension probe), so
 * the export CSS collectors (collectFilteredCss / collectContentCss /
 * collectEpubCss) cannot enumerate them and the exported HTML/EPUB loses
 * every structural content rule (diagram-block centering, img/svg sizing,
 * KaTeX, ...). A <style> element is a normal document node, so collection
 * works exactly like the webview <link> path.
 *
 * FOUC is already handled by the document_start preload style
 * (#markdown-viewer-preload hides the page until the viewer renders).
 */
function injectContentStyles(): void {
  if (document.getElementById('mv-content-styles')) {
    return;
  }
  void (async () => {
    try {
      const css = await fetch(chrome.runtime.getURL('ui/styles.css')).then((r) => {
        if (!r.ok) throw new Error(`Unable to fetch ui/styles.css (${r.status})`);
        return r.text();
      });
      const style = document.createElement('style');
      style.id = 'mv-content-styles';
      style.textContent = css;
      document.head.appendChild(style);
    } catch {
      // Keep the previous behavior (no injected stylesheet) rather than
      // breaking the page when the fetch fails.
    }
  })();
}

injectContentStyles();

export {};
