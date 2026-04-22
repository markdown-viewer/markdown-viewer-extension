# Obsidian Dialect Demo

This file demonstrates common Obsidian wiki-link and embed syntax.

## 1) Basic Wiki Links

- [[test]]
- [[test-full]]
- [[mermaid-demo]]

## 2) Wiki Links With Alias

- [[test|Open test.md]]
- [[mermaid-demo|Mermaid Example]]
- [[latex|Math Example]]

## 3) Heading Links

- [[test#Task List]]
- [[test-full#Markdown Feature Matrix]]
- [[#Local Heading Example]]

## 4) Block Reference Links

- [[test#^example-block-id]]
- [[#^local-block-id]]

## 5) Basic Embeds

- ![[test]]
- ![[mermaid-demo]]
- ![[latex]]

## 6) Media Embeds

- ![[test.svg]]
- ![[small-icon.svg]]
- ![[arrow-down.svg]]

## 7) Embed Options

- ![[small-icon.svg|120]]
- ![[test#Task List]]
- ![[test.svg|Demo SVG]]

## 8) Paths And Spaces

- [[assets/my note]]
- [[assets/my note|Alias With Spaces]]
- ![[assets/my image.svg]]

## 9) Local Heading Example

This heading is for [[#Local Heading Example]].

## 10) Local Block Example

This paragraph is for local block reference tests. ^local-block-id

## 11) Should Not Parse Inside Code

Inline code:

`[[test]]` and `![[test.svg]]`

Fenced code block:

```md
[[test]]
![[test.svg]]
[[test|alias]]
```

## 12) Mixed Markdown And Obsidian Syntax

- Standard markdown link: [test](./test.md)
- Standard markdown image: ![svg](./test.svg)
- Obsidian link: [[test]]
- Obsidian embed: ![[test.svg]]
