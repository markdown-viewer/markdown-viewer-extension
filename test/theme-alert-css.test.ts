import assert from 'assert';
import { describe, it } from 'node:test';
import { themeToCSS } from '../src/utils/theme-to-css';
import type { ThemeConfig, TableStyleConfig, CodeThemeConfig, LayoutScheme } from '../src/utils/theme-to-css';
import type { ColorScheme } from '../src/types/theme';

// GitHub's canonical alert palette (must match generateAlertCSS in theme-to-css.ts).
const ALERT_COLORS: Record<string, string> = {
  note: '#0969da',
  tip: '#1a7f37',
  important: '#8250df',
  warning: '#9a6700',
  caution: '#cf222e',
};

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
    paragraph: { spacingAfter: '12pt' },
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

function generateCSS(page: string = '#ffffff'): string {
  return themeToCSS(
    minimalTheme,
    minimalLayout,
    makeColorScheme(page),
    minimalTableStyle,
    minimalCodeTheme
  );
}

describe('Alert CSS Generation', () => {
  it('emits a base rule for blockquote.markdown-alert', () => {
    const css = generateCSS();
    assert.ok(css.includes('blockquote.markdown-alert {'), 'should emit a base alert rule');
    assert.ok(css.includes('border-left: 4px solid'), 'base rule should set a left border');
  });

  it('emits a title rule', () => {
    const css = generateCSS();
    assert.ok(css.includes('.markdown-alert-title'), 'should style the alert title');
    assert.ok(css.includes('font-weight: 600'), 'title should be bold');
  });

  for (const [kind, color] of Object.entries(ALERT_COLORS)) {
    it(`emits per-kind colour for ${kind}`, () => {
      const css = generateCSS();
      assert.ok(
        css.includes(`blockquote.markdown-alert-${kind} {`),
        `should emit a ${kind} rule`
      );
      assert.ok(
        css.includes(`border-left-color: ${color}`),
        `${kind} border should use ${color}`
      );
      assert.ok(
        css.includes(`color: ${color}`),
        `${kind} title should use ${color}`
      );
    });

    it(`tints ${kind} background against the page colour`, () => {
      const css = generateCSS('#ffffff');
      assert.ok(
        css.includes(`color-mix(in srgb, ${color} 10%, #ffffff)`),
        `${kind} background should mix ${color} into the page colour`
      );
    });
  }

  it('adapts alert backgrounds to a dark page colour', () => {
    const darkPage = '#0d1117';
    const css = generateCSS(darkPage);
    assert.ok(
      css.includes(`color-mix(in srgb, ${ALERT_COLORS.note} 10%, ${darkPage})`),
      'note background should mix against the dark page'
    );
    // Light-theme page should no longer appear in the dark output.
    assert.ok(
      !css.includes(`color-mix(in srgb, ${ALERT_COLORS.note} 10%, #ffffff)`),
      'dark theme should not use the light page colour'
    );
  });
});
