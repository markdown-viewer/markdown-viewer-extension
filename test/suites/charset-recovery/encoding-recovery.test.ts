/**
 * Charset-recovery contract tests.
 *
 * Verifies the three-stage pipeline of src/utils/encoding-recovery.ts against
 * realistic mojibake samples:
 *   1. hasMojibakeSymptoms — cheap DOM-text gate; must fire on misdecoded
 *      text (UTF-8 → windows-1252, GBK, Big5, Shift_JIS shapes) while staying
 *      quiet on healthy documents (ASCII, correctly decoded CJK, genuine
 *      Latin with sparse diacritics).
 *   2. detectByteEncoding — strict UTF-8 validation first, then statistical
 *      detection for genuine legacy encodings; single-byte Latin files must
 *      come back with a windows-125x label (decode == browser output → the
 *      caller's no-op), never as an East-Asian encoding.
 *   3. decodeBytes + end-to-end: the raw bytes of a misdecoded document must
 *      round-trip back to the original text.
 *
 * Windows-1252 simulation: `win1252Decode` maps every byte through the real
 * windows-1252 codec (0x80–0x9F remap table, undefined bytes → U+FFFD), which
 * is exactly what browsers produce when decoding a charset-less document.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeBytes, detectByteEncoding, hasMojibakeSymptoms } from '../../../src/utils/encoding-recovery';

const utf8Bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Simulate the browser decoding raw bytes as windows-1252 (no charset + no BOM). */
function win1252Decode(bytes: Uint8Array): string {
  // windows-1252 remaps 0x80–0x9F to punctuation/C1-lookalikes; five bytes are
  // undefined and surface as U+FFFD. 0xA0–0xFF map 1:1 to their code points.
  const HIGH: Record<number, number> = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
    0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
    0x9e: 0x017e, 0x9f: 0x0178,
  };
  let out = '';
  for (const byte of bytes) {
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
    } else if (byte >= 0xa0) {
      out += String.fromCharCode(byte);
    } else if (HIGH[byte] !== undefined) {
      out += String.fromCharCode(HIGH[byte]);
    } else {
      out += '\uFFFD'; // 0x81, 0x8D, 0x8F, 0x90, 0x9D are undefined in windows-1252
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// hasMojibakeSymptoms — healthy documents must NOT trigger a refetch
// ---------------------------------------------------------------------------

test('hasMojibakeSymptoms: plain ASCII markdown is healthy', () => {
  assert.equal(hasMojibakeSymptoms('# Hello world\n\nSome **bold** text and [a link](https://example.com).'), false);
  assert.equal(hasMojibakeSymptoms(''), false);
});

test('hasMojibakeSymptoms: correctly decoded CJK is healthy', () => {
  assert.equal(hasMojibakeSymptoms('# 这是正常的 UTF-8 中文文档\n\n包含中文标点，以及一些英文 words。'), false);
  assert.equal(hasMojibakeSymptoms('これは日本語のテストです。ひらがな・カタカナ・漢字。'), false);
  assert.equal(hasMojibakeSymptoms('이것은 한국어 텍스트입니다. 한글 문서 테스트.'), false);
});

test('hasMojibakeSymptoms: genuine Latin with sparse diacritics is healthy', () => {
  // French: 7 mojibake-shaped chars out of 21 letters (33%) — below the ratio,
  // no runs of 3.
  assert.equal(hasMojibakeSymptoms('Café déjà vu à Noël — leçon numéro un, très bien fait.'), false);
  // German: accents stay sparse too.
  assert.equal(hasMojibakeSymptoms('Größe und Ärger über die schöne Straße in München.'), false);
  // Turkish: ı, ü, ş are single glyphs, not mojibake sequences.
  assert.equal(hasMojibakeSymptoms('İstanbul ve Ankara güzel şehirlerdir.'), false);
  // English typographic punctuation only.
  assert.equal(hasMojibakeSymptoms('He said "hello" — and then left, right?'), false);
});

// ---------------------------------------------------------------------------
// hasMojibakeSymptoms — misdecoded documents MUST trigger recovery
// ---------------------------------------------------------------------------

test('hasMojibakeSymptoms: UTF-8 Chinese decoded as windows-1252 ("方案" → "æ–¹æ¡ˆ")', () => {
  const mojibake = win1252Decode(utf8Bytes('这是一份被误解码的中文测试文档，用来验证乱码检测。'));
  assert.ok(!/[\u3400-\u9fff]/.test(mojibake), 'mojibake must not contain CJK');
  assert.equal(hasMojibakeSymptoms(mojibake), true);
});

test('hasMojibakeSymptoms: UTF-8 Japanese kana mojibake ("テスト" → "ãƒ†ã‚¹ãƒˆ")', () => {
  assert.equal(hasMojibakeSymptoms(win1252Decode(utf8Bytes('テスト'))), true);
});

test('hasMojibakeSymptoms: UTF-8 Korean mojibake', () => {
  assert.equal(hasMojibakeSymptoms('í•œê¸€ ë¬¸ì„œ'), true); // 한글 문서 decoded as windows-1252
});

test('hasMojibakeSymptoms: UTF-8 Cyrillic mojibake ("привет" → "Ð¿Ñ€Ð¸Ð²ÐµÑ‚")', () => {
  assert.equal(hasMojibakeSymptoms('Ð¿Ñ€Ð¸Ð²ÐµÑ‚ Ð¼Ð¸Ñ€'), true);
});

test('hasMojibakeSymptoms: genuine GBK decoded as windows-1252 ("ÖÐÎÄ" shapes)', () => {
  assert.equal(hasMojibakeSymptoms('ÖÐÎÄÎÄ¼þ±àÂë²âÊÔ'), true);
});

test('hasMojibakeSymptoms: genuine Big5 decoded as windows-1252 ("¤¤¤å" shapes)', () => {
  assert.equal(hasMojibakeSymptoms('¤¤¤å¤å¥ó²M'), true);
});

test('hasMojibakeSymptoms: genuine Shift_JIS decoded as windows-1252 ("‚±‚ñ‚É‚¿‚Í" shapes)', () => {
  // こんにちは → ‚±‚ñ‚É‚¿‚Í
  assert.equal(hasMojibakeSymptoms('‚±‚ñ‚É‚¿‚Í‚µ‚Ä‚¢‚é'), true);
  // テスト → ƒeƒXƒg — half-width ASCII trails, only three ƒ glyphs but they
  // dominate the letter ratio.
  assert.equal(hasMojibakeSymptoms('ƒeƒXƒg'), true);
});

test('hasMojibakeSymptoms: replacement characters trigger recovery', () => {
  assert.equal(hasMojibakeSymptoms('some text\uFFFDmore\uFFFD'), true);
});

test('hasMojibakeSymptoms: mixed ASCII prose with mojibake sections (run rule)', () => {
  // Ratio alone stays below 40% here; the 4-glyph run "ä¸æ–‡" must fire.
  assert.equal(hasMojibakeSymptoms('Hello world, this is ä¸æ–‡ content in a mostly English file'), true);
});

// ---------------------------------------------------------------------------
// detectByteEncoding
// ---------------------------------------------------------------------------

test('detectByteEncoding: valid UTF-8 is always UTF-8 (no guesser involved)', () => {
  assert.equal(detectByteEncoding(utf8Bytes('这是一份用于验证编码检测的中文测试文档，包含多行内容。')), 'utf-8');
  assert.equal(detectByteEncoding(utf8Bytes('中文')), 'utf-8');
  assert.equal(detectByteEncoding(utf8Bytes('plain ascii')), 'utf-8');
});

test('detectByteEncoding: empty input yields null', () => {
  assert.equal(detectByteEncoding(new Uint8Array(0)), null);
});

test('detectByteEncoding: genuine single-byte Latin decodes as windows-1252 family, never East-Asian', () => {
  // Bytes are the actual latin1 encoding of a French sentence (é = 0xE9, ...).
  const latin = new Uint8Array(Buffer.from("Café déjà vu à Noël, leçon numéro un cent pour cent.", 'latin1'));
  const label = detectByteEncoding(latin);
  assert.ok(label === 'windows-1252' || label === 'iso-8859-15', `got ${label}`);
  // Decoding with the label must reproduce the browser's windows-1252 output.
  assert.equal(decodeBytes(latin, label!), "Café déjà vu à Noël, leçon numéro un cent pour cent.");
});

test('detectByteEncoding: genuine GBK Chinese resolves to gb18030 on realistic samples', () => {
  // Longer GBK sample (184 bytes of real Chinese text) — short GBK samples can
  // be misreported as Big5 by the statistical detector, a known limitation.
  const gbkBytes = new Uint8Array(Buffer.from(
    '1eLKx9K7t93Tw9Pa0enWpLHgwuu87LLi0NDOqrXE1tDOxLLiytTOxLW1oaMKy/yw/LqstuDQ0MTayN2jrNPDwLTIt8jP19a3+7yvvOyy4sb31Nq9z7Ok0fmxvsnPtcTF0LaoveG5+8rHt/HOyLaov8m/v6GjCs+jzfu87LLixvfE3Lm71f3It8q2sfCz9kdCS7Hgwuu1xNbQzsTOxLG+tviyu8rHzvPF0M6qxuTL+7ar0cex4MLroaMK',
    'base64'
  ));
  assert.equal(detectByteEncoding(gbkBytes), 'gb18030');
});

test('detectByteEncoding: chardet misreporting UTF-8 for latin1 bytes is rejected', () => {
  // chardet can answer "UTF-8" for short windows-1252 text (observed with
  // "café déjà vu"); the bytes fail strict UTF-8 validation, so the label must
  // never be utf-8.
  const latin = new Uint8Array(Buffer.from('café déjà vu', 'latin1'));
  const label = detectByteEncoding(latin);
  assert.notEqual(label, 'utf-8');
  assert.ok(label === null || label === 'windows-1252' || label === 'iso-8859-15', `got ${label}`);
});

// ---------------------------------------------------------------------------
// End-to-end: the content-detector flow (symptom gate → refetch → decode)
// ---------------------------------------------------------------------------

const ORIGINAL_ZH = '这是一份用于验证编码检测行为的中文测试文档。\n' +
  '它包含多行内容，用来确认字符集检测器在较长样本上的判定结果是否稳定可靠。\n' +
  '希望检测器能够正确识别出GBK编码的中文文本而不是误判为其他东亚编码。\n';

test('end-to-end: UTF-8 file misdecoded as windows-1252 is recovered', () => {
  const bytes = utf8Bytes(ORIGINAL_ZH);
  const browserDecoded = win1252Decode(bytes); // what the DOM contains

  assert.equal(hasMojibakeSymptoms(browserDecoded), true);
  const label = detectByteEncoding(bytes);
  assert.equal(label, 'utf-8');
  const recovered = decodeBytes(bytes, label!);
  assert.equal(recovered, ORIGINAL_ZH);
  assert.notEqual(recovered, browserDecoded); // rewriting the body changes the text
});

test('end-to-end: genuine GBK file misdecoded as windows-1252 is recovered via gb18030', () => {
  const gbkBytes = new Uint8Array(Buffer.from(
    '1eLKx9K7t93Tw9Pa0enWpLHgwuu87LLi0NDOqrXE1tDOxLLiytTOxLW1oaMKy/yw/LqstuDQ0MTayN2jrNPDwLTIt8jP19a3+7yvvOyy4sb31Nq9z7Ok0fmxvsnPtcTF0LaoveG5+8rHt/HOyLaov8m/v6GjCs+jzfu87LLixvfE3Lm71f3It8q2sfCz9kdCS7Hgwuu1xNbQzsTOxLG+tviyu8rHzvPF0M6qxuTL+7ar0cex4MLroaMK',
    'base64'
  ));
  const browserDecoded = win1252Decode(gbkBytes); // what the DOM contains

  assert.equal(hasMojibakeSymptoms(browserDecoded), true);
  const label = detectByteEncoding(gbkBytes);
  assert.equal(label, 'gb18030');
  assert.equal(decodeBytes(gbkBytes, label!), ORIGINAL_ZH);
});

test('end-to-end: genuine single-byte Latin decodes to the same text the browser showed (no-op)', () => {
  // A charset-less windows-1252 file decodes correctly in the browser, and
  // even if the gate fired, decoding with the detected label reproduces the
  // DOM text — the caller skips the rewrite, so nothing can be corrupted.
  const latinBytes = new Uint8Array(Buffer.from('Café déjà vu à Noël, leçon numéro un cent pour cent.', 'latin1'));
  const browserDecoded = win1252Decode(latinBytes);
  const label = detectByteEncoding(latinBytes);
  assert.ok(label, 'expected a detection result');
  assert.equal(decodeBytes(latinBytes, label!), browserDecoded);
});
