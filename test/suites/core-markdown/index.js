// Suite group: markdown processing & converters (fibjs test runner).
// Import order inside the group matters: docx-math-converter (mathjax) must
// load before markdown-processor installs the global xml `document`.
import './book-exporter.test.ts';
import './book-export-progress.test.ts';
import './docx-math-converter.test.js';
import './markdown-block-splitter.test.js';
import './markdown-document.test.js';
import './markdown-processor.test.js';
import './markdown-table-code.test.ts';
import './remark-github-alerts.test.js';
import './remark-inline-html.test.js';
import './remark-mode.test.ts';
