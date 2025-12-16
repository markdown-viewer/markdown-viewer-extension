// Scroll Position Manager
// Handles saving and restoring scroll positions for markdown documents

/**
 * Creates a scroll manager for handling scroll position persistence.
 * @param {Object} platform - Platform API for messaging
 * @param {Function} getCurrentDocumentUrl - Function to get current document URL
 * @returns {Object} Scroll manager instance
 */
export function createScrollManager(platform, getCurrentDocumentUrl) {
  // Flag to stop scroll position restoration when user interacts
  let stopScrollRestore = false;

  /**
   * Stop the automatic scroll position restoration
   */
  function cancelScrollRestore() {
    stopScrollRestore = true;
  }

  /**
   * Restore scroll position after rendering
   * @param {number} scrollPosition - The saved scroll position to restore
   */
  function restoreScrollPosition(scrollPosition) {
    // Reset flag for new restoration
    stopScrollRestore = false;

    if (scrollPosition === 0) {
      // For position 0, just scroll to top immediately
      window.scrollTo(0, 0);
      platform.message.send({
        type: 'clearScrollPosition',
        url: getCurrentDocumentUrl()
      }).catch(() => {}); // Ignore errors
      return;
    }

    // Clear saved position
    platform.message.send({
      type: 'clearScrollPosition',
      url: getCurrentDocumentUrl()
    }).catch(() => {}); // Ignore errors

    // Debounced scroll adjustment
    let scrollTimer = null;
    const adjustmentTimeout = 5000; // Stop adjusting after 5 seconds
    const startTime = Date.now();

    // Listen for user scroll to stop restoration
    const onUserScroll = () => {
      stopScrollRestore = true;
      window.removeEventListener('wheel', onUserScroll);
      window.removeEventListener('keydown', onUserKeydown);
      window.removeEventListener('touchmove', onUserScroll);
    };

    const onUserKeydown = (e) => {
      // Stop on navigation keys
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        onUserScroll();
      }
    };

    window.addEventListener('wheel', onUserScroll, { passive: true });
    window.addEventListener('keydown', onUserKeydown);
    window.addEventListener('touchmove', onUserScroll, { passive: true });

    const adjustScroll = () => {
      if (stopScrollRestore || Date.now() - startTime > adjustmentTimeout) {
        // Cleanup listeners when stopping
        window.removeEventListener('wheel', onUserScroll);
        window.removeEventListener('keydown', onUserKeydown);
        window.removeEventListener('touchmove', onUserScroll);
        return;
      }

      // Cancel previous timer if exists
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }

      // Schedule scroll after 100ms of no changes
      scrollTimer = setTimeout(() => {
        if (!stopScrollRestore) {
          window.scrollTo(0, scrollPosition);
        }
      }, 100);
    };

    // Trigger initial scroll
    adjustScroll();

    // Monitor images loading
    const images = document.querySelectorAll('#markdown-content img');
    images.forEach(img => {
      if (!img.complete) {
        img.addEventListener('load', adjustScroll, { once: true });
        img.addEventListener('error', adjustScroll, { once: true });
      }
    });

    // Monitor async placeholders being replaced
    const observer = new MutationObserver(() => {
      adjustScroll();
    });

    const contentElement = document.getElementById('markdown-content');
    if (contentElement) {
      observer.observe(contentElement, {
        childList: true,
        subtree: true
      });
    }

    // Stop observing after timeout
    setTimeout(() => {
      observer.disconnect();
      window.removeEventListener('wheel', onUserScroll);
      window.removeEventListener('keydown', onUserKeydown);
      window.removeEventListener('touchmove', onUserScroll);
      if (scrollTimer) {
        clearTimeout(scrollTimer);
      }
    }, adjustmentTimeout);
  }

  /**
   * Get saved scroll position from background script
   * @returns {Promise<number>} Saved scroll position
   */
  async function getSavedScrollPosition() {
    let currentScrollPosition = 0;

    try {
      currentScrollPosition = window.scrollY || window.pageYOffset || 0;
    } catch (e) {
      // Window access blocked, use default position
    }

    // Get saved scroll position from background script
    try {
      const response = await platform.message.send({
        type: 'getScrollPosition',
        url: getCurrentDocumentUrl()
      });

      // Return saved position if available and current position is at top (page just loaded)
      if (response && typeof response.position === 'number' && currentScrollPosition === 0) {
        return response.position;
      }
    } catch (e) {
      // Failed to get saved position, use default
    }

    return currentScrollPosition;
  }

  return {
    cancelScrollRestore,
    restoreScrollPosition,
    getSavedScrollPosition
  };
}
