import { visit } from 'unist-util-visit';
import type { Processor } from 'unified';
import type { Node, Parent } from 'unist';
import type { ASTNode, AsyncTaskQueueManager } from '../types';
import { createErrorHTML, withNodeSourceInfo } from './plugin-content-utils';
import { isOpenapiSource } from '../utils/openapi';
import { syncBlockHtmlFromDOM } from '../core/viewer/viewer-controller';
import { escapeHtml } from '../core/markdown-processor';
import { recordRenderDiagnostic } from '../core/render-diagnostics';

const ELEMENT_NAME = 'documd-openapi';

export function registerOpenapiPlugin(
  processor: Processor,
  asyncTask: AsyncTaskQueueManager['asyncTask'],
): void {
  processor.use(function () {
    return (tree: Node) => {
      visit(tree, 'code', (node: Node, index: number | undefined, parent: Parent | undefined) => {
        const codeNode = node as ASTNode;
        const language = codeNode.lang?.toLowerCase();
        const content = codeNode.value ?? '';
        if (index === undefined || !parent) return;
        if (language !== 'openapi' && language !== 'swagger'
          && !((language === 'yaml' || language === 'yml') && isOpenapiSource(content))) return;

        const result = asyncTask(async ({ id, code, sourceHash, sourceLine }) => {
          const { mountOpenapiPreview } = await import('../ui/openapi-viewer');
          const placeholder = document.getElementById(id);
          if (!placeholder || placeholder.dataset.sourceHash !== sourceHash) return;
          const element = document.createElement(ELEMENT_NAME) as HTMLElement & { ready: Promise<void>; error?: Error };
          element.dataset.pluginType = 'openapi';
          element.dataset.pluginRendered = 'true';
          element.dataset.sourceHash = sourceHash;
          // Keep source in light DOM: cached/restored blocks can remount, and
          // script-free exports retain readable YAML instead of an empty box.
          const source = document.createElement('pre');
          source.textContent = code ?? '';
          element.appendChild(source);
          placeholder.replaceWith(element);
          await mountOpenapiPreview(element);
          if (!element.isConnected) return;
          if (element.error) {
            const message = element.error.message;
            const line = typeof sourceLine === 'number' ? sourceLine : null;
            recordRenderDiagnostic({ level: 'error', kind: 'render-failed', type: 'openapi', line, blockId: id, message });
            element.outerHTML = createErrorHTML(escapeHtml(`OpenAPI: ${message}`), { pluginType: 'openapi', sourceLine: line, blockId: id });
          }
          syncBlockHtmlFromDOM(id);
        }, withNodeSourceInfo({ code: content }, codeNode), { type: 'openapi', isInline: () => false });
        parent.children[index] = result.placeholder;
      });
    };
  });
}
