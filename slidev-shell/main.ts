/**
 * Slidev Shell entry point
 *
 * When loaded inside an iframe (Chrome/Firefox extension), waits for
 * slide data via postMessage before mounting. The dynamic import of
 * ./bootstrap ensures that shims reading window.__SLIDEV__ are not
 * evaluated until data is ready.
 */

import * as Vue from 'vue'
import { loadThemeFromCode, loadThemeFromUrl } from './theme-loader'
import { bootstrap } from './bootstrap'
import { bootstrapList } from './bootstrap-list'
import { initSlides } from './shims/slides'

// Expose Vue as global for theme IIFE bundles
;(window as any).Vue = Vue

/** Wait for SLIDEV_INIT message from host, or use pre-injected data */
function waitForData(): Promise<{ mode?: string; themeCode?: string; themeUrl?: string }> {
  // If data already injected (standalone / direct usage), proceed
  if ((window as any).__SLIDEV__?.slides?.length) {
    return Promise.resolve({})
  }

  return new Promise((resolve) => {
    window.addEventListener('message', function handler(event: MessageEvent) {
      if (event.data?.type === 'SLIDEV_INIT') {
        window.removeEventListener('message', handler)
        ;(window as any).__SLIDEV__ = {
          slides: event.data.slides,
          configs: event.data.configs || {},
        }
        resolve({ mode: event.data.mode, themeCode: event.data.themeCode, themeUrl: event.data.themeUrl })
      }
    })
    // Signal readiness to the host content script
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'SLIDEV_SHELL_READY' }, '*')
    }
  })
}

/** Inject Google Fonts <link> for web fonts declared by the theme */
function injectGoogleFonts(fonts: { sans?: string; mono?: string; serif?: string; local?: string } | undefined) {
  if (!fonts) return
  const local = new Set(
    (fonts.local || '').split(',').map(s => s.trim()).filter(Boolean)
  )
  const webFonts = new Set<string>()
  for (const key of ['sans', 'mono', 'serif'] as const) {
    const val = fonts[key]
    if (val) {
      for (const name of val.split(',')) {
        const trimmed = name.trim()
        if (trimmed && !local.has(trimmed)) webFonts.add(trimmed)
      }
    }
  }
  if (webFonts.size === 0) return
  const weights = '200;400;600'
  const families = [...webFonts]
    .map(f => `family=${f.replace(/\s+/g, '+')}:wght@${weights}`)
    .join('&')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`
  document.head.appendChild(link)
}

async function main() {
  const { mode, themeCode, themeUrl } = await waitForData()

  // Register diagram listener early — before async theme loading and Vue bootstrap.
  // Diagram render results from the host may arrive while we're still loading;
  // the listener stores them in a Map and a MutationObserver applies them once DOM is ready.
  setupDiagramListener()

  // Load theme: prefer eval (themeCode) for blob-URL contexts,
  // fall back to <script src> (themeUrl) for strict CSP contexts
  let theme
  if (themeCode) {
    theme = loadThemeFromCode(themeCode)
  } else if (themeUrl) {
    theme = await loadThemeFromUrl(themeUrl)
  } else {
    const themeName = (window as any).__SLIDEV__?.configs?.theme || 'default'
    console.warn(`[slidev-shell] No theme code/url provided for "${themeName}"`)
  }
  if (theme) {
    ;(window as any).__SLIDEV__.themeLayouts = theme.layouts
    injectGoogleFonts(theme.fonts)
    // Apply colorSchema: theme's fixed schema (dark/light) takes priority over
    // frontmatter, because a dark-only theme like Dracula cannot work in light mode.
    // Must also toggle DOM class directly because @slidev/client/logic/dark.ts
    // uses a Vue computed+watch that already fired (immediate:true) before this
    // point, and our non-reactive configs Proxy won't retrigger it.
    const configSchema = (window as any).__SLIDEV__.configs.colorSchema
    const themeSchema = theme.colorSchema
    // Theme's fixed colorSchema wins; fallback to frontmatter
    const effectiveSchema = (themeSchema && themeSchema !== 'auto' && themeSchema !== 'both')
      ? themeSchema
      : configSchema
    if (effectiveSchema && effectiveSchema !== 'auto' && effectiveSchema !== 'both') {
      ;(window as any).__SLIDEV__.configs.colorSchema = effectiveSchema
      const dark = effectiveSchema === 'dark'
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.classList.toggle('light', !dark)
    }
  }

  initSlides()

  if (mode === 'list') {
    await bootstrapList()
    return
  }

  await bootstrap()

  // On touch devices, enable tap-to-navigate (right half → next, left half → prev).
  // Slidev's built-in click handler only fires on the container margin area
  // (#slide-container), which is unreachable on mobile where content fills the screen.
  if ('ontouchstart' in window) {
    setupTapNavigation()
  }
}

/** Listen for async diagram render results from host and replace placeholders */
function setupDiagramListener() {
  // Store diagram render results; replace placeholders when they appear in DOM.
  // Slidev only mounts the current slide, so placeholders may not exist yet.
  const diagramResults = new Map<string, string>()

  function replaceDiagram(id: string, html: string) {
    const el = document.querySelector(`[data-diagram-id="${id}"]`)
    if (el) {
      el.outerHTML = html
      diagramResults.delete(id)
      return true
    }
    return false
  }

  // Watch for new nodes (slide navigation) and replace pending placeholders
  const observer = new MutationObserver(() => {
    if (diagramResults.size === 0) return
    for (const [id, html] of diagramResults) {
      replaceDiagram(id, html)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // Listen for async diagram render results from host
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'SLIDEV_UPDATE_DIAGRAM') {
      const { id, html } = event.data
      // Try immediate replacement; if element not in DOM yet, store for later
      if (!replaceDiagram(String(id), html)) {
        diagramResults.set(String(id), html)
      }
    }
  })
}

/** Tap-to-navigate for touch devices */
function setupTapNavigation() {
  let touchStart: { x: number; y: number; t: number } | null = null

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }
    }
  }, { passive: true })

  document.addEventListener('touchend', (e) => {
    if (!touchStart) return
    const touch = e.changedTouches[0]
    if (!touch) { touchStart = null; return }

    const dx = Math.abs(touch.clientX - touchStart.x)
    const dy = Math.abs(touch.clientY - touchStart.y)
    const dt = Date.now() - touchStart.t
    touchStart = null

    // Only treat as tap: small movement, short duration
    if (dx > 20 || dy > 20 || dt > 300) return

    // Ignore taps on interactive elements
    const target = e.target as HTMLElement
    if (target.closest('a, button, input, textarea, select, [role="button"]')) return

    // Dispatch keyboard event — Slidev's shortcut system will handle it
    const key = touch.clientX > window.innerWidth / 2 ? 'ArrowRight' : 'ArrowLeft'
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  }, { passive: true })
}

main()
