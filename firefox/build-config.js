// Firefox build configuration for esbuild
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

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

const copyFileIfExists = (sourcePath, targetPath, logMessage) => {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.copyFileSync(sourcePath, targetPath);
  if (logMessage) {
    console.log(logMessage);
  }
  return true;
};

// Pre-bundled library files to copy (these are loaded separately via <script> tags)
// Only mermaid needs to be separate (2.6MB) to keep each file under 5MB limit
const PREBUNDLED_LIBS = [
  { src: 'node_modules/mermaid/dist/mermaid.min.js', dest: 'libs/mermaid.min.js' },
];

export const createBuildConfig = () => {
  const config = {
    entryPoints: {
      'core/content-detector': 'chrome/src/webview/content-detector.ts',
      'core/main': 'firefox/src/webview/main.ts',
      'core/html-to-markdown': 'chrome/src/webview/html-to-markdown.ts',
      'core/drawio2svg': 'src/renderers/entries/drawio2svg-global.ts',
      'core/draw-uml': 'src/renderers/entries/draw-uml-global.ts',
      'core/render-worker': 'firefox/src/host/render-worker.ts',
      'core/background': 'firefox/src/host/background.ts',
      'ui/popup/popup': 'firefox/src/popup/popup.ts',  // Firefox popup with Firefox platform
      'ui/styles': 'src/ui/styles.css'
    },
    bundle: true,
    outdir: 'dist/firefox',
    format: 'iife',
    target: ['firefox109'],
    treeShaking: true,
    metafile: true,
    // Only mermaid is external (2.6MB) - loaded via separate script tag
    external: [
      'mermaid',
      'web-worker',
    ],
    define: {
      'process.env.NODE_ENV': '"production"',
      'MV_PLATFORM': '"firefox"',
      'MV_RUNTIME': '"shared"',
      'global': 'globalThis',
    },
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'css',
      '.woff2': 'file',
      '.woff': 'empty',
      '.ttf': 'empty',
      '.eot': 'empty'
    },
    assetNames: '[name]',
    minify: true,
    sourcemap: false,
    plugins: [
      // Redirect @markdown-viewer/drawio2svg and draw-uml imports to shims
      // ONLY for files under src/renderers/ — these run in the render worker
      // where the real libraries are loaded via separate <script> tags.
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
      {
        name: 'create-complete-extension',
        setup(build) {
          build.onEnd(() => {
            try {
              const fileCopies = [
                { src: 'firefox/manifest.json', dest: 'dist/firefox/manifest.json', log: '📄 Copied manifest.json from firefox/' },
                { src: 'chrome/src/popup/popup.html', dest: 'dist/firefox/ui/popup/popup.html' },
                { src: 'chrome/src/popup/popup.css', dest: 'dist/firefox/ui/popup/popup.css' },
                { src: 'firefox/src/host/background.html', dest: 'dist/firefox/ui/background.html', log: '📄 Copied background.html' }
              ];

              fileCopies.push(...copyDirectory('icons', 'dist/firefox/icons'));
              fileCopies.push(...copyDirectory('src/_locales', 'dist/firefox/_locales'));
              fileCopies.push(...copyDirectory('src/themes', 'dist/firefox/themes'));
              fileCopies.push(...copyDirectory('node_modules/@markdown-viewer/drawio2svg/resources/stencils', 'dist/firefox/stencils'));

              // Copy pre-built Slidev Shell assets
              if (fs.existsSync('dist/slidev-shell')) {
                fileCopies.push(...copyDirectory('dist/slidev-shell', 'dist/firefox/slidev-shell'));
                console.log('📦 Copied dist/slidev-shell → dist/firefox/slidev-shell');
              } else {
                console.warn('⚠️  dist/slidev-shell not found — run "cd slidev-shell && npm run build" first');
              }

              // Copy pre-built theme IIFE bundles for dynamic loading
              if (fs.existsSync('dist/themes')) {
                fileCopies.push(...copyDirectory('dist/themes', 'dist/firefox/slidev-shell/themes'));
                console.log('📦 Copied dist/themes → dist/firefox/slidev-shell/themes');
              }

              // Copy pre-bundled library files
              for (const lib of PREBUNDLED_LIBS) {
                fileCopies.push({ 
                  src: lib.src, 
                  dest: `dist/firefox/${lib.dest}`,
                  log: `📦 Copied ${lib.dest}`
                });
              }

              fileCopies.forEach(({ src, dest, log }) => copyFileIfExists(src, dest, log));

              // Fix KaTeX font paths in styles.css for Firefox
              const stylesCssSource = 'dist/firefox/ui/styles.css';

              if (fs.existsSync(stylesCssSource)) {
                let stylesContent = fs.readFileSync(stylesCssSource, 'utf8');
                // Firefox uses moz-extension:// protocol
                stylesContent = stylesContent.replace(
                  /url\("\.\.\/KaTeX_([^"]+)"\)/g,
                  'url("moz-extension://__MSG_@@extension_id__/KaTeX_$1")'
                );
                stylesContent = stylesContent.replace(
                  /url\("\.\/KaTeX_([^"]+)"\)/g,
                  'url("moz-extension://__MSG_@@extension_id__/KaTeX_$1")'
                );
                fs.writeFileSync(stylesCssSource, stylesContent);
                console.log('📄 Fixed font paths in styles.css for Firefox');
              }

              console.log('✅ Complete extension created in dist/firefox/');
              console.log('🎯 Ready for Firefox: about:debugging → This Firefox → Load Temporary Add-on → select dist/firefox/manifest.json');
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
