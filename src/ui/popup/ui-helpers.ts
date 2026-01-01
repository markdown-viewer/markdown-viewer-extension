/**
 * UI helpers for popup
 */

import { translate } from './i18n-helpers';
import { isFirefoxPopup } from './platform-detect';

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
  message.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: ${type === 'success' ? '#27ae60' : type === 'error' ? '#e74c3c' : '#3498db'};
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 12px;
    z-index: 1000;
    opacity: 0;
    transition: opacity 0.3s;
  `;
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
 * Check file access permission and show warning if disabled
 * Note: Firefox doesn't need this - it allows file:// access by default
 */
export async function checkFileAccess(): Promise<void> {
  const warningSection = document.getElementById('file-access-warning');
  if (!warningSection) {
    return;
  }

  try {
    // Firefox allows file:// access by default with <all_urls> permission
    if (isFirefoxPopup()) {
      warningSection.style.display = 'none';
      return;
    }

    // Check if file:// access is allowed (Chrome only)
    const extensionApi = chrome.extension;
    if (!extensionApi || typeof extensionApi.isAllowedFileSchemeAccess !== 'function') {
      warningSection.style.display = 'none';
      return;
    }

    const isAllowed = await extensionApi.isAllowedFileSchemeAccess();

    // Only show warning when permission is disabled
    if (!isAllowed) {
      // Get extension ID and create clickable link
      const extensionId = chrome.runtime.id;
      const extensionUrl = `chrome://extensions/?id=${extensionId}`;

      const descEl = document.getElementById('file-access-warning-desc');
      if (descEl) {
        const baseText = translate('file_access_disabled_desc_short') ||
          '要查看本地文件，请访问';
        const linkText = translate('file_access_settings_link') || '扩展设置页面';
        const suffixText = translate('file_access_disabled_suffix') ||
          '并启用「允许访问文件网址」选项';

        descEl.innerHTML = `${baseText} <a href="${extensionUrl}" style="color: #d97706; text-decoration: underline; cursor: pointer;">${linkText}</a> ${suffixText}`;

        // Add click handler
        const link = descEl.querySelector('a');
        if (link) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            window.open(extensionUrl, '_blank');
          });
        }
      }

      warningSection.style.display = 'block';
    } else {
      warningSection.style.display = 'none';
    }
  } catch (error) {
    // Hide warning on error (Firefox may throw when API doesn't exist)
    console.error('Failed to check file access:', error);
    warningSection.style.display = 'none';
  }
}
