import { showActionMenu, type ActionMenuHandle } from './action-menu';

export interface ExportMenuOptions {
  translate?: (key: string) => string;
  onExportDocx: () => void | Promise<void>;
  onSaveMarkdown?: () => void | Promise<void>;
  onPrint?: () => void | Promise<void>;
  getPrintDisabledTitle?: () => string | null;
}

export interface ExportMenu {
  showAtAnchor: (anchor: HTMLElement) => void;
  showAtPosition: (x: number, y: number) => void;
  hide: () => void;
  isVisible: () => boolean;
}

export function createExportMenu(options: ExportMenuOptions): ExportMenu {
  let current: ActionMenuHandle | null = null;

  function translate(key: string): string {
    return options.translate?.(key) || fallbackTranslation(key);
  }

  function show(anchor?: HTMLElement, x?: number, y?: number): void {
    current?.hide();
    const printDisabledTitle = options.getPrintDisabledTitle?.() || null;
    current = showActionMenu({
      anchor,
      x,
      y,
      items: [
        {
          label: translate('export_menu_export_docx'),
          onSelect: async () => {
            await options.onExportDocx();
          },
        },
        ...(options.onSaveMarkdown ? [{
          label: translate('export_menu_save_markdown'),
          onSelect: async () => {
            await options.onSaveMarkdown!();
          },
        }] : []),
        ...(options.onPrint ? [{
          label: translate('export_menu_print_pdf'),
          onSelect: async () => {
            await options.onPrint!();
          },
          disabled: Boolean(printDisabledTitle),
          title: printDisabledTitle || '',
        }] : []),
      ],
    });
  }

  return {
    showAtAnchor: (anchor) => show(anchor),
    showAtPosition: (x, y) => show(undefined, x, y),
    hide: () => current?.hide(),
    isVisible: () => current?.isVisible() ?? false,
  };
}

function fallbackTranslation(key: string): string {
  const map: Record<string, string> = {
    export_menu_export_docx: 'Export to DOCX',
    export_menu_save_markdown: 'Save as Markdown',
    export_menu_print_pdf: 'Print to PDF',
  };
  return map[key] || key;
}