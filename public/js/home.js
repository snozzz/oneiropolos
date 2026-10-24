// Home: write the goal, pick the directory, settings, team and mode, templates, tasks in progress.
import { $, ACTIVE, actions, api, app, esc, firstLine, fmtRelative, merge, native, nativeCall, shortPath, tPhase, tStatus, toast } from './core.js';
import { ICON, ORNAMENT, TEMPLATE_ICON, pickQuote } from './brand.js';
import { autosize, enhanceComposer } from './composer.js';
import { t } from './i18n.js';
import { tailPath } from './thread.js';
import { TASK_MODES, TEAM_MODES, mountSettingsForm, openSchedulePopover, readSettingsForm, scheduleLabel, settingsSummary, wbModel } from './forms.js';
import { closeModal, closePopover, confirmDialog, menuItem, openModal, openPopover } from './overlay.js';
import { expandInjections } from './tools.js';

const goalEl = $('#f-goal');
const maxGoalHeight = () => window.innerHeight * 0.46;
let composer = null;
let tplApplied = '';
let placeholderAck = '';

export function pickRunSettings(cfg) {
  // without a chosen GPT model use the account's default, so the UI can show a concrete name
  return {
    codex: { ...cfg.codex, model: cfg.codex.model || app.env?.codex.defaultModel || '' },
    workbuddy: { ...cfg.workbuddy },
    loop: { ...cfg.loop },
    team: { ...cfg.team },
    agents: { ...cfg.agents },
    safety: { ...cfg.safety },
  };
}

export function renderHero() {
  const q = pickQuote();
  $('#hero-orn').innerHTML = ORNAMENT;
  const quote = $('#hero-quote');
  // long lines break at sentence ends so words aren't split across lines
  const lines = q.text.length > 16 ? q.text.split(/(?<=[。；！？])|(?<=[.;!?—…])\s+(?=\S)/).filter(Boolean) : [q.text];
  quote.innerHTML = lines.map((l) => `<span class="ln">${esc(l)}</span>`).join('');
  quote.classList.toggle('long', lines.some((l) => l.length > 15));
  $('#hero-src').innerHTML = `— ${esc(q.src)}${q.gloss ? `<span class="gloss">${esc(q.gloss)}</span>` : ''}`;
  $('#hero-lede').textContent = t('home.lede');
}

export function updateHomeChips() {
  $('#dir-label').textContent = app.newDir ? shortPath(app.newDir) : t('home.pickDir');
  $('#btn-pick').classList.toggle('set', Boolean(app.newDir));
  $('#btn-pick').title = app.newDir || t('home.pickDirTitle');
  const st = app.newSettings;
  if (st) {
    $('#params-label').textContent = `${st.codex.model || 'GPT'} · ${wbModel(st.workbuddy.model || 'auto').name}`;
    $('#btn-params').title = settingsSummary(st);
    const team = st.team?.mode || 'off';
    $('#team-label').textContent = team === 'off' ? t('home.teamOff') : TEAM_MODES().find(([v]) => v === team)?.[1];
    $('#btn-team').classList.toggle('accent', team !== 'off');
    const mode = st.agents?.mode || 'normal';
    $('#mode-label').textContent = TASK_MODES().find(([v]) => v === mode)?.[1] || mode;
    $('#btn-mode').classList.toggle('accent', mode !== 'normal');
  }
  if (app.newStartAt && Date.parse(app.newStartAt) <= Date.now()) app.newStartAt = '';
  $('#schedule-label').textContent = scheduleLabel(app.newStartAt);
  $('#btn-schedule').classList.toggle('accent', Boolean(app.newStartAt));
}

export function renderRecentDirs() {
  const dirs = [...new Set(app.runs.map((r) => r.workdir))].filter((d) => d !== app.newDir).slice(0, 5);
  $('#recent-dirs').innerHTML = dirs.length ? `<span>${esc(t('home.recentDirs'))}</span>${dirs.map((d) => `<button type="button" data-dir="${esc(d)}" title="${esc(d)}">${esc(d.split('/').slice(-2).join('/'))}</button>`).join('')}` : '';
}

export function renderActiveOnHome() {
  const active = app.runs.filter((r) => ACTIVE.has(r.status));
  $('#home-active').classList.toggle('hidden', !active.length);
  $('#active-list').innerHTML = active.map((r) => {
    const what = r.status === 'running' ? tPhase(r.phase) : r.scheduledAt && r.status === 'waiting' ? t('home.waitingSchedule') : tStatus(r.status);
    return `<div class="active-card" data-id="${esc(r.id)}">
      <span class="sglyph ${esc(r.status)}"><span class="pip"></span></span>
      <div class="t"><div class="t1">${r.team !== 'off' ? `<span class="mini-badge">${ICON.team}</span>` : ''}${esc(firstLine(r.goal, 80))}</div><div class="t2">${esc(what)} · ${esc(t('home.roundOf', { n: r.round, max: r.maxRounds ?? '?' }))} · <span title="${esc(r.workdir)}">${esc(tailPath(r.workdir))}</span> · ${esc(fmtRelative(r.updatedAt))}</div></div>
      <div class="bar" title="${esc(t('home.progress', { n: r.progress ?? 0 }))}"><i style="width:${Math.max(0, Math.min(100, r.progress || 0))}%"></i></div>
    </div>`;
  }).join('');
}

$('#active-list').addEventListener('click', (e) => {
  const c = e.target.closest('[data-id]');
  if (c) location.hash = `#run/${c.dataset.id}`;
});

$('#recent-dirs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dir]');
  if (!b) return;
  app.newDir = b.dataset.dir;
  updateHomeChips();
  renderRecentDirs();
});

// ---------- working directory ----------
function pickFolderModal() {
  let current = app.newDir || app.env?.home || '';
  const body = openModal(t('home.pickDir'), '<div id="dir-picker"></div>', {
    subtitle: t('home.pickDirSubtitle'),
    foot: `<span class="note"></span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="dir-choose">${esc(t('home.chooseThisDir'))}</button>`,
  });
  $('#dir-choose').onclick = () => {
    app.newDir = current;
    updateHomeChips();
    renderRecentDirs();
    closeModal();
  };
  const render = async (p) => {
    try {
      const data = await api(`/api/fs/list?path=${encodeURIComponent(p)}`);
      current = data.path;
      $('#dir-picker', body).innerHTML = `
        <div class="dir-path mono">${esc(data.path)}</div>
        <div class="dir-list">${data.parent ? `<div data-go="..">↑ ${esc(t('home.parentDir'))}</div>` : ''}${data.dirs.map((d) => `<div data-go="${esc(d)}">${esc(d)}/</div>`).join('') || `<div class="muted">${esc(t('home.noSubdirs'))}</div>`}</div>`;
      $('#dir-picker', body).querySelectorAll('[data-go]').forEach((node) => {
        node.onclick = () => render(node.dataset.go === '..' ? data.parent : `${data.path.replace(/\/$/, '')}/${node.dataset.go}`);
      });
    } catch (err) {
      $('#dir-picker', body).innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  };
  render(current);
}

export async function pickFolder() {
  if (native) {
    const p = await nativeCall('pickFolder', { start: app.newDir || '' });
    if (p) {
      app.newDir = p;
      updateHomeChips();
      renderRecentDirs();
    }
  } else {
    pickFolderModal();
  }
}
$('#btn-pick').onclick = pickFolder;

// ---------- settings for this task ----------
export function openParams() {
  if (!app.env) return;
  const st = app.newSettings || pickRunSettings(app.env.config);
  const body = openModal(t('home.paramsTitle'), '<div class="form" id="f-form"></div>', {
    subtitle: t('home.paramsSubtitle'),
    size: 'mid',
    foot: `<label class="check note"><input type="checkbox" id="f-save-default"><span>${esc(t('home.saveAsDefault'))}</span></label><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="f-ok">${esc(t('common.ok'))}</button>`,
  });
  mountSettingsForm($('#f-form', body), 'f', st, { perm: true, autonomy: true });
  $('#f-ok').onclick = async () => {
    const picked = readSettingsForm($('#f-form', body), 'f');
    app.newSettings = merge(st, picked);
    try {
      if ($('#f-save-default').checked) {
        await api('/api/config', { method: 'PUT', body: picked });
        actions.refreshEnv?.();
      }
    } catch (err) {
      toast(err.message);
    }
    updateHomeChips();
    closeModal();
  };
}
$('#btn-params').onclick = openParams;

function ensureNewSettings() {
  if (!app.newSettings && app.env) app.newSettings = pickRunSettings(app.env.config);
  return app.newSettings;
}

export function setNewTeam(mode) {
  const st = ensureNewSettings();
  if (!st) return;
  st.team = { ...(st.team || {}), mode };
  updateHomeChips();
}

export function setNewMode(mode) {
  const st = ensureNewSettings();
  if (!st) return;
  st.agents = { ...(st.agents || {}), mode };
  updateHomeChips();
}

$('#btn-team').onclick = (e) => {
  const cur = ensureNewSettings()?.team?.mode || 'off';
  const pop = openPopover(e.currentTarget, `<div class="menu-label">${esc(t('home.teamTitle'))}</div>
    ${TEAM_MODES().map(([v, label]) => menuItem({ act: v, label, checked: v === cur, attrs: '' })).join('')}
    <div class="hint" style="padding:2px 11px 8px;margin:0;max-width:330px">${esc(t('home.teamHint'))}</div>`, { align: 'left' });
  pop.onclick = (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    closePopover();
    setNewTeam(b.dataset.act);
  };
};

$('#btn-mode').onclick = (e) => {
  const cur = ensureNewSettings()?.agents?.mode || 'normal';
  const hints = { normal: t('mode.normalHint'), plan: t('mode.planHint'), vuln: t('mode.vulnHint') };
  const pop = openPopover(e.currentTarget, `<div class="menu-label">${esc(t('home.modeTitle'))}</div>
    ${TASK_MODES().map(([v, label]) => menuItem({ act: v, label, desc: '', checked: v === cur })).join('')}
    <div class="hint" style="padding:2px 11px 8px;margin:0;max-width:330px">${esc(hints[cur])}</div>`, { align: 'left' });
  pop.onclick = (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    closePopover();
    setNewMode(b.dataset.act);
  };
};

$('#btn-schedule').onclick = (e) => {
  openSchedulePopover(e.currentTarget, {
    current: app.newStartAt,
    modelId: (app.newSettings || app.env?.config)?.workbuddy?.model || 'auto',
    onPick: (iso) => {
      app.newStartAt = iso;
      updateHomeChips();
    },
  });
};

// ---------- templates: placeholders are 【…】 or [[…]]; Tab jumps between them ----------
const PLACEHOLDER_RE = /【[^】\n]*】|\[\[[^\]\n]*\]\]/g;

function placeholderRanges(text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)].map((m) => [m.index, m.index + m[0].length]);
}

function jumpPlaceholder(ta, dir) {
  const list = placeholderRanges(ta.value);
  if (!list.length) return false;
  const target = dir > 0
    ? list.find(([s]) => s >= ta.selectionEnd) || list[0]
    : [...list].reverse().find(([, e]) => e <= ta.selectionStart) || list[list.length - 1];
  ta.focus();
  ta.setSelectionRange(target[0], target[1]);
  const line = ta.value.slice(0, target[0]).split('\n').length;
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
  const y = (line - 1) * lh;
  if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lh * 2) ta.scrollTop = Math.max(0, y - lh * 2);
  return true;
}

export async function loadTemplates() {
  try {
    app.templates = await api('/api/templates');
  } catch {
    return;
  }
  renderTemplates();
}

export function renderTemplates() {
  const { builtin, custom } = app.templates;
  const goal = goalEl.value.trim();
  const card = (tpl, isCustom) => `<button class="tpl-card${isCustom ? ' custom' : ''}${goal && goal === tpl.body.trim() ? ' applied' : ''}" type="button" data-tpl="${esc(tpl.id)}" title="${esc(isCustom ? t('home.myTemplate') : tpl.hint)}">
      <span class="ic">${TEMPLATE_ICON[isCustom ? 'custom' : tpl.id] || TEMPLATE_ICON.custom}</span>
      <span class="nm">${esc(tpl.name)}</span>
      <span class="ht">${esc(isCustom ? firstLine(tpl.body, 40) : tpl.hint)}</span>
      ${isCustom ? `<span class="del" data-del="${esc(tpl.id)}" title="${esc(t('home.deleteTemplate'))}" role="button" aria-label="${esc(t('common.delete'))}">×</span>` : ''}
    </button>`;
  const saveCard = `<button class="tpl-card custom save" type="button" data-save-tpl="1" title="${esc(t('home.saveTemplateTitle'))}">
      <span class="ic">${TEMPLATE_ICON.custom}</span><span class="nm">${esc(t('home.saveTemplate'))}</span><span class="ht">${esc(t('home.saveTemplateHint'))}</span></button>`;
  $('#tpl-list').innerHTML = builtin.map((tpl) => card(tpl, false)).join('') + custom.map((tpl) => card(tpl, true)).join('') + saveCard;
}

export function applyTemplate(tpl) {
  const cur = goalEl.value.trim();
  const go = () => {
    goalEl.value = tpl.body;
    tplApplied = tpl.body.trim();
    placeholderAck = '';
    $('#new-error').textContent = '';
    if (tpl.settings) {
      const st = ensureNewSettings();
      if (st) app.newSettings = merge(st, tpl.settings);
      updateHomeChips();
    }
    autosize(goalEl, maxGoalHeight());
    renderTemplates();
    goalEl.scrollTop = 0;
    goalEl.setSelectionRange(0, 0);
    if (!jumpPlaceholder(goalEl, 1)) goalEl.focus();
  };
  if (cur && cur !== tplApplied && cur !== tpl.body.trim()) {
    confirmDialog({ title: t('home.replaceTitle'), text: t('home.replaceText'), ok: t('home.replace') }).then((yes) => yes && go());
  } else {
    go();
  }
}

/** A template with its first blank filled in (e.g. /deepresearch <topic>); lines with other blanks are dropped. */
export function fillTemplate(tpl, value) {
  let n = 0;
  const filled = tpl.body.replace(PLACEHOLDER_RE, (m) => (n++ === 0 ? value : m));
  const hole = new RegExp(PLACEHOLDER_RE.source);
  const body = filled.split('\n').filter((line) => !hole.test(line)).join('\n').replace(/\n{3,}/g, '\n\n');
  return { ...tpl, body };
}

export function findTemplate(id) {
  return [...app.templates.builtin, ...app.templates.custom].find((x) => x.id === id);
}

$('#tpl-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const tpl = app.templates.custom.find((x) => x.id === del.dataset.del);
    if (!tpl || !(await confirmDialog({ title: t('home.deleteTemplateQ', { name: tpl.name }), ok: t('common.delete'), danger: true }))) return;
    try {
      app.templates = await api(`/api/templates/${tpl.id}`, { method: 'DELETE' });
      renderTemplates();
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (e.target.closest('[data-save-tpl]')) {
    openSaveTemplate();
    return;
  }
  const b = e.target.closest('[data-tpl]');
  if (!b) return;
  const tpl = findTemplate(b.dataset.tpl);
  if (tpl) applyTemplate(tpl);
});

function openSaveTemplate() {
  if (!goalEl.value.trim()) {
    toast(t('home.saveTemplateNeedGoal'));
    return;
  }
  $('#tpl-save').classList.remove('hidden');
  $('#tpl-name').focus();
}
$('#tpl-save-cancel').onclick = () => $('#tpl-save').classList.add('hidden');
$('#tpl-save-ok').onclick = async () => {
  try {
    app.templates = await api('/api/templates', { method: 'POST', body: { name: $('#tpl-name').value, body: goalEl.value } });
    $('#tpl-save').classList.add('hidden');
    $('#tpl-name').value = '';
    renderTemplates();
    toast(t('home.savedTemplate'));
  } catch (err) {
    toast(err.message);
  }
};
$('#tpl-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) $('#tpl-save-ok').click();
  if (e.key === 'Escape') $('#tpl-save').classList.add('hidden');
});

/** Puts text into the goal box (custom commands, generated prompts, skills, TODOs). */
export function insertIntoGoal(text, { replace = false } = {}) {
  if (replace || !goalEl.value.trim()) goalEl.value = text;
  else goalEl.value = `${goalEl.value.replace(/\s+$/, '')}\n\n${text}`;
  autosize(goalEl, maxGoalHeight());
  goalEl.focus();
  goalEl.setSelectionRange(goalEl.value.length, goalEl.value.length);
  if (!jumpPlaceholder(goalEl, 1)) goalEl.scrollTop = goalEl.scrollHeight;
}

export function goalText() {
  return goalEl.value;
}

// ---------- start ----------
export async function startTask() {
  const err = $('#new-error');
  err.textContent = '';
  let goal = goalEl.value.trim();
  if (!goal) {
    err.textContent = t('home.needGoal');
    goalEl.focus();
    return;
  }
  const holes = placeholderRanges(goal).length;
  if (holes && placeholderAck !== goal) {
    placeholderAck = goal;
    err.textContent = t('home.holes', { n: holes });
    goalEl.setSelectionRange(0, 0);
    jumpPlaceholder(goalEl, 1);
    return;
  }
  if (!app.newDir) {
    err.textContent = t('home.needDir');
    return;
  }
  const btn = $('#btn-start');
  btn.disabled = true;
  try {
    if (app.env && !app.env.workbuddy.loggedIn) throw new Error(t('home.needWbLogin'));
    if (app.env && !app.env.codex.loggedIn) throw new Error(t('home.needGptLogin'));
    // !`cmd` runs the command and puts its output into the goal (snow-cli command injection)
    const injected = await expandInjections(goal, app.newDir);
    if (injected == null) return;
    goal = injected;
    const st = app.newSettings || {};
    const run = await api('/api/runs', { method: 'POST', body: { goal, workdir: app.newDir, startAt: app.newStartAt || null, settings: { codex: st.codex, workbuddy: st.workbuddy, loop: st.loop, team: st.team, agents: st.agents, safety: st.safety } } });
    composer.remember(goalEl.value.trim());
    goalEl.value = '';
    autosize(goalEl, maxGoalHeight());
    tplApplied = '';
    placeholderAck = '';
    app.newStartAt = '';
    updateHomeChips();
    renderTemplates();
    await actions.refreshRuns?.();
    location.hash = `#run/${run.id}`;
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
$('#btn-start').onclick = startTask;

export function initHome() {
  composer = enhanceComposer(goalEl, {
    box: $('#home-composer'),
    below: true,
    historyKey: 'goal',
    maxHeight: maxGoalHeight(),
    submit: 'mod-enter',
    onSubmit: () => startTask(),
    dir: () => app.newDir,
    agents: () => (app.env?.subagents || []).filter((a) => a.enabled),
    commands: () => actions.homeCommands?.() || [],
  });
  goalEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || composer.isOpen()) return;
    if (jumpPlaceholder(e.target, e.shiftKey ? -1 : 1)) e.preventDefault();
  });
  goalEl.addEventListener('input', () => {
    autosize(goalEl, maxGoalHeight());
    if ($('#tpl-list .applied') || goalEl.value.trim() === tplApplied) renderTemplates();
  });
  goalEl.addEventListener('history', () => autosize(goalEl, maxGoalHeight()));
  renderHero();
}

export function focusGoal() {
  setTimeout(() => goalEl.focus(), 50);
}

export { goalEl, composer as homeComposer };
