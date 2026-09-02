// Suite group: plugin & host-page rewrites (fibjs test runner).
// html-plugin scopes its fake document to its own suite (before/after), so
// aggregating it with markdown-processor's xml DOM is safe.
import './html-plugin.test.js';
import './obsidian-link-rewrite.test.js';
import './obsidian-markdown-embed-rewrite.test.js';
import './obsidian-svg-embed-rewrite.test.js';
