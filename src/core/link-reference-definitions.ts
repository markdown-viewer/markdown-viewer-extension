/**
 * CommonMark link reference definitions (`[label]: url "title"`).
 *
 * The viewer renders a document block by block: `splitMarkdownIntoBlocksWithLines`
 * hands one block at a time to remark, and micromark resolves `[text][label]`
 * / `![alt][label]` **while parsing**. A block that only references a label
 * therefore degrades to literal text whenever the definition lives in another
 * block — which is the normal authoring style (definitions collected at the
 * bottom of the file). That is issue #136: footnotes rendered fine because
 * `footnote-model.ts` extracts footnote definitions from the whole document
 * before splitting, while reference links had no equivalent.
 *
 * This module is that equivalent, in three steps:
 *
 * 1. `collectLinkReferenceDefinitions` parses the whole document **once** (and
 *    only when a definition-looking line exists) and keeps remark's own view of
 *    each definition, so label matching and URL/title decoding are exactly
 *    CommonMark's.
 * 2. `appendDefinitionsForBlock` re-appends, right before a block is parsed,
 *    only the definitions that block actually references. remark then resolves
 *    the references at parse time, through the normal pipeline (sanitizer,
 *    relative-URL rewriting, DOCX/HTML export).
 * 3. Nothing is stripped from the source: definition-only blocks keep their
 *    line and render to empty markup, exactly as they did before, so scroll
 *    sync line numbers stay aligned with the file.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

/**
 * A single link reference definition, resolved document-wide.
 */
export interface LinkReferenceDefinition {
  /** Destination, as mdast decoded it. */
  url: string;
  /** Optional title, as mdast decoded it. */
  title: string | null;
  /** The definition re-serialized as markdown, ready to be appended to a block. */
  markdown: string;
}

export type LinkReferenceDefinitionMap = Map<string, LinkReferenceDefinition>;

/**
 * Cheap prefilter: a definition line starts with an optional blockquote prefix
 * and a bracketed label (footnote definitions `[^x]:` are excluded — they are
 * `footnote-model.ts`'s job). Only a hit pays for the whole-document parse.
 */
const DEFINITION_HINT_RE = /^[ \t]*(?:>[ \t]*)*\[(?!\^)[^[\]\n]*\]:/m;

/**
 * `[label]` groups a block might resolve through a definition.
 *
 * Deliberately lossy in the safe direction: a group immediately followed by
 * `(` (inline link) or `[` (the text half of a full reference) is not a
 * reference, so it is skipped; everything else is kept, including the `[md]`
 * nested inside `[![md] Java][o-link]`. A false positive only costs a redundant
 * definition in the parse buffer — micromark still decides what resolves.
 */
const REFERENCE_CANDIDATE_RE = /(?=\[([^[\]\n]{1,999})\])(?!\[[^[\]\n]*\]\s*[\[(])/g;

/** A block that is entirely code never needs reference resolution. */
const FENCED_CODE_START_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;
const INDENTED_CODE_START_RE = /^(?: {4}|\t)/;

/**
 * Normalize a label into mdast's identifier form.
 *
 * micromark normalizes by collapsing markdown whitespace, trimming, then
 * lower- **and** uppercasing (the double case fold makes characters such as
 * `ϴ` canonical and keeps keys off `Object.prototype`); mdast-util-from-markdown
 * then lowercases that result before storing `node.identifier`. Reproducing both
 * steps is what makes a label found in a block match the label mdast recorded
 * for the definition.
 */
export function normalizeReferenceLabel(label: string): string {
  return label
    .replace(/[\t\n\r ]+/g, ' ')
    .trim()
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/g, (character) => `\\${character}`);
}

/**
 * Destination inside `<…>`: micrparse rejects `<`, `>` and line breaks there,
 * so those are percent-encoded. Backslashes are escapes in that context too.
 */
function escapeDestination(url: string): string {
  return url
    .replace(/[\\]/g, '\\\\')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/[\r\n]+/g, '%0A');
}

function escapeTitle(title: string): string {
  return title.replace(/[\\"]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, ' ');
}

function serializeDefinition(label: string, url: string, title: string | null): string {
  const destination = `<${escapeDestination(url)}>`;
  if (!title) {
    return `[${escapeLabel(label)}]: ${destination}`;
  }
  return `[${escapeLabel(label)}]: ${destination} "${escapeTitle(title)}"`;
}

interface DefinitionNode {
  identifier?: string;
  label?: string;
  url?: string;
  title?: string | null;
}

/**
 * Collect every link reference definition in a document, keyed by normalized
 * identifier. As in CommonMark, the **first** definition for a label wins.
 *
 * The document is parsed with `remark-parse` alone (definitions are core
 * CommonMark, not GFM), and only when the prefilter finds a definition-looking
 * line — documents without them pay a single regex scan.
 */
export function collectLinkReferenceDefinitions(markdown: string): LinkReferenceDefinitionMap {
  const definitions: LinkReferenceDefinitionMap = new Map();
  if (!markdown || !DEFINITION_HINT_RE.test(markdown)) {
    return definitions;
  }

  const tree = unified().use(remarkParse).parse(markdown);

  visit(tree, 'definition', (node) => {
    const definition = node as DefinitionNode;
    const identifier = definition.identifier;
    // Footnote definitions look like link definitions to a bare CommonMark
    // parse; footnote-model.ts owns those and strips them before this runs.
    if (!identifier || identifier.startsWith('^') || definitions.has(identifier)) {
      return;
    }

    const label = definition.label ?? identifier;
    const url = definition.url ?? '';
    const title = definition.title ?? null;
    definitions.set(identifier, {
      url,
      title,
      markdown: serializeDefinition(label, url, title),
    });
  });

  return definitions;
}

function isCodeOnlyBlock(content: string): boolean {
  const firstLine = content.split('\n').find((line) => line.trim() !== '');
  if (firstLine === undefined) {
    return false;
  }
  return FENCED_CODE_START_RE.test(firstLine) || INDENTED_CODE_START_RE.test(firstLine);
}

/**
 * Every distinct identifier a block bracket-references. Overlapping candidates
 * are allowed on purpose: `[![md] Java][o-link]` must yield both `md` (the
 * nested image reference) and `o-link`. False positives only cost a redundant
 * definition in the parse buffer, never a wrong link — micromark decides.
 */
export function blockReferencedLabels(content: string): string[] {
  if (!content.includes('[')) {
    return [];
  }

  const labels: string[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(REFERENCE_CANDIDATE_RE)) {
    const label = normalizeReferenceLabel(match[1]);
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
  }

  return labels;
}

/**
 * Append the definitions a block references, so the block can be parsed on its
 * own. Returns `content` unchanged when nothing matches (the common case), and
 * never touches code blocks (appending there could land inside an unclosed
 * fence).
 *
 * The block keeps its identity: definitions render to nothing, so a block that
 * only referenced labels gains links without gaining output nodes.
 */
export function appendDefinitionsForBlock(
  content: string,
  definitions: LinkReferenceDefinitionMap,
): string {
  if (definitions.size === 0) {
    return content;
  }

  if (isCodeOnlyBlock(content)) {
    return content;
  }

  const matched: string[] = [];
  for (const label of blockReferencedLabels(content)) {
    const definition = definitions.get(label);
    if (definition) {
      matched.push(definition.markdown);
    }
  }

  if (matched.length === 0) {
    return content;
  }

  // Blank lines on both sides start a new block: without them the definition
  // would be absorbed into the block's trailing paragraph or list item.
  return `${content}\n\n${matched.join('\n')}\n\n`;
}
