import type { Processor } from 'unified';
import { normalizeMathBlocks, sanitizeRenderedHtml, escapeHtml } from './markdown-processor';
import { escapePipesInTableCodeSpans } from '../utils/markdown-table-code';
import { appendDefinitionsForBlock, type LinkReferenceDefinitionMap } from './link-reference-definitions.ts';
import type { ParsedFootnotes, FootnoteDefinition } from './footnote-model.ts';

function replaceReferenceTextNodes(container: HTMLElement, definitions: FootnoteDefinition[]): void {
  if (definitions.length === 0) return;

  const defMap = new Map(definitions.map((def) => [def.label, def]));
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    if (!parent) continue;
    if (parent.closest('code, pre, a, .md-footnotes-container')) continue;

    const value = textNode.nodeValue || '';
    if (!value.includes('[^')) continue;

    const fragment = document.createDocumentFragment();
    const regex = /\[\^([^\]]+)\]/g;
    let lastIndex = 0;
    let matched = false;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(value)) !== null) {
      const label = match[1];
      const def = defMap.get(label);
      if (!def) continue;

      matched = true;
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(value.slice(lastIndex, match.index)));
      }

      const sup = document.createElement('sup');
      sup.className = 'footnote-ref';
      const anchor = document.createElement('a');
      anchor.href = `#${def.anchorId}`;
      anchor.id = `footnote-ref-${def.label}`;
      anchor.textContent = `[${def.label}]`;
      sup.appendChild(anchor);
      fragment.appendChild(sup);

      lastIndex = match.index + match[0].length;
    }

    if (!matched) continue;

    if (lastIndex < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(lastIndex)));
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

async function renderFootnoteContent(
  content: string,
  processor: Processor,
  linkDefinitions: LinkReferenceDefinitionMap,
): Promise<string> {
  // Footnote bodies are rendered on their own, so a `[label]: url` definition
  // they reference has to travel with them (same reason as block rendering).
  const withDefinitions = appendDefinitionsForBlock(content, linkDefinitions);
  const normalizedContent = escapePipesInTableCodeSpans(normalizeMathBlocks(withDefinitions));
  const file = await processor.process(normalizedContent);
  return sanitizeRenderedHtml(String(file));
}

function mergeLabelIntoFirstLine(label: string, contentHtml: string): string {
  // The label comes from the document (`[^label]:`) and may contain anything
  // but `]` — quotes and angle brackets included — so it is escaped before it
  // is interpolated into markup, exactly like the sanitized footnote body.
  const labelHtml = `<span class="footnote-label">[${escapeHtml(label)}]</span>`;
  if (!contentHtml.trim()) {
    return `<p>${labelHtml}</p>`;
  }

  if (/^<p[\s>]/i.test(contentHtml.trim())) {
    return contentHtml.replace(/<p([^>]*)>/i, `<p$1>${labelHtml} `);
  }

  return `<p>${labelHtml} ${contentHtml}</p>`;
}

export async function applyFootnotes(
  container: HTMLElement,
  footnotes: ParsedFootnotes,
  processor: Processor,
  linkDefinitions: LinkReferenceDefinitionMap,
): Promise<void> {
  container.querySelectorAll('.md-footnotes-container').forEach((node) => node.remove());
  if (footnotes.definitions.length === 0) return;

  replaceReferenceTextNodes(container, footnotes.definitions);

  const sectionHost = document.createElement('div');
  sectionHost.className = 'md-block md-footnotes-container footnotes-endnotes-block';

  const itemsHtml: string[] = [];
  for (const def of footnotes.definitions) {
    const contentHtml = await renderFootnoteContent(def.content, processor, linkDefinitions);
    itemsHtml.push([
      `  <li class="footnote-item" id="${escapeHtml(def.anchorId)}">`,
      `    <div class="footnote-content">${mergeLabelIntoFirstLine(def.label, contentHtml)}</div>`,
      '  </li>'
    ].join('\n'));
  }

  sectionHost.innerHTML = [
    '<section class="footnotes">',
    '  <h2 id="footnotes">Footnotes</h2>',
    '  <ul>',
    ...itemsHtml,
    '  </ul>',
    '</section>',
  ].join('\n');

  container.appendChild(sectionHost);
}
