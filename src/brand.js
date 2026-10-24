// The program's names, in one place for notifications, the CLI and exported files (the UI has public/js/brand.js).
// Oneiropolos is Homer's ὀνειροπόλος, "one who deals with dreams" — the dream interpreter: WorkBuddy's report is like a
// dream that may come true or deceive, and GPT's job is to tell which (Odyssey 19: true dreams pass through the gate of
// horn, false ones through the gate of ivory). In Chinese it is 守梦人 ("keeper of the dream"), in Japanese 夢守.
import { currentLang } from './i18n.js';

export const BRAND = {
  latin: 'Oneiropolos',
  greek: 'ὀνειροπόλος',
  names: { en: 'Oneiropolos', zh: '守梦人', ja: '夢守' },
  // the CLI and the data directory keep the old name, so scripts and task records keep working
  cli: 'wbloop',
};

export function brandName(lang = currentLang()) {
  return BRAND.names[lang] || BRAND.latin;
}
