#!/usr/bin/env node
/**
 * Typecheck wrapper: reports errors in this repository's OWN sources and
 * passes/fails on them. Errors from node_modules packages that ship raw TS
 * sources (the @markdown-viewer/* source-distributed deps) are counted and
 * summarized separately — their sources are compiled under this project's
 * strict settings but live outside the repository and cannot be fixed here.
 *
 * Exit code: 1 when the project's own sources have type errors (with the
 * full list printed), 0 otherwise. Vendor error count is always printed so
 * regressions there stay visible.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');

const tscBin = resolve(__dirname, '../node_modules/.bin/tsc');
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));

const run = spawnSync(tscBin, ['--noEmit', '--pretty', 'false'], {
  encoding: 'utf8',
});

const output = `${run.stdout || ''}${run.stderr || ''}`;
const lines = output.split('\n');

// Error lines look like:  src/foo.ts(12,3): error TS2322: message
// (TS also emits bare "error TS…" continuation lines for multi-line messages
// under --pretty false only for lib errors; treat non-file lines as context.)
const ERROR_LINE = /^([^( ]+)\((\d+),(\d+)\): error (TS\d+):/;
const VENDOR_PREFIX = /^node_modules\//;

const own = [];
const vendor = new Map(); // file -> count
let unknown = 0;

for (const line of lines) {
  const match = ERROR_LINE.exec(line.trim());
  if (!match) {
    if (line.trim().startsWith('error TS') || line.trim().startsWith('TS')) {
      unknown += 1;
    }
    continue;
  }
  const [, file, , , code] = match;
  if (VENDOR_PREFIX.test(file)) {
    vendor.set(file, (vendor.get(file) || 0) + 1);
  } else {
    own.push(line.trim());
  }
}

const vendorTotal = [...vendor.values()].reduce((sum, n) => sum + n, 0);

if (own.length > 0) {
  console.error(`TypeScript found ${own.length} error(s) in project sources:\n`);
  for (const err of own) {
    console.error(`  ${err}`);
  }
  console.error(`\n(${vendorTotal} additional error(s) inside node_modules vendor packages, not counted)`);
  process.exit(1);
}

console.log(`typecheck OK (${pkg.name}): 0 errors in project sources`);
if (vendorTotal > 0) {
  console.log(
    `note: ${vendorTotal} error(s) remain inside node_modules source-distributed vendor packages ` +
    `(@markdown-viewer/*). They are compiled by tsc but cannot be fixed from this repository.`,
  );
  const top = [...vendor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [file, count] of top) {
    console.log(`  ${count}x ${file}`);
  }
}
process.exit(run.status === 0 ? 0 : vendorTotal > 0 ? 0 : run.status ?? 1);
