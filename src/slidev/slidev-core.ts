/**
 * Shared Slidev slide-parsing core.
 *
 * Platform-neutral: everything here runs in both the Chrome content-script
 * and the VS Code webview.  Platform-specific concerns (diagram rendering,
 * iframe creation, messaging) are injected via the `DiagramPlaceholder`
 * callback or handled in the platform entry files.
 */

import { parseSync } from '@slidev/parser'
import MarkdownIt from 'markdown-it'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import katex from 'katex'
import { CODE_BLOCK_LANGUAGE_MAP, DIAGRAM_CODE_BLOCK_LANGUAGE_SET } from '../types/formats'

import { createHighlighterCoreSync } from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { fromHighlighter } from '@shikijs/markdown-it/core'

// Static language grammar imports
import langBash from '@shikijs/langs/bash'
import langCss from '@shikijs/langs/css'
import langHtml from '@shikijs/langs/html'
import langJavascript from '@shikijs/langs/javascript'
import langJson from '@shikijs/langs/json'
import langMarkdown from '@shikijs/langs/markdown'
import langPython from '@shikijs/langs/python'
import langSql from '@shikijs/langs/sql'
import langTypescript from '@shikijs/langs/typescript'
import langYaml from '@shikijs/langs/yaml'
import langXml from '@shikijs/langs/xml'

// Static Shiki theme imports
import themeVitesseLight from '@shikijs/themes/vitesse-light'
import themeVitesseDark from '@shikijs/themes/vitesse-dark'

// ── Types ──────────────────────────────────────────────────────────────

export interface DiagramJob {
  renderType: string
  code: string
  id: number
}

export interface ParsedSlide {
  no: number
  index: number
  frontmatter: Record<string, any>
  html: string
  slots: Record<string, string>
  note: string | undefined
  title: string | undefined
  level: number | undefined
  clicksTotal: number
}

export interface SlidevConfigs {
  theme: string
  transition: string | undefined
  aspectRatio: unknown
  canvasWidth: number | undefined
  slidesTitle: string
  themeConfig: Record<string, any> | undefined
  colorSchema: string | undefined
}

export interface ParseResult {
  slides: ParsedSlide[]
  configs: SlidevConfigs
  diagramJobs: DiagramJob[]
}

const SLIDEV_FRONTMATTER_KEYS = new Set([
  'theme',
  'layout',
  'transition',
  'class',
  'colorSchema',
  'themeConfig',
  'canvasWidth',
  'aspectRatio',
  'mdc',
  'drawings',
  'lineNumbers',
  'routerMode',
  'presenter',
  'remoteAssets',
  'download',
  'downloadable',
])

/** Callback that returns the HTML to embed for a diagram code block. */
export type DiagramPlaceholderFn = (id: number) => string

// ── Shiki highlighter ──────────────────────────────────────────────────

const shiki = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  themes: [themeVitesseLight, themeVitesseDark],
  langs: [
    langBash, langCss, langHtml, langJavascript, langJson,
    langMarkdown, langPython, langSql, langTypescript, langYaml, langXml,
  ],
})

// ── Markdown-it + KaTeX ────────────────────────────────────────────────

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== '$') return false
  if (state.src[state.pos + 1] === '$') return false

  const start = state.pos + 1
  let end = start
  while (end < state.posMax) {
    if (state.src[end] === '$' && state.src[end - 1] !== '\\') break
    end++
  }
  if (end >= state.posMax) return false
  if (start === end) return false

  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.content = state.src.slice(start, end)
    token.markup = '$'
  }
  state.pos = end + 1
  return true
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const startPos = state.bMarks[startLine] + state.tShift[startLine]
  if (startPos + 2 > state.eMarks[startLine]) return false
  if (state.src.slice(startPos, startPos + 2) !== '$$') return false

  if (silent) return true

  let nextLine = startLine
  let found = false
  while (++nextLine < endLine) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
    const lineEnd = state.eMarks[nextLine]
    const line = state.src.slice(lineStart, lineEnd).trim()
    if (line === '$$') { found = true; break }
  }
  if (!found) return false

  const contentStart = state.bMarks[startLine] + state.tShift[startLine] + 2
  const firstLineContent = state.src.slice(contentStart, state.eMarks[startLine]).trim()
  const innerLines: string[] = []
  if (firstLineContent) innerLines.push(firstLineContent)
  for (let i = startLine + 1; i < nextLine; i++) {
    innerLines.push(state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]))
  }

  const token = state.push('math_block', 'math', 0)
  token.content = innerLines.join('\n')
  token.markup = '$$'
  token.map = [startLine, nextLine + 1]
  state.line = nextLine + 1
  return true
}

function renderKatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: 'html',
    })
  } catch {
    return `<span class="katex-error" style="color:red">${latex}</span>`
  }
}

// ── Diagram types ──────────────────────────────────────────────────────

// Diagram language set and alias resolution come from the central format
// registry (formats.json → formats.ts). Adding a new diagram type there
// automatically makes it recognized by Slidev fence blocks.
const DIAGRAM_TYPES = DIAGRAM_CODE_BLOCK_LANGUAGE_SET

function normalizeDiagramType(lang: string): string {
  return CODE_BLOCK_LANGUAGE_MAP[lang] || lang
}

// ── v-click processor ──────────────────────────────────────────────────

export function processVClicks(html: string, startIndex = 0): { html: string; clicksTotal: number } {
  if (!html.includes('v-click')) {
    return { html, clicksTotal: 0 }
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div id="__root">${html}</div>`, 'text/html')
  const root = doc.getElementById('__root')!
  let clickIndex = startIndex

  const vClicksEls = root.querySelectorAll('v-clicks')
  vClicksEls.forEach(vc => {
    const list = vc.querySelector('ul, ol')
    if (list) {
      list.querySelectorAll(':scope > li').forEach(li => {
        clickIndex++
        li.setAttribute('data-v-click-at', String(clickIndex))
        li.classList.add('slidev-vclick-target', 'slidev-vclick-hidden')
      })
    } else {
      Array.from(vc.children).forEach(child => {
        clickIndex++
        child.setAttribute('data-v-click-at', String(clickIndex))
        child.classList.add('slidev-vclick-target', 'slidev-vclick-hidden')
      })
    }
    while (vc.firstChild) vc.parentNode!.insertBefore(vc.firstChild, vc)
    vc.remove()
  })

  const vClickEls = root.querySelectorAll('v-click')
  vClickEls.forEach(vc => {
    Array.from(vc.children).forEach(child => {
      clickIndex++
      child.setAttribute('data-v-click-at', String(clickIndex))
      child.classList.add('slidev-vclick-target', 'slidev-vclick-hidden')
    })
    while (vc.firstChild) vc.parentNode!.insertBefore(vc.firstChild, vc)
    vc.remove()
  })

  root.querySelectorAll('[v-click]').forEach(el => {
    clickIndex++
    el.setAttribute('data-v-click-at', String(clickIndex))
    el.classList.add('slidev-vclick-target', 'slidev-vclick-hidden')
    el.removeAttribute('v-click')
  })

  return { html: root.innerHTML, clicksTotal: clickIndex - startIndex }
}

// ── Markdown-it instance factory ───────────────────────────────────────

/**
 * Create a fully configured markdown-it instance with KaTeX, Shiki,
 * and diagram fence interception.
 *
 * Each call returns a fresh instance + a mutable `diagramJobs` array
 * that accumulates diagram blocks found during rendering.
 */
export function createMarkdownRenderer(placeholderFn: DiagramPlaceholderFn) {
  const diagramJobs: DiagramJob[] = []

  const md = new MarkdownIt({ html: true, linkify: true, typographer: true })

  // KaTeX
  md.inline.ruler.after('escape', 'math_inline', mathInlineRule)
  md.block.ruler.after('blockquote', 'math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  md.renderer.rules.math_inline = (tokens, idx) => renderKatex(tokens[idx].content, false)
  md.renderer.rules.math_block = (tokens, idx) => renderKatex(tokens[idx].content, true)

  // Diagram fence override (must be registered before Shiki)
  const defaultFence = md.renderer.rules.fence!.bind(md.renderer.rules)
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    const lang = (token.info || '').trim().split(/\s+/)[0].toLowerCase()
    if (DIAGRAM_TYPES.has(lang)) {
      const id = diagramJobs.length
      diagramJobs.push({ renderType: normalizeDiagramType(lang), code: token.content, id })
      return placeholderFn(id)
    }
    return defaultFence(tokens, idx, options, env, slf)
  }

  // Shiki
  md.use(fromHighlighter(shiki as any, {
    themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
    defaultColor: false,
    defaultLanguage: 'text' as any,
    fallbackLanguage: 'text' as any,
    transformers: [
      {
        name: 'slidev-class',
        pre(node) {
          const cls = node.properties.class as string || ''
          node.properties.class = cls + ' slidev-code'
          // Keep --shiki-light / --shiki-dark CSS vars on <pre> so .line
          // spans can inherit them; only strip explicit color/background.
          if (typeof node.properties.style === 'string') {
            node.properties.style = node.properties.style
              .split(';')
              .filter(s => s.trim().startsWith('--'))
              .join(';') || undefined
          }
        },
        root(node) {
          return {
            type: 'root',
            children: [{
              type: 'element',
              tagName: 'div',
              properties: { class: 'slidev-code-wrapper' },
              children: node.children as any[],
            }],
          } as any
        },
      },
    ],
  }))

  return { md, diagramJobs }
}

// ── Slide parser ───────────────────────────────────────────────────────

const slotSeparator = /^::(\w+)::$/

function hasSlidevFrontmatter(frontmatter: unknown): boolean {
  if (!frontmatter || typeof frontmatter !== 'object') {
    return false
  }

  for (const key of Object.keys(frontmatter as Record<string, unknown>)) {
    if (SLIDEV_FRONTMATTER_KEYS.has(key)) {
      return true
    }
  }

  return false
}

/**
 * Best-effort Slidev detection for plain `.md`/`.markdown` files.
 *
 * Strategy:
 * 1) explicit Slidev-only syntax (`v-click`, slot markers, etc.)
 * 2) Slidev-specific frontmatter keys parsed by @slidev/parser
 * 3) weak fallback: many short slides after parser split
 */
export function isLikelySlidevMarkdown(rawContent: string): boolean {
  if (!rawContent || !rawContent.trim()) {
    return false
  }

  const explicitSyntax = /<v-clicks?\b|\bv-click(?:\b|=)|^::\w+::$/m.test(rawContent)

  try {
    const parsed = parseSync(rawContent, '')
    const slides = parsed?.slides || []
    if (slides.length === 0) {
      return explicitSyntax
    }

    if (slides.some((slide: any) => hasSlidevFrontmatter(slide?.frontmatter))) {
      return true
    }

    if (explicitSyntax) {
      return true
    }

    if (slides.length >= 3) {
      const shortSlides = slides.filter((slide: any) => String(slide?.content || '').trim().length <= 500).length
      return shortSlides / slides.length >= 0.7
    }

    return false
  } catch {
    return explicitSyntax
  }
}

export function parseSlides(rawContent: string, placeholderFn: DiagramPlaceholderFn): ParseResult {
  const { md, diagramJobs } = createMarkdownRenderer(placeholderFn)

  const parsed = parseSync(rawContent, '')

  const slides: ParsedSlide[] = parsed.slides.map((slide: any, index: number) => {
    const content: string = slide.content || ''
    const frontmatter = slide.frontmatter || {}

    if (index === 0 && !frontmatter.layout) {
      frontmatter.layout = 'cover'
    }

    const lines = content.split('\n')
    let currentSlot = 'default'
    const slotLines: Record<string, string[]> = { default: [] }

    for (const line of lines) {
      const match = line.trim().match(slotSeparator)
      if (match) {
        currentSlot = match[1]
        slotLines[currentSlot] = []
      } else {
        if (!slotLines[currentSlot]) slotLines[currentSlot] = []
        slotLines[currentSlot].push(line)
      }
    }

    const slots: Record<string, string> = {}
    let clicksTotal = 0
    for (const [name, slines] of Object.entries(slotLines)) {
      const slotMd = slines.join('\n').trim()
      if (slotMd) {
        const rendered = md.render(slotMd)
        const processed = processVClicks(rendered, clicksTotal)
        slots[name] = processed.html
        clicksTotal += processed.clicksTotal
      }
    }

    return {
      no: index + 1,
      index,
      frontmatter,
      html: slots.default || '',
      slots,
      note: slide.note,
      title: slide.title,
      level: slide.level,
      clicksTotal,
    }
  })

  const headmatter = parsed.slides[0]?.frontmatter || {}
  const configs: SlidevConfigs = {
    theme: headmatter.theme || 'default',
    transition: headmatter.transition,
    aspectRatio: headmatter.aspectRatio,
    canvasWidth: headmatter.canvasWidth,
    slidesTitle: headmatter.title || 'Slides',
    themeConfig: headmatter.themeConfig,
    colorSchema: headmatter.colorSchema,
  }

  return { slides, configs, diagramJobs }
}
