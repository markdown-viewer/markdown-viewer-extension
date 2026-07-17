// Heading anchor links
// Injects a hover-revealed "#" anchor next to each rendered heading so a reader
// can jump to / bookmark / share a specific section (Laravel-docs style).
// Browser viewer only (chrome/edge/firefox).

import Localization from '../../../../src/utils/localization';

const ANCHOR_CLASS = 'heading-anchor';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

export interface HeadingAnchorsController {
  /** (Re)inject anchors after a render. Idempotent. */
  refresh(): void;
}

/**
 * Set up in-content heading anchor links.
 *
 * @param onNavigate - Called with the heading id when an anchor is clicked.
 *   The caller is responsible for scrolling and updating the URL hash.
 * @returns Controller exposing a `refresh()` to re-inject after re-renders.
 */
export function setupHeadingAnchors(onNavigate: (id: string) => void): HeadingAnchorsController {
  const contentDiv = document.getElementById('markdown-content');

  if (!contentDiv) {
    return { refresh: () => {} };
  }

  // Delegated click handling: survives incremental block re-renders that replace
  // heading DOM, so a single listener covers all current and future anchors.
  contentDiv.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest(`a.${ANCHOR_CLASS}`) as HTMLAnchorElement | null;
    if (!anchor || !contentDiv.contains(anchor)) {
      return;
    }

    event.preventDefault();

    const href = anchor.getAttribute('href');
    if (!href?.startsWith('#')) {
      return;
    }

    onNavigate(decodeURIComponent(href.slice(1)));
  });

  function refresh(): void {
    const title = Localization.translate('heading_anchor_title') || 'Link to this section';
    const headings = contentDiv!.querySelectorAll<HTMLElement>(HEADING_SELECTOR);

    headings.forEach((heading) => {
      // Only headings with an id are addressable.
      if (!heading.id) {
        return;
      }

      // Skip if an anchor is already present (idempotent across re-renders).
      if (heading.querySelector(`:scope > a.${ANCHOR_CLASS}`)) {
        return;
      }

      const anchor = document.createElement('a');
      anchor.className = ANCHOR_CLASS;
      anchor.href = `#${encodeURIComponent(heading.id)}`;
      anchor.setAttribute('aria-label', title);
      anchor.title = title;
      // The visible "#" glyph is drawn via CSS ::before so it never leaks into
      // heading.textContent (which the TOC and heading extraction rely on).
      anchor.setAttribute('tabindex', '-1');
      anchor.contentEditable = 'false';

      heading.appendChild(anchor);
    });
  }

  return { refresh };
}
