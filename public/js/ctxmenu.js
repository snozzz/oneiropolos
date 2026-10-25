// Right-click menus. The web view's own menu (Back, Reload, Inspect Element …) never shows: text fields and selected
// text keep the native Cut/Copy/Paste menu, task rows in the sidebar get the app's menu, everything else gets none.
import { $, ACTIVE, actions, api, app, esc, firstLine, toast } from './core.js';
import { t } from './i18n.js';
import { closePopover, confirmDialog, menuItem, openPopover } from './overlay.js';

function nativeMenuWanted(e) {
  const el = e.target;
  if (el.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  const sel = window.getSelection();
  return Boolean(sel && !sel.isCollapsed && String(sel).trim() && sel.containsNode?.(el, true));
}

/** A popover menu at the pointer, kept inside the window. */
export function openMenuAt(x, y, html) {
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }), contains: () => false };
  const pop = openPopover(anchor, html, { align: 'left', className: 'ctx-menu' });
  const r = pop.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) pop.style.left = `${Math.max(8, Math.round(window.innerWidth - r.width - 8))}px`;
  if (r.bottom > window.innerHeight - 8) pop.style.top = `${Math.max(8, Math.round(y - r.height))}px`;
  return pop;
}

function runMenu(r) {
  const active = ACTIVE.has(r.status);
  const items = [
    menuItem({ act: 'pin', icon: 'pin', label: r.pinned ? t('ctx.unpin') : t('ctx.pin') }),
    menuItem({ act: 'rename', icon: 'edit', label: t('ctx.rename') }),
    menuItem({ act: 'finder', icon: 'finder', label: t('run.openInFinder') }),
    menuItem({ act: 'export', icon: 'export', label: t('ctx.export') }),
    '<div class="menu-sep"></div>',
  ];
  if (r.status === 'running' || r.status === 'waiting' || r.status === 'waiting_user') items.push(menuItem({ act: 'pause', icon: 'pause', label: t('run.pause') }));
  if (active && r.status !== 'queued') items.push(menuItem({ act: 'stop', icon: 'stop', label: t('run.stop') }));
  if (['paused', 'stopped', 'interrupted', 'failed'].includes(r.status)) items.push(menuItem({ act: 'resume', icon: 'play', label: t('run.continue') }));
  if (items[items.length - 1] !== '<div class="menu-sep"></div>') items.push('<div class="menu-sep"></div>');
  items.push(menuItem({ act: 'delete', icon: 'trash', label: t('common.delete'), danger: true, attrs: active && r.status !== 'queued' ? `disabled title="${esc(t('ctx.stopFirst'))}"` : '' }));
  return items.join('');
}

async function runMenuAction(act, r) {
  const base = `/api/runs/${r.id}`;
  if (act === 'pin') {
    await api(base, { method: 'PATCH', body: { pinned: !r.pinned } });
  } else if (act === 'rename') {
    startRename(r);
    return;
  } else if (act === 'finder') {
    await api('/api/open', { method: 'POST', body: { path: r.workdir } });
    return;
  } else if (act === 'export') {
    const res = await api(`${base}/export`, { method: 'POST', body: {} });
    toast(t('run.exported', { path: res.path.replace(app.env?.home || '\u0000', '~') }), { action: { label: t('run.showInFinder'), run: () => api('/api/reveal', { method: 'POST', body: { path: res.path } }).catch((err) => toast(err.message)) } });
    return;
  } else if (act === 'pause' || act === 'stop' || act === 'resume') {
    await api(`${base}/control`, { method: 'POST', body: { cmd: act } });
  } else if (act === 'delete') {
    if (!(await confirmDialog({ title: t('run.deleteTitle'), text: t('run.deleteText'), ok: t('common.delete'), danger: true }))) return;
    await api(base, { method: 'DELETE' });
    if (app.currentId === r.id) location.hash = '#new';
  }
  await actions.refreshRuns?.();
}

/** Renames in place: the row's title becomes a text field; Enter saves, Esc or leaving the field cancels. */
function startRename(r) {
  const li = $(`.run-item[data-id="${CSS.escape(r.id)}"]`);
  const title = li && $('.title', li);
  if (!title) return;
  app.renaming = r.id;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = r.title || firstLine(r.goal, 120);
  input.spellcheck = false;
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    app.renaming = null;
    const value = input.value.trim();
    if (save && value !== (r.title || firstLine(r.goal, 120))) {
      try {
        // the goal's own first line means "no custom name"
        await api(`/api/runs/${r.id}`, { method: 'PATCH', body: { title: value === firstLine(r.goal, 120) ? '' : value } });
        if (app.state?.id === r.id) app.state.title = value;
      } catch (err) {
        toast(err.message);
      }
    }
    await actions.refreshRuns?.();
    actions.renderHeader?.();
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

export function initContextMenus() {
  document.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('.run-item');
    if (li && !e.target.closest('.rename-input')) {
      e.preventDefault();
      const r = (app.runs || []).find((x) => x.id === li.dataset.id);
      if (!r) return;
      li.classList.add('ctx-on');
      const pop = openMenuAt(e.clientX, e.clientY, runMenu(r));
      const clear = new MutationObserver(() => {
        if (pop.classList.contains('hidden')) {
          li.classList.remove('ctx-on');
          clear.disconnect();
        }
      });
      clear.observe(pop, { attributes: true, attributeFilter: ['class'] });
      pop.onclick = (ev) => {
        const b = ev.target.closest('[data-act]');
        if (!b || b.disabled) return;
        closePopover();
        runMenuAction(b.dataset.act, r).catch((err) => toast(err.message));
      };
      return;
    }
    if (!nativeMenuWanted(e)) e.preventDefault();
  });
}

