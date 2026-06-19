const DEF_LINE_PATTERN = /^\[\^([^\]]+)\]:\s*(.*)/;

export interface FootnoteDefinition {
  label: string;
  anchorId: string;
  content: string;
}

export interface ParsedFootnotes {
  bodyMarkdown: string;
  definitions: FootnoteDefinition[];
}

export function parseFootnotes(markdown: string): ParsedFootnotes {
  const lines = markdown.split('\n');
  const definitions: FootnoteDefinition[] = [];
  const remaining: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(DEF_LINE_PATTERN);
    if (!match) {
      remaining.push(line);
      continue;
    }

    const label = match[1];
    const contentLines: string[] = [];
    const firstContent = match[2] || '';
    if (firstContent) {
      contentLines.push(firstContent);
    }

    index += 1;
    while (index < lines.length) {
      const nextLine = lines[index];

      if (/^( {4,}|\t)/.test(nextLine) && nextLine.trim() !== '') {
        contentLines.push(nextLine.replace(/^( {4}|\t)/, ''));
        index += 1;
        continue;
      }

      if (nextLine.trim() === '') {
        index += 1;
        break;
      }

      break;
    }
    index -= 1;

    definitions.push({
      label,
      anchorId: `footnote-${label}`,
      content: contentLines.join('\n').trim(),
    });
  }

  return {
    bodyMarkdown: remaining.join('\n'),
    definitions,
  };
}

export function buildDocxFootnoteMarkdown(markdown: string): string {
  const { bodyMarkdown, definitions } = parseFootnotes(markdown);
  if (definitions.length === 0) return markdown;

  let content = bodyMarkdown;
  for (const def of definitions) {
    const escaped = def.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    content = content.replace(new RegExp(`\\[\\^${escaped}\\]`, 'g'), `<sup>[${def.label}]</sup>`);
  }

  const footnoteLines: string[] = ['', '', '## Footnotes', ''];
  for (const def of definitions) {
    const contentLines = def.content.split('\n');
    if (contentLines.length === 0 || (contentLines.length === 1 && !contentLines[0])) {
      footnoteLines.push(`- [${def.label}]`);
      continue;
    }

    footnoteLines.push(`- [${def.label}] ${contentLines[0]}`);
    for (let index = 1; index < contentLines.length; index++) {
      footnoteLines.push(`    ${contentLines[index]}`);
    }
  }

  return content + footnoteLines.join('\n');
}
