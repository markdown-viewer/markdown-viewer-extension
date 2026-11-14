/**
 * Reference-style links and images in the LIVE viewer (issue #136).
 *
 * The viewer renders a document one block at a time, and CommonMark resolves
 * `[text][label]` while a block is parsed — so a definition sitting in another
 * block used to leave the reference as literal text. This runs the real browser
 * renderer over a fixture whose definitions are deliberately kept away from
 * their uses, and asserts what the reader actually sees.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';

import {
  createBrowserRenderHarness,
  type BrowserRenderHarness,
} from '../../helpers/browser-render-harness.ts';

const FIXTURE = path.resolve('test/fixtures/layout/reference-links.md');

const FIXED_PARAMS = {
  theme: 'default',
  language: 'en',
  frontmatterDisplay: 'hide',
  tableMergeEmpty: false,
  tableLayout: 'center',
  imageLayout: 'center',
  diagramLayout: 'center',
  timeoutMs: 180_000,
} as const;

describe('reference-style links in the viewer', () => {
  let harness: BrowserRenderHarness;
  let html: string;

  before(async () => {
    harness = await createBrowserRenderHarness({ inputPath: FIXTURE });
    html = await harness.renderHtml(FIXTURE, FIXED_PARAMS);
  });

  after(async () => {
    await harness.dispose();
  });

  it('resolves a full reference link', () => {
    assert.match(
      html,
      /<a href="https:\/\/example\.com\/docs"[^>]*>Example Site<\/a>/,
      '`[Example Site][site]` must become a real link',
    );
  });

  it('resolves a shortcut reference link', () => {
    // The shortcut form has no second bracket pair: the text IS the label.
    assert.match(
      html,
      /Shortcut reference:.*?<a href="https:\/\/example\.com\/docs"/s,
      '`[site]` must resolve through its definition',
    );
  });

  it('embeds a reference-style image', () => {
    // The viewer inlines document-relative images as data URLs, so the
    // assertion is on the presence of the rendered picture, not on its src.
    assert.match(
      html,
      /<img src="data:image\//,
      '`![Logo][logo]` must render the image defined elsewhere',
    );
    assert.match(html, /<img [^>]*alt="Logo"/, 'the reference image keeps its alt text');
  });

  it('keeps a reference image clickable inside a reference link', () => {
    assert.match(
      html,
      /<a href="https:\/\/example\.com\/docs"[^>]*>\s*<img /s,
      '`[![Logo][logo]][site]` must nest the image inside the link',
    );
  });

  it('keeps a reference image inside an inline link', () => {
    assert.match(
      html,
      /<a href="https:\/\/example\.com\/inline"[^>]*>\s*<img /s,
      '`[![Logo][logo]](url)` must resolve the reference image inside the link',
    );
  });

  it('resolves references used inside table cells', () => {
    assert.match(
      html,
      /<td><a href="https:\/\/example\.com\/docs"/,
      'a reference in a table cell must resolve',
    );
    assert.match(
      html,
      /<td><img src="data:image\//,
      'a reference image in a table cell must resolve',
    );
  });

  it('leaves an undefined label literal, as CommonMark specifies', () => {
    assert.ok(
      html.includes('[Undefined][missing-label]'),
      'an unresolved reference must stay literal text, not disappear',
    );
  });

  it('hides the definition blocks themselves', () => {
    assert.ok(
      !/<p>\s*\[site\]:/.test(html),
      'a `[site]: url` definition must not render as a paragraph',
    );
  });
});
