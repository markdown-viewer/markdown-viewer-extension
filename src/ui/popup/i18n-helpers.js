// Internationalization helpers for popup

import Localization, { DEFAULT_SETTING_LOCALE } from '../../utils/localization.js';

/**
 * Translate a key to localized string
 * @param {string} key - Translation key
 * @param {string|string[]} substitutions - Optional substitutions
 * @returns {string} Translated string
 */
export const translate = (key, substitutions) => Localization.translate(key, substitutions);

/**
 * Get the current UI locale
 * @returns {string} Locale code (e.g., 'en', 'zh-CN')
 */
export const getUiLocale = () => {
  const selectedLocale = Localization.getLocale();
  if (selectedLocale && selectedLocale !== DEFAULT_SETTING_LOCALE) {
    return selectedLocale.replace('_', '-');
  }

  if (chrome?.i18n?.getUILanguage) {
    return chrome.i18n.getUILanguage();
  }
  return 'en';
};

/**
 * Apply internationalized text to DOM elements
 * Elements with data-i18n attribute will have their text content replaced
 * Elements with data-i18n-attr attribute will have specified attributes set
 */
export const applyI18nText = () => {
  // Handle text content
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach((element) => {
    const { i18n: key, i18nArgs } = element.dataset;
    let substitutions;

    if (i18nArgs) {
      substitutions = i18nArgs.split('|');
    }

    let message = translate(key, substitutions);
    if (message && substitutions) {
      const list = Array.isArray(substitutions) ? substitutions : [substitutions];
      message = message.replace(/\{(\d+)\}/g, (match, index) => {
        const idx = Number.parseInt(index, 10);
        if (Number.isNaN(idx) || idx < 0 || idx >= list.length) {
          return match;
        }
        return list[idx];
      });
    }

    if (message) {
      element.textContent = message;
    }
  });

  // Handle attribute translations
  const attributeElements = document.querySelectorAll('[data-i18n-attr]');
  attributeElements.forEach((element) => {
    const mapping = element.dataset.i18nAttr;
    if (!mapping) {
      return;
    }

    mapping.split(',').forEach((pair) => {
      const [attrRaw, key] = pair.split(':');
      if (!attrRaw || !key) {
        return;
      }

      const attrName = attrRaw.trim();
      const message = translate(key.trim());
      if (attrName && message) {
        element.setAttribute(attrName, message);
      }
    });
  });
};
