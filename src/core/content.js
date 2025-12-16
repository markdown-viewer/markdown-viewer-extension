// Markdown Viewer Content Script - Chrome Extension Entry Point
// Uses shared markdown-processor for core processing logic

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import ExtensionRenderer from '../utils/renderer.js';
import DocxExporter from '../exporters/docx-exporter.js';
import Localization, { DEFAULT_SETTING_LOCALE } from '../utils/localization.js';
import themeManager from '../utils/theme-manager.js';
import { loadAndApplyTheme } from '../utils/theme-to-css.js';
import { registerRemarkPlugins } from '../plugins/index.js';
import { platform } from '../platform/chrome/index.js';
import {
  normalizeMathBlocks,
  escapeHtml,
  sanitizeRenderedHtml,
  processTablesForWordCompatibility,
  renderHtmlIncrementally
} from './markdown-processor.js';

// Import refactored modules
import { BackgroundCacheManagerProxy } from './cache-proxy.js';
import { createScrollManager } from './scroll-manager.js';
import { createFileStateManager, getCurrentDocumentUrl, saveToHistory } from './file-state.js';
import { createAsyncTaskQueue } from './async-task-queue.js';
import { updateProgress, showProcessingIndicator, hideProcessingIndicator } from './ui/progress-indicator.js';
import { createTocManager } from './ui/toc-manager.js';
import { createToolbarManager, generateToolbarHTML, layoutIcons } from './ui/toolbar.js';

async function initializeContentScript() {
  // Record page load start time for performance measurement
  const pageLoadStartTime = performance.now();
  const translate = (key, substitutions) => Localization.translate(key, substitutions);

  // Initialize cache manager with platform
  const cacheManager = new BackgroundCacheManagerProxy(platform);
  
  // Initialize renderer with background cache proxy
  const renderer = new ExtensionRenderer(cacheManager);

  // Initialize DOCX exporter
  const docxExporter = new DocxExporter(renderer);

  // Store renderer and utility functions globally for plugins and debugging
  window.extensionRenderer = renderer;
  window.docxExporter = docxExporter;
  window.sanitizeRenderedHtml = sanitizeRenderedHtml;

  // Initialize file state manager
  const { saveFileState, getFileState } = createFileStateManager(platform);

  // Initialize scroll manager
  const scrollManager = createScrollManager(platform, getCurrentDocumentUrl);
  const { cancelScrollRestore, restoreScrollPosition, getSavedScrollPosition } = scrollManager;

  // Initialize TOC manager
  const tocManager = createTocManager(saveFileState, getFileState);
  const { generateTOC, setupTocToggle, updateActiveTocItem, setupResponsiveToc } = tocManager;

  // Initialize async task queue
  const asyncTaskQueueManager = createAsyncTaskQueue(escapeHtml);
  const { asyncTask, processAsyncTasks } = asyncTaskQueueManager;

  // Get the raw markdown content
  const rawMarkdown = document.body.textContent;

  // Get saved state early to prevent any flashing
  const initialState = await getFileState();

  // Layout configurations
  const layoutTitles = {
    normal: translate('toolbar_layout_title_normal'),
    fullscreen: translate('toolbar_layout_title_fullscreen'),
    narrow: translate('toolbar_layout_title_narrow')
  };

  const layoutConfigs = {
    normal: { maxWidth: '1360px', icon: layoutIcons.normal, title: layoutTitles.normal },
    fullscreen: { maxWidth: '100%', icon: layoutIcons.fullscreen, title: layoutTitles.fullscreen },
    narrow: { maxWidth: '680px', icon: layoutIcons.narrow, title: layoutTitles.narrow }
  };
  
  // Determine initial layout and zoom from saved state
  const initialLayout = (initialState.layoutMode && layoutConfigs[initialState.layoutMode]) 
    ? initialState.layoutMode 
    : 'normal';
  const initialMaxWidth = layoutConfigs[initialLayout].maxWidth;
  const initialZoom = initialState.zoom || 100;
  
  // Default TOC visibility based on screen width if no saved state
  let initialTocVisible;
  if (initialState.tocVisible !== undefined) {
    initialTocVisible = initialState.tocVisible;
  } else {
    initialTocVisible = window.innerWidth > 1024;
  }
  const initialTocClass = initialTocVisible ? '' : ' hidden';

  const toolbarPrintDisabledTitle = translate('toolbar_print_disabled_title');

  // Initialize toolbar manager
  const toolbarManager = createToolbarManager({
    translate,
    escapeHtml,
    saveFileState,
    getFileState,
    rawMarkdown,
    docxExporter,
    cancelScrollRestore,
    updateActiveTocItem,
    toolbarPrintDisabledTitle
  });

  // Set initial zoom level
  toolbarManager.setInitialZoom(initialZoom);

  // Create a new container for the rendered content
  document.body.innerHTML = generateToolbarHTML({
    translate,
    escapeHtml,
    initialTocClass,
    initialMaxWidth,
    initialZoom
  });

  // Set initial body class for TOC state
  if (!initialTocVisible) {
    document.body.classList.add('toc-hidden');
  }

  // Wait a bit for DOM to be ready, then start processing
  setTimeout(async () => {
    // Get saved scroll position
    const savedScrollPosition = await getSavedScrollPosition();

    // Initialize toolbar
    toolbarManager.initializeToolbar();

    // Parse and render markdown
    await renderMarkdown(rawMarkdown, savedScrollPosition);

    // Save to history after successful render
    await saveToHistory(platform);

    // Setup TOC toggle
    setupTocToggle();

    // Setup keyboard shortcuts
    toolbarManager.setupKeyboardShortcuts();

    // Setup responsive behavior
    await setupResponsiveToc();

    // Now that all DOM is ready, process async tasks
    setTimeout(() => {
      processAsyncTasks(translate, showProcessingIndicator, hideProcessingIndicator, updateProgress);
    }, 200);
  }, 100);

  // Listen for scroll events and save position to background script
  let scrollTimeout;
  try {
    window.addEventListener('scroll', () => {
      // Update active TOC item
      updateActiveTocItem();
      
      // Debounce scroll saving to avoid too frequent background messages
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        try {
          const currentPosition = window.scrollY || window.pageYOffset;
          saveFileState({
            scrollPosition: currentPosition
          });
        } catch (e) {
          // Ignore errors
        }
      }, 300);
    });
  } catch (e) {
    // Scroll event listener setup failed, continuing without scroll persistence
  }

  async function renderMarkdown(markdown, savedScrollPosition = 0) {
    const contentDiv = document.getElementById('markdown-content');

    if (!contentDiv) {
      console.error('markdown-content div not found!');
      return;
    }

    // Load and apply theme
    try {
      const themeId = await themeManager.loadSelectedTheme();
      const theme = await themeManager.loadTheme(themeId);
      await loadAndApplyTheme(themeId);
      
      // Set theme configuration for renderer
      if (theme && theme.fontScheme && theme.fontScheme.body) {
        const fontFamily = themeManager.buildFontFamily(theme.fontScheme.body.fontFamily);
        const fontSize = parseFloat(theme.fontScheme.body.fontSize);
        await renderer.setThemeConfig({
          fontFamily: fontFamily,
          fontSize: fontSize
        });
      }
    } catch (error) {
      console.error('Failed to load theme, using defaults:', error);
    }

    // Pre-process markdown to normalize math blocks and list markers
    let normalizedMarkdown = normalizeMathBlocks(markdown);

    try {
      // Setup markdown processor with async plugins
      const processor = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkBreaks)
        .use(remarkMath);
      
      // Register all plugins from plugin registry
      registerRemarkPlugins(processor, renderer, asyncTask, translate, escapeHtml, visit);
      
      // Continue with rehype processing
      processor
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeSlug)
        .use(rehypeHighlight)
        .use(rehypeKatex)
        .use(rehypeStringify, { allowDangerousHtml: true });

      const file = await processor.process(normalizedMarkdown);
      let htmlContent = String(file);

      // Add table centering for better Word compatibility
      htmlContent = processTablesForWordCompatibility(htmlContent);

      // Sanitize HTML before injecting into the document
      htmlContent = sanitizeRenderedHtml(htmlContent);

      // Render incrementally to avoid blocking the main thread
      contentDiv.innerHTML = '';
      await renderHtmlIncrementally(contentDiv, htmlContent, { batchSize: 200, yieldDelay: 0 });

      // Show the content container
      const pageDiv = document.getElementById('markdown-page');
      if (pageDiv) {
        pageDiv.classList.add('loaded');
      }

      // Generate table of contents after rendering
      await generateTOC();

      // Apply initial zoom to ensure scroll margins are correct
      toolbarManager.applyZoom(toolbarManager.getZoomLevel(), false);

      // Restore scroll position immediately
      restoreScrollPosition(savedScrollPosition);
      
      // Update TOC active state initially
      setTimeout(updateActiveTocItem, 100);

    } catch (error) {
      console.error('Markdown processing error:', error);
      console.error('Error stack:', error.stack);
      contentDiv.innerHTML = `<pre style="color: red; background: #fee; padding: 20px;">Error processing markdown: ${error.message}\n\nStack:\n${error.stack}</pre>`;
      restoreScrollPosition(savedScrollPosition);
    }
  }
}

platform.message.addListener((message) => {
  if (!message) {
    return;
  }
  
  if (message.type === 'localeChanged') {
    const locale = message.locale || DEFAULT_SETTING_LOCALE;

    Localization.setPreferredLocale(locale)
      .catch((error) => {
        console.error('Failed to update locale in content script:', error);
      })
      .finally(() => {
        window.location.reload();
      });
  } else if (message.type === 'themeChanged') {
    window.location.reload();
  }
});

Localization.init().catch((error) => {
  console.error('Localization init failed in content script:', error);
}).finally(() => {
  initializeContentScript();
});
