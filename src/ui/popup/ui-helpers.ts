/**
 * UI helpers for popup
 */

import { getWebExtensionApi, isPlatform } from '../../utils/platform-info';
import { translate } from './i18n-helpers';

/**
 * Show a confirmation modal
 * @param title - Modal title
 * @param message - Modal message
 * @returns True if confirmed, false otherwise
 */
export function showConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('modal-title');
    const messageEl = document.getElementById('modal-message');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn) {
      // Fallback to native confirm if modal elements are missing
      resolve(confirm(message));
      return;
    }

    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.style.display = 'flex';

    const cleanup = (): void => {
      modal.style.display = 'none';
      confirmBtn.replaceWith(confirmBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };

    (confirmBtn as HTMLButtonElement).onclick = () => {
      cleanup();
      resolve(true);
    };

    (cancelBtn as HTMLButtonElement).onclick = () => {
      cleanup();
      resolve(false);
    };

    // Close on click outside
    modal.onclick = (e: MouseEvent) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };
  });
}

/**
 * Message type for toast
 */
type MessageType = 'success' | 'error' | 'info';

/**
 * Show a toast message
 * @param text - Message text
 * @param type - Message type ('success', 'error', 'info')
 */
export function showMessage(text: string, type: MessageType = 'info'): void {
  const message = document.createElement('div');
  message.className = `mv-toast mv-toast--${type}`;
  message.textContent = text;

  document.body.appendChild(message);

  setTimeout(() => {
    message.style.opacity = '1';
  }, 100);

  setTimeout(() => {
    message.style.opacity = '0';
    setTimeout(() => {
      if (message.parentElement) {
        message.parentElement.removeChild(message);
      }
    }, 300);
  }, 2000);
}

/**
 * Show error message
 * @param text - Error text
 */
export function showError(text: string): void {
  console.error('Popup Error:', text);
  showMessage(`Error: ${text}`, 'error');
}

/**
 * Check file access permission and show a warning when disabled.
 *
 * Both Chrome (chrome.extension.isAllowedFileSchemeAccess) and Firefox 153+
 * (browser.extension.isAllowedFileSchemeAccess — reflects the per-extension
 * "Access local files on your computer" toggle on about:addons) expose the
 * same check. Browsers/builds without the API hide the warning silently.
 */
export async function checkFileAccess(): Promise<void> {
  const warningSection = document.getElementById('file-access-warning');
  if (!warningSection) {
    return;
  }

  let extensionApi: { isAllowedFileSchemeAccess?: () => Promise<boolean> } | undefined;
  let runtimeId = '';
  let tabsApi: { create: (options: { url: string }) => Promise<unknown> } | undefined;
  try {
    const api = getWebExtensionApi();
    extensionApi = api.extension;
    runtimeId = api.runtime?.id ?? '';
    tabsApi = api.tabs;
  } catch {
    // Platform identity unavailable — do not surface a warning we cannot verify.
  }

  if (!extensionApi || typeof extensionApi.isAllowedFileSchemeAccess !== 'function') {
    warningSection.style.display = 'none';
    return;
  }

  let isAllowed: boolean;
  try {
    isAllowed = await extensionApi.isAllowedFileSchemeAccess();
  } catch {
    // API rejected — keep the warning hidden rather than mislead.
    warningSection.style.display = 'none';
    return;
  }

  // Only show the warning when permission is disabled.
  if (isAllowed) {
    warningSection.style.display = 'none';
    return;
  }

  // Firefox has no deep link into the per-extension toggle; about:addons is
  // where the user finds the "Access local files on your computer" permission
  // for docu.md.
  const settingsUrl = isPlatform('firefox')
    ? 'about:addons'
    : `chrome://extensions/?id=${encodeURIComponent(runtimeId)}`;

  const descEl = document.getElementById('file-access-warning-desc');
  if (descEl) {
    const baseText = translate('file_access_disabled_desc_short') ||
      '要查看本地文件，请访问';
    const linkText = translate('file_access_settings_link') || '扩展设置页面';
    const suffixText = translate('file_access_disabled_suffix') ||
      '并启用「允许访问文件网址」选项';

    descEl.innerHTML = `${baseText} <a href="${settingsUrl}" style="color: var(--color-warning); text-decoration: underline; cursor: pointer;">${linkText}</a> ${suffixText}`;

    // Add click handler
    const link = descEl.querySelector('a');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        // chrome:// and about: URLs cannot be opened with window.open() —
        // route them through the tabs API.
        if (tabsApi) {
          void tabsApi.create({ url: settingsUrl });
        } else {
          window.open(settingsUrl, '_blank');
        }
      });
    }
  }

  warningSection.style.display = 'block';
}
