/**
 * DOCX Math Converter
 * Converts LaTeX math expressions to DOCX-compatible OMML format
 */

import { convertToXmlComponent, type ParagraphChild } from 'docx';
import { mathjax } from 'mathjax-full/js/mathjax';
import { TeX } from 'mathjax-full/js/input/tex';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html';
import { SerializedMmlVisitor } from 'mathjax-full/js/core/MmlTree/SerializedMmlVisitor';
import { STATE } from 'mathjax-full/js/core/MathItem';
import { mml2omml } from './mml2omml';
import { xml2js } from 'xml-js';
import type { Element as XmlElement } from 'xml-js';

/**
 * MathJax environment interface
 */
interface MathJaxEnvironment {
  adaptor: unknown;
  document: {
    convert: (input: string, options: { display: boolean; end: unknown }) => unknown;
  };
  visitor: SerializedMmlVisitor;
}

/**
 * Parsed XML structure from xml-js
 */
interface ParsedXml {
  elements?: XmlElement[];
}

let mathJaxEnvironment: MathJaxEnvironment | null = null;
let mathJaxInitializing: Promise<void> | null = null;

// Exclude bussproofs because it requires layout features that depend on typesetting output jax.
const TEX_PACKAGES = AllPackages.filter((pkg: string) => pkg !== 'bussproofs');

// LaTeX commands that MathJax doesn't support, mapped to Unicode characters
// These are typically from packages like esint, stmaryrd, etc.
const UNSUPPORTED_LATEX_COMMANDS: Record<string, string> = {
  // Integral variants (esint package)
  '\\oiint': '\u222F', // ∯ surface integral
  '\\oiiint': '\u2230', // ∰ volume integral
  '\\varointclockwise': '\u2232', // ∲ clockwise contour integral
  '\\ointctrclockwise': '\u2233', // ∳ anticlockwise contour integral
  '\\intclockwise': '\u2231', // ∱ clockwise integral

  // Additional symbols that might not be supported
  '\\amalg': '\u2A3F', // ⨿ amalgamation
};

/**
 * Preprocess LaTeX string to replace unsupported commands with Unicode equivalents.
 * This allows commands from packages like esint to work without MathJax support.
 */
function preprocessLatexCommands(latexString: string): string {
  let result = latexString;
  for (const [command, unicode] of Object.entries(UNSUPPORTED_LATEX_COMMANDS)) {
    // Use regex to match the command (with word boundary to avoid partial matches)
    const regex = new RegExp(command.replace(/\\/g, '\\\\') + '(?![a-zA-Z])', 'g');
    result = result.replace(regex, unicode);
  }
  return result;
}

export function convertMathMl2Omml(mathMlString: string): string {
  return mml2omml(mathMlString, { disableDecode: true });
}

function convertOmml2Math(ommlString: string): ParagraphChild {
  const parsed = xml2js(ommlString, {
    compact: false,
    ignoreDeclaration: true,
    ignoreComment: true,
    captureSpacesBetweenElements: true,
  }) as ParsedXml;

  const elements = parsed?.elements ?? [];
  const mathElement = elements.find((element) => element.type === 'element' && element.name === 'm:oMath');

  if (!mathElement) {
    throw new Error('Invalid OMML content: missing m:oMath element');
  }

  const component = convertToXmlComponent(mathElement as unknown as Record<string, unknown>);

  if (!component || typeof component === 'string') {
    throw new Error('Failed to convert OMML element');
  }

  if ((component as unknown as { rootKey: string }).rootKey !== 'm:oMath') {
    throw new Error('Failed to convert OMML element');
  }

  // The component is the Math element (rootKey checked above), which is a
  // ParagraphChild at runtime; docx 9.15 only widened the base class type.
  return component as unknown as ParagraphChild;
}

function convertMathMl2Math(mathMlString: string): ParagraphChild {
  const ommlString = convertMathMl2Omml(mathMlString);
  return convertOmml2Math(ommlString);
}

function ensureMathJaxEnvironment(): MathJaxEnvironment {
  if (mathJaxEnvironment) {
    return mathJaxEnvironment;
  }

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);

  const tex = new TeX({ packages: TEX_PACKAGES });
  const document = mathjax.document('', {
    InputJax: tex,
  });

  const visitor = new SerializedMmlVisitor();

  mathJaxEnvironment = { adaptor, document, visitor };
  return mathJaxEnvironment!;
}

export async function mathJaxReady(): Promise<boolean> {
  if (mathJaxEnvironment) {
    return true;
  }

  if (mathJaxInitializing) {
    await mathJaxInitializing;
    return true;
  }

  mathJaxInitializing = Promise.resolve().then(() => {
    ensureMathJaxEnvironment();
  });

  await mathJaxInitializing;
  mathJaxInitializing = null;
  return true;
}

function latex2MathMl(latexString: string): string {
  if (typeof latexString !== 'string') {
    throw new Error('latex2MathMl expects a string input');
  }

  // Preprocess unsupported LaTeX commands to Unicode equivalents
  const preprocessed = preprocessLatexCommands(latexString);

  const { document, visitor } = ensureMathJaxEnvironment();
  const mathNode = document.convert(preprocessed, {
    display: false,
    end: STATE.CONVERT,
  });

  return visitor.visitTree(mathNode as any);
}

export function convertLatex2Math(latexString: string): ParagraphChild {
  const mathMlString = latex2MathMl(latexString);
  return convertMathMl2Math(mathMlString);
}

export { convertMathMl2Math, convertOmml2Math };
