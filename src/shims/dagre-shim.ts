/// <reference path="../types/dagre.d.ts" />
// Shim module: bridge `dagre` CommonJS to the ESM import shape expected by @antv/layout.
//
// @antv/layout 的 ESM 代码使用 `import dagre, { graphlib } from 'dagre'`。
// 这里用 namespace import 取得 dagre 的 CJS module.exports 整体作为 default，
// 再把它上面的 graphlib 字段作为命名导出，从而匹配 @antv/layout 的导入语法。
import * as dagreNamespace from 'dagre';

const dagre = dagreNamespace.default ?? dagreNamespace;

export const graphlib = (dagreNamespace as any).graphlib ?? dagre?.graphlib;

export default dagre;