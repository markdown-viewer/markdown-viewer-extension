// Shared build configuration for esbuild
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

export const createBuildConfig = () => {
  const config = {
    entryPoints: {
      'core/content-detector': 'chrome/src/webview/content-detector.ts',
      'core/main': 'chrome/src/webview/main.ts',
      'core/clipboard-main': 'chrome/src/webview/clipboard-main.ts',
      'core/background': 'chrome/src/host/background.ts',
      'core/offscreen-render-worker': 'chrome/src/webview/offscreen-render-worker.ts',
      'ui/popup/popup': 'chrome/src/popup/popup.ts',
      'ui/styles': 'src/ui/styles.css'
    },
    bundle: true,
    outdir: 'dist/chrome',
    format: 'iife', // Use IIFE for Chrome extension content scripts
    target: ['chrome120'], // Target modern Chrome
    treeShaking: true,
    metafile: false, // Generate metafile for bundle analysis
    // Define globals
    define: {
      'process.env.NODE_ENV': '"production"',
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
    external: ['mermaid'],
    minify: true,
    sourcemap: false,
    plugins: [
      // Plugin to copy static files and create complete extension
      {
        name: 'create-complete-extension',
        setup(build) {
          build.onEnd(() => {
            try {
              const fileCopies = [
                { src: 'chrome/manifest.json', dest: 'dist/chrome/manifest.json', log: '📄 Copied manifest.json from chrome/' },
                { src: 'chrome/src/popup/popup.html', dest: 'dist/chrome/ui/popup/popup.html' },
                { src: 'chrome/src/popup/popup.css', dest: 'dist/chrome/ui/popup/popup.css' },
                { src: 'chrome/src/webview/offscreen-render.html', dest: 'dist/chrome/ui/offscreen-render.html' },
                { src: 'chrome/src/webview/clipboard-preview.html', dest: 'dist/chrome/ui/clipboard-preview.html' }
              ];

              fileCopies.push(...copyDirectory('icons', 'dist/chrome/icons'));
              fileCopies.push(...copyDirectory('src/_locales', 'dist/chrome/_locales'));
              fileCopies.push(...copyDirectory('src/themes', 'dist/chrome/themes'));

              // Copy mermaid library (loaded separately via script tag)
              fileCopies.push({ 
                src: 'node_modules/mermaid/dist/mermaid.min.js', 
                dest: 'dist/chrome/libs/mermaid.min.js',
                log: '📦 Copied libs/mermaid.min.js'
              });

              fileCopies.forEach(({ src, dest, log }) => copyFileIfExists(src, dest, log));

              // Fix KaTeX font paths in styles.css
              // esbuild bundles fonts to dist/ root with relative paths like ./KaTeX_*.woff2
              // We convert them to absolute Chrome extension URLs so they work in content scripts
              // __MSG_@@extension_id__ will be resolved by Chrome when CSS is injected
              const stylesCssSource = 'dist/chrome/ui/styles.css';

              if (fs.existsSync(stylesCssSource)) {
                let stylesContent = fs.readFileSync(stylesCssSource, 'utf8');
                // Fix both ./ and ../ paths for KaTeX fonts
                stylesContent = stylesContent.replace(
                  /url\("\.\.\/KaTeX_([^"]+)"\)/g,
                  'url("chrome-extension://__MSG_@@extension_id__/KaTeX_$1")'
                );
                stylesContent = stylesContent.replace(
                  /url\("\.\/KaTeX_([^"]+)"\)/g,
                  'url("chrome-extension://__MSG_@@extension_id__/KaTeX_$1")'
                );
                fs.writeFileSync(stylesCssSource, stylesContent);
                console.log('📄 Fixed font paths in styles.css');
              }

              console.log('✅ Complete extension created in dist/chrome/');
              console.log('🎯 Ready for Chrome: chrome://extensions/ → Load unpacked → select dist/chrome/');
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
