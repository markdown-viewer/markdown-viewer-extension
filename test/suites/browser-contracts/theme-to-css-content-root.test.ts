/**
 * Content-root selector expansion tests.
 *
 * The shared theme CSS must not rely on `:is(...)` — EPUB readers and older
 * CSS engines do not support it reliably. themeToCSS() expands every
 * `#markdown-content` selector into an explicit dual selector that also
 * covers `.markdown-viewer-content`, with equivalent semantics.
 */

import assert from 'assert';
import { describe, it } from 'node:test';
import { themeToCSS } from '../../../src/utils/theme-to-css';
import type { ThemeConfig, TableStyleConfig, CodeThemeConfig, LayoutScheme } from '../../../src/utils/theme-to-css';
import type { ColorScheme } from '../../../src/types/theme';

function makeColorScheme(page: string): ColorScheme {
  return {
    id: 'test',
    name: 'Test',
    name_en: 'Test',
    description: 'Test color scheme',
    text: { primary: '#000', secondary: '#333', muted: '#666' },
    accent: { link: '#00f', linkHover: '#00d' },
    background: { page, code: '#f5f5f5' },
    blockquote: { border: '#ddd' },
    table: {
      border: '#ccc',
      headerBackground: '#f0f0f0',
      headerText: '#000',
      zebraEven: '#fff',
      zebraOdd: '#fafafa',
    },
  };
}

const minimalLayout: LayoutScheme = {
  id: 'test',
  name: 'Test',
  name_en: 'Test',
  description: 'Test layout',
  body: { fontSize: '12pt', lineHeight: 1.6 },
  headings: {
    h1: { fontSize: '24pt', spacingBefore: '24pt', spacingAfter: '12pt' },
    h2: { fontSize: '20pt', spacingBefore: '20pt', spacingAfter: '10pt' },
    h3: { fontSize: '16pt', spacingBefore: '16pt', spacingAfter: '8pt' },
    h4: { fontSize: '14pt', spacingBefore: '14pt', spacingAfter: '6pt' },
    h5: { fontSize: '12pt', spacingBefore: '12pt', spacingAfter: '4pt' },
    h6: { fontSize: '10pt', spacingBefore: '10pt', spacingAfter: '4pt' },
  },
  code: { fontSize: '10pt' },
  blocks: {
    paragraph: { spacingAfter: '12pt', firstLineIndent: true },
    list: { spacingAfter: '12pt' },
    listItem: {},
    blockquote: { spacingAfter: '12pt', paddingVertical: '8pt', paddingHorizontal: '16pt' },
    codeBlock: { spacingAfter: '12pt', paddingVertical: '12pt', paddingHorizontal: '16pt' },
    table: { spacingAfter: '12pt' },
    horizontalRule: { spacingBefore: '12pt', spacingAfter: '12pt' },
  },
};

const minimalTableStyle: TableStyleConfig = {
  header: { fontWeight: 'bold' },
  cell: { padding: '8px 12px' },
};

const minimalCodeTheme: CodeThemeConfig = {
  colors: {},
  foreground: '#000',
};

const minimalTheme: ThemeConfig = {
  fontScheme: {
    body: { fontFamily: 'sans-serif' },
    headings: { fontFamily: 'sans-serif' },
    code: { fontFamily: 'monospace' },
  },
  layoutScheme: 'regular',
  colorScheme: 'github-light',
  tableStyle: 'classic',
  codeTheme: 'github-light',
};

function generateCSS(page: string = '#ffffff', firstLineIndent = 0): string {
  return themeToCSS(
    minimalTheme,
    minimalLayout,
    makeColorScheme(page),
    minimalTableStyle,
    minimalCodeTheme,
    firstLineIndent
  );
}

describe('Content-root selector expansion (no :is())', () => {
  it('never emits :is(...) in the generated CSS', () => {
    const css = generateCSS();
    assert.ok(!css.includes(':is('), 'Generated CSS must not rely on :is(...)');
  });

  it('expands a simple descendant rule into explicit dual selectors', () => {
    const css = generateCSS();
    assert.ok(
      css.includes('#markdown-content p, .markdown-viewer-content p'),
      'Paragraph rule should be expanded for both content roots'
    );
  });

  it('expands compound selectors (class on the content root) into dual selectors', () => {
    const css = generateCSS();
    assert.ok(
      css.includes('#markdown-content.table-layout-center table'),
      'Original compound selector should be preserved'
    );
    assert.ok(
      css.includes('.markdown-viewer-content.table-layout-center table'),
      'Compound selector should also be expanded for the alternate root'
    );
  });

  it('expands classed content roots into a nested child branch (child-render hosts)', () => {
    const css = generateCSS();
    // Hosts that render into a child .markdown-viewer-content inside
    // #markdown-content carry the layout classes on the child only. The
    // nested branch keeps the variant rule at or above the base rule's
    // specificity (the base rule includes the #markdown-content id).
    assert.ok(
      css.includes('#markdown-content .markdown-viewer-content.table-layout-left table'),
      'Classed content root should also expand into a nested child branch'
    );
  });

  it('expands every branch of a selector list', () => {
    const css = generateCSS();
    assert.ok(
      css.includes('#markdown-content table th, .markdown-viewer-content table th,'),
      'First list branch should be expanded'
    );
    assert.ok(
      css.includes('#markdown-content table td, .markdown-viewer-content table td'),
      'Second list branch should be expanded'
    );
  });

  it('keeps non-content rules untouched', () => {
    const css = generateCSS();
    assert.ok(css.includes('.katex {'), 'Non-content rules should stay as-is');
    assert.ok(css.includes(':root {'), ':root block should stay as-is');
  });
});

describe('No color-mix() in generated CSS', () => {
  it('never emits color-mix(...)', () => {
    const css = generateCSS('#ffffff');
    assert.ok(!css.includes('color-mix('), 'Generated CSS must not rely on color-mix()');
  });

  it('materializes the accent background mix as a concrete hex color', () => {
    const css = generateCSS('#ffffff');
    // 16% #00f over #ffffff = rgb(214, 214, 255) = #d6d6ff
    assert.ok(css.includes('--md-accent-bg: #d6d6ff;'), 'Accent background should be a concrete color');
  });

  it('materializes the accent subtle mix over transparent as rgba', () => {
    const css = generateCSS('#ffffff');
    // 22% #00f over transparent = rgba(0, 0, 255, 0.22)
    assert.ok(css.includes('--md-accent-subtle: rgba(0, 0, 255, 0.22);'),
      'Accent subtle should be an rgba color with the mix alpha');
  });

  it('materializes the alert note background tint as a concrete hex color', () => {
    const css = generateCSS('#ffffff');
    // 10% #0969da over #ffffff = rgb(230, 240, 251) = #e6f0fb
    assert.ok(css.includes('background-color: #e6f0fb;'), 'Alert tint should be a concrete color');
  });

  it('adapts the alert tint to a dark page color', () => {
    const darkPage = '#0d1117';
    const css = generateCSS(darkPage);
    // 10% #0969da over #0d1117 = rgb(13, 26, 43) = #0d1a2b
    assert.ok(css.includes('background-color: #0d1a2b;'), 'Alert tint should follow the page color');
    assert.ok(!css.includes('#e6f0fb'), 'Dark theme should not use the light-theme tint');
  });
});

describe('No each-line text-indent in generated CSS', () => {
  it('never emits a text-indent with the each-line keyword', () => {
    const css = generateCSS('#ffffff', 2);
    assert.ok(!css.includes('each-line'), 'Generated CSS must not rely on the each-line keyword');
  });

  it('keeps the standard first-line text-indent', () => {
    const css = generateCSS('#ffffff', 2);
    // The layout scheme has firstLineIndent enabled; the plain indent must
    // remain for EPUB-compatible first-line indentation.
    assert.ok(css.includes('text-indent: 2em;'), 'Standard first-line indent should stay');
  });
});

describe('No fit-content in generated table CSS', () => {
  it('never emits width: fit-content', () => {
    const css = generateCSS();
    assert.ok(!css.includes('fit-content'), 'Generated CSS must not rely on fit-content');
  });

  it('tables use the classic content-width layout (display: table + width: auto)', () => {
    const css = generateCSS();
    assert.ok(css.includes('display: table;'), 'Tables should use display:table for content-width sizing');
    assert.ok(css.includes('width: auto;'), 'Tables should use width:auto instead of fit-content');
  });
});
