// Home: a verse and the goal box. The box holds the working directory, the models, and a "+" menu with the rest
// (templates, Team Mode, task mode, start time); options that differ from the defaults show as small chips.
import { $, actions, api, app, esc, firstLine, fmtClock, merge, native, nativeCall, shortPath, toast } from './core.js';
import { ICON, ORNAMENT, TEMPLATE_ICON, pickQuote } from './brand.js';
import { autosize, enhanceComposer } from './composer.js';
import { t } from './i18n.js';
import { TASK_MODES, TEAM_MODES, mountSettingsForm, openSchedulePopover, readSettingsForm, scheduleLabel, settingsSummary, wbModel } from './forms.js';
import { ENGINE_NAMES, engineOf, engineStatus, roleLabel, roleSpec, useRoleNames } from './engines.js';
import { closeModal, closePopover, confirmDialog, menuItem, openModal, openPopover } from './overlay.js';
import { expandInjections } from './tools.js';

const goalEl = $('#f-goal');
const maxGoalHeight = () => window.innerHeight * 0.46;
let composer = null;
let tplApplied = '';
let placeholderAck = '';
let starting = false;
let chipsHtml = '';

export function pickRunSettings(cfg) {
  // without a chosen GPT model use the account's default, so the UI can show a concrete name
  return {
    roles: JSON.parse(JSON.stringify(cfg.roles || {})),
    codex: { ...cfg.codex, model: cfg.codex.model || app.env?.codex.defaultModel || '' },
    claude: { ...cfg.claude },
    deepseek: { ...cfg.deepseek },
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
  // the gloss (original text, a note) stays out of the way: it's the tooltip of the source
  const src = $('#hero-src');
  src.textContent = `— ${q.src}`;
  src.title = q.gloss || '';
  src.classList.toggle('glossed', Boolean(q.gloss));
}

/** The one-line introduction is shown only until the first task exists. */
export function renderLede() {
  const lede = $('#hero-lede');
  // Chinese and Japanese sentences are packed into lines that end at a full stop
  const lines = [];
  for (const part of t('home.lede').split(/(?<=[。！？])/).filter(Boolean)) {
    if (lines.length && lines[lines.length - 1].length + part.length <= 40) lines[lines.length - 1] += part;
    else lines.push(part);
  }
  lede.innerHTML = lines.map((l) => `<span class="ln">${esc(l)}</span>`).join('');
  lede.classList.toggle('hidden', app.runs.length > 0);
}

const dirName = (d) => String(d).replace(/\/+$/, '').replaceAll('\\', '/').split('/').pop() || d;

function parentShort(d) {
  const parts = shortPath(d).replace(/\/+$/, '').replaceAll('\\', '/').split('/').slice(0, -1);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : parts.join('/') || '/';
}

export function updateHomeChips() {
  const dir = app.newDir;
  const pick = $('#btn-pick');
  $('#dir-label').textContent = dir ? dirName(dir) : t('home.pickDir');
  pick.classList.toggle('unset', !dir);
  pick.title = dir ? shortPath(dir) : t('home.pickDirTitle');
  const st = app.newSettings;
  if (st) {
    $('#params-label').textContent = `${roleLabel(st, 'lead')} · ${roleLabel(st, 'executor')}`;
    useRoleNames(st);
    actions.renderAccounts?.();
    $('#btn-params').title = settingsSummary(st);
  }
  if (app.newStartAt && Date.parse(app.newStartAt) <= Date.now()) app.newStartAt = '';
  renderOptionChips();
}

const teamLabel = (mode) => TEAM_MODES().find(([v]) => v === mode)?.[1] || mode;
const modeLabel = (mode) => TASK_MODES().find(([v]) => v === mode)?.[1] || mode;

/** Chips for the options that differ from the defaults; a chip opens its menu, its × resets it. */
function renderOptionChips() {
  const st = app.newSettings;
  const team = st?.team?.mode || 'off';
  const mode = st?.agents?.mode || 'normal';
  const chips = [];
  if (team !== 'off') chips.push(['team', 'team', t('home.chipTeam', { mode: teamLabel(team) })]);
  if (mode !== 'normal') chips.push(['mode', 'list', modeLabel(mode)]);
  if (app.newStartAt) chips.push(['schedule', 'clock', scheduleLabel(app.newStartAt)]);
  const reset = esc(t('home.reset'));
  const html = chips.map(([id, icon, label]) => `<span class="opt-chip" data-opt="${id}" role="button" tabindex="0">${ICON[icon]}<span class="lbl">${esc(label)}</span><button class="x" type="button" data-reset="${id}" title="${reset}" aria-label="${reset}">${ICON.x}</button></span>`).join('');
  // the environment refresh calls this every 30 s: rebuild only on a change, so an open chip menu keeps its anchor
  if (html !== chipsHtml) $('#opt-chips').innerHTML = chipsHtml = html;
}

$('#opt-chips').addEventListener('click', (e) => {
  const reset = e.target.closest('[data-reset]');
  if (reset) {
    const id = reset.dataset.reset;
    if (id === 'team') setNewTeam('off');
    else if (id === 'mode') setNewMode('normal');
    else {
      app.newStartAt = '';
      updateHomeChips();
    }
    return;
  }
  const chip = e.target.closest('[data-opt]');
  if (chip) openOption(chip.dataset.opt, chip);
});
$('#opt-chips').addEventListener('keydown', (e) => {
  const chip = e.target.closest('[data-opt]');
  if (chip && e.target === chip && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openOption(chip.dataset.opt, chip);
  }
});

function syncComposer() {
  const has = Boolean(goalEl.value.trim());
  $('#home-composer').classList.toggle('has-text', has);
  $('#btn-start').disabled = !has || starting;
}

// ---------- working directory ----------
function setDir(dir) {
  app.newDir = dir;
  updateHomeChips();
  actions.refreshCommands?.();
}

function pickFolderModal() {
  let current = app.newDir || app.env?.home || '';
  const body = openModal(t('home.pickDir'), '<div id="dir-picker"></div>', {
    subtitle: t('home.pickDirSubtitle'),
    foot: `<span class="note"></span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="dir-choose">${esc(t('home.chooseThisDir'))}</button>`,
  });
  $('#dir-choose').onclick = () => {
    setDir(current);
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
    if (p) setDir(p);
  } else {
    pickFolderModal();
  }
}

/** Recent folders first; "Choose another folder…" opens the picker (straight away when there are none). */
function openDirMenu(anchor) {
  const dirs = [...new Set(app.runs.map((r) => r.workdir))].filter((d) => d && d !== app.newDir).slice(0, 6);
  if (!dirs.length) {
    pickFolder();
    return;
  }
  const pop = openPopover(anchor, `<div class="menu-label">${esc(t('home.recentDirs'))}</div>
    ${dirs.map((d, i) => `<button class="menu-item" type="button" data-i="${i}" title="${esc(d)}">${ICON.folder}<span>${esc(dirName(d))}</span><span class="desc">${esc(parentShort(d))}</span></button>`).join('')}
    <div class="menu-sep"></div>
    <button class="menu-item" type="button" data-browse="1">${ICON.finder}<span>${esc(t('home.otherDir'))}</span></button>`, { align: 'left', className: 'dir-pop' });
  pop.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (b) {
      closePopover();
      setDir(dirs[Number(b.dataset.i)]);
    } else if (e.target.closest('[data-browse]')) {
      closePopover();
      pickFolder();
    }
  };
}
$('#btn-pick').onclick = (e) => openDirMenu(e.currentTarget);

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

// ---------- the "+" menu and its option menus ----------
function openMoreMenu(anchor) {
  const st = ensureNewSettings();
  const row = (id, icon, label, value = '') => `<button class="menu-item sub" type="button" data-opt="${id}">${ICON[icon]}<span>${esc(label)}</span>${value ? `<span class="desc">${esc(value)}</span>` : ''}<span class="chev">${ICON.chev}</span></button>`;
  const pop = openPopover(anchor, `
    ${row('templates', 'scroll', t('home.templates'))}
    <div class="menu-sep"></div>
    ${row('team', 'team', t('home.teamTitle'), teamLabel(st?.team?.mode || 'off'))}
    ${row('mode', 'list', t('home.modeTitle'), modeLabel(st?.agents?.mode || 'normal'))}
    ${row('schedule', 'clock', t('home.optStart'), app.newStartAt ? fmtClock(app.newStartAt) : t('home.now'))}`, { align: 'left', className: 'more-pop' });
  pop.onclick = (e) => {
    const b = e.target.closest('[data-opt]');
    if (b) openOption(b.dataset.opt, anchor);
  };
}
$('#btn-more').onclick = (e) => openMoreMenu(e.currentTarget);

function openOption(id, anchor) {
  if (id === 'templates') openTemplateMenu(anchor);
  else if (id === 'team') openTeamMenu(anchor);
  else if (id === 'mode') openModeMenu(anchor);
  else if (id === 'schedule') openSchedule(anchor);
}

function openTeamMenu(anchor) {
  const cur = ensureNewSettings()?.team?.mode || 'off';
  const pop = openPopover(anchor, `<div class="menu-label">${esc(t('home.teamTitle'))}</div>
    ${TEAM_MODES().map(([v, label]) => menuItem({ act: v, label, checked: v === cur })).join('')}
    <div class="hint pop-hint">${esc(t('home.teamHint'))}</div>`, { align: 'left' });
  pop.onclick = (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    closePopover();
    setNewTeam(b.dataset.act);
  };
}

function openModeMenu(anchor) {
  const cur = ensureNewSettings()?.agents?.mode || 'normal';
  const hints = { normal: t('mode.normalHint'), plan: t('mode.planHint'), vuln: t('mode.vulnHint') };
  const pop = openPopover(anchor, `<div class="menu-label">${esc(t('home.modeTitle'))}</div>
    ${TASK_MODES().map(([v, label]) => menuItem({ act: v, label, checked: v === cur })).join('')}
    <div class="hint pop-hint">${esc(hints[cur])}</div>`, { align: 'left' });
  pop.onclick = (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    closePopover();
    setNewMode(b.dataset.act);
  };
}

function openSchedule(anchor) {
  openSchedulePopover(anchor, {
    current: app.newStartAt,
    // night discounts exist for WorkBuddy models only
    modelId: (() => {
      const spec = roleSpec(app.newSettings || app.env?.config, 'executor');
      return spec.engine === 'workbuddy' ? spec.model || 'auto' : '';
    })(),
    onPick: (iso) => {
      app.newStartAt = iso;
      updateHomeChips();
    },
  });
}

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
    // keep the last list
  }
}

/** The template list (from the "+" menu or /template): built-in ones, then the user's, then "Save as template". */
export function openTemplateMenu(anchor = $('#btn-more')) {
  const { builtin = [], custom = [] } = app.templates || {};
  const item = (tpl, isCustom) => {
    const icon = TEMPLATE_ICON[isCustom ? 'custom' : tpl.id] || TEMPLATE_ICON.custom;
    const hint = isCustom ? firstLine(tpl.body, 80) : tpl.hint;
    const del = isCustom ? `<button class="x" type="button" data-del="${esc(tpl.id)}" title="${esc(t('home.deleteTemplate'))}" aria-label="${esc(t('common.delete'))}">${ICON.x}</button>` : '';
    return `<div class="menu-item tpl-item" role="button" tabindex="0" data-tpl="${esc(tpl.id)}" title="${esc(hint)}">${icon}<span class="nm">${esc(tpl.name)}</span><span class="ht">${esc(hint)}</span>${del}</div>`;
  };
  const pop = openPopover(anchor, `<div class="menu-label">${esc(t('home.templates'))}</div>
    ${builtin.map((x) => item(x, false)).join('')}
    ${custom.length ? `<div class="menu-sep"></div>${custom.map((x) => item(x, true)).join('')}` : ''}
    <div class="menu-sep"></div>
    <button class="menu-item" type="button" data-save-tpl="1" title="${esc(t('home.saveTemplateTitle'))}">${ICON.plus}<span>${esc(t('home.saveTemplate'))}</span></button>
    <div class="tpl-save hidden"><input id="tpl-name" type="text" maxlength="30" placeholder="${esc(t('home.templateNamePlaceholder'))}" autocomplete="off"><button class="btn sm primary" type="button" id="tpl-save-ok">${esc(t('common.save'))}</button></div>`, { align: 'left', className: 'tpl-pop' });
  const choose = (node) => {
    const tpl = findTemplate(node.dataset.tpl);
    closePopover();
    if (tpl) applyTemplate(tpl);
  };
  pop.onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const tpl = custom.find((x) => x.id === del.dataset.del);
      if (!tpl || !(await confirmDialog({ title: t('home.deleteTemplateQ', { name: tpl.name }), ok: t('common.delete'), danger: true }))) return;
      try {
        app.templates = await api(`/api/templates/${tpl.id}`, { method: 'DELETE' });
        if (anchor.isConnected) openTemplateMenu(anchor);
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (e.target.closest('[data-save-tpl]')) {
      if (!goalEl.value.trim()) {
        toast(t('home.saveTemplateNeedGoal'));
        return;
      }
      $('[data-save-tpl]', pop).classList.add('hidden');
      $('.tpl-save', pop).classList.remove('hidden');
      $('#tpl-name', pop).focus();
      return;
    }
    if (e.target.closest('#tpl-save-ok')) {
      saveTemplate($('#tpl-name', pop).value);
      return;
    }
    const node = e.target.closest('[data-tpl]');
    if (node) choose(node);
  };
  pop.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.target.id === 'tpl-name' && e.key === 'Enter') saveTemplate(e.target.value);
    else if (e.key === 'Enter' && e.target.matches('[data-tpl]')) choose(e.target);
  };
}

async function saveTemplate(name) {
  try {
    app.templates = await api('/api/templates', { method: 'POST', body: { name, body: goalEl.value } });
    closePopover();
    toast(t('home.savedTemplate'));
  } catch (err) {
    toast(err.message);
  }
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
    syncComposer();
    goalEl.scrollTop = 0;
    goalEl.setSelectionRange(0, 0);
    if (jumpPlaceholder(goalEl, 1)) toast(t('home.tplHint'), { ms: 4200 });
    else goalEl.focus();
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

/** Puts text into the goal box (custom commands, generated prompts, skills, TODOs). */
export function insertIntoGoal(text, { replace = false } = {}) {
  if (replace || !goalEl.value.trim()) goalEl.value = text;
  else goalEl.value = `${goalEl.value.replace(/\s+$/, '')}\n\n${text}`;
  autosize(goalEl, maxGoalHeight());
  syncComposer();
  goalEl.focus();
  goalEl.setSelectionRange(goalEl.value.length, goalEl.value.length);
  if (!jumpPlaceholder(goalEl, 1)) goalEl.scrollTop = goalEl.scrollHeight;
}

export function goalText() {
  return goalEl.value;
}

// ---------- start ----------
export async function startTask() {
  if (starting) return;
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
  starting = true;
  syncComposer();
  try {
    // both roles' engines must be signed in before anything starts
    for (const role of ['lead', 'executor']) {
      const id = engineOf(app.newSettings, role);
      const acct = engineStatus(id);
      if (app.env?.engines && !acct.loggedIn) throw new Error(t(acct.installed ? 'home.needSignIn' : 'home.needInstall', { name: ENGINE_NAMES[id] }));
    }
    // !`cmd` runs the command and puts its output into the goal (snow-cli command injection)
    const injected = await expandInjections(goal, app.newDir);
    if (injected == null) return;
    goal = injected;
    const st = app.newSettings || {};
    const run = await api('/api/runs', { method: 'POST', body: { goal, workdir: app.newDir, startAt: app.newStartAt || null, settings: { roles: st.roles, codex: st.codex, claude: st.claude, deepseek: st.deepseek, workbuddy: st.workbuddy, loop: st.loop, team: st.team, agents: st.agents, safety: st.safety } } });
    composer.remember(goalEl.value.trim());
    goalEl.value = '';
    autosize(goalEl, maxGoalHeight());
    tplApplied = '';
    placeholderAck = '';
    app.newStartAt = '';
    updateHomeChips();
    await actions.refreshRuns?.();
    location.hash = `#run/${run.id}`;
  } catch (e) {
    err.textContent = e.message;
  } finally {
    starting = false;
    syncComposer();
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
    syncComposer();
  });
  goalEl.addEventListener('history', () => {
    autosize(goalEl, maxGoalHeight());
    syncComposer();
  });
  renderHero();
  syncComposer();
}

export function focusGoal() {
  setTimeout(() => goalEl.focus(), 50);
}

export { goalEl, composer as homeComposer };
