/**
 * Font-config contract tests.
 *
 * The shared content CSS derives its font stacks from font-config.json. The
 * stacks must include cross-platform CJK fallbacks (PingFang SC / Noto Sans
 * CJK / Microsoft YaHei) so exported artifacts (HTML / EPUB / PDF) render
 * Chinese text consistently on iOS/Android readers where the classic
 * Windows/macOS fonts (FangSong, SimSun, ...) do not exist.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = path.resolve('src/themes/font-config.json');

interface FontEntry {
  name: string;
  webFallback: string;
}

function fontConfig(): Record<string, FontEntry> {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { fonts: Record<string, FontEntry> };
  return parsed.fonts;
}

const CROSS_PLATFORM_CJK = ['PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei'];

describe('Font-config CJK fallback contract', () => {
  it('FangSong keeps its primary font first and adds cross-platform CJK fallbacks', () => {
    const entry = fontConfig()['FangSong'];
    assert.ok(entry, 'FangSong should be configured');
    assert.ok(entry.webFallback.startsWith('FangSong,'), 'FangSong must stay the primary font (Web preview unchanged)');
    for (const candidate of CROSS_PLATFORM_CJK) {
      assert.ok(entry.webFallback.includes(candidate),
        `FangSong stack should include ${candidate} for iOS/Android readers`);
    }
  });

  it('CJK fallbacks precede the Western serif fallbacks', () => {
    const entry = fontConfig()['FangSong'];
    const serifIndex = entry.webFallback.indexOf('Georgia');
    for (const candidate of CROSS_PLATFORM_CJK) {
      const candidateIndex = entry.webFallback.indexOf(candidate);
      assert.ok(candidateIndex !== -1 && candidateIndex < serifIndex,
        `${candidate} should come before the Western serif fallbacks`);
    }
  });
});
