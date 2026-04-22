import GithubSlugger from 'github-slugger';

type ResolveLinkPath = (linkPath: string, sourcePath: string) => string | null;
type ReadMarkdownFile = (path: string) => Promise<string | null>;

interface ExpandOptions {
  resolveLinkPath: ResolveLinkPath;
  readMarkdownFile: ReadMarkdownFile;
  maxDepth?: number;
}

interface EmbedTarget {
  linkPath: string;
  fragment: string;
}

/**
 * Expand Obsidian markdown embeds (![[...]] for markdown notes) into real markdown content.
 *
 * Non-markdown embeds (images, media) are left unchanged for later pipeline stages.
 */
export async function expandObsidianMarkdownEmbeds(
  markdown: string,
  sourcePath: string,
  options: ExpandOptions,
): Promise<string> {
  if (!markdown.includes('![[')) {
    return markdown;
  }

  const maxDepth = Math.max(0, options.maxDepth ?? 2);
  return expandInternal(markdown, sourcePath, options, 0, new Set<string>(), maxDepth);
}

async function expandInternal(
  markdown: string,
  sourcePath: string,
  options: ExpandOptions,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
): Promise<string> {
  if (depth > maxDepth || !markdown.includes('![[')) {
    return markdown;
  }

  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = markdown.endsWith('\n');
  const lines = markdown.split(/\r?\n/);
  let activeFence: { char: '`' | '~'; length: number } | null = null;
  const outputLines: string[] = [];

  for (const line of lines) {
    const fence = parseFenceMarker(line);
    if (fence) {
      if (!activeFence) {
        activeFence = fence;
      } else if (activeFence.char === fence.char && fence.length >= activeFence.length) {
        activeFence = null;
      }
      outputLines.push(line);
      continue;
    }

    if (activeFence || !line.includes('![[')) {
      outputLines.push(line);
      continue;
    }

    const expanded = await rewriteInlineEmbeds(line, sourcePath, options, depth, visited, maxDepth);
    outputLines.push(expanded);
  }

  const rewritten = outputLines.join(newline);
  return hasTrailingNewline && !rewritten.endsWith(newline)
    ? rewritten + newline
    : rewritten;
}

async function rewriteInlineEmbeds(
  line: string,
  sourcePath: string,
  options: ExpandOptions,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
): Promise<string> {
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
        const embedContent = line.slice(index + 3, closingIndex);
        const expanded = await expandSingleEmbed(embedContent, sourcePath, options, depth, visited, maxDepth);
        if (expanded !== null) {
          output += expanded;
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

async function expandSingleEmbed(
  embedContent: string,
  sourcePath: string,
  options: ExpandOptions,
  depth: number,
  visited: Set<string>,
  maxDepth: number,
): Promise<string | null> {
  const target = parseEmbedTarget(embedContent);
  if (!target || !target.linkPath || isMediaPath(target.linkPath)) {
    return null;
  }

  const resolvedPath = options.resolveLinkPath(target.linkPath, sourcePath);
  if (!resolvedPath || !isMarkdownPath(resolvedPath)) {
    return null;
  }

  const visitKey = `${resolvedPath}#${target.fragment}`;
  if (visited.has(visitKey)) {
    return null;
  }

  visited.add(visitKey);
  try {
    const raw = await options.readMarkdownFile(resolvedPath);
    if (raw === null) {
      return null;
    }

    const embedded = selectEmbeddedContent(raw, target.fragment);
    if (!embedded.trim()) {
      return null;
    }

    const recursivelyExpanded = await expandInternal(
      embedded,
      resolvedPath,
      options,
      depth + 1,
      visited,
      maxDepth,
    );

    return ensureStandaloneBlock(recursivelyExpanded);
  } finally {
    visited.delete(visitKey);
  }
}

function parseEmbedTarget(embedContent: string): EmbedTarget | null {
  const raw = embedContent.trim();
  if (!raw) {
    return null;
  }

  const pipeIndex = raw.indexOf('|');
  const linkPart = (pipeIndex === -1 ? raw : raw.slice(0, pipeIndex)).trim();
  if (!linkPart) {
    return null;
  }

  const hashIndex = linkPart.indexOf('#');
  if (hashIndex === -1) {
    return { linkPath: linkPart, fragment: '' };
  }

  return {
    linkPath: linkPart.slice(0, hashIndex).trim(),
    fragment: linkPart.slice(hashIndex + 1).trim(),
  };
}

function selectEmbeddedContent(markdown: string, fragment: string): string {
  if (!fragment) {
    return markdown;
  }

  if (fragment.startsWith('^')) {
    const block = extractBlockById(markdown, fragment.slice(1));
    return block ?? '';
  }

  const section = extractHeadingSection(markdown, fragment);
  return section ?? '';
}

function extractHeadingSection(markdown: string, headingRef: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const target = headingRef.trim();
  if (!target) {
    return null;
  }

  const targetSlug = slugifyHeading(target);
  let start = -1;
  let level = 7;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(?: {0,3})(#{1,6})\s+(.*)$/);
    if (!match) continue;

    const headingLevel = match[1].length;
    const rawHeading = stripHeadingTrailingHashes(match[2].trim());
    const headingSlug = slugifyHeading(rawHeading);
    if (rawHeading === target || headingSlug === targetSlug) {
      start = i;
      level = headingLevel;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(?: {0,3})(#{1,6})\s+/);
    if (!match) continue;

    if (match[1].length <= level) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join('\n');
}

function extractBlockById(markdown: string, blockId: string): string | null {
  const safeId = escapeRegExp(blockId.trim());
  if (!safeId) {
    return null;
  }

  const lines = markdown.split(/\r?\n/);
  const markerRegex = new RegExp(`(?:^|\\s)\\^${safeId}(?:\\s|$)`);

  let markerLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (markerRegex.test(lines[i])) {
      markerLine = i;
      break;
    }
  }

  if (markerLine === -1) {
    return null;
  }

  let start = markerLine;
  while (start > 0 && lines[start - 1].trim() !== '') {
    start -= 1;
  }

  let end = markerLine;
  while (end + 1 < lines.length && lines[end + 1].trim() !== '') {
    end += 1;
  }

  return lines.slice(start, end + 1).join('\n');
}

function slugifyHeading(text: string): string {
  const slugger = new GithubSlugger();
  return slugger.slug(text);
}

function stripHeadingTrailingHashes(text: string): string {
  return text.replace(/\s+#+\s*$/, '').trim();
}

function ensureStandaloneBlock(markdown: string): string {
  const trimmed = markdown.trim();
  return trimmed ? `\n${trimmed}\n` : '';
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

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function isMediaPath(path: string): boolean {
  return /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp|mp3|mp4|mov|webm|pdf)$/i.test(path);
}

function countRun(text: string, start: number, char: string): number {
  let count = 0;
  while (text[start + count] === char) {
    count += 1;
  }
  return count;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
