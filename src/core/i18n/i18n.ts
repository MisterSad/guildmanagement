/**
 * src/core/i18n/i18n.ts
 *
 * ES Module i18n engine (English-only). Mirrors the legacy `i18n.js` public
 * contract exactly: t() falls back to the raw key, setLang() is a documented
 * no-op, getLang() returns 'en', and applyTranslations() fills
 * [data-i18n], [data-i18n-placeholder] and [data-i18n-title].
 *
 * Phase 1: this module does NOT assign window.GM_I18N — the parity bridge is
 * added in src/main.ts at cutover (avoids any test-time side effect).
 */

import { EN } from './i18n.dictionary';

const TRANSLATIONS: Record<string, Record<string, string>> = { en: EN };
const currentLang = 'en';

/** Exact translation, or the raw key when unknown. */
export function t(key: string, replacements?: Record<string, string | number>): string {
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS['en'];
  let str = (dict && dict[key]) || (TRANSLATIONS['en'] && TRANSLATIONS['en'][key]) || key;
  if (replacements) {
    Object.keys(replacements).forEach((k) => {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(replacements[k]));
    });
  }
  return str;
}

export function getLang(): string {
  return currentLang;
}

/** English-only: kept as a documented no-op for API compatibility. */
export function setLang(_lang: string): void {
  // no-op
}

export function applyTranslations(root?: HTMLElement | Document): void {
  if (typeof document === 'undefined') return;
  const scope: ParentNode = root || document;

  const elements = scope.querySelectorAll('[data-i18n]');
  elements.forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });

  const placeholders = scope.querySelectorAll('[data-i18n-placeholder]');
  placeholders.forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) (el as HTMLInputElement).placeholder = t(key);
  });

  const titles = scope.querySelectorAll('[data-i18n-title]');
  titles.forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });
}

export const i18n = { t, getLang, setLang, applyTranslations };
export default i18n;
