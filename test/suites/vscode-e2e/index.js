// Suite group: VS Code extension E2E (Node.js test runner + Playwright).
// Drives the real installed VS Code with the built extension from dist/vscode
// (`npm run build:vscode`). Point at another build with
// MV_VSCODE_EXECUTABLE=/path/to/Code, or opt out with MV_SKIP_VSCODE_TESTS=1.
//
// Files are ordered fast-to-slow: the diagram suite boots the render bundle
// and is the one case allowed to be slow, so it goes last.
import './preview-panel.test.ts';
import './commands-and-panels.test.ts';
import './diagram-preview.test.ts';
