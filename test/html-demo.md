# HTML 混合内容完整演示

[返回主测试文档](./test.md)

本文档包含 HTML 混合内容的完整演示，涵盖各种 HTML 元素和复杂布局。

> **⚠️ 注意：** 在 Markdown 中嵌入 HTML 时，请确保 HTML 代码块内部**不要有空行**。Markdown 解析器会将空行视为段落分隔符，导致 HTML 被拆分成多个独立的块，从而破坏布局结构。

---

## 1. 基础 HTML 元素

### 1.1 提示框

<div style="padding: 15px; background: #f0f9ff; border-left: 4px solid #0284c7; margin: 10px 0;">
  <strong>💡 提示：</strong>这是一个使用 HTML 编写的提示框，测试 HTML 和 Markdown 混合使用。
</div>

<div style="padding: 15px; background: #fef3c7; border-left: 4px solid #f59e0b; margin: 10px 0;">
  <strong>⚠️ 警告：</strong>这是一个警告提示框。
</div>

<div style="padding: 15px; background: #fee2e2; border-left: 4px solid #ef4444; margin: 10px 0;">
  <strong>❌ 错误：</strong>这是一个错误提示框。
</div>

<div style="padding: 15px; background: #dcfce7; border-left: 4px solid #22c55e; margin: 10px 0;">
  <strong>✅ 成功：</strong>这是一个成功提示框。
</div>

### 1.2 状态卡片

<div style="display: flex; gap: 10px; margin: 20px 0;">
  <div style="flex: 1; padding: 15px; background: #dcfce7; border-radius: 8px;">
    <h4 style="margin: 0 0 8px 0; color: #166534;">✅ 成功</h4>
    <p style="margin: 0; font-size: 14px;">操作已成功完成</p>
  </div>
  <div style="flex: 1; padding: 15px; background: #fee2e2; border-radius: 8px;">
    <h4 style="margin: 0 0 8px 0; color: #991b1b;">❌ 错误</h4>
    <p style="margin: 0; font-size: 14px;">发生了一个错误</p>
  </div>
</div>

### 1.3 HTML 注释

**html注释**
<!-- 这是一个 html 注释 -->

---

## 2. 复杂布局

### 2.1 特性展示

<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 12px; margin: 20px 0;">
  <h3 style="margin: 0 0 15px 0;">扩展功能特性</h3>
  <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
    <div style="background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px;">
      <strong>⚡ 高性能</strong><br/>
      双层缓存架构
    </div>
    <div style="background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px;">
      <strong>🎨 美观</strong><br/>
      现代化UI设计
    </div>
    <div style="background: rgba(255,255,255,0.1); padding: 15px; border-radius: 8px;">
      <strong>🔒 安全</strong><br/>
      Manifest V3
    </div>
  </div>
</div>

### 2.2 数据展示表格

<table style="border-collapse: collapse; margin: 20px 0;">
  <thead>
    <tr style="background: #f3f4f6;">
      <th style="padding: 12px; text-align: left; border: 1px solid #e5e7eb;">模块</th>
      <th style="padding: 12px; text-align: left; border: 1px solid #e5e7eb;">功能</th>
      <th style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">状态</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding: 12px; border: 1px solid #e5e7eb;">Content Script</td>
      <td style="padding: 12px; border: 1px solid #e5e7eb;">Markdown 渲染</td>
      <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">✅</td>
    </tr>
    <tr style="background: #f9fafb;">
      <td style="padding: 12px; border: 1px solid #e5e7eb;">Offscreen Document</td>
      <td style="padding: 12px; border: 1px solid #e5e7eb;">图表转换</td>
      <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">✅</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #e5e7eb;">Cache Manager</td>
      <td style="padding: 12px; border: 1px solid #e5e7eb;">性能优化</td>
      <td style="padding: 12px; text-align: center; border: 1px solid #e5e7eb;">✅</td>
    </tr>
  </tbody>
</table>

---

## 3. 定义列表

<dl>
  <dt>Definition list</dt>
  <dd>Is something people use sometimes.</dd>
  <dt>Markdown in HTML</dt>
  <dd>Does *not* work **very** well. Use HTML <em>tags</em>.</dd>
</dl>

---

## 4. Scoped CSS 测试

### 4.1 基础 scoped 样式

下面应该显示【这是正文】

<div style="position: relative;">
   <style scoped>
      .de-container { width: 100%; border: 2px solid rgba(148, 163, 184, 0.45); }
   </style>
   <div class="de-container">
       这是正文
   </div>
</div>

---

## 5. 按钮样式

<div style="display: flex; gap: 10px; margin: 20px 0;">
  <button style="padding: 10px 20px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer;">主要按钮</button>
  <button style="padding: 10px 20px; background: white; color: #3b82f6; border: 2px solid #3b82f6; border-radius: 6px; cursor: pointer;">次要按钮</button>
  <button style="padding: 10px 20px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer;">危险按钮</button>
  <button style="padding: 10px 20px; background: #e5e7eb; color: #6b7280; border: none; border-radius: 6px; cursor: not-allowed;">禁用按钮</button>
</div>

---

## 6. 徽章和标签

<div style="display: flex; gap: 8px; flex-wrap: wrap; margin: 20px 0;">
  <span style="padding: 4px 12px; background: #dbeafe; color: #1d4ed8; border-radius: 20px; font-size: 12px;">JavaScript</span>
  <span style="padding: 4px 12px; background: #dcfce7; color: #166534; border-radius: 20px; font-size: 12px;">TypeScript</span>
  <span style="padding: 4px 12px; background: #fef3c7; color: #92400e; border-radius: 20px; font-size: 12px;">Python</span>
  <span style="padding: 4px 12px; background: #fee2e2; color: #991b1b; border-radius: 20px; font-size: 12px;">Ruby</span>
  <span style="padding: 4px 12px; background: #f3e8ff; color: #6b21a8; border-radius: 20px; font-size: 12px;">Go</span>
</div>

---

## 7. 进度条

<div style="margin: 20px 0;">
  <div style="margin-bottom: 15px;">
    <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
      <span>进度 1</span>
      <span>75%</span>
    </div>
    <div style="background: #e5e7eb; border-radius: 10px; height: 10px;">
      <div style="background: linear-gradient(90deg, #3b82f6, #8b5cf6); width: 75%; height: 100%; border-radius: 10px;"></div>
    </div>
  </div>
  <div style="margin-bottom: 15px;">
    <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
      <span>进度 2</span>
      <span>50%</span>
    </div>
    <div style="background: #e5e7eb; border-radius: 10px; height: 10px;">
      <div style="background: #22c55e; width: 50%; height: 100%; border-radius: 10px;"></div>
    </div>
  </div>
  <div>
    <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
      <span>进度 3</span>
      <span>25%</span>
    </div>
    <div style="background: #e5e7eb; border-radius: 10px; height: 10px;">
      <div style="background: #ef4444; width: 25%; height: 100%; border-radius: 10px;"></div>
    </div>
  </div>
</div>

---

## 8. 时间线

<div style="margin: 20px 0; padding-left: 30px; border-left: 3px solid #3b82f6;">
  <div style="position: relative; margin-bottom: 30px;">
    <div style="position: absolute; left: -39px; top: 0; width: 20px; height: 20px; background: #3b82f6; border-radius: 50%; border: 3px solid white;"></div>
    <div style="padding: 15px; background: #f8fafc; border-radius: 8px;">
      <h4 style="margin: 0 0 5px 0; color: #1e40af;">2024-01-01</h4>
      <p style="margin: 0; color: #64748b;">项目启动，完成需求分析</p>
    </div>
  </div>
  <div style="position: relative; margin-bottom: 30px;">
    <div style="position: absolute; left: -39px; top: 0; width: 20px; height: 20px; background: #22c55e; border-radius: 50%; border: 3px solid white;"></div>
    <div style="padding: 15px; background: #f8fafc; border-radius: 8px;">
      <h4 style="margin: 0 0 5px 0; color: #166534;">2024-02-15</h4>
      <p style="margin: 0; color: #64748b;">核心功能开发完成</p>
    </div>
  </div>
  <div style="position: relative;">
    <div style="position: absolute; left: -39px; top: 0; width: 20px; height: 20px; background: #f59e0b; border-radius: 50%; border: 3px solid white;"></div>
    <div style="padding: 15px; background: #f8fafc; border-radius: 8px;">
      <h4 style="margin: 0 0 5px 0; color: #92400e;">2024-03-01</h4>
      <p style="margin: 0; color: #64748b;">正式发布 v1.0</p>
    </div>
  </div>
</div>

---

## 9. 统计卡片

<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin: 20px 0;">
  <div style="padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; color: white;">
    <div style="font-size: 32px; font-weight: bold;">1,234</div>
    <div style="font-size: 14px; opacity: 0.9;">总用户数</div>
  </div>
  <div style="padding: 20px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); border-radius: 12px; color: white;">
    <div style="font-size: 32px; font-weight: bold;">567</div>
    <div style="font-size: 14px; opacity: 0.9;">活跃用户</div>
  </div>
  <div style="padding: 20px; background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); border-radius: 12px; color: white;">
    <div style="font-size: 32px; font-weight: bold;">89%</div>
    <div style="font-size: 14px; opacity: 0.9;">满意度</div>
  </div>
  <div style="padding: 20px; background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%); border-radius: 12px; color: white;">
    <div style="font-size: 32px; font-weight: bold;">$12.3K</div>
    <div style="font-size: 14px; opacity: 0.9;">收入</div>
  </div>
</div>

---

## 10. 扩展整体架构图

<div style="width: 1280px; box-sizing: border-box; position: relative;">
  <style scoped>
    .ext-arch-container { display: flex; gap: 15px; }
    .ext-wing-left { width: 200px; flex-shrink: 0; }
    .ext-wing-right { width: 200px; flex-shrink: 0; }
    .ext-arch-main { flex: 1; min-width: 0; }
    .ext-arch-title { text-align: center; font-size: 24px; font-weight: bold; color: #1e3a8a; margin-bottom: 20px; }
    .ext-arch-layer { margin: 10px 0; padding: 15px; border-radius: 10px; position: relative; }
    .ext-arch-divider { display: flex; align-items: center; justify-content: center; margin: 8px 0; color: #64748b; font-size: 13px; font-style: italic; }
    .ext-arch-divider-line { flex: 1; height: 1px; background: #cbd5e1; }
    .ext-arch-divider-text { margin: 0 15px; }
    .ext-layer-user { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 2px solid #f59e0b; }
    .ext-layer-extension { background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border: 2px solid #2563eb; }
    .ext-layer-processing { background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); border: 2px solid #0284c7; }
    .ext-layer-storage { background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 2px solid #10b981; }
    .ext-section-header { font-size: 16px; font-weight: bold; color: #334155; margin-bottom: 15px; text-align: center; }
    .ext-user-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
    .ext-extension-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
    .ext-processing-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .ext-storage-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
    .ext-component-box { border-radius: 8px; padding: 12px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .ext-user-box { background: #fbbf24; border: 1.5px solid #d97706; }
    .ext-extension-box { background: #60a5fa; border: 1.5px solid #2563eb; }
    .ext-processing-box { background: #38bdf8; border: 1.5px solid #0284c7; }
    .ext-storage-box { background: #4ade80; border: 1.5px solid #16a34a; }
    .ext-component-title { font-size: 13px; font-weight: bold; color: #1e3a8a; margin-bottom: 8px; }
    .ext-component-text { font-size: 12px; color: #1e40af; line-height: 1.5; }
    .ext-component-feature { background: rgba(255,255,255,0.7); border-radius: 4px; padding: 4px; margin: 3px 0; font-size: 11px; }
    .ext-wing-panel { background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%); border: 2px solid #7c3aed; border-radius: 8px; padding: 12px 12px 15px 12px; }
    .ext-wing-panel.external { background: linear-gradient(135deg, #fdf4ff 0%, #fae8ff 100%); border-color: #a855f7; }
    .ext-wing-header { font-size: 16px; font-weight: bold; text-align: center; margin-bottom: 15px; color: #581c87; }
    .ext-wing-header.external { color: #7e22ce; }
    .ext-wing-section { background: #8b5cf6; border: 1.5px solid #7c3aed; border-radius: 6px; padding: 10px; margin: 10px 0; }
    .ext-wing-section.external { background: #a855f7; border-color: #9333ea; }
    .ext-wing-section-title { font-size: 13px; font-weight: bold; color: #f3f4f6; margin-bottom: 8px; text-align: center; }
    .ext-wing-text { font-size: 11px; color: #f3f4f6; line-height: 1.4; text-align: center; }
    .ext-wing-item { background: rgba(255,255,255,0.2); border-radius: 4px; padding: 4px 6px; margin: 3px 0; font-size: 11px; }
  </style>
  <div class="ext-arch-title">Markdown Viewer Extension 整体架构</div>
  <div class="ext-arch-divider"><div class="ext-arch-divider-line"></div></div>
  <div class="ext-arch-container">
    <!-- Left Wing: Core Technologies -->
    <div class="ext-wing-left">
      <div class="ext-wing-panel">
        <div class="ext-wing-header">核心技术栈</div>
        <div class="ext-wing-section">
          <div class="ext-wing-section-title">Markdown处理</div>
          <div class="ext-wing-text">
            <div class="ext-wing-item">unified核心引擎</div>
            <div class="ext-wing-item">remark-parse解析器</div>
            <div class="ext-wing-item">remark-gfm扩展</div>
            <div class="ext-wing-item">remark-math公式</div>
          </div>
        </div>
        <div class="ext-wing-section">
          <div class="ext-wing-section-title">内容渲染</div>
          <div class="ext-wing-text">
            <div class="ext-wing-item">rehype-highlight</div>
            <div class="ext-wing-item">rehype-katex</div>
            <div class="ext-wing-item">rehype-stringify</div>
          </div>
        </div>
      </div>
    </div>
    <!-- Main Architecture -->
    <div class="ext-arch-main">
      <!-- User Layer -->
      <div class="ext-arch-layer ext-layer-user">
        <div class="ext-section-header">用户交互层</div>
        <div class="ext-user-grid">
          <div class="ext-component-box ext-user-box">
            <div class="ext-component-title">用户</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">文档查看</div>
              <div class="ext-component-feature">快捷键操作</div>
            </div>
          </div>
          <div class="ext-component-box ext-user-box">
            <div class="ext-component-title">Chrome浏览器</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">文件加载</div>
              <div class="ext-component-feature">扩展宿主</div>
            </div>
          </div>
          <div class="ext-component-box ext-user-box">
            <div class="ext-component-title">文件系统</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">本地.md文件</div>
              <div class="ext-component-feature">网络资源</div>
            </div>
          </div>
        </div>
      </div>
      <div class="ext-arch-divider">
        <div class="ext-arch-divider-line"></div>
        <div class="ext-arch-divider-text">⬇ 自动检测激活</div>
        <div class="ext-arch-divider-line"></div>
      </div>
      <!-- Extension Layer -->
      <div class="ext-arch-layer ext-layer-extension">
        <div class="ext-section-header">Chrome扩展层</div>
        <div class="ext-extension-grid">
          <div class="ext-component-box ext-extension-box">
            <div class="ext-component-title">Content Detector</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">轻量级检测</div>
              <div class="ext-component-feature">动态注入触发</div>
            </div>
          </div>
          <div class="ext-component-box ext-extension-box">
            <div class="ext-component-title">Content Script</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">unified处理</div>
              <div class="ext-component-feature">DOM重构</div>
            </div>
          </div>
          <div class="ext-component-box ext-extension-box">
            <div class="ext-component-title">Background</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">消息中转</div>
              <div class="ext-component-feature">缓存代理</div>
            </div>
          </div>
          <div class="ext-component-box ext-extension-box">
            <div class="ext-component-title">Popup UI</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">缓存统计</div>
              <div class="ext-component-feature">清理操作</div>
            </div>
          </div>
          <div class="ext-component-box ext-extension-box">
            <div class="ext-component-title">Offscreen</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">Mermaid渲染</div>
              <div class="ext-component-feature">SVG转PNG</div>
            </div>
          </div>
        </div>
      </div>
      <div class="ext-arch-divider">
        <div class="ext-arch-divider-line"></div>
        <div class="ext-arch-divider-text">⬇ 内容处理管道</div>
        <div class="ext-arch-divider-line"></div>
      </div>
      <!-- Storage Layer -->
      <div class="ext-arch-layer ext-layer-storage">
        <div class="ext-section-header">存储缓存层</div>
        <div class="ext-storage-grid">
          <div class="ext-component-box ext-storage-box">
            <div class="ext-component-title">Cache Manager</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">双层缓存架构</div>
              <div class="ext-component-feature">LRU淘汰</div>
            </div>
          </div>
          <div class="ext-component-box ext-storage-box">
            <div class="ext-component-title">IndexedDB</div>
            <div class="ext-component-text">
              <div class="ext-component-feature">持久化存储</div>
              <div class="ext-component-feature">多索引支持</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Right Wing: External Dependencies -->
    <div class="ext-wing-right">
      <div class="ext-wing-panel external">
        <div class="ext-wing-header external">外部依赖</div>
        <div class="ext-wing-section external">
          <div class="ext-wing-section-title">语法高亮</div>
          <div class="ext-wing-text">
            <div class="ext-wing-item">highlight.js</div>
          </div>
        </div>
        <div class="ext-wing-section external">
          <div class="ext-wing-section-title">数学渲染</div>
          <div class="ext-wing-text">
            <div class="ext-wing-item">KaTeX</div>
          </div>
        </div>
        <div class="ext-wing-section external">
          <div class="ext-wing-section-title">图表生成</div>
          <div class="ext-wing-text">
            <div class="ext-wing-item">Mermaid</div>
            <div class="ext-wing-item">html2canvas</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

---

[返回主测试文档](./test.md)
