# 主题系统改进计划

日期：2026-07-18

## 背景

当前 Markdown 主题系统已经具备模块化基础：每个预设主题由 `src/themes` 下可复用的 `fontScheme`、`layoutScheme`、`colorScheme`、`tableStyle` 和 `codeTheme` 组合而成。运行时加载集中在 `src/utils/theme-manager.ts` 和 `src/utils/theme-to-css.ts`，并通过平台资源接口加载主题，同时把主题信息传递给图表/图形渲染器。

当前仓库包含：

- `src/themes/presets` 下 33 个 Markdown 主题
- `src/themes/registry.json` 中 8 个主题分类
- 7 套布局方案
- 21 套颜色方案
- 9 套表格样式
- 11 套代码高亮主题
- `slidev-shell` 下另有独立的 Slidev 主题流水线，但不纳入本计划的主题系统改造范围

只读审计结果显示：主题引用完整，字体配置完整；但基础对比度检查发现 12 组文本/背景组合低于 WCAG AA 的 4.5:1 要求，主要集中在 `muted` 文本颜色，以及一处 `link` 颜色。

## 外部成熟实践摘要

成熟主题系统通常具备以下共同模式：

- Material Design 3 将 token 分为 reference、system、component 三层。
- IBM Carbon 使用按用途命名的 role-based token，并显式定义层级背景、交互状态、焦点 token 和可访问性规则。
- GitHub Primer 将颜色和排版基础能力以 CSS 变量暴露，并按用途分组。
- VS Code 区分 workbench colors、syntax colors 和 semantic colors，并在 webview 中暴露当前主题 CSS 变量。
- WCAG 2.2 要求普通文本至少 4.5:1 对比度、大文本至少 3:1，对颜色承载信息的场景还要求不能只依赖颜色。
- Tailwind 类暗色模式实践支持显式 light/dark/system 三态，并建议在首屏 CSS 加载前设置 class 或 data attribute，避免主题闪烁。

## 当前优势

- 主题配置是组合式的，不是重复编写整份 CSS。
- 字体 fallback 和 DOCX 字体映射集中在 `font-config.json`。
- 主题应用时已经会把字体、字号、图形风格、light/dark `colorSchema` 传递给渲染器。
- VS Code 构建流程会生成已解析的主题 bundle，加快加载速度。
- registry 已经包含面向产品的元数据，例如分类、顺序、精选主题和推荐主题。
- Slidev 流水线独立存在，不需要由 Markdown 主题系统驱动。

## 主要差距

### 1. 主题契约还没有被强制执行

`registry.json` 已经包含 `version`、`order`、`recommendations` 等字段，但 TypeScript 类型和运行时消费逻辑只建模了其中一部分。主题 JSON 文件也没有在 CI 中通过 schema 校验。

### 2. token 层过小

`theme-to-css.ts` 目前只暴露了少量变量，例如 `--md-page-bg`、`--md-surface`、`--md-accent`。大多数生成 CSS 仍然把具体颜色直接写到文档选择器上。Viewer chrome、TOC、alert、focus 样式、滚动条、图表、导出链路还没有共同消费同一套 token 契约。

### 3. 可访问性检查不成体系

目前有字体配置检查脚本，但缺少完整的主题质量检查。现有低对比度问题可以在没有告警的情况下进入发布包。

### 4. host/system 主题行为分散

运行时已经可以切换 `.dark`/`.light` 并持久化 `mdv-dark`，但还没有完整的产品级 `preset`、`system`、`host` 主题模式模型，尤其缺少跨 VS Code、浏览器扩展、Obsidian、移动端的一致行为。

### 5. 主题系统边界需要明确排除 Slidev

Slidev 主题包含布局组件、演示文稿专用 CSS 和外部主题包生态，应该继续走 `slidev-shell` 的独立流水线。Markdown 主题系统不需要影响 Slidev，也不应把 Slidev 的 color schema、字体或布局纳入本计划的验收范围。本计划只关注 Markdown 文档预览、viewer UI、图表渲染和导出链路。

### 6. 导出一致性没有机器可读描述

部分类型注释已经标明某些字段只用于 Web preview，但平台能力支持没有机器可读描述。现在很难一眼判断某个主题字段会影响 Web、HTML export、DOCX export、mobile 还是 VS Code。

### 7. 普通段落 spacing 配置仍然残留并被消费

之前已经做过一次重构，目标是不再使用普通段落的上留白和下留白。但当前 7 个 `src/themes/layout-schemes/*.json` 的 `blocks.paragraph` 里仍然保留 `spacingAfter`，数值范围为 `8pt` 到 `14pt`。这些配置并不是死字段：Web 预览的 `src/utils/theme-to-css.ts` 仍会把 `blocks.paragraph.spacingBefore/spacingAfter` 转成 `#markdown-content p` 的 `margin`；DOCX 导出的 `src/exporters/theme-to-docx.ts` 也仍会读取它们，并通过 `compensateParagraphSpacing()` 生成 Normal 段落 spacing。

这意味着“普通段落不再使用段前/段后留白”的重构尚未闭环。后续应只保留普通段落的 `firstLineIndent` 能力，移除普通段落 spacing 配置和消费路径；heading、list、blockquote、codeBlock、table、horizontalRule 的 spacing 配置仍然保留，因为它们属于块级元素之间的结构间距，不属于普通段落上下留白。

## 建议路线图

## 阶段 1：加入主题校验和质量门禁

新增 `scripts/check-themes.cjs`，或等价的 TypeScript 脚本。

检查项：

- 校验 `registry.json` 结构。
- 校验所有 preset、layout、color、table、code、font 文件。
- 检查重复 id。
- 检查 registry 条目是否引用存在的 preset 文件。
- 检查每个 preset 是否引用存在的 layout/color/table/code 配置。
- 检查每个 preset 使用的字体是否存在于 `font-config.json`。
- 检查未使用或孤立的主题配置，并以 warning 形式报告。
- 检查正文和链接相对于页面背景的基础 WCAG 对比度。
- 检查表头对比度。
- 检查代码前景色和语法 token 相对于代码背景的对比度。
- 检查 alert/status 标题颜色对比度。
- 检查普通段落配置中不再出现 `spacingBefore` 或 `spacingAfter`。

审计中发现的首批修复项：

- `manuscript/draft`：muted 颜色对比度过低。
- `newspaper/sepia`：muted 颜色对比度略低于 4.5。
- `palatino/sepia`：muted 颜色对比度略低于 4.5。
- `typewriter/sepia`：muted 颜色对比度略低于 4.5。
- `elegant/sakura`：muted 颜色对比度过低。
- `vscode/vscode-light`：muted 颜色对比度过低。
- `handwritten/sakura`：muted 颜色对比度过低。
- `rainbow/rainbow`：muted 颜色对比度过低。
- `candy/candy`：muted 和 link 颜色对比度过低。
- `ocean/ocean`：muted 颜色对比度过低。
- `vscode-dark/vscode-dark`：muted 颜色对比度过低。

交付物：

- `scripts/check-themes.cjs`
- `check:themes` 之类的 `npm` script
- 复用或替代现有字体检查脚本
- 修复对比度问题，或明确记录允许例外
- 移除普通段落 `spacingAfter` 遗留配置，并阻止后续重新引入

验收标准：

- 当存在缺失引用、非法 schema、重复 id 或关键对比度失败时，`npm run check:themes` 以非零状态退出。
- 当普通段落配置重新出现 `spacingBefore` 或 `spacingAfter` 时，`npm run check:themes` 以非零状态退出。
- 现有主题全部通过检查。

## 阶段 2：定义稳定的 `--md-*` 语义 token 层

扩展 `src/utils/theme-to-css.ts` 中生成的 CSS 变量。

建议 token 分组：

- 页面：`--md-bg-page`、`--md-bg-surface`、`--md-bg-layer-1`、`--md-bg-layer-2`
- 文本：`--md-text-primary`、`--md-text-secondary`、`--md-text-muted`、`--md-text-inverse`
- 边框：`--md-border-subtle`、`--md-border-default`、`--md-border-strong`
- 强调色：`--md-accent`、`--md-accent-hover`、`--md-accent-bg`、`--md-selection-bg`
- 焦点：`--md-focus-ring`、`--md-focus-inset`
- 代码：`--md-code-bg`、`--md-code-text`、`--md-code-border`
- 表格：`--md-table-border`、`--md-table-header-bg`、`--md-table-header-text`、`--md-table-row-even`、`--md-table-row-odd`
- 提示块：`--md-alert-note`、`--md-alert-tip`、`--md-alert-important`、`--md-alert-warning`、`--md-alert-caution`
- 图表：`--md-chart-1` 到 `--md-chart-8`

实施策略：

1. 先从现有 `ColorScheme` 生成变量，不改变主题 JSON 格式。
2. 将生成的文档 CSS 改为消费变量，而不是重复写入原始颜色值。
3. 将 viewer chrome、toolbar、TOC、滚动条、alert 和自定义块改为消费同一套变量。
4. 普通 `p` 不再从主题读取上下 margin，只保留首行缩进相关样式。
5. 如果已有 CSS 依赖旧变量名，保留一个版本的兼容 alias。

验收标准：

- 切换主题时，文档正文和 viewer chrome 都通过同一 token 层更新。
- 现有主题 JSON 保持兼容。
- 除有意进行的可访问性修复外，默认主题没有非预期视觉回归。

## 阶段 3：加入明确的主题模式

引入产品级主题模式模型：

- `preset`：严格使用当前选择的 `themeId`。
- `system`：根据 `prefers-color-scheme` 在 light/dark 主题对之间切换。
- `host`：在宿主应用可用时跟随宿主主题。

建议设置项：

- `themeMode`
- `themeId`
- `lightThemeId`
- `darkThemeId`
- `hostThemeMapping`

平台行为：

- 浏览器扩展：`system` 跟随 `prefers-color-scheme`。
- VS Code：`host` 将 VS Code CSS 变量和主题类型映射为 Markdown 主题 token。
- Obsidian：`host` 跟随 Obsidian 主题 class 或 CSS 变量。
- Mobile：`system` 跟随系统亮暗色。

首屏行为：

- 在主 CSS 加载前设置 `data-md-theme-mode` 或 `.dark/.light`。
- 打开深色文档或 iframe 时避免白屏闪烁。

验收标准：

- 切换主题模式时，Markdown、图表、代码高亮、toolbar 和 TOC 一致更新。
- 重新加载 dark/system/host 主题时，不会先闪出白色页面再应用主题。

## 阶段 4：升级主题 registry 元数据

扩展 `src/themes/registry.json`，让主题选择器可以按使用场景推荐主题。

建议元数据：

- `tags`：例如 `technical`、`long-reading`、`cjk`、`print`、`screen`、`dark`、`high-contrast`
- `density`：`compact`、`regular`、`spacious`
- `languageFit`：`latin`、`cjk`、`mixed`
- `exportFit`：`web`、`html`、`docx`
- `accessibility`：`aa`、`aaa`、`high-contrast`
- `pair`：匹配的 light/dark 主题 id
- `preview`：生成的缩略图或示例 key

验收标准：

- 主题选择器可以按场景分组、搜索和推荐主题。
- 元数据通过 schema 校验。
- 文档可以从 registry 元数据生成，减少手工重复维护。

## 阶段 5：定义平台能力元数据

为主题字段加入机器可读的平台能力模型。

能力维度示例：

- Web preview
- 浏览器扩展
- VS Code webview
- Obsidian webview
- Mobile WebView
- HTML export
- DOCX export

用这套能力模型回答：

- 哪些字段只作用于 Web？
- 哪些字段影响 DOCX export？
- 哪些字段需要 fallback 行为？

验收标准：

- 不支持的字段会在校验或导出时产生 warning。
- 文档清楚展示导出和平台支持情况。
- 主题作者可以预期某个样式会在哪里生效。

## 阶段 6：对齐 Markdown、图表和导出

主题系统的对齐范围限定为 Markdown 预览、viewer UI、图表渲染和导出链路。Slidev 继续由 `slidev-shell` 独立管理，不接收 Markdown 主题系统的配置约束。

推荐对齐点：

- 共享 light/dark/host 状态。
- 尽可能共享字体基线。
- 共享图表/图形色板。
- 共享代码高亮的 light/dark 选择。

验收标准：

- 图表和图形在视觉上匹配当前文档主题。
- 导出结果不会意外切换主题风格家族。

## 阶段 7：加入视觉回归覆盖

创建代表性 fixture，覆盖：

- h1-h6 标题
- 段落和列表
- blockquote
- GitHub alerts
- 表格和宽表格
- inline code 和 code block
- Mermaid、Vega、Graphviz、PlantUML
- 数学公式
- 脚注
- 中文和中英混排文本
- 深色主题

建议代表主题矩阵：

- `default`
- `academic`
- `technical`
- `vscode`
- `magazine`
- `heiti`
- `midnight`
- `dracula`
- `vscode-dark`

验收标准：

- 截图或 DOM/CSS 快照能够捕捉非预期主题回归。
- 至少覆盖一个浅色主题、一个深色主题、一个 CJK 主题、一个技术文档主题和一个导出导向主题。

## 建议实施顺序

1. 移除普通段落 `spacingAfter` 遗留配置，并同步清理 Web/DOCX 消费路径。
2. 增加 `check:themes` 并修复当前对比度失败项。
3. 扩展 `--md-*` 语义变量，同时保持现有主题 JSON 兼容。
4. 将 viewer chrome、TOC、alerts 迁移到语义变量。
5. 增加 `themeMode` 和平台特定的 system/host 选择逻辑。
6. 扩展 registry 元数据并更新主题选择器。
7. 增加平台能力元数据和导出 warning。
8. 增加视觉回归测试。

## 风险与缓解

- 风险：token 迁移造成大范围视觉变化。
  缓解：先从现有值生成 token，再逐步迁移选择器。

- 风险：VS Code、Obsidian、浏览器、移动端的 host 主题映射差异较大。
  缓解：先归一化为内部语义 token 对象，再生成 CSS。

- 风险：对比度修复削弱主题个性。
  缓解：优先只调整失败的角色，尤其是 muted/link 颜色，并保持原有色相家族。

- 风险：后续改造误把 Slidev 纳入 Markdown 主题系统。
  缓解：在 schema、文档和验收标准中明确 Slidev 不属于本主题系统范围。

## 完成定义

当满足以下条件时，主题系统达到目标状态：

- 主题文件通过 schema 校验。
- 主题引用和字体配置在 CI 中检查。
- 可访问性检查能够捕捉常见对比度失败。
- 文档内容和 viewer UI 消费同一套语义 token 层。
- 用户可以选择明确的 preset、system 或 host-following 主题行为。
- registry 元数据支持有意义的主题推荐。
- 平台和导出能力差异有文档说明，并且机器可读。
- Markdown、viewer UI、图表和导出共享 light/dark 状态与核心视觉语义。
