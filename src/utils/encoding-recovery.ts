/**
 * Charset recovery for text documents the browser decoded with the wrong
 * encoding.
 *
 * Background: when a top-level text/markdown document is served over HTTP(S)
 * without a `charset` parameter and without a BOM, browsers fall back to the
 * "environment encoding" (windows-1252 on typical systems). UTF-8 content then
 * shows as mojibake ("方案" → "æ–¹æ¡ˆ"), and genuinely legacy-encoded files
 * (GBK, Big5, Shift_JIS, ...) are mangled as well. Once the browser has
 * decoded the document the bytes are gone — the raw stream has to be
 * re-fetched and decoded explicitly.
 *
 * Recovery pipeline (driven by the content detector):
 *   1. `hasMojibakeSymptoms` — cheap signal check over the already-decoded DOM
 *      text. Nothing is refetched while the document looks healthy: recovery
 *      costs a full second download, so this gate deliberately errs on the
 *      side of doing nothing.
 *   2. `detectByteEncoding` — strict UTF-8 validation first (it exactly
 *      describes the dominant failure mode — a UTF-8 file whose charset was
 *      dropped — and is immune to statistical misdetection), then chardet for
 *      genuine legacy encodings.
 *   3. `decodeBytes` — explicit TextDecoder decode of the re-fetched bytes.
 *
 * Safety properties:
 *   - Valid UTF-8 bytes are always decoded as UTF-8 regardless of what a
 *     statistical guesser says (chardet can misreport short windows-1252
 *     samples as UTF-8 and vice versa).
 *   - Single-byte legacy results (windows-125x, ISO-8859-x, ...) decode to
 *     essentially the same text the browser already produced, so the caller's
 *     "skip when unchanged" check turns them into a harmless no-op.
 *   - East-Asian multibyte results are only trusted when decoding the sample
 *     actually yields mostly CJK text with virtually no U+FFFD; this blocks
 *     mangling genuinely single-byte documents when a detector misfires
 *     (e.g. short GBK samples are occasionally reported as Big5 — the result
 *     is then still unreadable, but never *corrupted further*).
 */

import * as chardet from 'chardet';

const SAMPLE_TEXT_LENGTH = 20000;
const BYTE_SAMPLE_LENGTH = 128 * 1024;

/**
 * CJK ideographs, kana and hangul. Their presence in the browser-decoded text
 * means the charset was almost certainly decoded correctly — there is nothing
 * to recover.
 */
const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7A3\u3040-\u30FF]/;

/**
 * The character shapes windows-1252 produces when it decodes 0x80–0xFF bytes:
 * every byte of a multibyte character becomes one Latin-1-ish glyph
 * ("ä¸", "æ–", "ÖÐ", "¤¤", "ƒe", "í•œ", "Ð¿", ...).
 */
const MOJIBAKE_CHAR_CLASS =
  '\\u00A0-\\u024F\\u02B0-\\u02FF\\u2013\\u2014\\u2018-\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122';
const MOJIBAKE_CHAR_RE = new RegExp(`[${MOJIBAKE_CHAR_CLASS}]`, 'g');
/** Three or more consecutive mojibake-shaped chars — a run genuine Latin text never produces. */
const MOJIBAKE_RUN_RE = new RegExp(`[${MOJIBAKE_CHAR_CLASS}]{3,}`);
const ASCII_LETTER_RE = /[A-Za-z]/g;

/**
 * Single-byte legacy encodings. Decoding raw bytes with any of these labels
 * reproduces (or trivially improves on) what the browser already decoded, so
 * applying them can never corrupt a document that was displayed correctly.
 */
const SINGLE_BYTE_LABELS = new Set([
  'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253', 'windows-1254',
  'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258', 'windows-874',
  'iso-8859-2', 'iso-8859-5', 'iso-8859-6', 'iso-8859-7', 'iso-8859-8',
  'iso-8859-9', 'iso-8859-13', 'iso-8859-15', 'koi8-r', 'koi8-u',
  'macintosh', 'ibm866',
]);

/** Multibyte East-Asian encodings that need a plausibility check before use. */
const EAST_ASIAN_LABELS = new Set([
  'gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr', 'iso-2022-jp',
]);

/**
 * Cheap gate over browser-decoded text: is this document showing symptoms of
 * a charset misdecode? Pure function — no I/O — so it can be unit-tested.
 *
 * Deciding "no" costs nothing (the viewer renders the document as-is).
 * Deciding "yes" is only safe because the caller re-decodes the raw bytes
 * with a detected encoding instead of guessing.
 */
export function hasMojibakeSymptoms(text: string): boolean {
  const sample = text.slice(0, SAMPLE_TEXT_LENGTH);
  // Bytes the browser could not map in its fallback charset surface as U+FFFD.
  if (sample.includes('\uFFFD')) return true;
  // Correctly decoded CJK text means the charset was right — the mojibake
  // patterns below only apply to text that lost its CJK characters.
  if (CJK_RE.test(sample)) return false;

  const mojibakeChars = sample.match(MOJIBAKE_CHAR_RE)?.length ?? 0;
  // Three or more mojibake-shaped chars: a single CJK character already mangles
  // into three glyphs (UTF-8) or two (GBK/Big5 pairs, where one half often
  // decodes to an ASCII letter and is not counted). The ratio/run checks below
  // keep sparse genuine diacritics (French "café", German "Größe", ...) out.
  if (mojibakeChars < 3) return false;

  // Genuine Latin text keeps diacritics sparse (French/German/Spanish stay
  // well under 40% of letters); misdecoded multibyte text is dense because
  // every source character became several Latin-1-ish glyphs.
  const asciiLetters = sample.match(ASCII_LETTER_RE)?.length ?? 0;
  if (mojibakeChars / (mojibakeChars + asciiLetters) >= 0.4) return true;

  // Documents mixing ASCII prose with mojibake sections keep the overall
  // ratio low; long consecutive runs of mojibake-shaped characters catch them.
  return MOJIBAKE_RUN_RE.test(sample);
}

/** Map an ICU-style chardet name to a TextDecoder label, or null if unsupported. */
function toDecoderLabel(detectedName: string): string | null {
  const name = detectedName.toLowerCase();
  if (name === 'ascii') return 'utf-8';
  // ISO-8859-1 is a strict subset of the browser fallback (windows-1252);
  // decoding with windows-1252 reproduces what the browser showed and fixes
  // the few undefined ISO-8859-1 bytes at the same time.
  if (name === 'iso-8859-1') return 'windows-1252';
  if (name === 'tis-620') return 'windows-874';
  if (name === 'gb2312' || name === 'gbk') return 'gb18030';
  if (
    name === 'utf-8' ||
    name === 'utf-16le' ||
    name === 'utf-16be' ||
    SINGLE_BYTE_LABELS.has(name) ||
    EAST_ASIAN_LABELS.has(name)
  ) {
    return name;
  }
  return null;
}

/** Count replacement characters and CJK characters a decode produces. */
function decodingQuality(bytes: Uint8Array, encodingLabel: string): { total: number; replacement: number; cjk: number } {
  let text: string;
  try {
    text = new TextDecoder(encodingLabel).decode(bytes);
  } catch {
    return { total: 0, replacement: 0, cjk: 0 };
  }
  let replacement = 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) {
      replacement++;
    } else if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjk++;
    }
  }
  return { total: text.length, replacement, cjk };
}

/**
 * Decide which encoding the raw response bytes should be decoded with.
 * Returns a TextDecoder label or null when no safe choice exists.
 */
export function detectByteEncoding(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  const sample =
    bytes.length > BYTE_SAMPLE_LENGTH ? bytes.subarray(0, BYTE_SAMPLE_LENGTH) : bytes;
  if (sample.length === 0) return null;

  // Strict UTF-8 validation first. A UTF-8 file whose charset header was
  // dropped is by far the most common case, and byte validation is exact —
  // no statistical guesser involved. A sample cut at the byte boundary may
  // end mid-sequence, so retry trimming up to 3 trailing bytes (the longest
  // UTF-8 continuation tail) before declaring the bytes non-UTF-8.
  let validUtf8 = false;
  for (let trim = 0; trim <= 3; trim++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - trim)));
      validUtf8 = true;
      break;
    } catch {
      // Try a shorter tail; a full-document sample always succeeds at trim 0.
    }
  }
  if (validUtf8) return 'utf-8';

  let detected: string | null = null;
  try {
    detected = chardet.detect(sample);
  } catch {
    // Detection failed on an unusual input; leave `detected` null.
  }
  if (!detected) return null;

  const label = toDecoderLabel(detected);
  if (!label || label === 'utf-8') {
    // chardet reporting UTF-8 for bytes that failed strict validation is a
    // known false positive (e.g. short windows-1252 samples); never trust it.
    return null;
  }
  if (EAST_ASIAN_LABELS.has(label)) {
    // Only trust multibyte results whose decode actually looks like CJK text:
    // a misdetection (GBK ↔ Big5 on short samples) keeps the output unreadable
    // but must never mangle a correctly displayed single-byte document.
    const quality = decodingQuality(sample, label);
    if (quality.total === 0) return null;
    if (quality.replacement / quality.total >= 0.005) return null;
    if (quality.cjk < Math.max(8, quality.total * 0.02)) return null;
  }
  return label;
}

/**
 * Decode raw bytes with an explicit TextDecoder label. Returns null when the
 * label is invalid in this environment.
 */
export function decodeBytes(bytes: Uint8Array, encodingLabel: string): string | null {
  try {
    return new TextDecoder(encodingLabel).decode(bytes);
  } catch {
    return null;
  }
}
