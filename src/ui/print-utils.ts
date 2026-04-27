export async function printElement(element: HTMLElement, title = document.title): Promise<void> {
  const markdownContent = element.querySelector('#markdown-content') as HTMLElement | null;
  // Extract theme background color for @page and html/body rules
  const pageBackgroundColor = markdownContent
    ? getComputedStyle(markdownContent).backgroundColor
    : (getComputedStyle(document.body).backgroundColor || '');

  // Firefox does not support @page { background-color }; margin area will remain white on Firefox.
  // Chrome 131+ supports it, so we always use 12mm margins.

  const printStyle = document.createElement('style');
  printStyle.id = 'mv-print-inject';
  printStyle.textContent = `
    @page {
      margin: 12mm;
      /* @page { background-color } is Chrome 131+ only; covers the bleed area including margin zone */
      background-color: ${pageBackgroundColor};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    @media print {
      html {
        /* print-color-adjust: exact on the root element propagates to the document viewport
           per CSS Color Adjust Level 1 §4.1, covering the canvas background (html background).
           On Firefox with @page { margin: 0 }, html background fills the entire page. */
        background-color: ${pageBackgroundColor} !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      body {
        background-color: ${pageBackgroundColor} !important;
      }
      /* Diagram images: wrapper <div> sets the design width; <img> is fully auto (max-width:100% +
         max-height clamp). Both dims auto on <img> so replaced-element algorithm preserves
         aspect ratio when max-height triggers on tall diagrams. */
      #markdown-content img {
        max-width: 100%;
        max-height: 9.5in;
        height: auto;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      #markdown-content .diagram-block {
        overflow: visible !important;
        max-width: 100% !important;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      #markdown-content .diagram-block img {
        max-width: 100% !important;
        max-height: 9.5in !important;
        width: auto !important;
        height: auto !important;
      }
      /* SVG diagrams: shared screen rule sets width:100% to fill the container; in print we
         want to keep natural size so small diagrams don't get blown up. Force width/height auto
         here to neutralize that screen-only rule. */
      #markdown-content .diagram-block svg {
        max-height: 9.5in !important;
        max-width: 100% !important;
        width: auto !important;
        height: auto !important;
      }
    }
  `;
  document.head.appendChild(printStyle);

  const cleanup = () => {
    if (printStyle.parentNode) {
      printStyle.parentNode.removeChild(printStyle);
    }
  };

  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();

  // Fallback cleanup in case afterprint doesn't fire
  setTimeout(cleanup, 2000);
}