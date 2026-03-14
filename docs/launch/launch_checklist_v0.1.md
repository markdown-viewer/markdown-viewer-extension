# Launch Checklist v0.1 — Markdown Viewer Pro (Chrome)

> Goal: ship MVP extension + first revenue + first distribution loop.

## Frozen baseline (for consistency)
- Platform: Chrome first (Edge compatible)
- Audience: B2C
- Pricing: Lifetime ¥79 (Early bird ¥49)
- Payment: Stripe Phase 1
- Licensing: token 90d + notice 7d + grace 7d; max_devices=3

---

## 1) Chrome Web Store listing
### Store metadata
- [ ] Name / short name
- [ ] One-line value proposition (must mention: Markdown render + Print/PDF)
- [ ] Long description w/ keywords
- [ ] Privacy disclosures (what data is collected; licensing calls)
- [ ] Category + language

### Assets
- [ ] 5–8 screenshots (script below)
- [ ] 30–60s demo video (optional but recommended)
- [ ] Icon set (16/32/48/128)

### Screenshot script (5 shots)
1) Before vs After: raw markdown vs rendered (GitHub-like)
2) Long doc: TOC navigation + search
3) Theme switch: light/dark + typography
4) Print/PDF: normal print vs Pro print template (highlight "not broken")
5) Mermaid: diagram rendering on/off (Pro badge)

---

## 2) Website / landing (Phase 1 minimal)
- [ ] Landing page: hero + 3 benefits + 2 CTAs (Install / Upgrade)
- [ ] Pricing block: ¥79 lifetime + ¥49 early bird (deadline/limited quantity if used)
- [ ] Purchase flow: Stripe checkout → success page shows license key
- [ ] Support/FAQ: device limit (3 devices), offline refresh policy, refund policy

---

## 3) Content plan (Top 10 topics)
- [ ] 如何在 Chrome/Edge 打开 .md 文件并正确预览
- [ ] Markdown 转 PDF 不走样：打印样式怎么设置
- [ ] 为什么系统默认打开 Markdown 很难看（解决方案）
- [ ] GitHub 风格 Markdown 渲染怎么实现/怎么用
- [ ] Mermaid 在 Markdown 里怎么预览（浏览器端方案）
- [ ] Markdown 写周报/简历：怎么导出最好看
- [ ] 暗黑模式下 Markdown 阅读体验优化
- [ ] 长文档目录（TOC）如何提升阅读效率
- [ ] Markdown 渲染差异坑：表格/代码块/列表
- [ ] 最佳 Markdown Viewer 扩展推荐（对比/评测）

---

## 4) Distribution checklist (first wave)
- [ ] 3 篇长文：知乎/掘金/CSDN/少数派（每篇含截图 + 安装 CTA）
- [ ] 1 次社区发布：V2EX/SegmentFault
- [ ] 1 个 GitHub repo/README（开源渲染核心或主题样式作为背书）
- [ ] 1 条 B 站/小红书短视频脚本（工作流：打开→渲染→导出）

---

## 5) Metrics to watch (week 1)
- [ ] Store: impressions → installs
- [ ] Activation: first render success
- [ ] Intent: paywall_show
- [ ] Conversion: purchase_click → payment success → activate_success
- [ ] Support load: device_limit_hit, deactivate_fail rate
