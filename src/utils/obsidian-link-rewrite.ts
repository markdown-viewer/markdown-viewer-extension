import GithubSlugger from 'github-slugger';
import { ensureRelativeDotSlash, isSpecialAbsoluteUrl } from './document-url.ts';

interface ParsedWikilink {
  path: string;
  fragment: string;
  detail: string;
}

/**
 * Rewrite Obsidian wiki links and embeds to standard markdown syntax.
 *
 * Supported patterns:
 * - [[note]] -> [note](note.md)
 * - [[note|alias]] -> [alias](note.md)
 * - [[note#heading]] -> [note](note.md#heading)
 * - [[#heading]] -> [heading](#heading)
 * - ![[image.svg|120]] -> ![](image.svg)
 * - ![[note]] -> [note](note.md)
 */
export function rewriteObsidianLinks(markdown: string): string {
  if (!markdown.includes('[[')) {
    return markdown;
  }

  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = markdown.endsWith('\n');
  const lines = markdown.split(/\r?\n/);
  let activeFence: { char: '`' | '~'; length: number } | null = null;

  const rewritten = lines.map((line) => {
    const fence = parseFenceMarker(line);
    if (fence) {
      if (!activeFence) {
        activeFence = fence;
      } else if (activeFence.char === fence.char && fence.length >= activeFence.length) {
        activeFence = null;
      }
      return line;
    }

    if (activeFence) {
      return line;
    }

    return rewriteInlineObsidianLinks(line);
  }).join(newline);

  return hasTrailingNewline && !rewritten.endsWith(newline)
    ? rewritten + newline
    : rewritten;
}

function parseFenceMarker(line: string): { char: '`' | '~'; length: number } | null {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
  if (!match) {
    return null;
  }

  const marker = match[1];
  const char = marker[0];
  if (char !== '`' && char !== '~') {
    return null;
  }

  return { char, length: marker.length };
}

function rewriteInlineObsidianLinks(line: string): string {
  let output = '';
  let index = 0;

  while (index < line.length) {
    if (line[index] === '`') {
      const tickCount = countRun(line, index, '`');
      const closingIndex = line.indexOf('`'.repeat(tickCount), index + tickCount);
      if (closingIndex === -1) {
        output += line.slice(index);
        break;
      }

      output += line.slice(index, closingIndex + tickCount);
      index = closingIndex + tickCount;
      continue;
    }

    if (line.startsWith('![[', index)) {
      const closingIndex = line.indexOf(']]', index + 3);
      if (closingIndex !== -1) {
        const rewritten = rewriteSingleWikilink(line.slice(index + 3, closingIndex), true);
        if (rewritten) {
          output += rewritten;
          index = closingIndex + 2;
          continue;
        }
      }
    }

    if (line.startsWith('[[', index)) {
      const closingIndex = line.indexOf(']]', index + 2);
      if (closingIndex !== -1) {
        const rewritten = rewriteSingleWikilink(line.slice(index + 2, closingIndex), false);
        if (rewritten) {
          output += rewritten;
          index = closingIndex + 2;
          continue;
        }
      }
    }

    output += line[index];
    index += 1;
  }

  return output;
}

function rewriteSingleWikilink(content: string, isEmbed: boolean): string | null {
  const parsed = parseWikilink(content);
  if (!parsed) {
    return null;
  }

  const isImg = isImageLikePath(parsed.path);

  const destination = buildDestination(parsed.path, parsed.fragment);
  if (!destination) {
    return null;
  }

  if (isEmbed && isImg) {
    return `![](${formatMarkdownDestination(destination)})`;
  }

  const text = buildLinkText(parsed, isEmbed);
  return `[${escapeLinkText(text)}](${formatMarkdownDestination(destination)})`;
}

function parseWikilink(content: string): ParsedWikilink | null {
  const raw = content.trim();
  if (!raw) {
    return null;
  }

  const pipeIndex = raw.indexOf('|');
  const linkPart = (pipeIndex === -1 ? raw : raw.slice(0, pipeIndex)).trim();
  const detailPart = pipeIndex === -1 ? '' : raw.slice(pipeIndex + 1).trim();
  if (!linkPart) {
    return null;
  }

  const hashIndex = linkPart.indexOf('#');
  if (hashIndex === -1) {
    return {
      path: linkPart,
      fragment: '',
      detail: detailPart,
    };
  }

  return {
    path: linkPart.slice(0, hashIndex).trim(),
    fragment: linkPart.slice(hashIndex + 1).trim(),
    detail: detailPart,
  };
}

function buildDestination(path: string, fragment: string): string {
  const normalizedPath = normalizeWikilinkPath(path);
  const normalizedFragment = normalizeFragment(fragment);

  if (!normalizedPath && !normalizedFragment) {
    return '';
  }
  if (!normalizedPath) {
    return `#${normalizedFragment}`;
  }
  if (!normalizedFragment) {
    return normalizedPath;
  }
  return `${normalizedPath}#${normalizedFragment}`;
}

function normalizeWikilinkPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }

  // Keep explicit URL-like destinations unchanged.
  if (isSpecialAbsoluteUrl(trimmed)) {
    return trimmed;
  }

  if (trimmed.endsWith('/')) {
    return ensureRelativeDotSlash(trimmed);
  }

  const slashIndex = trimmed.lastIndexOf('/');
  const basename = slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);

  // Obsidian links are often extensionless note names.
  if (!basename.includes('.')) {
    return ensureRelativeDotSlash(`${trimmed}.md`);
  }

  return ensureRelativeDotSlash(trimmed);
}

function normalizeFragment(fragment: string): string {
  const trimmed = fragment.trim();
  if (!trimmed) {
    return '';
  }

  // Keep block-id references as-is.
  if (trimmed.startsWith('^')) {
    return trimmed;
  }

  const slugger = new GithubSlugger();
  return slugger.slug(trimmed);
}

function isImageLikePath(path: string): boolean {
  if (!path) {
    return false;
  }
  return /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(path);
}

function buildLinkText(parsed: ParsedWikilink, isEmbed: boolean): string {
  if (!isEmbed && parsed.detail) {
    return parsed.detail;
  }

  const normalizedPath = normalizeWikilinkPath(parsed.path);
  const fragmentText = formatFragmentText(parsed.fragment);

  if (normalizedPath) {
    const slashIndex = normalizedPath.lastIndexOf('/');
    const basename = slashIndex === -1 ? normalizedPath : normalizedPath.slice(slashIndex + 1);
    const noteName = basename.replace(/\.md$/i, '') || basename;
    return fragmentText ? `${noteName}${formatFragmentSuffix(parsed.fragment, fragmentText)}` : noteName;
  }

  if (parsed.fragment.startsWith('^')) {
    return `^${fragmentText}`;
  }

  return fragmentText || 'link';
}

function formatFragmentText(fragment: string): string {
  if (!fragment) {
    return '';
  }

  return fragment.startsWith('^') ? fragment.slice(1) : fragment;
}

function formatFragmentSuffix(fragment: string, fragmentText: string): string {
  if (!fragment) {
    return '';
  }

  return fragment.startsWith('^') ? `#^${fragmentText}` : `#${fragmentText}`;
}

function escapeLinkText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function formatMarkdownDestination(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path;
}

function countRun(text: string, start: number, char: string): number {
  let count = 0;
  while (text[start + count] === char) {
    count += 1;
  }
  return count;
}
