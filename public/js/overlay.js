// Dialogs, popovers, confirmations, the command palette.
import { $, $$, el, esc } from './core.js';
import { ICON } from './brand.js';
import { t } from './i18n.js';

let modalOnClose = null;

/** Opens a dialog and returns its body element. size: narrow (default) | mid | wide | tabs */
export function openModal(title, html, { size = 'narrow', subtitle = '', foot = '', onClose = null } = {}) {
  closePopover();
  modalOnClose?.();
  modalOnClose = onClose;
  $('#modal-title').textContent = title;
  $('#modal-subtitle').textContent = subtitle;
  $('#modal-body').innerHTML = html;
  const f = $('#modal-foot');
  f.innerHTML = foot;
  f.classList.toggle('hidden', !foot);
  const card = $('.modal-card');
  card.className = `modal-card ${size === 'wide' ? '' : size}`;
  $('#modal').classList.remove('hidden');
  return $('#modal-body');
}

export function closeModal() {
  if ($('#modal').classList.contains('hidden')) return;
  $('#modal').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  $('#modal-foot').innerHTML = '';
  const cb = modalOnClose;
  modalOnClose = null;
  cb?.();
}

export function modalOpen() {
  return !$('#modal').classList.contains('hidden');
}

$('#modal-close').innerHTML = ICON.close;
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') closeModal();
});
$('#modal').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeModal();
});

/** Replaces the browser's confirm(): Promise<boolean> */
export function confirmDialog({ title, text = '', ok = t('common.ok'), cancel = t('common.cancel'), danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v) => {
      if (answered) return;
      answered = true;
      resolve(v);
    };
    openModal(title, text ? `<p class="muted" style="margin:0;line-height:1.75">${text}</p>` : '', {
      foot: `<span class="note"></span><button class="btn" type="button" data-close>${esc(cancel)}</button><button class="btn ${danger ? 'danger primary' : 'primary'}" type="button" id="confirm-ok">${esc(ok)}</button>`,
      onClose: () => answer(false),
    });
    const btn = $('#confirm-ok');
    btn.onclick = () => {
      answer(true);
      closeModal();
    };
    setTimeout(() => btn.focus(), 30);
  });
}

// ---------- popovers (menus, plan, time picker) ----------
let popAnchor = null;

export function openPopover(anchor, html, { align = 'right', className = '' } = {}) {
  const pop = $('#popover');
  pop.onclick = null;
  pop.className = `popover ${className}`;
  pop.innerHTML = html;
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  pop.style.left = '';
  pop.style.right = '';
  pop.style.maxHeight = '';
  if (align === 'left') pop.style.left = `${Math.max(8, Math.round(r.left))}px`;
  else pop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  // below the anchor when it fits, else on the roomier side, shortened to fit the window
  const h = pop.offsetHeight;
  const below = window.innerHeight - r.bottom - 14;
  const above = r.top - 14;
  if (h <= below || below >= above) {
    if (h > below) pop.style.maxHeight = `${Math.max(120, Math.round(below))}px`;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
  } else {
    if (h > above) pop.style.maxHeight = `${Math.round(above)}px`;
    pop.style.top = `${Math.round(r.top - 6 - Math.min(h, above))}px`;
  }
  popAnchor = anchor;
  return pop;
}

export function closePopover() {
  $('#popover').classList.add('hidden');
  popAnchor = null;
}

export function popoverOpen() {
  return !$('#popover').classList.contains('hidden');
}

document.addEventListener('mousedown', (e) => {
  if (popoverOpen() && !$('#popover').contains(e.target) && !popAnchor?.contains(e.target)) closePopover();
});

export const menuItem = ({ act, icon, label, danger, kbd, desc, checked, attrs = '' }) => `<button class="menu-item${danger ? ' danger' : ''}${checked ? ' checked' : ''}" type="button" ${act ? `data-act="${esc(act)}"` : ''} ${attrs}>${icon ? ICON[icon] || icon : ''}<span>${esc(label)}</span>${kbd ? `<span class="kbd">${esc(kbd)}</span>` : desc ? `<span class="desc">${esc(desc)}</span>` : ''}</button>`;

// ---------- fuzzy matching: characters in order; runs and word starts score higher ----------
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 1;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct;
  let score = 0;
  let pos = -1;
  let streak = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, pos + 1);
    if (next < 0) return 0;
    streak = next === pos + 1 ? streak + 1 : 0;
    score += 10 + streak * 6 - Math.min(9, next - pos);
    pos = next;
  }
  return score;
}

// ---------- command palette (⌘K) ----------
let palette = null;

/** items：[{ group, icon, title, keys?, hint?, kbd?, run }] */
export function openPalette(getItems, { placeholder = t('palette.placeholder') } = {}) {
  closePalette();
  const wrap = el(`<div class="palette-wrap">
    <div class="palette" role="dialog" aria-label="${esc(t('palette.title'))}">
      <div class="palette-input">${ICON.search}<input type="search" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"></div>
      <div class="palette-list"></div>
      <div class="palette-foot"><span>${esc(t('palette.select'))}</span><span>${esc(t('palette.run'))}</span><span>${esc(t('palette.close'))}</span></div>
    </div></div>`);
  document.body.appendChild(wrap);
  const input = $('input', wrap);
  const list = $('.palette-list', wrap);
  let shown = [];
  let index = 0;
  const all = getItems();
  const render = () => {
    const q = input.value.trim();
    shown = all
      .map((it) => ({ it, s: fuzzyScore(q, `${it.title} ${it.keys || ''} ${it.hint || ''}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .map((x) => x.it)
      .slice(0, 60);
    index = Math.min(index, Math.max(0, shown.length - 1));
    let group = '';
    list.innerHTML = shown.map((it, i) => {
      const head = !q && it.group !== group ? `<div class="menu-label">${esc(it.group)}</div>` : '';
      group = it.group;
      return `${head}<button class="menu-item${i === index ? ' on' : ''}" type="button" data-i="${i}">${it.icon ? ICON[it.icon] || it.icon : ''}<span>${esc(it.title)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : it.hint ? `<span class="desc">${esc(it.hint)}</span>` : ''}</button>`;
    }).join('') || `<div class="suggest-empty">${esc(t('palette.empty'))}</div>`;
    $('.menu-item.on', list)?.scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => {
    const it = shown[i];
    if (!it) return;
    closePalette();
    it.run();
  };
  input.addEventListener('input', () => {
    index = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      index = (index + 1) % Math.max(1, shown.length);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index - 1 + shown.length) % Math.max(1, shown.length);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  });
  list.addEventListener('mousemove', (e) => {
    const b = e.target.closest('[data-i]');
    if (b && Number(b.dataset.i) !== index) {
      index = Number(b.dataset.i);
      $$('.menu-item', list).forEach((x) => x.classList.toggle('on', Number(x.dataset.i) === index));
    }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) run(Number(b.dataset.i));
  });
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) closePalette();
  });
  palette = wrap;
  render();
  setTimeout(() => input.focus(), 10);
}

export function closePalette() {
  palette?.remove();
  palette = null;
}

export function paletteOpen() {
  return Boolean(palette);
}
