// Shared composer features: auto-grow, slash commands, @ file mentions, # sub-agents, >> teammates, ↑↓ input history.
import { $, $$, api, app, el, esc, saveUi } from './core.js';
import { t } from './i18n.js';
import { fuzzyScore } from './overlay.js';

export function autosize(ta, max) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(max, ta.scrollHeight + 2)}px`;
}

// ---------- files of the working directory (cached for 30 s) ----------
const fileCache = new Map();

async function projectFiles(dir) {
  if (!dir) return [];
  const hit = fileCache.get(dir);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  try {
    const r = await api(`/api/fs/files?dir=${encodeURIComponent(dir)}`);
    fileCache.set(dir, { at: Date.now(), files: r.files });
    return r.files;
  } catch {
    return [];
  }
}

function highlight(pathText, query) {
  if (!query) return esc(pathText);
  const q = query.toLowerCase();
  const t = pathText.toLowerCase();
  const at = t.lastIndexOf(q);
  if (at >= 0) return `${esc(pathText.slice(0, at))}<b>${esc(pathText.slice(at, at + q.length))}</b>${esc(pathText.slice(at + q.length))}`;
  return esc(pathText);
}

/**
 * Adds suggestions and history to a textarea.
 * opts.commands(): available slash commands [{ name, label, desc, arg?, keys?, run(arg) }]
 * opts.dir(): working directory for @ file mentions
 * opts.agents(): sub-agents for # mentions [{ id, name, description }]
 * opts.teammates(): teammate names for ">>name message" (Team Mode)
 * opts.historyKey: history group; opts.below: show suggestions below the textarea
 */
export function enhanceComposer(ta, { box, commands = () => [], dir = () => '', agents = () => [], teammates = () => [], historyKey = 'msg', maxHeight = 240, below = false, submit = 'enter', onSubmit = null } = {}) {
  const pop = el(`<div class="suggest hidden${below ? ' below' : ''}" role="listbox"></div>`);
  box.appendChild(pop);
  let mode = null; // 'slash' | 'file' | 'agent' | 'mate'
  let items = [];
  let index = 0;
  let token = null; // @ / # mention: { start, end, query }
  let histPos = -1;
  let draft = '';

  const close = () => {
    mode = null;
    pop.classList.add('hidden');
    pop.innerHTML = '';
  };
  const isOpen = () => Boolean(mode);

  const renderSlash = () => {
    const raw = ta.value.slice(1);
    const name = raw.split(/\s/)[0];
    // arguments started: only this command is suggested
    const hasArgs = /\s/.test(raw);
    const list = hasArgs
      ? commands().filter((c) => c.name === name).map((c) => ({ c, s: 1 }))
      : commands().map((c) => ({ c, s: fuzzyScore(name, `${c.name} ${c.keys || ''} ${c.label}`) })).filter((x) => x.s > 0);
    if (name && !hasArgs) list.sort((a, b) => b.s - a.s);
    items = list.map((x) => x.c);
    if (!items.length) {
      close();
      return;
    }
    index = Math.min(index, items.length - 1);
    pop.innerHTML = `<div class="suggest-head"><span>${esc(t('composer.commands'))}</span><span>${esc(t('composer.tabRun'))}</span></div>${items.map((c, i) => `<div class="suggest-item${i === index ? ' on' : ''}" data-i="${i}"><span class="cmd">/${esc(c.name)}</span>${c.arg ? `<span class="arg">${esc(c.arg)}</span>` : ''}<span class="desc">${esc(c.label)}${c.desc ? ` · ${esc(c.desc)}` : ''}</span></div>`).join('')}`;
    pop.classList.remove('hidden');
    mode = 'slash';
  };

  const renderFiles = async () => {
    const files = await projectFiles(dir());
    if (mode !== 'file' && mode !== 'file-pending') return;
    const q = token.query;
    const scored = files.map((f) => ({ f, s: fuzzyScore(q, f) })).filter((x) => x.s > 0);
    if (q) scored.sort((a, b) => b.s - a.s || a.f.length - b.f.length);
    items = scored.slice(0, 40).map((x) => x.f);
    index = Math.min(index, Math.max(0, items.length - 1));
    pop.innerHTML = `<div class="suggest-head"><span>${esc(dir() ? t('composer.files') : t('composer.filesNoDir'))}</span><span>${esc(t('composer.tabInsert'))}</span></div>${items.map((f, i) => `<div class="suggest-item${i === index ? ' on' : ''}" data-i="${i}"><span class="path">${highlight(f, q)}</span></div>`).join('') || `<div class="suggest-empty">${esc(dir() ? t('composer.noFiles') : t('composer.pickDirFirst'))}</div>`}`;
    pop.classList.remove('hidden');
    mode = 'file';
  };

  const renderAgents = () => {
    const q = token.query;
    const list = agents().map((a) => ({ a, s: fuzzyScore(q, `${a.id} ${a.name} ${a.description || ''}`) })).filter((x) => x.s > 0);
    if (q) list.sort((a, b) => b.s - a.s);
    items = list.slice(0, 30).map((x) => x.a);
    if (!items.length) {
      close();
      return;
    }
    index = Math.min(index, items.length - 1);
    pop.innerHTML = `<div class="suggest-head"><span>${esc(t('composer.agents'))}</span><span>${esc(t('composer.tabInsert'))}</span></div>${items.map((a, i) => `<div class="suggest-item${i === index ? ' on' : ''}" data-i="${i}"><span class="cmd">#${esc(a.id)}</span><span class="desc">${esc(a.name)}${a.description ? ` · ${esc(a.description)}` : ''}</span></div>`).join('')}`;
    pop.classList.remove('hidden');
    mode = 'agent';
  };

  const renderMates = (q) => {
    items = teammates().filter((n) => !q || n.toLowerCase().startsWith(q.toLowerCase()));
    if (!items.length) {
      close();
      return;
    }
    index = Math.min(index, items.length - 1);
    pop.innerHTML = `<div class="suggest-head"><span>${esc(t('composer.mates'))}</span><span>${esc(t('composer.tabInsert'))}</span></div>${items.map((n, i) => `<div class="suggest-item${i === index ? ' on' : ''}" data-i="${i}"><span class="cmd">&gt;&gt;${esc(n)}</span><span class="desc">${esc(t('composer.mateDesc'))}</span></div>`).join('')}`;
    pop.classList.remove('hidden');
    mode = 'mate';
  };

  const mentionToken = (sign) => {
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) return null;
    const before = ta.value.slice(0, caret);
    const re = sign === '@' ? /(^|[\s（(，,。：:；;])@([^\s@`]*)$/ : /(^|[\s（(，,。：:；;])#([\w.-]*)$/;
    const m = before.match(re);
    if (!m) return null;
    return { start: caret - m[2].length - 1, end: caret, query: m[2] };
  };

  const refresh = () => {
    if (ta.value.startsWith('/') && !ta.value.includes('\n') && commands().length) {
      renderSlash();
      return;
    }
    const mate = ta.value.match(/^\s*>>(\S*)$/);
    if (mate && teammates().length) {
      renderMates(mate[1]);
      return;
    }
    token = mentionToken('@');
    if (token) {
      if (mode !== 'file') mode = 'file-pending';
      renderFiles();
      return;
    }
    token = agents().length ? mentionToken('#') : null;
    if (token) {
      renderAgents();
      return;
    }
    close();
  };

  const choose = (i) => {
    if (mode === 'slash') {
      const c = items[i];
      if (!c) return;
      if (c.arg) {
        const rest = ta.value.slice(1).replace(/^\S*\s?/, '');
        ta.value = `/${c.name} ${rest}`;
        ta.setSelectionRange(ta.value.length, ta.value.length);
        close();
        autosize(ta, maxHeight);
        ta.dispatchEvent(new Event('input'));
      } else {
        ta.value = '';
        autosize(ta, maxHeight);
        ta.dispatchEvent(new Event('input'));
        close();
        c.run('');
      }
    } else if (mode === 'file' || mode === 'agent') {
      const v = items[i];
      if (!v || !token) return;
      const insert = mode === 'file' ? `\`${v}\` ` : `#${v.id} `;
      ta.value = ta.value.slice(0, token.start) + insert + ta.value.slice(token.end);
      const pos = token.start + insert.length;
      ta.setSelectionRange(pos, pos);
      close();
      autosize(ta, maxHeight);
      ta.dispatchEvent(new Event('input'));
    } else if (mode === 'mate') {
      const n = items[i];
      if (!n) return;
      ta.value = `>>${n} `;
      ta.setSelectionRange(ta.value.length, ta.value.length);
      close();
      autosize(ta, maxHeight);
      ta.dispatchEvent(new Event('input'));
    }
  };

  pop.addEventListener('mousedown', (e) => {
    const it = e.target.closest('[data-i]');
    if (!it) return;
    e.preventDefault();
    choose(Number(it.dataset.i));
  });

  ta.addEventListener('input', () => {
    // a Chinese IME turns "/" into "、" (or "／"): a leading one counts as a slash
    if (/^[、／]/.test(ta.value)) {
      const pos = ta.selectionStart;
      ta.value = `/${ta.value.slice(1)}`;
      ta.setSelectionRange(pos, pos);
    }
    histPos = -1;
    refresh();
  });
  ta.addEventListener('click', refresh);
  ta.addEventListener('blur', () => setTimeout(close, 120));

  const send = (alt) => {
    const text = ta.value.trim();
    if (!text) return;
    close();
    onSubmit?.(text, { alt });
  };

  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (isOpen() && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        $$('.suggest-item', pop).forEach((x) => x.classList.toggle('on', Number(x.dataset.i) === index));
        $('.suggest-item.on', pop)?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey)) {
        // a slash command with arguments: Enter runs it
        if (!(mode === 'slash' && e.key === 'Enter' && /\s\S/.test(ta.value.slice(1)))) {
          e.preventDefault();
          e.stopImmediatePropagation();
          choose(index);
          return;
        }
      }
    }
    if (isOpen() && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    // input history: ↑↓ when the box is empty (or while browsing)
    const hist = app.ui.history?.[historyKey] || [];
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && hist.length) {
      const browsing = histPos >= 0;
      if (!browsing && (e.key === 'ArrowDown' || ta.value.trim())) return;
      if (browsing && ta.value !== hist[hist.length - 1 - histPos]) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!browsing) draft = ta.value;
      const next = histPos + (e.key === 'ArrowUp' ? 1 : -1);
      if (next >= hist.length) return;
      histPos = next;
      ta.value = histPos < 0 ? draft : hist[hist.length - 1 - histPos];
      ta.setSelectionRange(ta.value.length, ta.value.length);
      autosize(ta, maxHeight);
      ta.dispatchEvent(new CustomEvent('history'));
      return;
    }
    if (e.key === 'Enter' && onSubmit) {
      const mod = e.metaKey || e.ctrlKey;
      if (submit === 'enter' && !e.shiftKey && !mod) {
        e.preventDefault();
        send(e.altKey);
      } else if (submit === 'mod-enter' && mod) {
        e.preventDefault();
        send(false);
      }
    }
  });

  return {
    close,
    isOpen,
    send,
    remember(text) {
      const t = String(text || '').trim();
      if (!t || t.startsWith('/')) return;
      const all = { ...(app.ui.history || {}) };
      const list = (all[historyKey] || []).filter((x) => x !== t);
      list.push(t.slice(0, 4000));
      all[historyKey] = list.slice(-60);
      saveUi({ history: all });
      histPos = -1;
    },
    /** Hands "/command args" to its command; returns false when it isn't one */
    runSlash(text) {
      const m = String(text).match(/^\/(\S+)\s*([\s\S]*)$/);
      if (!m) return false;
      const c = commands().find((x) => x.name === m[1]);
      if (!c) return false;
      c.run(m[2].trim());
      return true;
    },
  };
}
