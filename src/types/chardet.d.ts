// Minimal type declarations for the `chardet` package (no bundled types).
// Only the API surface used by the extension is declared:
//   - detect() runs statistical charset detection over raw bytes and returns
//     the ICU-style encoding name (e.g. "UTF-8", "GB18030", "Big5",
//     "windows-1252") or null when nothing matches.
// detectFile() is Node-only (it needs fs) and is never used in the extension.

declare module 'chardet' {
  export interface DetectOptions {
    sampleSize?: number;
    returnAllMatches?: boolean;
  }

  export function detect(
    input: Uint8Array | ArrayBuffer | number[],
    options?: DetectOptions
  ): string | null;
}
