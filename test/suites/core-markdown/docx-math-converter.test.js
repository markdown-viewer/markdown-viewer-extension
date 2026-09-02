import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  convertLatex2Math,
  convertMathMl2Math,
  convertMathMl2Omml,
  convertOmml2Math,
  mathJaxReady,
} from '../../../src/exporters/docx-math-converter.ts';

// We also need latex2MathMl for testing, but it's not exported
// So we'll use MathJax directly for generating MathML in tests
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { SerializedMmlVisitor } from 'mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js';
import { STATE } from 'mathjax-full/js/core/MathItem.js';

// Setup test MathJax environment
const TEX_PACKAGES = AllPackages.filter((pkg) => pkg !== 'bussproofs');
const testAdaptor = liteAdaptor();
RegisterHTMLHandler(testAdaptor);
const testTex = new TeX({ packages: TEX_PACKAGES });
const testDocument = mathjax.document('', { InputJax: testTex });
const testVisitor = new SerializedMmlVisitor();

function latex2MathMl(latexString) {
  const mathNode = testDocument.convert(latexString, { display: false, end: STATE.CONVERT });
  return testVisitor.visitTree(mathNode);
}

// Wait for MathJax to be ready before running tests
await mathJaxReady();

describe('docx-math-converter', () => {
  describe('convertLatex2Math - basic LaTeX', () => {
    it('should convert simple variable', () => {
      const result = convertLatex2Math('x');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should convert superscript', () => {
      const result = convertLatex2Math('x^2');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should convert subscript', () => {
      const result = convertLatex2Math('x_1');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should convert fraction', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\frac{a}{b}'));
      assert.ok(omml.includes('<m:f>'), 'Should contain fraction element');
      assert.ok(omml.includes('<m:num>'), 'Should contain numerator');
      assert.ok(omml.includes('<m:den>'), 'Should contain denominator');
    });

    it('should convert square root', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\sqrt{x}'));
      assert.ok(omml.includes('<m:rad>'), 'Should contain radical element');
      assert.ok(omml.includes('<m:degHide'), 'Should hide degree for square root');
    });

    it('should convert nth root', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\sqrt[3]{x}'));
      assert.ok(omml.includes('<m:rad>'), 'Should contain radical element');
      assert.ok(omml.includes('<m:deg>'), 'Should contain degree element');
      assert.ok(omml.includes('3'), 'Should contain the degree value');
    });

    it('should convert sum with limits', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\sum_{i=1}^{n} i'));
      assert.ok(omml.includes('∑') || omml.includes('&#x2211;'), 'Should contain summation symbol');
    });

    it('should convert integral', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\int_0^1 f(x) dx'));
      assert.ok(omml.includes('∫') || omml.includes('&#x222B;'), 'Should contain integral symbol');
    });

    it('should convert matrix', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'));
      assert.ok(omml.includes('<m:m>'), 'Should contain matrix element');
      assert.ok(omml.includes('<m:mr>'), 'Should contain matrix rows');
      assert.ok(omml.includes('<m:d>'), 'Should contain delimiter for parentheses');
    });

    it('should convert Greek letters', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\alpha + \\beta = \\gamma'));
      assert.ok(omml.includes('α') || omml.includes('&#x3B1;'), 'Should contain alpha');
      assert.ok(omml.includes('β') || omml.includes('&#x3B2;'), 'Should contain beta');
      assert.ok(omml.includes('γ') || omml.includes('&#x3B3;'), 'Should contain gamma');
    });

    it('should convert unsupported esint commands like oiint', () => {
      const result = convertLatex2Math('\\oiint_S \\vec{F} \\cdot d\\vec{S}');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
      // Check that the result contains the surface integral symbol (converted from \oiint)
      const jsonString = JSON.stringify(result);
      assert.ok(jsonString.includes('∯'), 'Should contain surface integral Unicode symbol');
    });

    it('should convert oiiint command', () => {
      const result = convertLatex2Math('\\oiiint_V \\rho \\, dV');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
      // Check that the result contains the volume integral symbol
      const jsonString = JSON.stringify(result);
      assert.ok(jsonString.includes('∰'), 'Should contain volume integral Unicode symbol');
    });
  });

  describe('convertLatex2Math - spacing commands', () => {
    // Helper to get OMML string from LaTeX
    function latexToOmml(latex) {
      const mathMl = latex2MathMl(latex);
      return convertMathMl2Omml(mathMl);
    }

    const EM_SPACE = '\u2003';
    const THIN_SPACE = '\u2009';
    const MEDIUM_SPACE = '\u2005';
    const THICK_SPACE = '\u2004';

    it('should preserve \\quad spacing', () => {
      const omml = latexToOmml('a \\quad b');
      assert.ok(omml.includes(EM_SPACE), 'Should contain em space for \\quad');
    });

    it('should preserve \\qquad spacing', () => {
      const omml = latexToOmml('a \\qquad b');
      // \qquad is 2em, should have two em spaces
      const emSpaceCount = (omml.match(new RegExp(EM_SPACE, 'g')) || []).length;
      assert.ok(emSpaceCount >= 2, 'Should contain at least two em spaces for \\qquad');
    });

    it('should preserve \\, (thin space)', () => {
      const omml = latexToOmml('a \\, b');
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space for \\,');
    });

    it('should preserve \\: (medium space)', () => {
      const omml = latexToOmml('a \\: b');
      assert.ok(omml.includes(MEDIUM_SPACE), 'Should contain medium space for \\:');
    });

    it('should preserve \\; (thick space)', () => {
      const omml = latexToOmml('a \\; b');
      assert.ok(omml.includes(THICK_SPACE), 'Should contain thick space for \\;');
    });

    it('should preserve \\bmod spacing', () => {
      const omml = latexToOmml('a \\bmod b');
      assert.ok(omml.includes('mod'), 'Should contain "mod" text');
      assert.ok(omml.includes(THICK_SPACE), 'Should contain thick space for \\bmod');
    });

    it('should preserve \\bmod with superscript', () => {
      const omml = latexToOmml('V = T \\bmod 2^{31}');
      assert.ok(omml.includes('mod'), 'Should contain "mod" text');
      assert.ok(omml.includes(THICK_SPACE), 'Should contain thick space');
    });

    it('should preserve \\pmod spacing', () => {
      const omml = latexToOmml('a \\equiv b \\pmod{n}');
      assert.ok(omml.includes('mod'), 'Should contain "mod" text');
    });

    it('should preserve spacing after \\log', () => {
      const omml = latexToOmml('\\log n');
      assert.ok(omml.includes('log'), 'Should contain "log" text');
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space after \\log');
    });

    it('should preserve spacing in O(n log n)', () => {
      const omml = latexToOmml('O(n \\log n)');
      assert.ok(omml.includes('log'), 'Should contain "log" text');
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space');
    });

    it('should preserve spacing after \\sin', () => {
      const omml = latexToOmml('\\sin x');
      assert.ok(omml.includes('sin'), 'Should contain "sin" text');
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space after \\sin');
    });

    it('should preserve spacing after \\cos', () => {
      const omml = latexToOmml('\\cos x');
      assert.ok(omml.includes('cos'), 'Should contain "cos" text');
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space after \\cos');
    });

    it('should preserve spacing after \\sup', () => {
      const omml = latexToOmml('\\sup S');
      assert.ok(omml.includes('sup'), 'Should contain "sup" text');
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space after \\sup');
    });

    it('should preserve spacing after \\inf', () => {
      const omml = latexToOmml('\\inf S');
      assert.ok(omml.includes('inf'), 'Should contain "inf" text');
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space after \\inf');
    });
  });

  describe('convertMathMl2Math - direct MathML input', () => {
    it('should convert simple MathML', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>';
      const result = convertMathMl2Math(mathMl);
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should convert MathML with mspace', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mspace width="1em"/><mi>b</mi></math>';
      const result = convertMathMl2Math(mathMl);
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should handle MathML with mfrac', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>';
      const result = convertMathMl2Math(mathMl);
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should handle MathML with msup (superscript)', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><msup><mi>x</mi><mn>2</mn></msup></math>';
      const result = convertMathMl2Math(mathMl);
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should handle MathML with msub (subscript)', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><msub><mi>x</mi><mn>1</mn></msub></math>';
      const result = convertMathMl2Math(mathMl);
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should handle MathML with msqrt', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><msqrt><mi>x</mi></msqrt></math>';
      const result = convertMathMl2Math(mathMl);
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });
  });

  describe('convertOmml2Math - direct OMML input', () => {
    it('should convert simple OMML', () => {
      const omml = '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath>';
      const result = convertOmml2Math(omml);
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should throw error for invalid OMML (missing m:oMath)', () => {
      const invalidOmml = '<m:r xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:t>x</m:t></m:r>';
      assert.throws(() => {
        convertOmml2Math(invalidOmml);
      }, /Invalid OMML content/);
    });
  });

  describe('convertMathMl2Omml - space preprocessing', () => {
    const EM_SPACE = '\u2003';
    const THIN_SPACE = '\u2009';
    const MEDIUM_SPACE = '\u2005';
    const THICK_SPACE = '\u2004';

    it('should convert mspace width="1em" to em space', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mspace width="1em"/><mi>b</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(EM_SPACE), 'Should contain em space');
    });

    it('should convert mspace width="2em" to double em space', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mspace width="2em"/><mi>b</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      const emSpaceCount = (omml.match(new RegExp(EM_SPACE, 'g')) || []).length;
      assert.ok(emSpaceCount >= 2, 'Should contain at least two em spaces');
    });

    it('should convert mspace width="0.167em" to thin space', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mspace width="0.167em"/><mi>b</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space');
    });

    it('should convert mo with lspace to space before operator', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mo lspace="thickmathspace">+</mo><mi>b</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(THICK_SPACE), 'Should contain thick space before operator');
    });

    it('should convert mo with rspace to space after operator', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mo rspace="thickmathspace">+</mo><mi>b</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(THICK_SPACE), 'Should contain thick space after operator');
    });

    it('should convert invisible function application operator to thin space', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>f</mi><mo>&#x2061;</mo><mi>x</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(THIN_SPACE), 'Should contain thin space for function application');
    });

    it('should handle self-closing mspace tag', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mspace width="1em" /><mi>b</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(EM_SPACE), 'Should handle self-closing mspace');
    });

    it('should handle mspace with closing tag', () => {
      const mathMl = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mspace width="1em"></mspace><mi>b</mi></math>';
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(EM_SPACE), 'Should handle mspace with closing tag');
    });
  });

  describe('edge cases and error handling', () => {
    it('should handle empty LaTeX string', () => {
      const result = convertLatex2Math('');
      assert.ok(result);
    });

    it('should handle LaTeX with only whitespace', () => {
      const result = convertLatex2Math('   ');
      assert.ok(result);
    });

    it('should handle complex nested expressions', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\frac{\\sqrt{x^2 + y^2}}{\\sum_{i=1}^{n} i^2}'));
      assert.ok(omml.includes('<m:f>'), 'Should contain fraction element');
      assert.ok(omml.includes('<m:rad>'), 'Should contain radical element');
      assert.ok(omml.includes('<m:sSup>'), 'Should contain superscript elements');
    });

    it('should handle multiple operators', () => {
      const result = convertLatex2Math('a + b - c \\times d \\div e');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should handle text within math', () => {
      const omml = convertMathMl2Omml(latex2MathMl('x \\text{ is positive}'));
      assert.ok(omml.includes('is positive'), 'Should contain the text content');
    });

    it('should handle limits', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\lim_{x \\to \\infty} f(x)'));
      assert.ok(omml.includes('lim'), 'Should contain lim text');
      assert.ok(omml.includes('∞') || omml.includes('&#x221E;'), 'Should contain infinity symbol');
    });

    it('should handle binomial coefficient', () => {
      const omml = convertMathMl2Omml(latex2MathMl('\\binom{n}{k}'));
      assert.ok(omml.includes('<m:d>'), 'Should use m:d delimiter element for scaling parentheses');
      assert.ok(omml.includes('<m:begChr m:val="("/>'), 'Should have opening parenthesis');
      assert.ok(omml.includes('<m:endChr m:val=")"/>'), 'Should have closing parenthesis');
      assert.ok(omml.includes('<m:f>'), 'Should contain fraction element');
      assert.ok(omml.includes('<m:type m:val="noBar"/>'), 'Fraction should have no bar for binomial');
    });

    it('should handle binomial theorem formula', () => {
      const omml = convertMathMl2Omml(latex2MathMl('(x+y)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^{n-k} y^k'));
      assert.ok(omml.includes('<m:d>'), 'Should use m:d for binomial coefficient brackets');
      assert.ok(omml.includes('<m:type m:val="noBar"/>'), 'Binomial should use noBar fraction');
      assert.ok(omml.includes('<m:sSup>'), 'Should contain superscript elements');
    });

    it('should handle Catalan number formula', () => {
      const omml = convertMathMl2Omml(latex2MathMl('C_n = \\frac{1}{n+1}\\binom{2n}{n} = \\binom{2n}{n} - \\binom{2n}{n+1}'));
      // Should have 3 binomial coefficients, each using m:d
      const delimCount = (omml.match(/<m:d>/g) || []).length;
      assert.strictEqual(delimCount, 3, 'Should have 3 delimiter elements for 3 binomial coefficients');
      assert.ok(omml.includes('<m:type m:val="bar"/>'), 'Should have regular fraction with bar');
      assert.ok(omml.includes('<m:type m:val="noBar"/>'), 'Should have noBar fractions for binomials');
    });

    it('should handle cases environment', () => {
      const omml = convertMathMl2Omml(latex2MathMl('f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x = 0 \\\\ -1 & x < 0 \\end{cases}'));
      assert.ok(omml.includes('<m:m>'), 'Should contain matrix element for cases');
      assert.ok(omml.includes('<m:mr>'), 'Should contain matrix rows');
      // Cases should have 3 rows
      const rowCount = (omml.match(/<m:mr>/g) || []).length;
      assert.strictEqual(rowCount, 3, 'Should have 3 rows for 3 cases');
    });

    it('should handle empty groups in prescripts', () => {
      // Empty groups like {} should not produce empty <m:e/> elements
      const result = convertLatex2Math('{}_a^b X');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should handle empty groups in isotope notation', () => {
      const result = convertLatex2Math('{}^{14}_6 C');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });

    it('should handle consecutive superscripts with empty group', () => {
      const result = convertLatex2Math('x^2{}^3');
      assert.ok(result);
      assert.strictEqual(result.rootKey, 'm:oMath');
    });
  });

  describe('convertMathMl2Omml - empty mrow handling', () => {
    const ZERO_WIDTH_SPACE = '\u200B';

    it('should not produce empty <m:e/> for prescripts', () => {
      const mathMl = latex2MathMl('{}_a^b X');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(!omml.includes('<m:e/>'), 'Should not contain empty <m:e/>');
    });

    it('should not produce empty <m:e/> for isotope notation', () => {
      const mathMl = latex2MathMl('{}^{235}_{92}\\text{U}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(!omml.includes('<m:e/>'), 'Should not contain empty <m:e/>');
    });

    it('should not produce empty <m:e/> for consecutive superscripts', () => {
      const mathMl = latex2MathMl('x^2{}^3');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(!omml.includes('<m:e/>'), 'Should not contain empty <m:e/>');
    });

    it('should contain zero-width space for empty group in prescripts', () => {
      const mathMl = latex2MathMl('{}_a^b X');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(ZERO_WIDTH_SPACE), 'Should contain zero-width space for empty group');
    });

    it('should contain zero-width space for empty group in isotope', () => {
      const mathMl = latex2MathMl('{}^{235}_{92}\\text{U}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes(ZERO_WIDTH_SPACE), 'Should contain zero-width space for empty group');
    });

    it('should not have empty m:t content for prescripts', () => {
      const mathMl = latex2MathMl('{}_a^b X');
      const omml = convertMathMl2Omml(mathMl);
      // Check that we don't have empty m:t tags (content length 0)
      const emptyMtPattern = /<m:t[^>]*><\/m:t>/;
      assert.ok(!emptyMtPattern.test(omml), 'Should not contain empty m:t elements');
    });
  });

  describe('convertMathMl2Omml - column alignment handling', () => {
    it('should preserve right-left alignment for aligned environment', () => {
      const mathMl = latex2MathMl('\\begin{aligned} a &= b \\\\ &= c \\end{aligned}');
      const omml = convertMathMl2Omml(mathMl);
      // Check that we have separate m:mc elements with correct alignments
      assert.ok(omml.includes('<m:mcJc m:val="right"/>'), 'First column should be right-aligned');
      assert.ok(omml.includes('<m:mcJc m:val="left"/>'), 'Second column should be left-aligned');
    });

    it('should have two m:mc elements for two-column aligned', () => {
      const mathMl = latex2MathMl('\\begin{aligned} x &= 1 \\end{aligned}');
      const omml = convertMathMl2Omml(mathMl);
      // Count m:mc elements
      const mcCount = (omml.match(/<m:mc>/g) || []).length;
      assert.strictEqual(mcCount, 2, 'Should have 2 m:mc elements for 2-column table');
    });

    it('should preserve center alignment for matrix', () => {
      const mathMl = latex2MathMl('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
      const omml = convertMathMl2Omml(mathMl);
      // Matrix columns should be center-aligned
      assert.ok(omml.includes('<m:mcJc m:val="center"/>'), 'Matrix columns should be center-aligned');
    });
  });

  describe('convertMathMl2Omml - delimiter handling for matrices', () => {
    it('should convert pmatrix to m:d with parentheses', () => {
      const mathMl = latex2MathMl('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:d>'), 'Should contain m:d delimiter element');
      assert.ok(omml.includes('<m:begChr m:val="("/>'), 'Should have opening parenthesis');
      assert.ok(omml.includes('<m:endChr m:val=")"/>'), 'Should have closing parenthesis');
    });

    it('should convert bmatrix to m:d with square brackets', () => {
      const mathMl = latex2MathMl('\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:d>'), 'Should contain m:d delimiter element');
      assert.ok(omml.includes('<m:begChr m:val="["/>'), 'Should have opening bracket');
      assert.ok(omml.includes('<m:endChr m:val="]"/>'), 'Should have closing bracket');
    });

    it('should convert vmatrix to m:d with vertical bars', () => {
      const mathMl = latex2MathMl('\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:d>'), 'Should contain m:d delimiter element');
      assert.ok(omml.includes('<m:begChr m:val="|"/>'), 'Should have opening bar');
      assert.ok(omml.includes('<m:endChr m:val="|"/>'), 'Should have closing bar');
    });

    it('should convert Vmatrix to m:d with double vertical bars', () => {
      const mathMl = latex2MathMl('\\begin{Vmatrix} a & b \\\\ c & d \\end{Vmatrix}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:d>'), 'Should contain m:d delimiter element');
      // Double vertical bar is ‖ (U+2016)
      assert.ok(omml.includes('<m:begChr m:val="‖"/>'), 'Should have opening double bar');
      assert.ok(omml.includes('<m:endChr m:val="‖"/>'), 'Should have closing double bar');
    });

    it('should convert Bmatrix to m:d with curly braces', () => {
      const mathMl = latex2MathMl('\\begin{Bmatrix} a & b \\\\ c & d \\end{Bmatrix}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:d>'), 'Should contain m:d delimiter element');
      assert.ok(omml.includes('<m:begChr m:val="{"/>'), 'Should have opening brace');
      assert.ok(omml.includes('<m:endChr m:val="}"/>'), 'Should have closing brace');
    });

    it('should convert \\left(\\right) with fraction to m:d', () => {
      const mathMl = latex2MathMl('\\left( \\frac{a}{b} \\right)');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:d>'), 'Should contain m:d delimiter element');
      assert.ok(omml.includes('<m:begChr m:val="("/>'), 'Should have opening parenthesis');
      assert.ok(omml.includes('<m:endChr m:val=")"/>'), 'Should have closing parenthesis');
      assert.ok(omml.includes('<m:f>'), 'Should contain fraction element');
    });

    it('should convert \\left[\\right] to m:d with square brackets', () => {
      const mathMl = latex2MathMl('\\left[ x + y \\right]');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:d>'), 'Should contain m:d delimiter element');
      assert.ok(omml.includes('<m:begChr m:val="["/>'), 'Should have opening bracket');
      assert.ok(omml.includes('<m:endChr m:val="]"/>'), 'Should have closing bracket');
    });

    it('should wrap matrix content in m:e inside m:d', () => {
      const mathMl = latex2MathMl('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
      const omml = convertMathMl2Omml(mathMl);
      // The m:m (matrix) should be inside m:e which is inside m:d
      assert.ok(omml.includes('<m:e><m:m>'), 'Matrix should be wrapped in m:e element');
    });

    it('should handle nested delimiters', () => {
      const mathMl = latex2MathMl('\\left( a + \\left( b + c \\right) \\right)');
      const omml = convertMathMl2Omml(mathMl);
      // Should have two m:d elements for nested parens
      const delimCount = (omml.match(/<m:d>/g) || []).length;
      assert.strictEqual(delimCount, 2, 'Should have 2 delimiter elements for nested parens');
    });
  });

  describe('convertMathMl2Omml - over/under decorations', () => {
    // Single-character accents (should use m:acc)
    it('should convert \\hat{a} to m:acc with combining circumflex', () => {
      const mathMl = latex2MathMl('\\hat{a}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u0302"/>'), 'Should have combining circumflex accent');
    });

    it('should convert \\tilde{a} to m:acc with combining tilde', () => {
      const mathMl = latex2MathMl('\\tilde{a}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u0303"/>'), 'Should have combining tilde');
    });

    it('should convert \\dot{a} to m:acc with combining dot above', () => {
      const mathMl = latex2MathMl('\\dot{a}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u0307"/>'), 'Should have combining dot above');
    });

    it('should convert \\ddot{a} to m:acc with combining diaeresis', () => {
      const mathMl = latex2MathMl('\\ddot{a}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u0308"/>'), 'Should have combining diaeresis');
    });

    it('should convert \\dddot{a} to m:acc with combining three dots above', () => {
      const mathMl = latex2MathMl('\\dddot{a}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u20DB"/>'), 'Should have combining three dots above');
    });

    it('should convert \\mathring{a} to m:acc with combining ring above', () => {
      const mathMl = latex2MathMl('\\mathring{a}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u030A"/>'), 'Should have combining ring above');
    });

    it('should convert \\vec{v} to m:acc with combining right arrow', () => {
      const mathMl = latex2MathMl('\\vec{v}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u20D7"/>'), 'Should have combining right arrow above');
    });

    // Wide accents for multi-character base (should also use m:acc)
    it('should convert \\widehat{abc} to m:acc', () => {
      const mathMl = latex2MathMl('\\widehat{abc}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u0302"/>'), 'Should have combining circumflex');
      assert.ok(omml.includes('abc'), 'Should contain the base text');
    });

    it('should convert \\widetilde{abc} to m:acc', () => {
      const mathMl = latex2MathMl('\\widetilde{abc}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u0303"/>'), 'Should have combining tilde');
      assert.ok(omml.includes('abc'), 'Should contain the base text');
    });

    // Overline/underline (should use m:bar)
    it('should convert \\overline{abc} to m:bar with pos=top', () => {
      const mathMl = latex2MathMl('\\overline{abc}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:bar>'), 'Should contain m:bar element');
      assert.ok(omml.includes('<m:pos m:val="top"/>'), 'Should have pos=top for overline');
    });

    it('should convert \\underline{abc} to m:bar with pos=bot', () => {
      const mathMl = latex2MathMl('\\underline{abc}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:bar>'), 'Should contain m:bar element');
      assert.ok(omml.includes('<m:pos m:val="bot"/>'), 'Should have pos=bot for underline');
    });

    // Group characters (overbrace, underbrace, arrows - should use m:groupChr)
    it('should convert \\overbrace to m:groupChr with top position', () => {
      const mathMl = latex2MathMl('\\overbrace{a+b+c}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:groupChr>'), 'Should contain m:groupChr element');
      assert.ok(omml.includes('<m:chr m:val="\u23DE"/>'), 'Should have top curly bracket character');
      assert.ok(omml.includes('<m:pos m:val="top"/>'), 'Should have pos=top');
      assert.ok(omml.includes('<m:vertJc m:val="bot"/>'), 'Should have vertJc=bot for baseline alignment');
    });

    it('should convert \\underbrace to m:groupChr with bot position', () => {
      const mathMl = latex2MathMl('\\underbrace{a+b+c}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:groupChr>'), 'Should contain m:groupChr element');
      assert.ok(omml.includes('<m:chr m:val="\u23DF"/>'), 'Should have bottom curly bracket character');
      assert.ok(omml.includes('<m:pos m:val="bot"/>'), 'Should have pos=bot');
      assert.ok(omml.includes('<m:vertJc m:val="top"/>'), 'Should have vertJc=top for baseline alignment');
    });

    it('should convert \\overrightarrow{AB} to m:acc with combining arrow', () => {
      const mathMl = latex2MathMl('\\overrightarrow{AB}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u20D7"/>'), 'Should have combining right arrow above');
      assert.ok(omml.includes('AB'), 'Should contain the base text');
    });

    it('should convert \\overleftarrow{AB} to m:acc with combining arrow', () => {
      const mathMl = latex2MathMl('\\overleftarrow{AB}');
      const omml = convertMathMl2Omml(mathMl);
      assert.ok(omml.includes('<m:acc>'), 'Should contain m:acc element');
      assert.ok(omml.includes('<m:chr m:val="\u20D6"/>'), 'Should have combining left arrow above');
      assert.ok(omml.includes('AB'), 'Should contain the base text');
    });
  });
});