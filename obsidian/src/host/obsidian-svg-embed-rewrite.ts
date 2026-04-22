/**
 * Rewrites Obsidian SVG embeds into standard Markdown image syntax.
 *
 * The shared markdown pipeline does not understand ![[...]] embeds, but it
 * already supports normal image nodes pointing to SVG files.
 */

type LinkResolver = (linkPath: string) => string | null;

export function rewriteObsidianSvgEmbeds(
  markdown: string,
  sourcePath: string,
  resolveLinkPath: LinkResolver,
): string {
  if (!markdown.includes('![[')) {
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

    return rewriteInlineSvgEmbeds(line, sourcePath, resolveLinkPath);
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

function rewriteInlineSvgEmbeds(
  line: string,
  sourcePath: string,
  resolveLinkPath: LinkResolver,
): string {
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
        const rewritten = rewriteSingleSvgEmbed(
          line.slice(index + 3, closingIndex),
          sourcePath,
          resolveLinkPath,
        );
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

function rewriteSingleSvgEmbed(
  embedContent: string,
  sourcePath: string,
  resolveLinkPath: LinkResolver,
): string | null {
  const linkPath = extractEmbedLinkPath(embedContent);
  if (!linkPath || !isSvgPath(linkPath)) {
    return null;
  }

  const resolvedPath = resolveLinkPath(linkPath);
  const imagePath = resolvedPath
    ? (isSvgPath(resolvedPath) ? toRelativeVaultPath(sourcePath, resolvedPath) : linkPath)
    : linkPath;

  return `![](${formatMarkdownDestination(imagePath)})`;
}

function extractEmbedLinkPath(embedContent: string): string {
  const raw = embedContent.trim();
  const pipeIndex = raw.indexOf('|');
  return (pipeIndex === -1 ? raw : raw.slice(0, pipeIndex)).trim();
}

function isSvgPath(path: string): boolean {
  const clean = path.split('|')[0]?.split('#')[0]?.split('?')[0] ?? path;
  return clean.toLowerCase().endsWith('.svg');
}

function toRelativeVaultPath(sourcePath: string, targetPath: string): string {
  const sourceDir = dirname(normalizeVaultPath(sourcePath));
  const from = splitVaultPath(sourceDir);
  const to = splitVaultPath(normalizeVaultPath(targetPath));

  let commonLength = 0;
  while (
    commonLength < from.length &&
    commonLength < to.length &&
    from[commonLength] === to[commonLength]
  ) {
    commonLength += 1;
  }

  const up = Array(Math.max(0, from.length - commonLength)).fill('..');
  const down = to.slice(commonLength);
  const relative = [...up, ...down].join('/');

  return relative || basename(targetPath);
}

function normalizeVaultPath(path: string): string {
  const segments = path.split('/');
  const resolved: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join('/');
}

function dirname(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? '' : path.slice(0, lastSlash);
}

function basename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? path : path.slice(lastSlash + 1);
}

function splitVaultPath(path: string): string[] {
  return path ? path.split('/').filter(Boolean) : [];
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
