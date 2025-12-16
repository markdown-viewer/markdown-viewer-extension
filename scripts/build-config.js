// Shared build configuration for esbuild
import fs from 'fs';
import path from 'path';

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
      'core/content-detector': 'src/core/content-detector.js',
      'core/content': 'src/core/content.js',
      'core/background': 'src/core/background.js',
      'core/offscreen': 'src/platform/chrome/render-worker.js',
      'ui/popup/popup': 'src/ui/popup/popup.js',
      'ui/print/print': 'src/ui/print/print.js',
      'ui/print/print-page': 'src/ui/print/print-page.css',
      'ui/styles': 'src/ui/styles.css'
    },
    bundle: true,
    outdir: 'dist/chrome',
    format: 'iife', // Use IIFE for Chrome extension content scripts
    target: ['chrome120'], // Target modern Chrome
    treeShaking: true,
    // Define globals
    define: {
      'process.env.NODE_ENV': '"production"',
      'global': 'globalThis', // Polyfill for global
    },
    // Inject Node.js polyfills for browser environment
    inject: ['./scripts/buffer-shim.js'],
    loader: {
      '.css': 'css', // Load CSS files properly to handle @import
      '.woff': 'file',
      '.woff2': 'file',
      '.ttf': 'file',
      '.eot': 'file'
    },
    assetNames: '[name]', // Use original filename without hash
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
                { src: 'src/manifest.json', dest: 'dist/chrome/manifest.json', log: '📄 Copied manifest.json from src/' },
                { src: 'src/ui/popup/popup.html', dest: 'dist/chrome/ui/popup/popup.html' },
                { src: 'src/ui/popup/popup.css', dest: 'dist/chrome/ui/popup/popup.css' },
                { src: 'src/platform/chrome/render-worker.html', dest: 'dist/chrome/ui/offscreen.html' },
                { src: 'src/ui/print/print.html', dest: 'dist/chrome/ui/print/print.html' },
                { src: 'node_modules/html2canvas/dist/html2canvas.min.js', dest: 'dist/chrome/html2canvas.min.js', log: '📄 Copied html2canvas library' }
              ];

              fileCopies.push(...copyDirectory('icons', 'dist/chrome/icons'));
              fileCopies.push(...copyDirectory('src/_locales', 'dist/chrome/_locales'));
              fileCopies.push(...copyDirectory('src/themes', 'dist/chrome/themes'));

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
