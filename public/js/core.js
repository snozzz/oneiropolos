// Shared helpers: DOM, API, formatting, Markdown, global state.
import { fmtDuration, locale, t } from './i18n.js';

export { fmtDuration };
export const TOKEN = document.querySelector('meta[name="wbloop-token"]').content;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const native = window.oneiropolos || window.webkit?.messageHandlers?.wbloop || null;
if (native) document.documentElement.classList.add('native');

// a value the dictionary doesn't know (e.g. a new reasoning level) is shown as it is, not as a raw key
const tKnown = (k, raw) => {
  const v = t(k);
  return v === k ? String(raw ?? '') : v;
};
export const tStatus = (s) => tKnown(`status.${s}`, s);
export const tPhase = (p) => tKnown(`phase.${p}`, p);
export const tVerdict = (v) => tKnown(`verdict.${v}`, v);
export const tSeverity = (s) => tKnown(`severity.${s}`, s);
export const tEffort = (e) => tKnown(`effort.${e}`, e);
export const EFFORTS_KNOWN = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'off']);
export const ACTIVE = new Set(['running', 'waiting', 'paused', 'waiting_user', 'queued']);

/** A server message: { key, params } re-rendered in the current language, otherwise the stored text. */
export const msgText = (o, field = 'message') => (o?.[`${field}Key`] ? t(o[`${field}Key`], o[`${field}Params`] || undefined) : o?.key ? t(o.key, o.params || undefined) : o?.[field] ?? '');

// global state
export const app = {
  env: null,
  quota: null,
  runs: [],
  currentId: null,
  state: null,
  es: null,
  caughtUp: false,
  expanded: new Set(),
  t: null,
  templates: { builtin: [], custom: [] },
  ui: {},
  newSettings: null,
  newDir: '',
  newStartAt: '',
  commands: [],
  skills: [],
};

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-wbloop-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** The toast at the bottom, optionally with a button (e.g. "Show in Finder"). */
export function toast(text, { ms = 2800, action = null } = {}) {
  const box = $('#toast');
  box.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="btn sm" type="button">${esc(action.label)}</button>` : ''}`;
  box.classList.toggle('has-btn', Boolean(action));
  box.classList.remove('hidden');
  if (action) {
    $('button', box).onclick = () => {
      box.classList.add('hidden');
      action.run();
    };
  }
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.add('hidden'), action ? Math.max(ms, 6000) : ms);
}

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ---------- formatting ----------
const hm = (d) => d.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit' });

export function fmtTime(iso) {
  return iso ? hm(new Date(iso)) : '';
}

/** Today only the time; tomorrow "tomorrow HH:MM"; otherwise a date. */
export function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return hm(d);
  if (d.toDateString() === new Date(today.getTime() + 86400000).toDateString()) return t('time.tomorrow', { time: hm(d) });
  return `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${hm(d)}`;
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return t('time.minAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('time.hAgo', { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 7) return t('time.dAgo', { n: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString(locale);
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// like the WorkBuddy desktop app: 300000 → 300K, 1000000 → 1M
export function fmtCtx(n) {
  if (!n) return '';
  if (n >= 1e6 && n % 1e6 === 0) return `${n / 1e6}M`;
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}K`;
  return String(n);
}

export function fmtNum(n) {
  return String(Number(Number(n).toFixed(3)));
}

export function oneLine(s, max = 200) {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

export function firstLine(s, max = 90) {
  const line = String(s ?? '').split('\n').find((l) => l.trim()) || '';
  return oneLine(line, max);
}

export function shortPath(p) {
  const home = app.env?.home;
  return home && p && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p || '';
}

export function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(base?.[k]) && isPlainObject(v) ? merge(base[k], v) : v;
  }
  return out;
}

// ---------- minimal Markdown ----------
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
export { inline as mdInline };

function mdBlocks(text) {
  let out = '';
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out += `<p>${para.map(inline).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) out += `<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`;
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      flushPara();
      flushList();
      out += `<h4>${inline(m[1])}</h4>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = line.match(/^\s*\d+[.)、]\s*(.*)$/))) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(m[1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out;
}

export function md(src) {
  const parts = String(src ?? '').replace(/\r\n/g, '\n').split('```');
  return parts.map((part, i) => {
    if (i % 2 === 0) return mdBlocks(part);
    const nl = part.indexOf('\n');
    const code = nl >= 0 && /^[\w+#.-]*$/.test(part.slice(0, nl).trim()) ? part.slice(nl + 1) : part;
    return `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
  }).join('');
}

export function collapsible(html, key) {
  const open = app.expanded.has(key) ? ' open' : '';
  return `<div class="md collapsible${open}" data-key="${esc(key)}">${html}</div><button class="more" type="button" data-toggle="${esc(key)}">${open ? t('ui.collapse') : t('ui.expand')}</button>`;
}

export function fixCollapsibles(root) {
  // a timer instead of requestAnimationFrame: WebKit pauses animation frames while the window is in the background
  setTimeout(() => {
    root.querySelectorAll('.collapsible').forEach((box) => {
      const btn = box.nextElementSibling;
      if (box.scrollHeight <= 260 && !box.classList.contains('open')) {
        box.classList.add('open', 'short');
        if (btn?.classList.contains('more')) btn.classList.add('hidden');
      }
    });
  }, 0);
}

// ---------- appearance ----------
export function applyTheme(theme) {
  const v = theme === 'light' || theme === 'dark' ? theme : 'system';
  document.documentElement.dataset.theme = v;
  native?.postMessage({ type: 'theme', value: v });
}

// ---------- the native shell ----------
const nativeCallbacks = new Map();
window.addEventListener('message', (event) => {
  if (event.source === window && event.origin === location.origin && event.data?.source === 'oneiropolos-native') window.__wbloopNative.resolve(event.data.id, event.data.value);
});
window.__wbloopNative = {
  resolve(id, value) {
    const cb = nativeCallbacks.get(id);
    nativeCallbacks.delete(id);
    cb?.(value);
  },
};

export function nativeCall(type, payload = {}) {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    nativeCallbacks.set(id, resolve);
    native.postMessage({ type, id, ...payload });
  });
}

// ---------- UI preferences (kept on the server: the app gets a new port on every start, browser storage won't last) ----------
export async function loadUi() {
  try {
    app.ui = await api('/api/ui-state');
  } catch {
    app.ui = {};
  }
  return app.ui;
}

let uiTimer = null;
let uiPending = {};
export function saveUi(patch) {
  Object.assign(app.ui, patch);
  Object.assign(uiPending, patch);
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const body = uiPending;
    uiPending = {};
    api('/api/ui-state', { method: 'PUT', body }).catch(() => {});
  }, 400);
}

// ---------- cross-module actions: the palette, slash commands and menus call through here ----------
export const actions = {};

export function copyText(text) {
  const done = () => toast(t('ui.copied'));
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = el('<textarea style="position:fixed;left:-9999px;top:0"></textarea>');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    toast(t('ui.copyFailed'));
  }
  ta.remove();
}

/** Two-step confirmation inside a button (the first click arms it), without leaving the current dialog. */
export function armButton(btn, armedText, run) {
  const original = btn.innerHTML;
  btn.onclick = async () => {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = armedText;
      btn.classList.add('danger');
      setTimeout(() => {
        if (!btn.isConnected || !btn.dataset.armed) return;
        delete btn.dataset.armed;
        btn.innerHTML = original;
        btn.classList.remove('danger');
      }, 4000);
      return;
    }
    delete btn.dataset.armed;
    btn.disabled = true;
    try {
      await run();
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.innerHTML = original;
        btn.classList.remove('danger');
      }
    }
  };
}
