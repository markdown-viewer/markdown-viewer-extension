// UI helpers for popup

import { translate } from './i18n-helpers.js';

/**
 * Show a confirmation modal
 * @param {string} title - Modal title
 * @param {string} message - Modal message
 * @returns {Promise<boolean>} True if confirmed, false otherwise
 */
export function showConfirm(title, message) {
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

    const cleanup = () => {
      modal.style.display = 'none';
      confirmBtn.replaceWith(confirmBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };

    confirmBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    // Close on click outside
    modal.onclick = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };
  });
}

/**
 * Show a toast message
 * @param {string} text - Message text
 * @param {string} type - Message type ('success', 'error', 'info')
 */
export function showMessage(text, type = 'info') {
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
 * @param {string} text - Error text
 */
export function showError(text) {
  console.error('Popup Error:', text);
  showMessage(`Error: ${text}`, 'error');
}

/**
 * Check file access permission and show warning if disabled
 */
export async function checkFileAccess() {
  try {
    // Check if file:// access is allowed
    const isAllowed = await chrome.extension.isAllowedFileSchemeAccess();

    const warningSection = document.getElementById('file-access-warning');

    if (!warningSection) {
      return;
    }

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
            chrome.tabs.create({ url: extensionUrl });
          });
        }
      }

      warningSection.style.display = 'block';
    } else {
      warningSection.style.display = 'none';
    }
  } catch (error) {
    console.error('Failed to check file access:', error);
  }
}
