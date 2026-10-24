// Names, verses, ornaments and icons. The poetry is decoration only; buttons, settings and other functional text stay plain.
import { lang } from './i18n.js';

const NAMES = {
  en: { name: 'Oneiropolos', sub: 'ὀνειροπόλος' },
  zh: { name: '守梦人', sub: 'ONEIROPOLOS' },
  ja: { name: '夢守', sub: 'ONEIROPOLOS' },
};

export const BRAND = {
  ...(NAMES[lang] || NAMES.en),
  latin: 'Oneiropolos',
  greek: 'ὀνειροπόλος',
};

// Verses about sleep and napping — Chinese and Japanese poetry, Greek and Roman myth, Shakespeare and Keats — rotating
// with the time of day (once a day within each part of the day). Translations without a translator are our own.
const QUOTES = {
  zh: {
    dawn: [
      { text: '春眠不觉晓，处处闻啼鸟。', src: '孟浩然《春晓》' },
      { text: '俄然觉，则蘧蘧然周也。', src: '《庄子·齐物论》', gloss: '庄周梦为蝴蝶，忽然醒来，自己还是庄周。' },
      { text: '当那初生的、有玫瑰色手指的黎明出现。', src: '荷马《奥德赛》', gloss: 'ἠριγένεια φάνη ῥοδοδάκτυλος Ἠώς' },
    ],
    noon: [
      { text: '纸屏石枕竹方床，手倦抛书午梦长。', src: '蔡确《夏日登车盖亭》' },
      { text: '三杯软饱后，一枕黑甜余。', src: '苏轼《发广州》', gloss: '苏轼自注：北人谓昼寝为“黑甜”。' },
      { text: '五六月中，北窗下卧，遇凉风暂至，自谓是羲皇上人。', src: '陶渊明《与子俨等疏》' },
      { text: '昼寝而梦，游于华胥氏之国。', src: '《列子·黄帝》', gloss: '黄帝午睡，梦见一个不用治理、自然而然的国度；醒来，怡然自得。' },
    ],
    dusk: [
      { text: '日长睡起无情思，闲看儿童捉柳花。', src: '杨万里《闲居初夏午睡起》' },
      { text: '因过竹院逢僧话，偷得浮生半日闲。', src: '李涉《题鹤林寺僧舍》' },
      { text: '睡起莞然成独笑，数声渔笛在沧浪。', src: '蔡确《夏日登车盖亭》' },
    ],
    night: [
      { text: '睡眠啊，万物的安息，众神中最温和的神；你是心灵的宁静，忧虑见你便逃散。', src: '奥维德《变形记》卷十一', gloss: 'Somne, quies rerum, placidissime, Somne, deorum, pax animi, quem cura fugit.' },
      { text: '梦有两扇门：一扇以角制成，一扇以象牙制成。穿过角门的梦，终会成真。', src: '荷马《奥德赛》卷十九' },
      { text: '岩底流出忘川的溪水，潺潺流过细碎的卵石，催人入眠。', src: '奥维德《变形记》', gloss: '睡神许普诺斯的山洞。' },
      { text: '夜神生下了睡神，又生下了梦的一族。', src: '赫西俄德《神谱》' },
    ],
  },
  en: {
    dawn: [
      { text: 'Sleeping in spring, I miss the dawn; everywhere I hear the birds.', src: 'Meng Haoran, “Spring Dawn”' },
      { text: 'Suddenly he woke, and there he was — Zhuang Zhou, solid and unmistakable.', src: 'Zhuangzi, “The Butterfly Dream”', gloss: 'Had Zhou dreamed he was a butterfly, or was a butterfly dreaming it was Zhou?' },
      { text: 'When the child of morning, rosy-fingered Dawn, appeared…', src: 'Homer, Odyssey · tr. Samuel Butler', gloss: 'ἠριγένεια φάνη ῥοδοδάκτυλος Ἠώς' },
    ],
    noon: [
      { text: 'O sleep, O gentle sleep, Nature’s soft nurse…', src: 'Shakespeare, Henry IV, Part 2' },
      { text: 'Three cups, a soft fullness; then one pillow of black sweetness.', src: 'Su Shi, “Leaving Guangzhou”', gloss: 'His own note: northerners call a daytime nap “black sweetness”.' },
      { text: 'He napped at noon and dreamed he wandered in the land of Huaxu.', src: 'Liezi, “The Yellow Emperor”', gloss: 'A land that governed itself. He woke, and was content.' },
      { text: 'Lying under the north window as a cool breeze comes, I call myself a man of the golden age.', src: 'Tao Yuanming, letter to his sons' },
    ],
    dusk: [
      { text: 'We are such stuff as dreams are made on, and our little life is rounded with a sleep.', src: 'Shakespeare, The Tempest' },
      { text: 'Long days; waking from a nap with nothing on my mind, I watch the children chase the willow floss.', src: 'Yang Wanli, “Waking from a Nap in Early Summer”' },
      { text: 'Waking from my nap, I smile to myself; a fisherman’s flute drifts over the waves.', src: 'Cai Que, “Climbing the Chegai Pavilion”' },
    ],
    night: [
      { text: 'Sleep, rest of all things, gentlest of the gods, peace of the mind, from whom care flees.', src: 'Ovid, Metamorphoses XI', gloss: 'Somne, quies rerum, placidissime, Somne, deorum, pax animi, quem cura fugit.' },
      { text: 'Dreams pass through two gates, one of horn and one of ivory. Those that come through the gate of horn come true.', src: 'Homer, Odyssey XIX' },
      { text: 'O soft embalmer of the still midnight…', src: 'John Keats, “To Sleep”' },
      { text: 'Sleep that knits up the ravell’d sleave of care.', src: 'Shakespeare, Macbeth' },
    ],
  },
  ja: {
    dawn: [
      { text: '春眠暁を覚えず、処処啼鳥を聞く。', src: '孟浩然「春暁」' },
      { text: '昔者荘周夢に胡蝶と為る。', src: '『荘子』斉物論', gloss: '目覚めれば荘周。荘周が夢で蝶になったのか、蝶が夢で荘周になったのか。' },
      { text: '薔薇色の指をした暁の女神があらわれると…', src: 'ホメロス『オデュッセイア』', gloss: 'ἠριγένεια φάνη ῥοδοδάκτυλος Ἠώς' },
    ],
    noon: [
      { text: 'うたた寝に恋しき人を見てしより夢てふものは頼みそめてき', src: '小野小町『古今和歌集』' },
      { text: '三杯軟飽の後、一枕黒甜の余。', src: '蘇軾「広州を発す」', gloss: '蘇軾の自注：北方の人は昼寝を「黒甜」という。' },
      { text: '昼寝して夢み、華胥氏の国に遊ぶ。', src: '『列子』黄帝篇', gloss: '治めずとも治まる国。目覚めた黄帝は満ち足りていた。' },
    ],
    dusk: [
      { text: '夏草や兵どもが夢の跡', src: '松尾芭蕉『おくのほそ道』' },
      { text: '睡り起きて莞然として独り笑ふ、数声の漁笛滄浪に在り。', src: '蔡確「夏日車蓋亭に登る」' },
      { text: '思ひつつ寝ればや人の見えつらむ夢と知りせば覚めざらましを', src: '小野小町『古今和歌集』' },
    ],
    night: [
      { text: 'こんな夢を見た。', src: '夏目漱石『夢十夜』' },
      { text: '夢には二つの門がある。角の門をくぐる夢は、やがてまことになる。', src: 'ホメロス『オデュッセイア』第十九歌' },
      { text: '眠りよ、万物の安らぎ、神々のうちで最も穏やかな者よ。', src: 'オウィディウス『変身物語』第十一巻', gloss: 'Somne, quies rerum, placidissime, Somne, deorum, pax animi, quem cura fugit.' },
    ],
  },
};

function dayOfYear(d) {
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

export function pickQuote(now = new Date()) {
  const h = now.getHours();
  const part = h >= 5 && h < 10 ? 'dawn' : h >= 10 && h < 16 ? 'noon' : h >= 16 && h < 20 ? 'dusk' : 'night';
  const list = (QUOTES[lang] || QUOTES.en)[part];
  return list[dayOfYear(now) % list.length];
}

// the line on the "task complete" card
export const DONE_VERSE = {
  zh: { text: '睡起莞然成独笑', src: '蔡确' },
  en: { text: 'Waking from my nap, I smile to myself', src: 'Cai Que' },
  ja: { text: '睡り起きて莞然として独り笑ふ', src: '蔡確' },
}[lang] || { text: 'Waking from my nap, I smile to myself', src: 'Cai Que' };

// ---------- icons (24 grid, strokes, currentColor) ----------
const svg = (body, { vb = '0 0 24 24', sw = 1.6, fill = 'none' } = {}) => `<svg viewBox="${vb}" fill="${fill}" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
  folder: svg('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  sliders: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  send: svg('<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>', { sw: 2 }),
  cut: svg('<path d="M12 19V9M7 13.5 12 9l5 4.5"/><path d="M6 5h12"/>', { sw: 2 }),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
  pause: svg('<path d="M9 6.5v11M15 6.5v11"/>'),
  play: svg('<path d="M8 5.8v12.4a.6.6 0 0 0 .9.5l9.6-6.2a.6.6 0 0 0 0-1l-9.6-6.2a.6.6 0 0 0-.9.5z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.5 2.5h4l.5-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4z"/>', { sw: 1.4 }),
  help: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7"/><circle cx="12" cy="16.9" r=".5" fill="currentColor"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor"/>'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  chev: svg('<path d="M9.5 6.5 15 12l-5.5 5.5"/>', { sw: 1.8 }),
  check: svg('<path d="M5.5 12.5 10 17l8.5-9.5"/>', { sw: 1.8 }),
  x: svg('<path d="M7 7l10 10M17 7 7 17"/>', { sw: 1.8 }),
  warn: svg('<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17" r=".5" fill="currentColor"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".5" fill="currentColor"/>'),
  diff: svg('<path d="M8 5v8M4 9h8M5 18h7"/><path d="M15 4.5h3.5a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H15"/>'),
  rollback: svg('<path d="M8.5 7.5H15a5 5 0 0 1 0 10h-6"/><path d="M11.5 4.5 8.5 7.5l3 3"/>'),
  export: svg('<path d="M12 4v10M8 8l4-4 4 4"/><path d="M5 13.5v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>'),
  finder: svg('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1.5"/><path d="M3.5 7.5v9.5a2 2 0 0 0 2 2h12.3a2 2 0 0 0 1.9-1.4l1.6-4.6a1 1 0 0 0-.9-1.3H8.2a2 2 0 0 0-1.9 1.4L4 19"/>'),
  aside: svg('<path d="M5 6.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2h-6l-4 3.5V16H7a2 2 0 0 1-2-2z"/><path d="M9 9.5h6M9 12.5h3.5"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>'),
  trash: svg('<path d="M5 7h14M10 4.5h4M7 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7"/>'),
  list: svg('<path d="M9.5 7h10M9.5 12h10M9.5 17h10"/><circle cx="5" cy="7" r=".9" fill="currentColor"/><circle cx="5" cy="12" r=".9" fill="currentColor"/><circle cx="5" cy="17" r=".9" fill="currentColor"/>'),
  edit: svg('<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="M12.5 7.5l4 4"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1"/>'),
  moon: svg('<path d="M18.5 14.5A7.5 7.5 0 0 1 9.5 5.5a7.5 7.5 0 1 0 9 9z"/>'),
  palette: svg('<path d="M12 4a8 8 0 1 0 0 16c1.2 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.3-2.2H17a3.5 3.5 0 0 0 3-3.5C20 7.4 16.4 4 12 4z"/><circle cx="8" cy="11" r=".9" fill="currentColor"/><circle cx="11" cy="7.8" r=".9" fill="currentColor"/><circle cx="15.2" cy="8.4" r=".9" fill="currentColor"/>'),
  scroll: svg('<path d="M7 4.5h10a2 2 0 0 1 2 2V17"/><path d="M7 4.5a2 2 0 0 0-2 2v1.5h4V6.5a2 2 0 0 0-2-2z"/><path d="M9 8v10.5a1.5 1.5 0 0 0 3 0V17h9v1.5a1.5 1.5 0 0 1-1.5 1.5H10.5"/>'),
  hourglass: svg('<path d="M7 4h10M7 20h10M8 4c0 4 8 4.5 8 8s-8 4-8 8M16 4c0 4-8 4.5-8 8s8 4 8 8"/>'),
  data: svg('<ellipse cx="12" cy="6.5" rx="7" ry="2.5"/><path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>'),
  bell: svg('<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5h-14z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  key: svg('<circle cx="8" cy="14" r="3.5"/><path d="M10.5 11.5 18 4l2 2M15.5 6.5l2 2"/>'),
  at: svg('<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"/>'),
  slash: svg('<path d="M15 4.5 9 19.5"/>'),
  terminal: svg('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m7.5 10 2.5 2.5-2.5 2.5M12.5 15h4"/>'),
  team: svg('<circle cx="8" cy="8.5" r="2.6"/><circle cx="16.5" cy="9.5" r="2.1"/><path d="M3.5 18.5c.4-3 2.3-4.8 4.5-4.8s4.1 1.8 4.5 4.8M13 17.8c.4-2.2 1.8-3.5 3.5-3.5s3.1 1.3 3.5 3.5"/>'),
  shield: svg('<path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/><path d="M12 8.5v4.5"/><circle cx="12" cy="15.8" r=".5" fill="currentColor"/>'),
  hook: svg('<path d="M9 4.5v9a4 4 0 0 0 8 0v-2"/><path d="M15 13l2-2 2 2"/><circle cx="9" cy="4.5" r="1.2"/>'),
  plug: svg('<path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5v4"/>'),
  chart: svg('<path d="M4 19.5h16"/><path d="M7 16.5v-4M11 16.5V8M15 16.5v-6M19 16.5V5.5"/>'),
  repeat: svg('<path d="M5 11V9.5a3 3 0 0 1 3-3h10"/><path d="m15.5 3.5 3 3-3 3"/><path d="M19 13v1.5a3 3 0 0 1-3 3H6"/><path d="m8.5 20.5-3-3 3-3"/>'),
  book: svg('<path d="M5 5.5A2 2 0 0 1 7 3.5h11.5v14H7a2 2 0 0 0-2 2z"/><path d="M5 19.5a2 2 0 0 0 2 2h11.5v-4"/><path d="M9 7.5h6"/>'),
  agents: svg('<circle cx="12" cy="6" r="2.3"/><circle cx="5.5" cy="17" r="2.3"/><circle cx="18.5" cy="17" r="2.3"/><path d="M10.9 8 6.7 15M13.1 8l4.2 7M7.8 17h8.4"/>'),
  sparkle: svg('<path d="M12 3.5 13.8 10 20.5 12l-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2z"/>', { sw: 1.4 }),
  prompt: svg('<path d="M5 4.5h14v15H5z"/><path d="m8 9 2.5 2L8 13M12.5 14.5H16"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z"/>'),
  todo: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 2.5 2.5L16 9"/>'),
  eye: svg('<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3.2"/>'),
  wand: svg('<path d="M4.5 19.5 15 9"/><path d="m13.5 7.5 3 3"/><path d="M17.5 3.5v3M16 5h3M20 9.5v2M19 10.5h2"/>'),
  compress: svg('<path d="M9 4.5v4.5H4.5M15 4.5v4.5h4.5M9 19.5V15H4.5M15 19.5V15h4.5"/>'),
  user: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.8 3.4-6 7-6s6.4 2.2 7 6"/>'),
};

// ---------- role emblems: Athena's owl (GPT), Hephaestus' hammer (WorkBuddy), the crescent (you), Themis' scales (reviewer) ----------
export const EMBLEM = {
  gpt: svg('<path d="M5.3 4.4 8 7.2h8l2.7-2.8v9.1a6.7 6.7 0 0 1-13.4 0z"/><circle cx="9.3" cy="11.3" r="2.45"/><circle cx="14.7" cy="11.3" r="2.45"/><circle cx="9.3" cy="11.3" r=".95" fill="currentColor" stroke="none"/><circle cx="14.7" cy="11.3" r=".95" fill="currentColor" stroke="none"/><path d="M11.3 14.2 12 15.5l.7-1.3"/><path d="M8.5 21.4h7"/>', { sw: 1.45 }),
  wb: svg('<path d="M13.2 3 21 10.8 17.8 14 10 6.2z"/><path d="M15.6 8.4l-1.6-1.6"/><path d="M13.9 10.1 4.3 19.7"/>', { sw: 1.5 }),
  user: svg('<path d="M15.6 4A8.3 8.3 0 1 0 20.1 15.6 6.8 6.8 0 0 1 15.6 4z"/><path d="M18.8 4.2v2.4M17.6 5.4H20"/>', { sw: 1.45 }),
  rev: svg('<path d="M12 4.8V20.2M8.6 20.2h6.8M5.2 7.4h13.6"/><path d="M5.2 7.4 2.9 12.8M5.2 7.4l2.3 5.4M2.6 12.8a2.6 2.6 0 0 0 5.2 0z"/><path d="M18.8 7.4l-2.3 5.4M18.8 7.4l2.3 5.4M16.2 12.8a2.6 2.6 0 0 0 5.2 0z"/><circle cx="12" cy="4.2" r=".9" fill="currentColor"/>', { sw: 1.35 }),
};

// template icons: a temple for new projects, Zeus' thunderbolt for performance, a shield for tests, Argus' eye for reviews
export const TEMPLATE_ICON = {
  feature: svg('<path d="M12 3.5 13.8 10 20.5 12l-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2z"/>', { sw: 1.4 }),
  bugfix: svg('<path d="M14.8 5.2a4 4 0 0 0-4.9 5.1l-5.6 5.6a1.8 1.8 0 0 0 2.6 2.6l5.6-5.6a4 4 0 0 0 5.1-4.9l-2.5 2.5-2.2-.6-.6-2.2z"/>', { sw: 1.4 }),
  'new-project': svg('<path d="M3.5 9 12 4.5 20.5 9z"/><path d="M5 9.5v8M9.7 9.5v8M14.3 9.5v8M19 9.5v8"/><path d="M3.5 17.5h17M2.5 20h19"/>', { sw: 1.35 }),
  refactor: svg('<path d="M5.5 10a6.5 6.5 0 0 1 11.6-3.4L19 8.5"/><path d="M19 4.5v4h-4"/><path d="M18.5 14a6.5 6.5 0 0 1-11.6 3.4L5 15.5"/><path d="M5 19.5v-4h4"/>', { sw: 1.4 }),
  perf: svg('<path d="M13.6 2.8 5.8 13.6h5.6l-1.6 7.6 8.4-11.6h-5.8z"/>', { sw: 1.4 }),
  tests: svg('<path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/><path d="M8.8 11.8l2.3 2.3 4.2-4.4"/>', { sw: 1.4 }),
  review: svg('<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="1" fill="currentColor"/>', { sw: 1.4 }),
  init: svg('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 15.5h6"/>', { sw: 1.4 }),
  security: svg('<path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z"/><circle cx="11.3" cy="11" r="2.4"/><path d="m13.1 12.8 2.4 2.4"/>', { sw: 1.4 }),
  // an open scroll with a lens: reading many sources
  deepresearch: svg('<path d="M4.5 5.5h9.5v13H6.5a2 2 0 0 1-2-2z"/><path d="M7.5 9h4M7.5 12h3"/><circle cx="16.6" cy="14.6" r="3.1"/><path d="m18.9 16.9 2.3 2.3"/>', { sw: 1.4 }),
  'team-docs': svg('<circle cx="7" cy="8" r="2.4"/><circle cx="17" cy="8" r="2.4"/><circle cx="12" cy="16.5" r="2.4"/><path d="M9 9.5 10.6 14.6M15 9.5l-1.6 5.1M9.4 8h5.2"/>', { sw: 1.4 }),
  custom: ICON.scroll,
};

// the ornament above the home title: a crescent, a star on each side and fading lines
export const ORNAMENT = `<svg viewBox="0 0 64 22" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
  <path d="M3 11h17M44 11h17" stroke-width=".8" opacity=".55"/>
  <path d="M34.2 4.6a6.8 6.8 0 1 0 3.9 9.6 5.4 5.4 0 0 1-3.9-9.6z" stroke-width="1.2" fill="currentColor" fill-opacity=".12"/>
  <path d="M25 9.2v3.6M23.2 11h3.6M41.6 8.6v2.4M40.4 9.8h2.4" stroke-width=".9"/>
</svg>`;

/** A laurel wreath: two branches of leaves along curves, joined at the bottom */
function laurelSvg() {
  const leaf = (x, y, angle, side) => {
    const a = angle + side * 0.95;
    const len = 5.4;
    const w = 2.1;
    const tx = x + Math.cos(a) * len;
    const ty = y + Math.sin(a) * len;
    const nx = -Math.sin(a) * w;
    const ny = Math.cos(a) * w;
    const mx = (x + tx) / 2;
    const my = (y + ty) / 2;
    return `<path d="M${x.toFixed(2)} ${y.toFixed(2)}Q${(mx + nx).toFixed(2)} ${(my + ny).toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)}Q${(mx - nx).toFixed(2)} ${(my - ny).toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)}Z"/>`;
  };
  const branch = (p0, p1, p2, p3) => {
    let out = `<path d="M${p0.join(' ')}C${p1.join(' ')} ${p2.join(' ')} ${p3.join(' ')}" fill="none"/>`;
    for (let i = 1; i <= 7; i++) {
      const t = 0.1 + i * 0.12;
      const u = 1 - t;
      const x = u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0];
      const y = u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1];
      const dx = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
      const dy = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
      const ang = Math.atan2(dy, dx);
      out += leaf(x, y, ang, -1) + leaf(x, y, ang, 1);
    }
    return out;
  };
  return `<svg viewBox="0 0 64 40" stroke="currentColor" stroke-width="1" fill="currentColor" fill-opacity=".18" stroke-linejoin="round" aria-hidden="true">
    ${branch([30, 37], [16, 35], [8, 25], [7, 8])}
    ${branch([34, 37], [48, 35], [56, 25], [57, 8])}
    <path d="M29 37.5q3-2.2 6 0" fill="none"/>
  </svg>`;
}
export const LAUREL = laurelSvg();

// small status glyphs
export function statusGlyph(status) {
  if (['running', 'waiting', 'queued', 'waiting_user'].includes(status)) return '<span class="pip"></span>';
  if (status === 'done') return ICON.check;
  if (status === 'failed') return ICON.x;
  if (status === 'paused' || status === 'interrupted') return ICON.pause;
  if (status === 'stopped') return ICON.stop;
  return '<span class="pip"></span>';
}
