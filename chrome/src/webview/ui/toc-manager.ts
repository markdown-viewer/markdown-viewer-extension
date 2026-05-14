// Table of Contents Manager
// Handles TOC generation, toggle, and active item tracking

interface FileState {
  tocVisible?: boolean;
  [key: string]: unknown;
}

type SaveFileStateFunction = (state: FileState) => void;
type GetFileStateFunction = () => Promise<FileState>;

interface TocManager {
  generateTOC(): Promise<void>;
  setupTocToggle(): () => void;
  updateActiveTocItem(): void;
  scrollTocToActiveItem(activeLink: Element, tocDiv: Element): void;
  setupResponsiveToc(): Promise<void>;
}

const TOC_NAVIGATION_SCROLL_BEHAVIOR: ScrollBehavior = 'auto';

/**
 * Creates a TOC manager for handling table of contents functionality.
 * @param saveFileState - Function to save file state
 * @param getFileState - Function to get file state
 * @returns TOC manager instance
 */
export function createTocManager(
  saveFileState: SaveFileStateFunction,
  getFileState: GetFileStateFunction,
  isMobile: boolean
): TocManager {
  let tocGenerationToken = 0;

  function getScrollContainer(): HTMLElement | null {
    return document.getElementById('markdown-wrapper') as HTMLElement | null;
  }

  function scrollTargetIntoView(target: HTMLElement): void {
    const scrollContainer = getScrollContainer();
    if (!scrollContainer) {
      target.scrollIntoView({ behavior: TOC_NAVIGATION_SCROLL_BEHAVIOR, block: 'start' });
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const targetTop = targetRect.top - containerRect.top + scrollContainer.scrollTop;

    scrollContainer.scrollTo({
      top: Math.max(0, targetTop),
      behavior: TOC_NAVIGATION_SCROLL_BEHAVIOR
    });
  }

  /**
   * Generate table of contents from headings
   */
  async function generateTOC(): Promise<void> {
    const token = ++tocGenerationToken;
    const contentDiv = document.getElementById('markdown-content');
    const tocDiv = document.getElementById('table-of-contents');

    if (!contentDiv || !tocDiv) return;

    const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');

    if (headings.length === 0) {
      tocDiv.style.display = 'none';
      tocDiv.classList.add('hidden');
      document.body.classList.add('toc-hidden');
      return;
    }

    // Clear stale inline display state from the no-headings path.
    tocDiv.style.display = '';

    // Generate TOC list only
    let tocHTML = '<ul class="toc-list">';

    headings.forEach((heading, index) => {
      const level = parseInt(heading.tagName[1]);
      const text = heading.textContent;
      const id = heading.id || `heading-${index}`;

      if (!heading.id) {
        heading.id = id;
      }

      const indent = (level - 1) * 20;
      tocHTML += `<li style="margin-left: ${indent}px"><a href="#${id}">${text}</a></li>`;
    });

    tocHTML += '</ul>';

    // A newer generateTOC call started while we were building; abandon stale result.
    if (token !== tocGenerationToken) {
      return;
    }

    tocDiv.innerHTML = tocHTML;

    tocDiv.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();

        const href = (link as HTMLAnchorElement).getAttribute('href');
        if (!href?.startsWith('#')) {
          return;
        }

        const target = document.getElementById(decodeURIComponent(href.slice(1)));
        if (!target) {
          return;
        }

        scrollTargetIntoView(target as HTMLElement);
      });
    });
    
    // In embed mode the parent controls TOC visibility via postMessage; skip saved-state restoration.
    if (document.body.dataset.mvEmbed === '1') {
      return;
    }

    // Apply saved TOC visibility state after generating TOC
    const savedState = await getFileState();
    if (token !== tocGenerationToken) {
      return;
    }
    const overlayDiv = document.getElementById('toc-overlay');
    
    if (overlayDiv) {
      // Determine desired visibility: use saved state if available, otherwise use responsive default
      let shouldBeVisible: boolean;
      if (savedState.tocVisible !== undefined) {
        shouldBeVisible = savedState.tocVisible;
      } else {
        // No saved state - only mobile uses collapsed TOC by default.
        shouldBeVisible = !isMobile;
      }
      
      const currentlyVisible = !tocDiv.classList.contains('hidden');
      
      // Only update if state doesn't match
      if (shouldBeVisible !== currentlyVisible) {
        if (!shouldBeVisible) {
          // Hide TOC
          tocDiv.classList.add('hidden');
          document.body.classList.add('toc-hidden');
          overlayDiv.classList.add('hidden');
        } else {
          // Show TOC
          tocDiv.classList.remove('hidden');
          document.body.classList.remove('toc-hidden');
          if (isMobile) {
            overlayDiv.classList.remove('hidden');
          } else {
            overlayDiv.classList.add('hidden');
          }
        }
      }

      // Keep body/toc state consistent even when visibility does not change in this cycle.
      document.body.classList.toggle('toc-hidden', tocDiv.classList.contains('hidden'));
    }
  }

  /**
   * Setup TOC toggle functionality
   * @returns Toggle function
   */
  function setupTocToggle(): () => void {
    const tocDiv = document.getElementById('table-of-contents');
    const overlayDiv = document.getElementById('toc-overlay');

    if (!tocDiv || !overlayDiv) return () => {};

    const toggleToc = (): void => {
      const willBeHidden = !tocDiv.classList.contains('hidden');
      tocDiv.classList.toggle('hidden');
      document.body.classList.toggle('toc-hidden');
      if (isMobile) {
        overlayDiv.classList.toggle('hidden');
      } else {
        overlayDiv.classList.add('hidden');
      }
      
      // Save TOC visibility state
      saveFileState({
        tocVisible: !willBeHidden
      });
    };

    // Close TOC when clicking overlay on mobile only.
    if (isMobile) {
      overlayDiv.addEventListener('click', toggleToc);
    }

    // Return toggleToc function for use by toolbar button and keyboard shortcuts
    return toggleToc;
  }

  /**
   * Update active TOC item based on scroll position
   * Highlights the last heading that is above the viewport top
   */
  function updateActiveTocItem(): void {
    const contentDiv = document.getElementById('markdown-content');
    const tocDiv = document.getElementById('table-of-contents');
    
    if (!contentDiv || !tocDiv) return;
    
    const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) return;

    const scrollContainer = getScrollContainer();
    if (!scrollContainer) return;
    
    // Get current scroll position
    const scrollTop = scrollContainer.scrollTop;
    
    // Get current zoom level
    let currentZoom = 1;
    if ((contentDiv as HTMLElement).style.zoom) {
      currentZoom = parseFloat((contentDiv as HTMLElement).style.zoom) || 1;
    }

    // Threshold: toolbar height (50px) + small tolerance (10px)
    // Scale threshold with zoom to ensure accurate detection
    // Use Math.max to ensure threshold is never too small for low zoom levels
    const threshold = Math.max(10, 10 * currentZoom);
    const containerRect = scrollContainer.getBoundingClientRect();
    
    // Find the last heading that is above or near the viewport top
    let activeHeading: Element | null = null;
    
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];
      const headingTop = heading.getBoundingClientRect().top - containerRect.top + scrollTop;
      
      // If heading is above viewport top + threshold
      if (headingTop <= scrollTop + threshold) {
        activeHeading = heading;
      } else {
        // Headings are in order, so we can break once we find one below
        break;
      }
    }
    
    // Update TOC highlighting
    const tocLinks = tocDiv.querySelectorAll('a');
    tocLinks.forEach(link => {
      link.classList.remove('active');
    });
    
    if (activeHeading && activeHeading.id) {
      const activeLink = tocDiv.querySelector(`a[href="#${activeHeading.id}"]`);
      if (activeLink) {
        activeLink.classList.add('active');
        
        // Scroll TOC to make active item visible
        scrollTocToActiveItem(activeLink, tocDiv);
      }
    }
  }

  /**
   * Scroll TOC container to ensure active item is visible
   * @param activeLink - The active TOC link element
   * @param tocDiv - The TOC container element
   */
  function scrollTocToActiveItem(activeLink: Element, tocDiv: Element): void {
    if (!activeLink || !tocDiv) return;
    
    const linkRect = activeLink.getBoundingClientRect();
    const tocRect = tocDiv.getBoundingClientRect();
    
    // Calculate if link is outside visible area
    const linkTop = linkRect.top - tocRect.top + tocDiv.scrollTop;
    const linkBottom = linkTop + linkRect.height;
    
    const visibleTop = tocDiv.scrollTop;
    const visibleBottom = visibleTop + (tocDiv as HTMLElement).clientHeight;
    
    // Add some padding for better UX
    const padding = 20;
    
    if (linkTop < visibleTop + padding) {
      // Link is above visible area, scroll up
      tocDiv.scrollTop = linkTop - padding;
    } else if (linkBottom > visibleBottom - padding) {
      // Link is below visible area, scroll down
      tocDiv.scrollTop = linkBottom - (tocDiv as HTMLElement).clientHeight + padding;
    }
  }

  /**
   * Setup responsive TOC behavior
   */
  async function setupResponsiveToc(): Promise<void> {
    // Keep this method for compatibility with existing call sites.
    // TOC visibility is controlled by explicit user action/state only.
    return;
  }

  return {
    generateTOC,
    setupTocToggle,
    updateActiveTocItem,
    scrollTocToActiveItem,
    setupResponsiveToc
  };
}
