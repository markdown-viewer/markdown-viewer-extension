export interface ActionMenuItem {
  label: string;
  onSelect?: () => void | Promise<void>;
  disabled?: boolean;
  title?: string;
  separator?: boolean;
}

export interface ActionMenuHandle {
  hide: () => void;
  isVisible: () => boolean;
}

export interface ShowActionMenuOptions {
  items: ActionMenuItem[];
  anchor?: HTMLElement;
  x?: number;
  y?: number;
}

let cssInjected = false;
let activeCleanup: (() => void) | null = null;

function injectCSS(): void {
  if (cssInjected) {
    return;
  }
  cssInjected = true;

  const style = document.createElement('style');
  style.textContent = `
.mv-action-menu {
  position: fixed;
  z-index: 10000;
  display: inline-flex;
  flex-direction: column;
  align-items: stretch;
  width: auto;
  min-width: 0;
  max-width: min(calc(100vw - 16px), 320px);
  padding: 4px 0;
  background: var(--color-bg-surface, var(--vscode-menu-background, #ffffff));
  color: var(--color-text-primary, var(--vscode-menu-foreground, #1a1a1a));
  border: 1px solid var(--color-border, var(--vscode-menu-border, #e2e8f0));
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.mv-action-menu-item {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 6px 24px 6px 12px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  white-space: nowrap;
  box-sizing: border-box;
  font: inherit;
  cursor: pointer;
}

.mv-action-menu-item:hover:not(:disabled) {
  background: var(--color-primary, var(--vscode-menu-selectionBackground, #2563eb));
  color: var(--vscode-menu-selectionForeground, #ffffff);
}

.mv-action-menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mv-action-menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--color-border, var(--vscode-menu-separatorBackground, #e2e8f0));
}
`;
  document.head.appendChild(style);
}

function clampPosition(menu: HTMLElement, left: number, top: number): void {
  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);

  menu.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
  menu.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
}

export function showActionMenu(options: ShowActionMenuOptions): ActionMenuHandle {
  injectCSS();
  activeCleanup?.();

  const menu = document.createElement('div');
  menu.className = 'mv-action-menu';
  menu.setAttribute('role', 'menu');

  const items = options.items.filter((item) => item.separator || item.label);
  for (const item of items) {
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'mv-action-menu-separator';
      menu.appendChild(separator);
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mv-action-menu-item';
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.title = item.title || '';
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', async () => {
      if (item.disabled) {
        return;
      }
      cleanup();
      await item.onSelect?.();
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);

  let left = options.x ?? 8;
  let top = options.y ?? 8;
  if (options.anchor) {
    const rect = options.anchor.getBoundingClientRect();
    left = rect.right - menu.getBoundingClientRect().width;
    top = rect.bottom + 6;
  }
  clampPosition(menu, left, top);

  const onPointerDown = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (target && !menu.contains(target)) {
      cleanup();
    }
  };
  const onScroll = () => cleanup();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      cleanup();
    }
  };

  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', onKeyDown, true);

  function cleanup(): void {
    if (!menu.isConnected) {
      return;
    }
    menu.remove();
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (activeCleanup === cleanup) {
      activeCleanup = null;
    }
  }

  activeCleanup = cleanup;

  return {
    hide: cleanup,
    isVisible: () => menu.isConnected,
  };
}