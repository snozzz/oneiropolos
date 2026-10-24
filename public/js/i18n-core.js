// Language plumbing shared by the browser UI (public/js/i18n.js) and the Node side (src/i18n.js).
// Dictionaries are flat maps in public/js/locales/<lang>.js; "{name}" placeholders are filled from params.
// A key may have a "#one" variant that is used when params.n === 1 (English plurals).

export const LANGS = [
  { id: 'en', name: 'English', locale: 'en-US' },
  { id: 'zh', name: '中文', locale: 'zh-CN' },
  { id: 'ja', name: '日本語', locale: 'ja-JP' },
];

export const DEFAULT_LANG = 'en';

export function normalizeLang(value) {
  const s = String(value || '').toLowerCase();
  if (s.startsWith('zh')) return 'zh';
  if (s.startsWith('ja')) return 'ja';
  if (s.startsWith('en')) return 'en';
  return DEFAULT_LANG;
}

export function localeOf(lang) {
  return (LANGS.find((l) => l.id === lang) || LANGS[0]).locale;
}

export function format(str, params) {
  if (!params) return str;
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
}

export function makeT(dict, fallback = {}) {
  return function t(key, params) {
    let s;
    if (params && params.n === 1) s = dict[`${key}#one`] ?? fallback[`${key}#one`];
    if (s == null) s = dict[key] ?? fallback[key];
    return s == null ? key : format(s, params);
  };
}

/** Durations like "3 min 05 s" in the current language. */
export function makeDuration(t) {
  return function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return t('dur.s', { s });
    const m = Math.floor(s / 60);
    if (m < 60) return t('dur.ms', { m, s: s % 60 });
    return t('dur.hm', { h: Math.floor(m / 60), m: m % 60 });
  };
}
