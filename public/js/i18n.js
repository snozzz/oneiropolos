// The interface language: chosen in settings, injected into <html lang> by the server. English is the default and the
// fallback for any missing key. Switching the language reloads the page.
import { LANGS, localeOf, makeDuration, makeT, normalizeLang, setRoleNames } from './i18n-core.js';
import en from './locales/en.js';

export const lang = normalizeLang(document.documentElement.lang);
const dict = lang === 'en' ? en : (await import(`./locales/${lang}.js`)).default;

export const t = makeT(dict, en);
export const locale = localeOf(lang);
export const fmtDuration = makeDuration(t);
export { LANGS, setRoleNames };

/** Static text in index.html: data-i18n (text), data-i18n-placeholder, data-i18n-title, data-i18n-aria. */
export function translateDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
}
