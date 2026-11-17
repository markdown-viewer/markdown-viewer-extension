/**
 * Build script: compile each Slidev theme as a self-contained IIFE bundle.
 *
 * Each theme is built with `vue` externalized (uses window.Vue at runtime).
 * The output is an IIFE that assigns { layouts, css, fonts } to
 * window.__SLIDEV_THEME__, ready to be eval'd inside the Slidev shell iframe.
 *
 * Usage: node --import tsx slidev-shell/build-themes.ts
 */
import { build, type InlineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { presetWind3, presetAttributify, presetTypography, transformerDirectives, transformerVariantGroup } from 'unocss'
import { resolveApplyPlugin } from './vite-plugin-resolve-apply'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Default UnoCSS font stacks (from uno.config.ts)
const DEFAULT_FONTS = {
  sans: '"Avenir Next","Nunito Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji"',
  serif: 'ui-serif,Georgia,Cambria,"Times New Roman",Times,serif',
  mono: '"Fira Code",ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
}

/** Read font config from theme package.json */
function readThemeFonts(themeName: string): Record<string, string> {
  const candidates = [
    resolve(`./node_modules/@slidev/theme-${themeName}/package.json`),
    resolve(`./node_modules/slidev-theme-${themeName}/package.json`),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
      return pkg.slidev?.defaults?.fonts || {}
    }
  }
  return {}
}

/** Read colorSchema from theme package.json */
function readColorSchema(themeName: string): string | undefined {
  const candidates = [
    resolve(`./node_modules/@slidev/theme-${themeName}/package.json`),
    resolve(`./node_modules/slidev-theme-${themeName}/package.json`),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
      return pkg.slidev?.colorSchema
    }
  }
  return undefined
}

/** Build Google Fonts URL from theme font declarations, skipping local fonts */
function buildGoogleFontsUrl(fonts: Record<string, string>): string | undefined {
  const local = new Set(
    (fonts.local || '').split(',').map((s: string) => s.trim()).filter(Boolean)
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
  if (webFonts.size === 0) return undefined
  const weights = '200;400;600;700'
  const families = [...webFonts]
    .map(f => `family=${f.replace(/\s+/g, '+')}:wght@${weights}`)
    .join('&')
  return `https://fonts.googleapis.com/css2?${families}&display=swap`
}

/** Build fontFamily config with theme fonts prepended to defaults */
function buildFontFamily(themeFonts: Record<string, string>): Record<string, string> {
  const result = { ...DEFAULT_FONTS }
  for (const key of ['sans', 'serif', 'mono'] as const) {
    const custom = themeFonts[key]
    if (custom) {
      // Prepend custom fonts (may be comma-separated) to default stack
      const quoted = custom.split(',').map(f => {
        const t = f.trim()
        return t.includes(' ') && !t.startsWith('"') ? `"${t}"` : t
      }).join(',')
      result[key] = `${quoted},${result[key]}`
    }
  }
  return result
}

// All themes to build
const themes = [
  // Official themes
  'default', 'seriph', 'apple-basic', 'bricks',
  // Community themes
  'dracula', 'purplin', 'academic', 'geist', 'unicorn',
]

const outDir = resolve('../dist/themes')

async function buildTheme(themeName: string): Promise<void> {
  const entry = resolve(`./themes/${themeName}.ts`)
  if (!fs.existsSync(entry)) {
    console.warn(`  ⚠ Theme entry not found: ${entry}`)
    return
  }

  // Read theme-specific font config and build fontFamily overrides
  const themeFonts = readThemeFonts(themeName)
  const fontFamily = buildFontFamily(themeFonts)

  // Extract utility classes from theme layout .vue files for UnoCSS safelist
  const safelist: string[] = []
  for (const prefix of [`@slidev/theme-${themeName}`, `slidev-theme-${themeName}`]) {
    const dir = path.join(resolve('./node_modules'), prefix, 'layouts')
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.vue'))) {
        const content = fs.readFileSync(path.join(dir, f), 'utf8')
        // Extract class="..." values from templates
        const matches = content.matchAll(/class="([^"]+)"/g)
        for (const m of matches) {
          safelist.push(...m[1].split(/\s+/).filter(Boolean))
        }
      }
    }
  }

  const config: InlineConfig = {
    configFile: false,
    plugins: [
      // Inject uno.css import into theme entry so UnoCSS utilities are included in build output
      {
        name: 'inject-uno-css',
        enforce: 'pre' as const,
        transform(code: string, id: string) {
          if (/\/themes\/[^/]+\.ts$/.test(id)) {
            return `import 'uno.css';\n${code}`
          }
        },
      },
      vue(),
      UnoCSS({
        configFile: false,
        presets: [presetWind3(), presetAttributify(), presetTypography()],
        transformers: [transformerDirectives({ enforce: 'pre' }), transformerVariantGroup()],
        theme: { fontFamily },
        safelist: [...new Set(safelist)],
      }),
      resolveApplyPlugin({ fontFamily }),
    ],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    resolve: {
      alias: {
        // Resolve path for theme CSS and assets
      },
    },
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry,
        name: '__SLIDEV_THEME__',
        formats: ['iife'],
        fileName: () => `theme-${themeName}.js`,
      },
      rollupOptions: {
        external: ['vue'],
        output: {
          globals: {
            vue: 'Vue',
          },
          // Assign to window.__SLIDEV_THEME__
          extend: true,
        },
      },
      cssCodeSplit: false,
      // Vite 8 defaults CSS minification to Lightning CSS, which warns on the
      // theme stylesheets' raw `@apply` directives (the theme build resolves
      // them after minification, in resolveApplyPlugin). Keep the Vite 7
      // behavior so the build log stays clean and the directives are preserved
      // for that later pass.
      cssMinify: 'esbuild',
      // Inline assets as data-URIs in CSS
      assetsInlineLimit: Infinity,
      minify: true,
    },
    logLevel: 'warn',
  }

  await build(config)

  // Merge extracted SFC CSS into the IIFE JS bundle.
  // Vite extracts Vue SFC <style> blocks into separate .css files,
  // but we need ALL theme CSS inside the IIFE for eval-based loading.
  const jsFile = path.join(outDir, `theme-${themeName}.js`)
  const cssFiles = fs.readdirSync(outDir).filter(f => f.endsWith('.css'))
  for (const cssFileName of cssFiles) {
    const cssPath = path.join(outDir, cssFileName)
    let extractedCss = fs.readFileSync(cssPath, 'utf8').trim()
    // @slidev/theme-bricks' section.vue uses `@apply -mt-0`; negative zero is
    // not a generatable UnoCSS utility, so the directive survives the
    // transformer and would be an invalid rule in the embedded CSS. It means
    // margin-top: 0.
    extractedCss = extractedCss.replace(/@apply\s+-mt-0\s*;/g, 'margin-top: 0;')
    if (extractedCss && fs.existsSync(jsFile)) {
      let js = fs.readFileSync(jsFile, 'utf8')
      const escaped = JSON.stringify(extractedCss)
      // Append extracted SFC CSS to the theme's css export: n.css=VAR → n.css=VAR+EXTRA
      js = js.replace(/(\w+\.css\s*=\s*)(\w+)/, `$1$2+${escaped}`)
      fs.writeFileSync(jsFile, js)
    }
    fs.unlinkSync(cssPath)
  }

  console.log(`  ✓ theme-${themeName}.js`)
}

async function main() {
  console.log('Building theme bundles...')

  // Clean output
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true })
  }
  fs.mkdirSync(outDir, { recursive: true })

  // Build themes sequentially (parallel builds can conflict)
  for (const name of themes) {
    await buildTheme(name)
  }

  // Generate manifest with fonts info, fontUrl, and colorSchema
  const manifest: Record<string, { file: string; fonts: Record<string, string>; fontUrl?: string; colorSchema?: string }> = {}
  for (const name of themes) {
    const file = path.join(outDir, `theme-${name}.js`)
    if (fs.existsSync(file)) {
      const fonts = readThemeFonts(name)
      const colorSchema = readColorSchema(name)
      manifest[name] = { file: `theme-${name}.js`, fonts, fontUrl: buildGoogleFontsUrl(fonts), colorSchema }
    }
  }
  fs.writeFileSync(
    path.join(outDir, 'themes.json'),
    JSON.stringify(manifest, null, 2),
  )

  console.log(`\n✅ ${Object.keys(manifest).length} theme bundles built → dist/themes/`)
}

main().catch((err) => {
  console.error('Theme build failed:', err)
  process.exit(1)
})
