// Shared build configuration for esbuild
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dagreShimPlugin } from '../scripts/dagre-shim-plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const createChromiumBuildOptions = (overrides = {}) => {
  const {
    browserName = 'Chrome',
    browserProtocol = 'chrome-extension',
    manifestPath = 'chrome/manifest.json',
    outdir = 'dist/chrome',
    platformTag = 'chrome',
    readyMessage = 'chrome://extensions/ -> Load unpacked -> select dist/chrome/',
    extraCopyDirectories = [],
  } = overrides;

  return {
    browserName,
    browserProtocol,
    manifestPath,
    outdir,
    platformTag,
    readyMessage,
    extraCopyDirectories,
  };
};

const copyDirectory = (sourceDir, targetDir) => {
  if (!fs.existsSync(sourceDir)) {
    return [];
  }

  const toCopy = [];
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const sourcePath = path.join(sourceDir, entryName);
    const targetPath = path.join(targetDir, entryName);

    const isDirectory = typeof entry === 'object' && typeof entry.isDirectory === 'function'
      ? entry.isDirectory()
      : fs.statSync(sourcePath).isDirectory();

    if (isDirectory) {
      toCopy.push(...copyDirectory(sourcePath, targetPath));
    } else {
      toCopy.push({ src: sourcePath, dest: targetPath });
    }
  }

  return toCopy;
};

const copyFileIfExists = (sourcePath, targetPath, logMessage, mergeJson = false) => {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  if (mergeJson && sourcePath.endsWith('.json') && fs.existsSync(targetPath)) {
    const sourceJson = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const targetJson = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    fs.writeFileSync(targetPath, JSON.stringify({ ...targetJson, ...sourceJson }, null, 2) + '\n', 'utf8');
  } else {
    fs.copyFileSync(sourcePath, targetPath);
  }
  if (logMessage) {
    console.log(logMessage);
  }
  return true;
};

export const createBuildConfig = (overrides = {}) => {
  const options = createChromiumBuildOptions(overrides);
  const config = {
    entryPoints: {
      'core/content-detector': 'chrome/src/webview/content-detector.ts',
      'core/element-runtime': 'chrome/src/webview/element-runtime-runner.ts',
      'core/element-runtime-main': 'chrome/src/webview/element-runtime-main.ts',
      'core/runtime-bridge': 'chrome/src/webview/runtime-bridge.ts',
      'core/main': 'chrome/src/webview/main.ts',
      'core/html-to-markdown': 'chrome/src/webview/html-to-markdown.ts',
      'core/background': 'chrome/src/host/background.ts',
      'core/drawio2svg': 'src/renderers/entries/drawio2svg-global.ts',
      'core/draw-uml': 'src/renderers/entries/draw-uml-global.ts',
      'core/offscreen-render-worker': 'chrome/src/webview/offscreen-render-worker.ts',
      'ui/popup/popup': 'chrome/src/popup/popup.ts',
      'ui/workspace/workspace': 'chrome/src/workspace/workspace.ts',
      'ui/workspace/viewer-embed': 'chrome/src/workspace/viewer-embed.ts',
      'ui/styles': 'src/ui/styles.css'
    },
    bundle: true,
    outdir: options.outdir,
    format: 'iife', // Use IIFE for Chrome extension content scripts
    target: ['chrome120'], // Target modern Chrome
    treeShaking: true,
    metafile: false, // Generate metafile for bundle analysis
    // Define globals
    define: {
      'process.env.NODE_ENV': '"production"',
      'MV_PLATFORM': `"${options.platformTag}"`,
      'MV_RUNTIME': '"shared"',
      'global': 'globalThis', // Polyfill for global
    },
    // Inject Node.js polyfills for browser environment
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'css', // Load CSS files properly to handle @import
      '.woff2': 'file', // Only woff2 for modern browsers (Chrome 120+)
      '.woff': 'empty', // Ignore legacy formats
      '.ttf': 'empty',
      '.eot': 'empty'
    },
    assetNames: '[name]', // Use original filename without hash
    // Mermaid is loaded separately via script tag to keep bundle size manageable
    external: ['mermaid', 'web-worker'],
    minify: true,
    sourcemap: false,
    plugins: [
      dagreShimPlugin,
      // Redirect @markdown-viewer/drawio2svg and draw-uml imports to shims
      // ONLY for files under src/renderers/ — these run in the offscreen render
      // worker where the real libraries are loaded via separate <script> tags.
      // Other entry points (popup, background) that transitively import these
      // via barrel files must still get the real library bundled.
      {
        name: 'drawio2svg-shim',
        setup(build) {
          const shimPath = path.resolve(projectRoot, 'src/renderers/entries/drawio2svg-shim.ts');
          const drawUmlShimPath = path.resolve(projectRoot, 'src/renderers/entries/draw-uml-shim.ts');
          const renderersDir = path.resolve(projectRoot, 'src/renderers');
          build.onResolve({ filter: /^@markdown-viewer\/drawio2svg$/ }, (args) => {
            if (args.importer.endsWith('drawio2svg-global.ts')) return undefined;
            if (!args.importer.startsWith(renderersDir)) return undefined;
            return { path: shimPath };
          });
          build.onResolve({ filter: /^@markdown-viewer\/draw-uml$/ }, (args) => {
            if (args.importer.endsWith('draw-uml-global.ts')) return undefined;
            if (!args.importer.startsWith(renderersDir)) return undefined;
            return { path: drawUmlShimPath };
          });
        }
      },
      // Plugin to copy static files and create complete extension
      {
        name: 'create-complete-extension',
        setup(build) {
          build.onEnd(() => {
            try {
              const fileCopies = [
                { src: options.manifestPath, dest: `${options.outdir}/manifest.json`, log: `📄 Copied manifest.json from ${path.dirname(options.manifestPath)}/` },
                { src: 'chrome/src/popup/popup.html', dest: `${options.outdir}/ui/popup/popup.html` },
                { src: 'chrome/src/popup/popup.css', dest: `${options.outdir}/ui/popup/popup.css` },
                { src: 'chrome/src/workspace/workspace.html', dest: `${options.outdir}/ui/workspace/workspace.html` },
                { src: 'chrome/src/workspace/workspace.css', dest: `${options.outdir}/ui/workspace/workspace.css` },
                { src: 'chrome/src/workspace/viewer-embed.html', dest: `${options.outdir}/ui/workspace/viewer-embed.html` },
                { src: 'chrome/src/workspace/dark-preload.js', dest: `${options.outdir}/ui/workspace/dark-preload.js` },
                { src: 'chrome/src/webview/offscreen-render.html', dest: `${options.outdir}/ui/offscreen-render.html` }
              ];

              fileCopies.push(...copyDirectory('icons', `${options.outdir}/icons`));
              fileCopies.push(...copyDirectory('src/_locales', `${options.outdir}/_locales`));
              options.extraCopyDirectories.forEach(({ src, dest, mergeJson = false }) => {
                fileCopies.push(
                  ...copyDirectory(src, `${options.outdir}/${dest}`).map((file) => ({
                    ...file,
                    mergeJson,
                  }))
                );
              });
              fileCopies.push(...copyDirectory('src/themes', `${options.outdir}/themes`));
              fileCopies.push(...copyDirectory('node_modules/@markdown-viewer/drawio2svg/resources/stencils', `${options.outdir}/stencils`));

              // Copy mermaid library (loaded separately via script tag)
              fileCopies.push({ 
                src: 'node_modules/mermaid/dist/mermaid.min.js', 
                dest: `${options.outdir}/libs/mermaid.min.js`,
                log: '📦 Copied libs/mermaid.min.js'
              });

              // Copy pre-built Slidev Shell assets
              if (fs.existsSync('dist/slidev-shell')) {
                fileCopies.push(...copyDirectory('dist/slidev-shell', `${options.outdir}/slidev-shell`));
                console.log(`📦 Copied dist/slidev-shell → ${options.outdir}/slidev-shell`);
              } else {
                console.warn('⚠️  dist/slidev-shell not found — run "npm run build:slidev-shell" first');
              }

              // Copy pre-built theme IIFE bundles for dynamic loading
              if (fs.existsSync('dist/themes')) {
                fileCopies.push(...copyDirectory('dist/themes', `${options.outdir}/slidev-shell/themes`));
                console.log(`📦 Copied dist/themes → ${options.outdir}/slidev-shell/themes`);
              }

              fileCopies.forEach(({ src, dest, log, mergeJson }) => copyFileIfExists(src, dest, log, mergeJson));

              // Fix KaTeX font paths in styles.css
              // esbuild bundles fonts to dist/ root with relative paths like ./KaTeX_*.woff2
              // We convert them to absolute Chrome extension URLs so they work in content scripts
              // __MSG_@@extension_id__ will be resolved by Chrome when CSS is injected
              const stylesCssSource = `${options.outdir}/ui/styles.css`;

              if (fs.existsSync(stylesCssSource)) {
                let stylesContent = fs.readFileSync(stylesCssSource, 'utf8');
                // Fix both ./ and ../ paths for KaTeX fonts
                stylesContent = stylesContent.replace(
                  /url\("\.\.\/KaTeX_([^"]+)"\)/g,
                  `url("${options.browserProtocol}://__MSG_@@extension_id__/KaTeX_$1")`
                );
                stylesContent = stylesContent.replace(
                  /url\("\.\/KaTeX_([^"]+)"\)/g,
                  `url("${options.browserProtocol}://__MSG_@@extension_id__/KaTeX_$1")`
                );
                fs.writeFileSync(stylesCssSource, stylesContent);
                console.log('📄 Fixed font paths in styles.css');
              }

              console.log(`✅ Complete extension created in ${options.outdir}/`);
              console.log(`🎯 Ready for ${options.browserName}: ${options.readyMessage}`);
            } catch (error) {
              console.error('Error creating complete extension:', error.message);
            }
          });
        }
      }
    ]
  };

  return config;
};

export { createChromiumBuildOptions };
