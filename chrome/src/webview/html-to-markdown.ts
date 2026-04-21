/**
 * HTML to Markdown Converter Content Script
 *
 * This script is injected into HTML pages when the user triggers
 * "View as Markdown" via the context menu. It extracts the readable
 * article content using Readability, converts it to Markdown using
 * Turndown, and stores the result on window so the viewer can consume it.
 */

import { isProbablyReaderable, Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
// @ts-ignore – no bundled typings for turndown-plugin-gfm
import { gfm } from 'turndown-plugin-gfm';

export interface HtmlConvertedMarkdown {
  markdown: string;
  title: string;
  /** Original page URL */
  url: string;
}

declare global {
  interface Window {
    __mvHtmlConvertedMarkdown?: HtmlConvertedMarkdown;
  }
}

function convertHtmlPageToMarkdown(): HtmlConvertedMarkdown | null {
  // Self-detect: only convert if the page is a rendered HTML document.
  // For raw files (text/plain, application/octet-stream, etc.) the viewer
  // can render them directly from document.body.textContent.
  const contentType: string =
    (document as unknown as { contentType?: string }).contentType || '';
  console.debug('[mv:html2md] contentType:', contentType || '(empty)');

  if (contentType && !contentType.includes('text/html')) {
    console.debug('[mv:html2md] non-HTML content-type, skipping conversion');
    return null;
  }

  // If contentType is empty (e.g. some file:// URLs) check whether the body
  // is just a single <pre> wrapper – a clear sign this is raw plain text.
  if (!contentType) {
    const kids = Array.from(document.body?.children ?? []);
    if (kids.length === 1 && kids[0].tagName === 'PRE') {
      console.debug('[mv:html2md] single <pre> body, treating as raw text');
      return null;
    }
  }
  // Clone to avoid mutating the live DOM
  const documentClone = document.cloneNode(true) as Document;

  // Try Readability-based article extraction first
  let articleContent: string | null = null;
  let articleTitle = document.title || '';

  const isReaderable = isProbablyReaderable(documentClone);
  console.debug('[mv:html2md] isProbablyReaderable:', isReaderable);

  try {
    if (isReaderable) {
      const reader = new Readability(documentClone);
      const article = reader.parse();
      if (article) {
        articleContent = article.content;
        if (article.title) articleTitle = article.title;
        console.debug('[mv:html2md] readability title:', articleTitle, '| content length:', articleContent?.length);
        // Check if Readability result already contains JSON
        const rdJsonIdx = articleContent?.indexOf('{"props"') ?? -1;
        console.debug('[mv:html2md] json in readability output:', rdJsonIdx >= 0 ? articleContent!.slice(rdJsonIdx, rdJsonIdx + 120) : 'none');
      }
    }
  } catch (e) {
    console.warn('[mv:html2md] Readability failed:', e);
    // Readability failed; fall through to manual fallback
  }

  // Fallback: pick the most content-rich container
  if (!articleContent) {
    const mainEl =
      documentClone.querySelector('main') ||
      documentClone.querySelector('[role="main"]') ||
      documentClone.querySelector('#main-content') ||
      documentClone.querySelector('#main') ||
      documentClone.querySelector('#content') ||
      documentClone.querySelector('.content') ||
      documentClone.body;

    console.debug('[mv:html2md] fallback container:', mainEl?.tagName, mainEl?.id || mainEl?.className?.slice(0, 40));
    articleContent = mainEl ? mainEl.innerHTML : documentClone.body.innerHTML;
  }

  // Set up Turndown
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  td.use(gfm);

  // Remove elements Turndown should silently ignore
  td.remove([
    'script',
    'style',
    'noscript',
    'svg',
    'iframe',
    'canvas',
    'form',
    'button',
    'dialog',
  ]);

  // Skip base64 images – they bloat the markdown and are useless as text
  td.addRule('ignoreBase64Images', {
    filter(node: Node): boolean {
      if ((node as Element).nodeName === 'IMG') {
        const src = (node as Element).getAttribute('src') || '';
        return src.startsWith('data:image');
      }
      return false;
    },
    replacement(): string {
      return '';
    },
  });

  let markdown = td.turndown(articleContent);

  // Check if JSON survived into markdown output
  const mdJsonIdx = markdown.indexOf('{"props"');
  console.debug('[mv:html2md] json in markdown output:', mdJsonIdx >= 0 ? markdown.slice(mdJsonIdx, mdJsonIdx + 120) : 'none');
  console.debug('[mv:html2md] markdown length:', markdown.length, '| first 200:', markdown.slice(0, 200));

  // Clean up: lone dashes / middle-dots on their own line
  markdown = markdown.replace(/^[ \t]*[-·][ \t]*$/gm, '');
  // Collapse runs of blank lines to a single blank line
  markdown = markdown.replace(/^[ \t]+$/gm, '');
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

  return {
    markdown,
    title: articleTitle,
    url: window.location.href,
  };
}

// Run immediately when injected and expose the result on window.
// Returns null for non-HTML pages so the viewer falls back to raw textContent.
const result = convertHtmlPageToMarkdown();
if (result) {
  window.__mvHtmlConvertedMarkdown = result;
}
