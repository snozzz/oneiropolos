// Server-side translations: the same dictionaries as the UI (public/js/locales), language from ui.language in config.json.
import fs from 'node:fs';
import en from '../public/js/locales/en.js';
import ja from '../public/js/locales/ja.js';
import zh from '../public/js/locales/zh.js';
import { DEFAULT_LANG, localeOf, makeDuration, makeT, normalizeLang, setRoleNames } from '../public/js/i18n-core.js';
import { CONFIG_PATH } from './paths.js';

export { setRoleNames };

const DICTS = { en, zh, ja };
const T = Object.fromEntries(Object.entries(DICTS).map(([k, d]) => [k, makeT(d, en)]));

let cache = { stamp: '', lang: DEFAULT_LANG };

/** The UI language chosen in settings (re-read when config.json changes). WBLOOP_LANG overrides it. */
export function currentLang() {
  if (process.env.WBLOOP_LANG) return normalizeLang(process.env.WBLOOP_LANG);
  let stamp = 'none';
  try {
    const st = fs.statSync(CONFIG_PATH);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // no config yet
  }
  if (stamp !== cache.stamp) {
    let lang = DEFAULT_LANG;
    try {
      lang = normalizeLang(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))?.ui?.language);
    } catch {
      // keep default
    }
    cache = { stamp, lang };
  }
  return cache.lang;
}

export function t(key, params, lang = currentLang()) {
  return (T[lang] || T.en)(key, params);
}

export function dict(lang = currentLang()) {
  return DICTS[lang] || en;
}

export function locale(lang = currentLang()) {
  return localeOf(lang);
}

export function fmtDuration(ms, lang = currentLang()) {
  return makeDuration((k, p) => t(k, p, lang))(ms);
}

/** Local clock text: "14:05", "Tomorrow 01:00", or a date. */
export function clockText(ms, lang = currentLang()) {
  const d = new Date(ms);
  const loc = localeOf(lang);
  const hm = d.toLocaleTimeString(loc, { hour12: false, hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return hm;
  if (d.toDateString() === new Date(today.getTime() + 86400_000).toDateString()) return t('time.tomorrow', { time: hm }, lang);
  return `${d.toLocaleDateString(loc, { month: 'short', day: 'numeric' })} ${hm}`;
}

/** A message that can be re-rendered in another language later: { key, params, text }. */
export function msg(key, params) {
  return { key, params: params || undefined, text: t(key, params) };
}
