/**
 * Remark plugin to support GitHub-style alert syntax.
 * Compatible with unified 11 / remark-parse 11 / micromark architecture.
 *
 * GitHub renders "alerts" as styled blockquotes whose first line is an
 * alert marker, e.g.:
 *
 *   > [!NOTE]
 *   > Useful information that users should know.
 *
 * The supported alert kinds (matched case-insensitively) are:
 *   NOTE, TIP, IMPORTANT, WARNING, CAUTION
 *
 * The marker must be the first line of the blockquote and sit on its own line.
 * `> [!NOTE] content` (marker and content on the same line) is intentionally
 * NOT treated as an alert, matching GitHub's behaviour.
 *
 * This plugin rewrites such blockquotes into:
 *
 *   <blockquote class="markdown-alert markdown-alert-note">
 *     <p class="markdown-alert-title">Note</p>
 *     <p>Useful information that users should know.</p>
 *   </blockquote>
 *
 * which mirrors the DOM GitHub produces, so existing blockquote styling applies
 * and the alert can be themed independently.
 */

import { visit } from 'unist-util-visit';
import type { Plugin } from 'unified';
import type { Root, Paragraph, Blockquote, Text } from 'mdast';

/** Alert kinds recognised by GitHub, in their canonical casing. */
const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
type AlertType = (typeof ALERT_TYPES)[number];

const ALERT_TYPE_SET = new Set<string>(ALERT_TYPES);

/** Human-readable title shown in the alert header, per kind. */
const ALERT_TITLES: Record<AlertType, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

/** Lowercased kind for the CSS class, e.g. `markdown-alert-note`. */
function alertClass(type: AlertType): string {
  return `markdown-alert-${type.toLowerCase()}`;
}

interface WithData {
  data?: {
    hProperties?: Record<string, unknown> | { className?: string | string[] };
    [key: string]: unknown;
  };
}

/**
 * Build the title paragraph node that precedes the alert body.
 * Carries `markdown-alert-title` as an hProperties className so remark-rehype
 * renders `<p class="markdown-alert-title">Title</p>`.
 */
function createAlertTitle(type: AlertType): Paragraph {
  return {
    type: 'paragraph',
    data: { hProperties: { className: ['markdown-alert-title'] } },
    children: [{ type: 'text', value: ALERT_TITLES[type] }],
  };
}

/**
 * Merge a className into a node's existing hProperties without clobbering
 * other data fields remark-rehype may rely on.
 */
function setHPropertiesClassName(node: WithData, className: string[]): void {
  const data = node.data ?? {};
  data.hProperties = { ...(data.hProperties as Record<string, unknown> | undefined), className };
  node.data = data;
}

/**
 * Attempt to recognise a GitHub alert marker at the very start of a blockquote.
 * Returns the alert kind and the remainder of the first text node after the
 * marker line, or null when the blockquote is not an alert.
 *
 * `rest` is the content that follows the marker on the same paragraph. When
 * the marker line is the only content of the paragraph, `rest` is the empty
 * string and the caller should drop the now-empty paragraph.
 */
function detectAlert(firstText: Text): { type: AlertType; rest: string } | null {
  const value = firstText.value;

  // Marker: [!KIND] optionally followed by trailing spaces, then either a line
  // break (marker on its own line) or end-of-text. Anything else (e.g. a space
  // then prose) means the marker is not on its own line and is not an alert.
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(\r?\n)?([\s\S]*)$/i.exec(value);
  if (!match) return null;

  const type = match[1].toUpperCase() as AlertType;
  if (!ALERT_TYPE_SET.has(type)) return null;

  const newline = match[2] ?? '';
  const rest = match[3] ?? '';

  // No newline after the marker: only valid when nothing follows (a bare
  // `> [!NOTE]`). A marker immediately followed by prose is not an alert.
  if (newline === '' && rest !== '') return null;

  return { type, rest };
}

/**
 * Transform a blockquote recognised as a GitHub alert:
 * - strip the marker line
 * - drop the now-empty first paragraph if it had no other content
 * - tag the blockquote with the alert classes
 * - prepend a title paragraph
 */
function applyAlert(blockquote: Blockquote, type: AlertType, firstParagraph: Paragraph, firstText: Text, rest: string): void {
  if (rest === '') {
    // The marker occupied the whole first text node. Remove that text node so
    // any inline content that followed it (strong/em/…) becomes the body.
    firstParagraph.children = firstParagraph.children.filter((child) => child !== firstText);
    if (firstParagraph.children.length === 0) {
      // The paragraph held only the marker line; drop it entirely.
      blockquote.children = blockquote.children.filter((child) => child !== firstParagraph);
    }
  } else {
    // Marker line followed by content on the next line of the same paragraph.
    firstText.value = rest;
  }

  setHPropertiesClassName(blockquote as unknown as WithData, ['markdown-alert', alertClass(type)]);
  blockquote.children.unshift(createAlertTitle(type));
}

const remarkGithubAlerts: Plugin<[], Root> = function () {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const firstParagraph = node.children[0];
      if (!firstParagraph || firstParagraph.type !== 'paragraph') return;

      const firstChild = firstParagraph.children[0];
      if (!firstChild || firstChild.type !== 'text') return;

      const detected = detectAlert(firstChild);
      if (!detected) return;

      applyAlert(node, detected.type, firstParagraph, firstChild, detected.rest);
    });
  };
};

export default remarkGithubAlerts;
