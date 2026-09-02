// Node builtin stubs for browser bundles.
//
// The `chardet` package (used by src/utils/encoding-recovery.ts for charset
// detection of raw markdown bytes) requires 'fs' and 'util' at module top
// level, but its in-memory detection never touches the file system. Content
// scripts have no Node builtins, so both imports are redirected here by the
// node-shim esbuild plugin (scripts/node-shim-plugin.js):
//   - 'fs'   → empty object (only detectFile() — never called — uses it)
//   - 'util' → inherits() only, reimplemented with plain ES5-style wiring

/** 'fs' placeholder — chardet only uses it inside its Node-only detectFile(). */
export const fsShim = {};

/** Minimal util.inherits equivalent (prototype wiring + super_ back-reference). */
export function inherits(ctor: object, superCtor: object): void {
  const ctorWithSuper = ctor as { super_?: unknown };
  ctorWithSuper.super_ = superCtor;
  const ctorProto = (ctor as { prototype?: object }).prototype;
  const superProto = (superCtor as { prototype?: object }).prototype;
  if (ctorProto && superProto) {
    Object.setPrototypeOf(ctorProto, superProto);
  }
}

