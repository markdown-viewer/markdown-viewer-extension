/**
 * Host-injected CSS scoping contract.
 *
 * Obsidian injects the plugin's `styles.css` into the host application
 * document, so every top-level selector competes with Obsidian's own styles.
 * An unscoped `body { color: var(--gray-700) }` (light palette) overrode the
 * host editor's text color and made the editor unreadable in dark appearance
 * (issue #126).
 *
 * `scripts/scope-css.js` rewrites the stylesheet so it can only match inside
 * the viewer container. These tests pin the rewrite rules and check that the
 * real stylesheets no longer leak host-level selectors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

import { scopeCss, scopeSelector, splitFirstCompound } from '../../../scripts/scope-css.js';

const SCOPE = '.markdown-viewer-preview';
const CONTAINER_CLASSES = ['markdown-viewer-preview', 'mv-embed', 'mv-panel'];

const scopeOptions = { scope: SCOPE, containerClasses: CONTAINER_CLASSES };

const SCOPED_STYLESHEETS = [
  'src/ui/styles.css',
  'src/ui/toc-panel.css',
  'vscode/src/webview/settings-panel.css',
];

function scoped(selector) {
  return scopeSelector(selector, SCOPE, CONTAINER_CLASSES).selectors;
}

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

/** Every selector in a stylesheet, skipping keyframe steps and @font-face. */
function collectSelectors(css) {
  const selectors = [];
  const visit = (container) => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'atrule') {
        const name = node.name.toLowerCase();
        if (name.includes('keyframes') || name === 'font-face') continue;
        if (node.nodes) visit(node);
        continue;
      }
      if (node.type === 'rule') selectors.push(...node.selectors);
    }
  };
  visit(postcss.parse(css));
  return selectors;
}

describe('CSS scoping: selector rewrite rules', () => {
  it('nests plain selectors inside the container', () => {
    assert.deepEqual(scoped('#page-shell'), [`${SCOPE} #page-shell`]);
    assert.deepEqual(scoped('.toolbar-btn:hover'), [`${SCOPE} .toolbar-btn:hover`]);
  });

  it('merges the scope into selectors that target the container element itself', () => {
    // `.mv-embed` is a class on the container element, so the scope has to be
    // merged into the compound — a descendant prefix would never match.
    assert.deepEqual(scoped('.mv-embed #markdown-wrapper'), [`${SCOPE}.mv-embed #markdown-wrapper`]);
    assert.deepEqual(scoped('.mv-embed.mv-panel #toc-overlay'), [`${SCOPE}.mv-embed.mv-panel #toc-overlay`]);
  });

  it('collapses document-root rules onto the container', () => {
    const body = scopeSelector('body', SCOPE, CONTAINER_CLASSES);
    assert.deepEqual(body.selectors, [SCOPE]);
    assert.equal(body.collapsedDocumentRoot, true);

    const root = scopeSelector(':root', SCOPE, CONTAINER_CLASSES);
    assert.deepEqual(root.selectors, [SCOPE]);
    assert.equal(root.collapsedDocumentRoot, true);
  });

  it('covers the container and its descendants for the universal selector', () => {
    assert.deepEqual(scoped('*'), [SCOPE, `${SCOPE} *`]);
  });

  it('keeps host context and inserts the scope after it', () => {
    // Runtime code toggles these state classes on document.body, so the host
    // prefix must stay matchable while the styled target stays inside.
    assert.deepEqual(scoped('body.toc-hidden #markdown-wrapper'), [`body.toc-hidden ${SCOPE} #markdown-wrapper`]);
    assert.deepEqual(scoped(':root.dark ::-webkit-scrollbar-thumb'), [`:root.dark ${SCOPE} ::-webkit-scrollbar-thumb`]);
    assert.deepEqual(
      scoped('html[data-source-view] body.remark-panel-open #markdown-wrapper'),
      [`html[data-source-view] body.remark-panel-open ${SCOPE} #markdown-wrapper`],
    );
  });

  it('does not collapse host state rules into unconditional ones', () => {
    // `body.sidebar-resizing { user-select: none }` must stay conditional on
    // the drag state — collapsing it would disable selection permanently.
    assert.deepEqual(scoped('body.sidebar-resizing'), [`body.sidebar-resizing ${SCOPE}`]);
  });

  it('splits compounds around parentheses, brackets and quotes', () => {
    assert.deepEqual(splitFirstCompound('.a:is(b, c) > .d'), { first: '.a:is(b, c)', rest: ' > .d' });
    assert.deepEqual(splitFirstCompound('a[href="x y"] .b'), { first: 'a[href="x y"]', rest: ' .b' });
  });
});

describe('CSS scoping: stylesheet transform', () => {
  it('nests descendant rules and keeps declarations', () => {
    const out = scopeCss('.a { color: red }\n.b .c { color: blue }', scopeOptions);
    assert.deepEqual(collectSelectors(out), [`${SCOPE} .a`, `${SCOPE} .b .c`]);
  });

  it('drops viewport declarations from the collapsed document-root rule', () => {
    const out = scopeCss('body { margin: 0; height: 100vh; overflow: hidden; color: red }', scopeOptions);
    assert.ok(!out.includes('100vh'), 'height: 100vh must not follow the scope element');
    assert.ok(!/overflow\s*:/.test(out), 'overflow: hidden must not follow the scope element');
    assert.ok(out.includes('color: red'), 'remaining declarations stay');
  });

  it('recurses into conditional at-rules but not into keyframes', () => {
    const out = scopeCss('@media print { .a { color: red } } @keyframes spin { from { opacity: 0 } }', scopeOptions);
    assert.deepEqual(collectSelectors(out), [`${SCOPE} .a`]);
    assert.ok(out.includes('@keyframes'), 'keyframes are preserved');
  });

  it('keeps @font-face at the top level and preserves data URLs', () => {
    const out = scopeCss('@font-face { font-family: KaTeX_Main; src: url("data:font/woff2;base64,AAAA") }', scopeOptions);
    assert.ok(out.startsWith('@font-face'), '@font-face must remain a top-level rule');
    assert.ok(out.includes('base64,AAAA'), 'data URLs must survive stringification');
  });

  it('handles every selector form used by the webview stylesheet', () => {
    const css = [
      ':root { --gray-700: #514b43 }',
      ':root.dark { --gray-700: #c7ccd4 }',
      '* { box-sizing: border-box }',
      'body { color: var(--gray-700) }',
      'body.toc-position-right #table-of-contents { display: none }',
      'html[data-source-view] #markdown-content { padding: 0 }',
      '.mv-embed #toolbar { display: none }',
      '#markdown-content { color: red }',
    ].join('\n');

    const selectors = collectSelectors(scopeCss(css, scopeOptions));

    // Nothing may address the host document root without also carrying the
    // scope (host state context) — the scope itself is the only exception.
    for (const selector of selectors) {
      assert.ok(selector.includes('markdown-viewer-preview'), `"${selector}" escaped the container`);
    }
    assert.ok(selectors.includes(SCOPE), ':root / body must collapse onto the container');
    assert.ok(selectors.includes(`:root.dark ${SCOPE}`));
    assert.ok(selectors.includes(`body.toc-position-right ${SCOPE} #table-of-contents`));
    assert.ok(selectors.includes(`html[data-source-view] ${SCOPE} #markdown-content`));
    assert.ok(selectors.includes(`${SCOPE}.mv-embed #toolbar`));
  });
});

describe('CSS scoping: stylesheet contract', () => {
  for (const relativePath of SCOPED_STYLESHEETS) {
    it(`${relativePath} cannot style host elements`, () => {
      const transformed = collectSelectors(scopeCss(readSource(relativePath), scopeOptions));

      for (const selector of transformed) {
        assert.ok(selector.includes('markdown-viewer-preview'), `${relativePath}: "${selector}" escaped the container`);
        // Free-floating document-root rules are what clobbered the host; the
        // declarations must have moved onto the container instead.
        assert.notEqual(selector.trim(), 'body', `${relativePath}: bare body rule survived`);
        assert.notEqual(selector.trim(), ':root', `${relativePath}: bare :root rule survived`);
        assert.notEqual(selector.trim(), '*', `${relativePath}: bare universal rule survived`);
      }
    });
  }

  it('the document-root declarations move onto the container', () => {
    const parsed = postcss.parse(scopeCss(readSource('src/ui/styles.css'), scopeOptions));
    const containerRules = parsed.nodes.filter(
      (node) => node.type === 'rule' && node.selector.trim() === SCOPE,
    );
    assert.ok(containerRules.length, 'body / :root declarations must collapse onto the container');

    const props = containerRules.flatMap((rule) => rule.nodes.filter((node) => node.type === 'decl').map((node) => node.prop));

    assert.ok(props.includes('color'), 'the text color that clobbered the host editor moves to the container');
    assert.ok(props.includes('font-family'), 'the font stack moves to the container');
    assert.ok(!props.includes('height'), 'height: 100vh is viewport-only and must be dropped');
    assert.ok(!props.includes('overflow'), 'overflow: hidden is viewport-only and must be dropped');
  });

  it('obsidian build scopes every injected stylesheet', () => {
    const build = readSource('obsidian/build.js');
    assert.ok(build.includes("from '../scripts/scope-css.js'"), 'build must reuse the shared scoping helper');

    // Every section of the combined styles.css goes through the transform —
    // the webview bundle, the settings panel and the TOC panel alike.
    assert.ok(
      /\.map\(\s*\(\[header, css\]\)\s*=>\s*`[^`]*\$\{scopeCss\(css, SCOPE_OPTIONS\)\}/.test(build),
      'all sections must be scoped before they are written out',
    );
    for (const source of ['webviewCssPath', 'settingsCssPath', 'tocPanelCssPath']) {
      assert.ok(build.includes(source), `${source} must be part of the scoped output`);
    }
  });
});
