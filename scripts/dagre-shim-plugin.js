// esbuild plugin: shim `dagre` for `@antv/layout` ESM interop
//
// 背景：@antv/layout@2.x 发布的 ESM 文件（lib/algorithm/dagre/index.js）使用
// `import dagre, { graphlib } from 'dagre'` 语法导入 dagre@0.8.5。但 dagre@0.8.5
// 是纯 CommonJS 包（module.exports = { graphlib, layout, ... }），既无 `exports`
// 字段，也无 default 命名导出。esbuild 在 ESM 语境下严格解析，会报：
//   No matching export in ".../dagre/index.js" for import "default"
//   No matching export in ".../dagre/index.js" for import "graphlib"
//
// 本插件把对 `dagre` 的导入重定向到本地 shim 文件，由 shim 用 namespace import
// 桥接 CJS，再分别导出 default 和 graphlib 命名导出，匹配 @antv/layout 的导入语法。
//
// 仅在 `@antv/layout` 的代码路径触发，其它入口对 dagre 的直接导入不受影响。
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const shimPath = path.resolve(projectRoot, 'src/shims/dagre-shim.ts');

export const dagreShimPlugin = {
  name: 'dagre-cjs-interop-shim',
  setup(build) {
    // 拦截对 'dagre' 的导入，仅当 importer 处于 @antv/layout 内部时重定向到 shim。
    // 其它代码若直接 import dagre，保持原解析行为，避免不必要的干预。
    build.onResolve({ filter: /^dagre$/ }, (args) => {
      if (args.importer.includes(path.join('@antv', 'layout'))) {
        return { path: shimPath };
      }
      return undefined;
    });
  },
};