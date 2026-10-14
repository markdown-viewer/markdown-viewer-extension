# OpenAPI 预览演示（markdown 内嵌代码块）

[返回主测试文档](./test.md)

本文件演示 markdown 内嵌的 OpenAPI 围栏如何被 `openapi` 插件接管并渲染为 Redoc，
并与独立文件 [demo.openapi.yaml](./demo.openapi.yaml) 互为对照。

当前实现的接管条件（`src/plugins/openapi-plugin.ts`）：

| 围栏语言 | 内容 | 是否接管 |
|---|---|---|
| `openapi` | 任意 YAML | ✅ 无条件 |
| `swagger` | 任意 YAML | ✅ 无条件 |
| `yaml` / `yml` | 能解析出 `openapi: 3.x` 或 `swagger: '2.0'` | ✅ 按内容识别 |
| 其它 | — | ❌ 走普通代码块 |

接管后的 DOM：`<documd-openapi data-plugin-type="openapi">`，源码保留在 light DOM 的 `<pre>` 里
（脚本被禁用时仍可读到 YAML 原文，导出也不会只剩空盒子）。

---

## 1. `openapi` 围栏（OpenAPI 3.1）

预期：带侧栏与「试用」面板的 Redoc 文档。

```openapi
openapi: 3.1.0
info:
  title: Ping API
  version: 1.0.0
  description: 最小可用的 OpenAPI 3.1 文档，用于验证内嵌围栏渲染。
paths:
  /ping:
    get:
      summary: 健康检查
      operationId: ping
      responses:
        '200':
          description: 正常
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pong'
components:
  schemas:
    Pong:
      type: object
      required: [answer]
      properties:
        answer:
          type: integer
          examples: [42]
```

---

## 2. `yaml` 围栏（OpenAPI 3.0，按内容识别）

围栏语言写的是 `yaml`，但内容能被解析成 OpenAPI 文档，因此同样被接管。
注意 3.0 用 `nullable: true`，3.1 用 `type: [string, 'null']`。

```yaml
openapi: 3.0.3
info:
  title: Note API
  version: 2.0.0
paths:
  /notes:
    get:
      summary: 列出笔记
      responses:
        '200':
          description: 笔记数组
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Note'
components:
  schemas:
    Note:
      type: object
      properties:
        id: { type: string }
        body: { type: string, nullable: true }
```

---

## 3. `swagger` 围栏（Swagger 2.0，先转换再渲染）

`swagger: '2.0'` 的文档会先经 `convertSwagger2OpenAPI` 升级到 3.x，再交给 Redoc。
Swagger 2.0 用 `definitions` + `basePath`，OpenAPI 3.x 用 `components.schemas` + `servers`。

```swagger
swagger: '2.0'
info:
  title: Legacy API
  version: 1.0.0
basePath: /v1
paths:
  /ping:
    get:
      summary: 老版本健康检查
      responses:
        '200':
          description: 正常
          schema:
            $ref: '#/definitions/Pong'
definitions:
  Pong:
    type: object
    properties:
      answer: { type: integer }
```

---

## 4. 对照：普通 YAML 配置（不接管）

没有 `openapi` / `swagger` 顶层键的 YAML **不会**被接管，保持代码高亮：

```yaml
# 普通配置文件：不满足 OpenAPI 判定条件
server:
  host: 127.0.0.1
  port: 3000
features:
  - redoc
  - source-view
```

---

## 5. 反例：缺少 info.title / info.version

`openapi` 围栏是无条件接管的，所以内容不合法时不会静默失败，而是渲染错误提示元素
（`data-plugin-level` 语义下的 error 档，现实现为 `.mv-plugin-error` / `#fee` 配色）。

```openapi
openapi: 3.1.0
info:
  description: 故意缺少 title 与 version
paths: {}
```

---

## 6. 与独立文件对照

| 打开方式 | 现状（当前实现） |
|---|---|
| 独立文件 [demo.openapi.yaml](./demo.openapi.yaml) | `format: 'openapi'`：**缺省源码档**（`#mv-source-view` 显示 YAML 原文），按钮切到 rendered 档由 `mountOpenapiDocument()` 直接挂载 Redoc；普通 `.yaml` 则是 `format: 'code'`、恒源码档且无按钮 |
| markdown 内嵌（本文件） | **保持代码块**（R5）：`openapi` / `swagger` / `yaml` 围栏都不再被接管，与 DOCX 导出保持一致 |
| 面板宿主（VS Code / Obsidian） | `panel-viewer` 按内容识别，同样直接挂载 Redoc（不再经围栏） |
| CLI / 书籍导出 | `browser-renderer` 与 `book-renderer` 同样按文件识别并挂载 |

> 普通 YAML（非 OpenAPI）在浏览器里走 code-reading：`format: 'code'`，恒定源码档、无切换按钮；
> OpenAPI 文件是可切文档（缺省 source ⇄ rendered Redoc）。
