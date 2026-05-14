export interface CodeBlockCopyOptions {
  container: HTMLElement;
  translate?: (key: string) => string;
}

type CopyState = 'idle' | 'success' | 'error';

const BUTTON_CLASS = 'mv-code-copy-btn';
const READY_CLASS = 'mv-code-copy-ready';
const RESET_DELAY_MS = 1600;

const resetTimers = new WeakMap<HTMLButtonElement, number>();

export function isCopyableCodeBlock(pre: Pick<HTMLElement, 'querySelector'>): boolean {
  return Boolean(pre.querySelector('code'));
}

export function getCopyableCodeText(
  pre: Pick<HTMLElement, 'querySelector' | 'textContent'>
): string {
  const code = pre.querySelector('code');
  return code?.textContent ?? pre.textContent ?? '';
}

export function shouldBlurCopyButtonOnMouseLeave(
  activeElement: Element | null,
  button: HTMLButtonElement
): boolean {
  return activeElement === button;
}

export function setupCodeBlockCopy(options: CodeBlockCopyOptions): () => void {
  const { container, translate } = options;

  const t = (key: string, fallback: string) => {
    const value = translate?.(key);
    return value && value !== key ? value : fallback;
  };

  const copyLabel = t('code_copy', 'Copy code');
  const copiedLabel = t('code_copied', 'Copied');
  const failedLabel = t('code_copy_failed', 'Copy failed');

  const enhancePre = (pre: HTMLElement) => {
    if (!isCopyableCodeBlock(pre) || pre.querySelector(`.${BUTTON_CLASS}`)) {
      return;
    }

    pre.classList.add(READY_CLASS);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;

    const setState = (state: CopyState, label: string) => {
      button.dataset.copyState = state;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.textContent = state === 'success' ? '✓' : state === 'error' ? '!' : '⧉';
    };

    const scheduleReset = () => {
      const currentTimer = resetTimers.get(button);
      if (currentTimer) {
        window.clearTimeout(currentTimer);
      }

      const nextTimer = window.setTimeout(() => {
        resetTimers.delete(button);
        setState('idle', copyLabel);
      }, RESET_DELAY_MS);

      resetTimers.set(button, nextTimer);
    };

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        await writeTextToClipboard(getCopyableCodeText(pre));
        setState('success', copiedLabel);
      } catch {
        setState('error', failedLabel);
      }

      scheduleReset();
    });

    pre.addEventListener('mouseleave', () => {
      if (shouldBlurCopyButtonOnMouseLeave(document.activeElement, button)) {
        button.blur();
      }
    });

    setState('idle', copyLabel);
    pre.appendChild(button);
  };

  const enhanceAll = (root: ParentNode) => {
    if (root instanceof HTMLElement && root.tagName === 'PRE') {
      enhancePre(root);
    }

    if ('querySelectorAll' in root) {
      root.querySelectorAll('pre').forEach((pre) => {
        if (pre instanceof HTMLElement) {
          enhancePre(pre);
        }
      });
    }
  };

  enhanceAll(container);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          enhanceAll(node);
        }
      });
    }
  });

  observer.observe(container, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    container.querySelectorAll<HTMLButtonElement>(`.${BUTTON_CLASS}`).forEach((button) => {
      const timer = resetTimers.get(button);
      if (timer) {
        window.clearTimeout(timer);
        resetTimers.delete(button);
      }
      button.remove();
    });
    container.querySelectorAll(`pre.${READY_CLASS}`).forEach((pre) => {
      pre.classList.remove(READY_CLASS);
    });
  };
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('execCommand failed');
    }
  } finally {
    textarea.remove();
  }
}