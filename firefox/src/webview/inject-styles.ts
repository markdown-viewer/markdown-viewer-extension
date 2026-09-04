/**
 * Firefox counterpart of chrome/src/webview/inject-styles.ts.
 *
 * Inject ui/styles.css as a real <style> element on content-script-hosted
 * pages. browser.scripting.insertCSS (USER origin) never appears in
 * document.styleSheets, so the export CSS collectors cannot enumerate it
 * and exported HTML/EPUB would lose the shared content stylesheet.
 *
 * FOUC is handled by the document_start preload style.
 */

// Firefox WebExtension API — available as a global in content scripts.
declare const browser: {
  runtime: {
    getURL: (path: string) => string;
  };
};

function injectContentStyles(): void {
  if (document.getElementById('mv-content-styles')) {
    return;
  }
  void (async () => {
    try {
      const css = await fetch(browser.runtime.getURL('/ui/styles.css')).then((r) => {
        if (!r.ok) throw new Error(`Unable to fetch ui/styles.css (${r.status})`);
        return r.text();
      });
      const style = document.createElement('style');
      style.id = 'mv-content-styles';
      style.textContent = css;
      document.head.appendChild(style);
    } catch {
      // Keep the previous behavior rather than breaking the page.
    }
  })();
}

injectContentStyles();

export {};
