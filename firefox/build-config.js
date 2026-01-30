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
      'core/clipboard-main': 'firefox/src/webview/clipboard-main.ts',
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
    ],
    define: {
      'process.env.NODE_ENV': '"production"',
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
      {
        name: 'create-complete-extension',
        setup(build) {
          build.onEnd(() => {
            try {
              const fileCopies = [
                { src: 'firefox/manifest.json', dest: 'dist/firefox/manifest.json', log: '📄 Copied manifest.json from firefox/' },
                { src: 'chrome/src/popup/popup.html', dest: 'dist/firefox/ui/popup/popup.html' },
                { src: 'chrome/src/popup/popup.css', dest: 'dist/firefox/ui/popup/popup.css' },
                { src: 'firefox/src/host/background.html', dest: 'dist/firefox/ui/background.html', log: '📄 Copied background.html' },
                { src: 'firefox/src/webview/clipboard-preview.html', dest: 'dist/firefox/ui/clipboard-preview.html', log: '📄 Copied clipboard-preview.html' }
              ];

              fileCopies.push(...copyDirectory('icons', 'dist/firefox/icons'));
              fileCopies.push(...copyDirectory('src/_locales', 'dist/firefox/_locales'));
              fileCopies.push(...copyDirectory('src/themes', 'dist/firefox/themes'));

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
