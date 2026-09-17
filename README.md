# ![Markdown Viewer](icons/icon48.png) docu.md Markdown Viewer

[English](https://github.com/markdown-viewer/docs/blob/main/readme/README.en.md) · [简体中文](https://github.com/markdown-viewer/docs/blob/main/readme/README.zh-CN.md) · [繁體中文](https://github.com/markdown-viewer/docs/blob/main/readme/README.zh-TW.md) · [Русский](https://github.com/markdown-viewer/docs/blob/main/readme/README.ru.md) · [日本語](https://github.com/markdown-viewer/docs/blob/main/readme/README.ja.md) · [한국어](https://github.com/markdown-viewer/docs/blob/main/readme/README.ko.md) · [Deutsch](https://github.com/markdown-viewer/docs/blob/main/readme/README.de.md) · [Français](https://github.com/markdown-viewer/docs/blob/main/readme/README.fr.md) · [Español](https://github.com/markdown-viewer/docs/blob/main/readme/README.es.md)

Preview Markdown. Preserve the complex parts. Export finished documents.

docu.md Markdown Viewer opens local or online Markdown as a polished reading page and exports it when you need a document people can actually use. It keeps the source file simple while preserving the parts that usually break during handoff: tables, images, code blocks, math, diagrams, themes, and document spacing.

It is built for technical documentation, engineering notes, research drafts, weekly reports, knowledge-base pages, README files, and AI-generated Markdown that needs final formatting.

## Install

- **Chrome / Chromium:** https://chromewebstore.google.com/detail/markdown-viewer/jekhhoflgcfoikceikgeenibinpojaoi
- **Microsoft Edge:** https://microsoftedge.microsoft.com/addons/detail/documd-markdown-viewer/iphmkjlbnogmhofmmcahdhodiilokfca
- **Firefox:** https://addons.mozilla.org/firefox/addon/markdown-viewer-extension/
- **Obsidian:** https://community.obsidian.md/plugins/markdown-viewer-extension
- **VS Code:** https://marketplace.visualstudio.com/items?itemName=xicilion.markdown-viewer-extension · https://open-vsx.org/extension/xicilion/markdown-viewer-extension
- **Mobile:** See the [mobile app docs](https://github.com/markdown-viewer/docs/blob/main/platforms/mobile.md)

## Node.js HTML CLI

The repository includes a headless-Chrome CLI that renders a Markdown file with
the same parser, themes, math support, and diagram renderers used by the viewer.
It requires Node.js 24 or newer and an installed Google Chrome browser.

```bash
npm install
npm run build:cli
npm run documd -- README.md README.html
```

Chrome runs headlessly and uses a temporary browser profile. A separate Chromium
download is not required. Common options include:

```bash
npm run documd -- notes.md --theme technical
npm run documd -- report.md --frontmatter table --merge-empty-cells
npm run documd -- night.md night.pdf --theme midnight
```

Run `npm run documd -- --help` for all options. Theme IDs are listed in
`src/themes/registry.json`.

## Highlights

- Clean Markdown preview for local files and supported web URLs.
- DOCX export for editable Word documents.
- PDF, self-contained HTML, and EPUB export where supported by the platform.
- Editable formulas in Word output.
- Syntax highlighting for code blocks.
- Document themes for business reports, academic writing, technical notes, reading layouts, and Chinese typography.
- Smart rendering and caching for large documents.
- Local processing for normal preview and export workflows.

## Why It Exists

Markdown is fast to write and easy to version. It is also the default format for many AI assistants, developer notes, project reports, and technical drafts.

The problem appears at the handoff stage. A `.md` file is not always acceptable when a colleague expects a Word document, a reviewer wants a printable PDF, or a client needs a self-contained page. Copying content into another editor often means rebuilding layout, screenshots, formulas, code formatting, and tables by hand.

docu.md bridges that gap. Open the Markdown file, review the rendered result, choose a document style, and export when it is ready.

## Rich Content Support

docu.md supports standard Markdown, GitHub-style tables and task lists, images, highlighted code, math formulas, SVG content, complex HTML tables, and diagrams or charts written in common text-based formats such as PlantUML, Mermaid, Vega/Vega-Lite, drawio, Canvas, Infographic, Graphviz, and ECharts.

That feature list appears here once because it is useful. The rest of the README focuses on workflows, platforms, and practical setup.

## What You Can Do

- Open local or online Markdown files in a clean reading view.
- Export finished documents to DOCX, PDF, self-contained HTML, or EPUB where supported by the platform.
- Keep formulas editable in Word instead of flattening them into screenshots.
- Render diagrams and charts directly from Markdown source blocks.
- Preserve code highlighting, tables, images, headings, and long-form document structure.
- Switch document themes for academic, business, technical, reading, and Chinese typography needs.
- Work with local processing so your documents stay on your device.

## Common Workflows

### AI Draft to Shareable Document

Paste or save Markdown from an AI assistant, open it with docu.md, review the formatted result, and export a polished document for colleagues, clients, classmates, or reviewers.

### Technical Notes to Documentation

Keep architecture notes, project READMEs, API drafts, and visual blocks in Markdown. Preview them with formatted code and rendered content before sharing.

### Reports and Research Drafts

Use Markdown for writing speed, then export documents with tables, formulas, headings, and document themes preserved for review or submission.

## Document Output

docu.md focuses on the handoff formats people ask for after the writing is done:

- **DOCX** for editable Word documents.
- **PDF** for print-ready sharing where supported.
- **HTML** for self-contained publishing where supported.
- **EPUB** for ebooks and whole-book exports where supported.
- **Image/vector exports** for rendered visual blocks where supported.
- **XLSX** for tables saved as spreadsheets where supported.

Exact output options vary by platform. See the platform docs for the environment you use.

## Platforms

| Platform | Best For | Docs |
|---|---|---|
| Chrome / Chromium | Opening local or online Markdown in the browser | [Chrome docs](https://github.com/markdown-viewer/docs/blob/main/platforms/chrome.md) |
| Microsoft Edge | Edge Add-ons installation and Edge-managed updates | [Edge docs](https://github.com/markdown-viewer/docs/blob/main/platforms/edge.md) |
| Firefox | Firefox-based browser workflows | [Firefox docs](https://github.com/markdown-viewer/docs/blob/main/platforms/firefox.md) |
| Obsidian | Vault-native preview and export | [Obsidian docs](https://github.com/markdown-viewer/docs/blob/main/platforms/obsidian.md) |
| VS Code | Editor-side preview, commands, and writing workflows | [VS Code docs](https://github.com/markdown-viewer/docs/blob/main/platforms/vscode.md) |
| Mobile | Opening and sharing Markdown on iOS and Android | [Mobile docs](https://github.com/markdown-viewer/docs/blob/main/platforms/mobile.md) |

## Privacy

Document processing is local. docu.md does not require uploading your Markdown files to a remote rendering service for normal preview and export workflows.

## Getting Started

1. Install docu.md on the platform you use.
2. Open a Markdown file or choose it from your workspace.
3. Review the rendered document.
4. Pick a theme if needed.
5. Export or share the finished result.

## Documentation

- [Getting Started](https://github.com/markdown-viewer/docs/blob/main/getting-started/installation.md)
- [Feature Guide](https://github.com/markdown-viewer/docs/blob/main/features/README.md)
- [Platform Comparison](https://github.com/markdown-viewer/docs/blob/main/platforms/platform-comparison.md)
- [FAQ](https://github.com/markdown-viewer/docs/blob/main/faq.md)
- [Privacy Policy](PRIVACY.md)

## Open Source

docu.md Markdown Viewer is open source under GPLv3.

## Validation

Run the repository baseline check locally:

```sh
./scripts/repository-check
```
