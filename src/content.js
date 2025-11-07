// Markdown Viewer Content Script using unified + rehypeKatex + Extension Renderer
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import ExtensionRenderer from './renderer.js';
import ExtensionCacheManager from './cache-manager.js';

// Background Cache Proxy for Content Scripts
class BackgroundCacheManagerProxy {
  constructor() {
    this.dbName = 'MarkdownViewerCache';
    this.storeName = 'cache';
    this.dbVersion = 1;
  }

  async get(key) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'cacheOperation',
        operation: 'get',
        key: key
      });
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      return response.result;
    } catch (error) {
      return null;
    }
  }

  async set(key, value, type = 'unknown') {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'cacheOperation',
        operation: 'set',
        key: key,
        value: value,
        dataType: type
      });
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      return response.success;
    } catch (error) {
      return false;
    }
  }

  async clear() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'cacheOperation',
        operation: 'clear'
      });
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      return response.success;
    } catch (error) {
      return false;
    }
  }

  async getStats() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'cacheOperation',
        operation: 'getStats'
      });
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      return response.result;
    } catch (error) {
      return null;
    }
  }

  // No need for initDB since background handles it
  async initDB() {
    return Promise.resolve();
  }

  async calculateHash(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async generateKey(content, type) {
    const hash = await this.calculateHash(content);
    return `${hash}_${type}`;
  }
}

/**
 * Update processing status display
 * @param {string} title - Main status title
 * @param {string} status - Detailed status message
 * @param {string} progress - Progress information
 */
function updateProcessingStatus(title, status, progress = '') {
  const titleEl = document.getElementById('processing-title');
  const statusEl = document.getElementById('processing-status');
  const progressEl = document.getElementById('processing-progress');
  
  if (!titleEl || !statusEl || !progressEl) {
    return;
  }
  
  titleEl.textContent = title;
  statusEl.textContent = status;
  progressEl.textContent = progress;
}

/**
 * Hide processing overlay
 */
function hideProcessingOverlay() {
  const overlay = document.getElementById('processing-overlay');
  if (!overlay) {
    return;
  }
  
  overlay.style.opacity = '0';
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 300);
}

/**
 * Restore scroll position after rendering
 * @param {number} scrollPosition - The saved scroll position to restore
 */
function restoreScrollPosition(scrollPosition) {
  if (scrollPosition > 0) {
    // Function to perform the scroll restoration
    const performScroll = () => {
      window.scrollTo(0, scrollPosition);
      const currentPosition = window.scrollY || window.pageYOffset;
      
      // Clear sessionStorage after successful restoration (if available)
      try {
        const storageKey = `scroll_position_${document.location.href}`;
        sessionStorage.removeItem(storageKey);
      } catch (e) {
        // Ignore sessionStorage errors in sandboxed environments
      }
      
      // If the position wasn't set correctly, try again after a short delay
      if (Math.abs(currentPosition - scrollPosition) > 10) {
        setTimeout(() => {
          window.scrollTo(0, scrollPosition);
        }, 100);
      }
    };
    
    // Use requestAnimationFrame to ensure DOM is fully rendered
    requestAnimationFrame(() => {
      // Check if there are images that might still be loading
      const images = document.querySelectorAll('#markdown-content img');
      const imagePromises = Array.from(images).map(img => {
        if (img.complete) {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          img.addEventListener('load', resolve);
          img.addEventListener('error', resolve); // Resolve even on error
          // Timeout after 3 seconds to prevent infinite waiting
          setTimeout(resolve, 3000);
        });
      });
      
      if (imagePromises.length > 0) {
        Promise.all(imagePromises).then(() => {
          performScroll();
        });
      } else {
        performScroll();
      }
    });
  } else {
    // Still clear any stored position (if sessionStorage is available)
    try {
      const storageKey = `scroll_position_${document.location.href}`;
      sessionStorage.removeItem(storageKey);
    } catch (e) {
      // Ignore sessionStorage errors in sandboxed environments
    }
  }
}

/**
 * Normalize list markers in markdown text
 * Converts non-standard list markers to standard ones
 * @param {string} markdown - Raw markdown content
 * @returns {string} Normalized markdown
 */
function normalizeListMarkers(markdown) {
  // Convert bullet points (•) to standard dashes
  // Handle Tab + bullet + Tab pattern (common in some editors)
  let normalized = markdown.replace(/^(\s*)\t*[•◦▪▫]\t*\s*/gm, '$1- ');
  
  // Convert other common bullet symbols with various whitespace patterns
  normalized = normalized.replace(/^(\s*)\t*[▸▹►▷]\t*\s*/gm, '$1- ');
  
  // Handle cases where there are only tabs (convert to 2 spaces per tab for proper indentation)
  normalized = normalized.replace(/^(\t+)/gm, (match, tabs) => {
    return '  '.repeat(tabs.length);
  });
  
  // Convert numbered lists with various number formats
  normalized = normalized.replace(/^(\s*)([①②③④⑤⑥⑦⑧⑨⑩])\s+/gm, '$1$2. ');
  
  return normalized;
}

/**
 * Normalize math blocks in markdown text
 * Converts single-line $$...$$ to multi-line format for proper display math rendering
 * @param {string} markdown - Raw markdown content
 * @returns {string} Normalized markdown
 */
function normalizeMathBlocks(markdown) {
  // Match single-line display math blocks: $$...$$ (not starting/ending with $$$$)
  // Pattern explanation:
  // - (?<!\$\$) - not preceded by $$
  // - \$\$ - opening $$
  // - (.+?) - formula content (non-greedy)
  // - \$\$ - closing $$
  // - (?!\$\$) - not followed by $$
  const singleLineMathRegex = /^(\s*)(?<!\$\$)\$\$(.+?)\$\$(?!\$\$)\s*$/gm;
  
  let mathBlocksFound = 0;
  
  // Replace single-line math blocks with multi-line format
  const normalized = markdown.replace(singleLineMathRegex, (match, indent, formula) => {
    mathBlocksFound++;
    // Convert to multi-line format with proper spacing
    return `\n$$\n${formula.trim()}\n$$\n`;
  });
  
  return normalized;
}

/**
 * Remark plugin to convert Mermaid code blocks to PNG
 */
function remarkMermaidToPng(renderer) {
  return function() {
    return async (tree) => {
      const mermaidNodes = [];

      // Collect all mermaid code blocks
      visit(tree, 'code', (node, index, parent) => {
        if (node.lang === 'mermaid') {
          mermaidNodes.push({ node, index, parent });
        }
      });

      if (mermaidNodes.length === 0) {
        return;
      }

      updateProcessingStatus('正在处理 Mermaid 图表', `发现 ${mermaidNodes.length} 个图表`, `0/${mermaidNodes.length} 已完成`);

      // Convert each mermaid block
      for (let i = 0; i < mermaidNodes.length; i++) {
        const { node, index, parent } = mermaidNodes[i];
        
        try {
          updateProcessingStatus('正在处理 Mermaid 图表', '', `${i}/${mermaidNodes.length} 已完成`);
          
          const pngBase64 = await renderer.renderMermaidToPng(node.value);
          
          // Replace code block with HTML image
          parent.children[index] = {
            type: 'html',
            value: `<div class="mermaid-diagram" style="text-align: center; margin: 20px 0;"><img src="data:image/png;base64,${pngBase64}" alt="Mermaid diagram" style="max-width: 100%; height: auto;" /></div>`
          };
          
          updateProcessingStatus('正在处理 Mermaid 图表', '', `${i + 1}/${mermaidNodes.length} 已完成`);
        } catch (error) {
          // Keep original code block on error
          parent.children[index] = {
            type: 'html',
            value: `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">Mermaid Error: ${escapeHtml(error.message)}</pre>`
          };
        }
      }
    };
  };
}

/**
 * Remark plugin to convert HTML blocks to PNG
 */
function remarkHtmlToPng(renderer) {
  return function() {
    return async (tree) => {
      const htmlNodes = [];
      
      // Collect all significant HTML nodes
      visit(tree, 'html', (node, index, parent) => {
        const htmlContent = node.value.trim();
        
        // Check if it's a significant HTML block
        // Relax the conditions to catch more HTML blocks
        if ((htmlContent.startsWith('<div') || htmlContent.startsWith('<table') || htmlContent.startsWith('<svg')) && htmlContent.length > 100) {
          htmlNodes.push({ node, index, parent });
        }
      });
      
      if (htmlNodes.length === 0) {
        return;
      }
      
      updateProcessingStatus('正在处理 HTML 图表', `发现 ${htmlNodes.length} 个图表`, `0/${htmlNodes.length} 已完成`);
      
      for (let i = 0; i < htmlNodes.length; i++) {
        const { node, index, parent } = htmlNodes[i];
        
        try {
          updateProcessingStatus('正在处理 HTML 图表', '', `${i}/${htmlNodes.length} 已完成`);
          
          const pngBase64 = await renderer.renderHtmlToPng(node.value);
          
          // Replace HTML node with image
          parent.children[index] = {
            type: 'html',
            value: `<div class="html-diagram" style="text-align: center; margin: 20px 0;"><img src="data:image/png;base64,${pngBase64}" alt="HTML diagram" style="max-width: 100%; height: auto;" /></div>`
          };
          
          updateProcessingStatus('正在处理 HTML 图表', '', `${i + 1}/${htmlNodes.length} 已完成`);
        } catch (error) {
          // Keep original HTML on error but show error message
          parent.children[index] = {
            type: 'html',
            value: `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">HTML转换错误: ${escapeHtml(error.message)}</pre>`
          };
        }
      }
    };
  };
}

/**
 * Process HTML to convert SVG images to PNG
 */
async function processSvgImages(html, renderer) {
  const imgRegex = /<img\s+[^>]*src="([^"]+\.svg)"[^>]*>/gi;
  const matches = [];
  let match;
  
  // Collect all SVG image tags
  while ((match = imgRegex.exec(html)) !== null) {
    matches.push({
      fullMatch: match[0],
      src: match[1],
      index: match.index
    });
  }
  
  if (matches.length === 0) {
    return html;
  }
  
  updateProcessingStatus('正在处理 SVG 图像', `发现 ${matches.length} 个图像`, `0/${matches.length} 已完成`);
  
  // Process images in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, src } = matches[i];
    const imageNum = matches.length - i;
    
    try {
      updateProcessingStatus('正在处理 SVG 图像', `处理第 ${imageNum} 个图像`, `${imageNum - 1}/${matches.length} 已完成`);
      // Fetch SVG content
      let svgContent;
      if (src.startsWith('http://') || src.startsWith('https://')) {
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        svgContent = await response.text();
      } else {
        // For local files, we need to use a different approach
        // Since fetch is blocked by CORS, let's read the file via the extension background
        try {
          // Resolve the absolute file path
          const baseUrl = window.location.href;
          const absoluteUrl = new URL(src, baseUrl).href;
          
          // Send message to background script to read the file
          const response = await chrome.runtime.sendMessage({
            type: 'READ_LOCAL_FILE',
            filePath: absoluteUrl
          });
          
          if (response.error) {
            throw new Error(response.error);
          }
          
          svgContent = response.content;
        } catch (readError) {
          throw new Error(`Cannot read local SVG file "${src}": ${readError.message}`);
        }
      }
      
      const pngBase64 = await renderer.renderSvgToPng(svgContent);
      const newSrc = `data:image/png;base64,${pngBase64}`;
      
      // Replace the src in the HTML
      const newImgTag = fullMatch.replace(src, newSrc);
      html = html.substring(0, matches[i].index) + newImgTag + html.substring(matches[i].index + fullMatch.length);
      
      updateProcessingStatus('正在处理 SVG 图像', '', `${imageNum}/${matches.length} 已完成`);
    } catch (error) {
      console.error(`Failed to convert SVG ${imageNum}/${matches.length}: ${error.message}`);
      updateProcessingStatus('正在处理 SVG 图像', `第 ${imageNum} 个图像失败`, `${imageNum}/${matches.length} 已处理`);
      
      // Create error message with same styling as Mermaid errors
      const errorHtml = `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">SVG Error: Cannot load file "${escapeHtml(src)}" - ${escapeHtml(error.message)}</pre>`;
      
      // Replace the image tag with error message
      html = html.substring(0, matches[i].index) + errorHtml + html.substring(matches[i].index + fullMatch.length);
    }
  }
  
  return html;
}

/**
 * Process tables to add centering attributes for Word compatibility
 * @param {string} html - HTML content
 * @returns {string} HTML with centered tables
 */
function processTablesForWordCompatibility(html) {
  // Wrap tables with centering div and add align attributes (same as convert.js)
  html = html.replace(/<table>/g, '<div align="center"><table align="center">');
  html = html.replace(/<\/table>/g, '</table></div>');
  
  return html;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Initialize renderer with background cache proxy
const cacheManager = new BackgroundCacheManagerProxy();
const renderer = new ExtensionRenderer(cacheManager);

// Store renderer globally for debugging and access from other parts
window.extensionRenderer = renderer;

// Listen for cache operations messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle cache operations
  if (message.type === 'getCacheStats') {
    if (window.extensionRenderer && window.extensionRenderer.cacheManager) {
      window.extensionRenderer.cacheManager.getStats()
        .then(stats => {
          sendResponse(stats);
        })
        .catch(error => {
          console.error('Failed to get cache stats:', error);
          sendResponse({ error: error.message });
        });
      return true; // Keep message channel open
    } else {
      sendResponse({
        itemCount: 0,
        maxItems: 1000,
        totalSize: 0,
        totalSizeMB: '0.00',
        items: []
      });
    }
    return;
  }
  
  if (message.type === 'clearCache') {
    if (window.extensionRenderer && window.extensionRenderer.cacheManager) {
      window.extensionRenderer.cacheManager.clear()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch(error => {
          console.error('Failed to clear cache:', error);
          sendResponse({ error: error.message });
        });
      return true; // Keep message channel open
    } else {
      sendResponse({ error: 'No cache manager available' });
    }
    return;
  }
});

// Since this script is only injected when content-detector.js confirms this is a markdown file,
// we can directly proceed with processing
const isRemote = document.location.protocol !== 'file:';

// For sandboxed pages (like GitHub raw), we can't access sessionStorage
// So we'll use a simple fallback for scroll position
let savedScrollPosition = 0;
try {
  savedScrollPosition = window.scrollY || window.pageYOffset || 0;
  
  // Try to get scroll position from sessionStorage if available
  const storageKey = `scroll_position_${document.location.href}`;
  const storedPosition = sessionStorage.getItem(storageKey);
  if (storedPosition && savedScrollPosition === 0) {
    savedScrollPosition = parseInt(storedPosition, 10) || 0;
  }
  
  // Save to sessionStorage for future reloads if possible
  if (savedScrollPosition > 0) {
    sessionStorage.setItem(storageKey, savedScrollPosition.toString());
  }
} catch (e) {
  // If we can't access sessionStorage (sandboxed pages), just use current scroll position
  console.log('[Markdown Viewer] SessionStorage access blocked, using fallback');
  savedScrollPosition = window.scrollY || window.pageYOffset || 0;
}

// Get the raw markdown content
const rawMarkdown = document.body.textContent;

// Create a new container for the rendered content
document.body.innerHTML = `
  <div id="processing-overlay" class="processing-overlay">
    <div class="processing-content">
      <div class="processing-spinner"></div>
      <div id="processing-title">正在处理 Markdown 文档...</div>
      <div id="processing-status">正在解析文档结构</div>
      <div id="processing-progress"></div>
    </div>
  </div>
  <div id="table-of-contents">
    <div class="toc-header">目录</div>
  </div>
  <div id="toc-overlay" class="hidden"></div>
  <div id="markdown-wrapper">
    <div id="markdown-content"></div>
  </div>
`;

// Wait a bit for DOM to be ready, then start processing
setTimeout(async () => {
  // Parse and render markdown
  await renderMarkdown(rawMarkdown, savedScrollPosition);
  
  // Setup TOC toggle (using keyboard shortcut)
  setupTocToggle();
  
  // Setup responsive behavior
  setupResponsiveToc();
}, 100);

// Listen for scroll events to save position for potential future reloads
// Only if sessionStorage is available (not in sandboxed environments)
let scrollTimeout;
try {
  window.addEventListener('scroll', () => {
    // Debounce scroll saving to avoid too frequent sessionStorage writes
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      try {
        const currentPosition = window.scrollY || window.pageYOffset;
        if (currentPosition > 0) {
          const storageKey = `scroll_position_${document.location.href}`;
          sessionStorage.setItem(storageKey, currentPosition.toString());
        }
      } catch (e) {
        // Ignore sessionStorage errors in sandboxed environments
      }
    }, 300); // Save position 300ms after user stops scrolling
  });
} catch (e) {
  console.log('[Markdown Viewer] Scroll event listener setup failed, continuing without scroll persistence');
}

async function renderMarkdown(markdown, savedScrollPosition = 0) {
  updateProcessingStatus('正在处理 Markdown 文档...', '解析文档结构');
  
  const contentDiv = document.getElementById('markdown-content');
  
  if (!contentDiv) {
    console.error('markdown-content div not found!');
    updateProcessingStatus('处理失败', 'markdown-content 容器未找到');
    return;
  }

  // Pre-process markdown to normalize math blocks and list markers BEFORE parsing
  updateProcessingStatus('正在处理 Markdown 文档...', '处理数学公式');
  let normalizedMarkdown = normalizeMathBlocks(markdown);
  
  updateProcessingStatus('正在处理 Markdown 文档...', '标准化列表格式');
  normalizedMarkdown = normalizeListMarkers(normalizedMarkdown);

  try {
    // First, process markdown without PNG conversion plugins
    updateProcessingStatus('正在处理 Markdown 文档...', '设置 Markdown 处理器');
    
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath)
      .use(remarkHtmlToPng(renderer)) // Add HTML processing FIRST
      .use(remarkMermaidToPng(renderer)) // Add Mermaid processing AFTER HTML
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeSlug)
      .use(rehypeHighlight) // Add syntax highlighting
      .use(rehypeKatex)
      .use(rehypeStringify, { allowDangerousHtml: true });

    updateProcessingStatus('正在处理 Markdown 文档...', '转换 Markdown 为 HTML');
    const file = await processor.process(normalizedMarkdown);
    
    let htmlContent = String(file);
    
    // Process SVG images to PNG
    updateProcessingStatus('正在处理 SVG 图像', '转换图像格式');
    htmlContent = await processSvgImages(htmlContent, renderer);
    
    // Add table centering for better Word compatibility
    updateProcessingStatus('正在完成', '处理表格格式');
    htmlContent = processTablesForWordCompatibility(htmlContent);
    
    updateProcessingStatus('正在完成', '渲染最终内容');
    contentDiv.innerHTML = htmlContent;
    
    // Generate table of contents after rendering
    updateProcessingStatus('正在完成', '生成目录');
    generateTOC();
    
    // Hide processing overlay and restore scroll position
    setTimeout(() => {
      hideProcessingOverlay();
      restoreScrollPosition(savedScrollPosition);
    }, 200);
  } catch (error) {
    console.error('Markdown processing error:', error);
    console.error('Error stack:', error.stack);
    updateProcessingStatus('处理失败', `错误: ${error.message}`);
    contentDiv.innerHTML = `<pre style="color: red; background: #fee; padding: 20px;">Error processing markdown: ${error.message}\n\nStack:\n${error.stack}</pre>`;
    setTimeout(() => {
      hideProcessingOverlay();
      restoreScrollPosition(savedScrollPosition);
    }, 2000);
  }
}

function generateTOC() {
  const contentDiv = document.getElementById('markdown-content');
  const tocDiv = document.getElementById('table-of-contents');
  
  if (!contentDiv || !tocDiv) return;
  
  const headings = contentDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
  
  if (headings.length === 0) {
    tocDiv.style.display = 'none';
    return;
  }
  
  let tocHTML = '<div class="toc-header">目录</div><ul class="toc-list">';
  
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
  tocDiv.innerHTML = tocHTML;
}

function setupTocToggle() {
  const tocDiv = document.getElementById('table-of-contents');
  const overlayDiv = document.getElementById('toc-overlay');
  
  if (!tocDiv || !overlayDiv) return;
  
  const toggleToc = () => {
    tocDiv.classList.toggle('hidden');
    document.body.classList.toggle('toc-hidden');
    overlayDiv.classList.toggle('hidden');
  };
  
  // Use keyboard shortcut (Ctrl+T or Cmd+T) to toggle TOC
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 't') {
      e.preventDefault();
      toggleToc();
    }
  });
  
  // Close TOC when clicking overlay (for mobile)
  overlayDiv.addEventListener('click', toggleToc);
}

function setupResponsiveToc() {
  const tocDiv = document.getElementById('table-of-contents');
  
  if (!tocDiv) return;
  
  const handleResize = () => {
    if (window.innerWidth <= 1024) {
      // On smaller screens, hide TOC by default
      tocDiv.classList.add('hidden');
      document.body.classList.add('toc-hidden');
    } else {
      // On larger screens, show TOC by default
      tocDiv.classList.remove('hidden');
      document.body.classList.remove('toc-hidden');
    }
  };
  
  // Set initial state
  handleResize();
  
  // Listen for window resize
  window.addEventListener('resize', handleResize);
}
