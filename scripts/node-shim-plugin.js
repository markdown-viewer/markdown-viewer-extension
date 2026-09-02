// esbuild plugin: stub Node builtins ('fs', 'util') for browser bundles.
//
// The `chardet` package (used by src/utils/encoding-recovery.ts for charset
// detection of raw markdown bytes) requires 'fs' and 'util' at its top level
// (the Node-only detectFile() helper and util.inherits calls). Content scripts
// have no Node builtins, so both imports are redirected to the minimal shim in
// src/shims/node-shims.ts. Detection itself only touches the in-memory buffer
// and never goes near the file system.
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const shimsPath = path.resolve(projectRoot, 'src/shims/node-shims.ts');

export const nodeShimPlugin = {
  name: 'node-builtin-stubs',
  setup(build) {
    build.onResolve({ filter: /^(fs|util)$/ }, () => ({ path: shimsPath }));
  },
};
