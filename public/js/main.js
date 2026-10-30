// Entry point: sidebar, routing, global shortcuts, command palette.
import { $, $$, ACTIVE, actions, api, app, applyTheme, esc, firstLine, fmtRelative, loadUi, native, oneLine, tPhase, tStatus } from './core.js';
import { ICON, BRAND, chibiFace, statusGlyph } from './brand.js';
import { lang, locale, t, translateDom, shortcut } from './i18n.js';
import { applyTemplate, fillTemplate, findTemplate, focusGoal, goalText, initHome, insertIntoGoal, loadTemplates, openParams, openTemplateMenu, pickFolder, pickRunSettings, renderHero, renderLede, setNewMode, setNewTeam, updateHomeChips } from './home.js';
import { closeModal, closePalette, closePopover, modalOpen, openPalette, paletteOpen, popoverOpen } from './overlay.js';
import { initContextMenus } from './ctxmenu.js';
import { ENGINE_IDS, ENGINE_NAMES, ENGINE_VENDORS, engineOf, engineStatus, useRoleNames } from './engines.js';
import { openGptPanel, openHelp, openSettings, quotaText, registerPanels } from './panels.js';
import { applyDensity, closeRun, initThread, openAside, openRun, renderHeader, runAction, setDensity } from './thread.js';
import { openAgentsPicker, openGitLine, openLoops, openNewPrompt, openNotebook, openReview, openSkillsPicker, openTodoPicker, openUsage, runExecuteCommand } from './tools.js';

translateDom();
document.title = BRAND.name;
$('#brand-name').textContent = BRAND.name;
$('#brand-sub').textContent = BRAND.sub;
$('.brand').title = t('brand.title', { name: BRAND.name });
$$('[data-icon]').forEach((x) => {
  x.outerHTML = ICON[x.dataset.icon] || '';
});
// in the app, ⌘N, ⌘, ⌘K and ⌘/ are native menu items (visible in the menu bar); in a browser we handle them here
const isNative = document.documentElement.classList.contains('native');
native?.postMessage({ type: 'language', value: lang });

// ---------- accounts ----------
/** Every signed-in account, with GPT's quota or the account name; one line to sign in when there is none. */
function renderAccounts() {
  if (!app.env?.engines) return;
  const st = app.newSettings || app.env.config;
  const roles = (id) => [engineOf(st, 'lead') === id && st?.loop?.useLead !== false ? t('role.short.lead') : '', engineOf(st, 'executor') === id ? t('role.short.executor') : ''].filter(Boolean);
  const rows = ENGINE_IDS.filter((id) => engineStatus(id).loggedIn).map((id) => {
    const a = engineStatus(id);
    const q = id === 'chatgpt' ? app.quota : null;
    const quota = q ? quotaText(q) : '';
    const left = q ? Math.min(...[q.primary, q.secondary].filter(Boolean).map((w) => 100 - w.usedPercent)) : 100;
    const account = a.account && a.account !== ENGINE_VENDORS[id] ? a.account : '';
    const title = [ENGINE_VENDORS[id], a.plan, a.account, ...roles(id)].filter(Boolean).join(' · ');
    return `<button class="acct ok" type="button" title="${esc(title)}">${chibiFace(id)}<span class="name">${esc(ENGINE_NAMES[id])}</span><span class="val${quota && left <= 15 ? ' low' : ''}">${esc(quota || account)}</span></button>`;
  });
  $('#acct-rows').innerHTML = rows.join('') || `<button class="acct bad" type="button"><span class="dot"></span><span class="name">${esc(t('acct.notLoggedIn'))}</span><span class="val">${esc(t('acct.signIn'))}</span></button>`;
}

async function refreshEnv() {
  try {
    app.env = await api('/api/env');
  } catch (err) {
    console.warn(err);
    return;
  }
  if (!app.newSettings) app.newSettings = pickRunSettings(app.env.config);
  if (!app.currentId) useRoleNames(app.newSettings);
  renderAccounts();
  updateHomeChips();
  applyDensity();
}

async function refreshQuota(force = false) {
  if (!app.env?.engines?.chatgpt?.loggedIn) return;
  try {
    app.quota = (await api(`/api/quota${force ? '?force=1' : ''}`)).quota;
  } catch {
    return;
  }
  renderAccounts();
}

/** Custom slash commands (global ones, plus the project's when a directory is known). */
async function refreshCommands() {
  const dir = app.state?.workdir || app.newDir || '';
  try {
    app.commands = await api(`/api/commands${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
  } catch {
    app.commands = [];
  }
}

$('#acct-rows').onclick = (e) => {
  if (e.target.closest('.acct')) openSettings('accounts');
};
$('#btn-settings').onclick = () => openSettings();
$('#btn-help').onclick = openHelp;

// ---------- the task list in the sidebar ----------
function runItem(r) {
  const tip = `${tStatus(r.status)}${r.status === 'running' ? ` (${tPhase(r.phase)})` : ''} · ${t('home.roundOf', { n: r.round, max: r.maxRounds ?? '?' })} · ${fmtRelative(r.updatedAt)}\n${oneLine(r.goal, 300)}`;
  return `<li class="run-item${r.id === app.currentId ? ' active' : ''}" data-id="${esc(r.id)}" title="${esc(tip)}">
    <span class="sglyph ${esc(r.status)}">${statusGlyph(r.status)}</span><span class="title">${esc(r.title || firstLine(r.goal, 60))}</span>${r.team && r.team !== 'off' ? `<span class="mini-badge" title="${esc(t('form.team'))}">${ICON.team}</span>` : ''}${ACTIVE.has(r.status) ? '' : `<span class="when">${esc(shortWhen(r.updatedAt))}</span>`}
  </li>`;
}

function shortWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((now - d) / 86400000);
  if (days < 7) return t('time.dAgo', { n: Math.max(1, days) });
  return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
}

async function refreshRuns() {
  try {
    app.runs = await api('/api/runs');
  } catch {
    return;
  }
  // a rename in progress lives inside the list: don't redraw it under the user's cursor
  if (app.renaming) return;
  const pinned = app.runs.filter((r) => r.pinned).sort((a, b) => String(b.pinned).localeCompare(String(a.pinned)));
  const active = app.runs.filter((r) => !r.pinned && ACTIVE.has(r.status));
  const recent = app.runs.filter((r) => !r.pinned && !ACTIVE.has(r.status));
  $('#label-pinned').classList.toggle('hidden', !pinned.length);
  $('#list-pinned').innerHTML = pinned.map(runItem).join('');
  $('#label-active').classList.toggle('hidden', !active.length);
  $('#n-active').textContent = active.length > 1 ? String(active.length) : '';
  $('#list-active').innerHTML = active.map(runItem).join('');
  $('#label-recent').classList.toggle('hidden', !recent.length && Boolean(active.length || pinned.length));
  $('#list-recent').innerHTML = recent.length ? recent.map(runItem).join('') : active.length || pinned.length ? '' : `<li class="run-empty">${esc(t('side.empty1'))}<br>${esc(t('side.empty2'))}</li>`;
  renderLede();
}

$('#side-scroll').addEventListener('click', (e) => {
  const li = e.target.closest('.run-item');
  if (li) location.hash = `#run/${li.dataset.id}`;
});
$('#btn-new').onclick = () => {
  location.hash = '#new';
  focusGoal();
};
$('#btn-palette').onclick = () => openCommandPalette();

// ---------- command palette ----------
function setTheme(v) {
  applyTheme(v);
  api('/api/config', { method: 'PUT', body: { ui: { theme: v } } }).catch(() => {});
}

async function setLanguage(v) {
  await api('/api/config', { method: 'PUT', body: { ui: { language: v } } });
  native?.postMessage({ type: 'language', value: v });
  location.reload();
}


const homeDir = () => app.newDir;

function openCommandPalette() {
  openPalette(() => {
    const items = [];
    const inRun = Boolean(app.currentId && app.state);
    if (inRun) {
      const s = app.state;
      const running = ['running', 'waiting'].includes(s.status);
      const g = t('palette.current');
      if (s.status === 'waiting_user' && s.phase === 'approve') items.push({ group: g, icon: 'check', title: t('run.approvePlan'), keys: 'approve', run: () => runAction('approve') });
      if (running) items.push({ group: g, icon: 'pause', title: t('run.pause'), keys: 'pause zanting', run: () => runAction('pause') });
      if (['paused', 'stopped', 'interrupted', 'failed'].includes(s.status) || (s.status === 'waiting' && s.scheduledAt)) items.push({ group: g, icon: 'play', title: s.scheduledAt ? t('run.startNow') : t('run.continue'), keys: 'resume jixu', run: () => runAction('resume') });
      if (ACTIVE.has(s.status)) items.push({ group: g, icon: 'stop', title: t('run.stop'), keys: 'stop tingzhi', run: () => runAction('stop') });
      items.push(
        { group: g, icon: 'aside', title: t('cmd.btw'), hint: t('cmd.btwDesc'), keys: 'btw ask suikou', run: () => openAside() },
        { group: g, icon: 'diff', title: t('run.allChanges'), keys: 'diff gaidong', run: () => runAction('alldiff') },
        { group: g, icon: 'rollback', title: t('run.rollback'), keys: 'rollback undo huigun', run: () => runAction('rollback') },
        { group: g, icon: 'eye', title: t('run.review'), keys: 'review shencha', run: () => runAction('review') },
        { group: g, icon: 'compress', title: t('run.compact'), keys: 'compact yasuo', run: () => runAction('compact') },
        { group: g, icon: 'book', title: t('run.notebook'), keys: 'notebook biji', run: () => runAction('notebook') },
        { group: g, icon: 'repeat', title: t('run.loop'), keys: 'loop xunhuan', run: () => runAction('loop') },
        { group: g, icon: 'export', title: t('run.export'), keys: 'export daochu markdown', run: () => runAction('export') },
        { group: g, icon: 'sliders', title: t('run.adjust'), keys: 'settings tiaozheng', run: () => runAction('settings') },
        { group: g, icon: 'finder', title: t('run.openInFinder'), keys: 'finder open', run: () => runAction('openDir') },
      );
    }
    const g = t('palette.common');
    items.push(
      { group: g, icon: 'plus', title: t('side.newTask'), kbd: shortcut('⌘N'), keys: 'new xinrenwu', run: () => { location.hash = '#new'; focusGoal(); } },
      { group: g, icon: 'gear', title: t('settings.title'), kbd: shortcut('⌘,'), keys: 'settings shezhi', run: () => openSettings() },
      { group: g, icon: 'help', title: t('help.title'), kbd: shortcut('⌘/'), keys: 'help bangzhu shortcuts', run: openHelp },
      { group: g, icon: 'prompt', title: t('palette.prompts'), keys: 'system prompt role tishici', run: () => openSettings('prompts') },
      { group: g, icon: 'agents', title: t('palette.agents'), keys: 'agents subagent daili', run: () => openSettings('agents') },
      { group: g, icon: 'shield', title: t('palette.safety'), keys: 'safety sensitive yolo anquan', run: () => openSettings('safety') },
      { group: g, icon: 'hook', title: t('palette.hooks'), keys: 'hooks gouzi', run: () => openSettings('hooks') },
      { group: g, icon: 'sparkle', title: t('palette.skills'), keys: 'skills commands jineng', run: () => openSettings('skills') },
      { group: g, icon: 'plug', title: 'MCP', keys: 'mcp servers', run: () => openSettings('mcp') },
      { group: g, icon: 'chart', title: t('usage.title'), keys: 'usage tokens yongliang', run: () => openUsage() },
      { group: g, icon: 'repeat', title: t('loops.title'), keys: 'loop schedule xunhuan', run: () => openLoops({ dir: homeDir() }) },
      { group: g, icon: 'list', title: t('palette.density'), keys: 'density jingjian xiangxi tool-display', run: () => setDensity() },
      { group: g, icon: 'sun', title: t('palette.themeLight'), keys: 'theme light qianse', run: () => setTheme('light') },
      { group: g, icon: 'moon', title: t('palette.themeDark'), keys: 'theme dark shense', run: () => setTheme('dark') },
      { group: g, icon: 'palette', title: t('palette.themeSystem'), keys: 'theme system', run: () => setTheme('system') },
      { group: g, icon: 'globe', title: 'Language: English', keys: 'language english yuyan', run: () => setLanguage('en') },
      { group: g, icon: 'globe', title: '语言：中文', keys: 'language chinese zhongwen yuyan', run: () => setLanguage('zh') },
      { group: g, icon: 'globe', title: '言語：日本語', keys: 'language japanese nihongo', run: () => setLanguage('ja') },
      { group: g, icon: 'key', title: t('settings.accounts'), keys: 'accounts login sign in zhanghu denglu gpt claude deepseek workbuddy', run: () => openSettings('accounts') },
      { group: g, icon: 'chart', title: t('palette.gpt'), keys: 'gpt quota edu', run: openGptPanel },
    );
    for (const r of app.runs.slice(0, 80)) {
      items.push({ group: t('palette.tasks'), icon: ACTIVE.has(r.status) ? 'play' : r.status === 'done' ? 'check' : 'scroll', title: firstLine(r.goal, 70), hint: `${tStatus(r.status)} · ${fmtRelative(r.updatedAt)}`, keys: `${r.workdir} ${oneLine(r.goal, 300)}`, run: () => { location.hash = `#run/${r.id}`; } });
    }
    return items;
  });
}

// slash commands of the home composer
actions.homeCommands = () => {
  const list = [
    { name: 'dir', label: t('home.pickDir'), keys: 'ml mulu folder', run: pickFolder },
    { name: 'params', label: t('home.paramsTitle'), keys: 'cs canshu model', run: openParams },
    { name: 'template', label: t('home.templates'), desc: t('cmd.templateDesc'), keys: 'mb muban tpl templates', run: () => openTemplateMenu() },
    { name: 'team', label: t('cmd.team'), desc: t('cmd.teamHomeDesc'), arg: 'off|auto|always', keys: 'td tuandui', run: (a) => setNewTeam(['off', 'auto', 'always'].includes(a) ? a : (app.newSettings?.team?.mode || 'off') === 'off' ? 'auto' : 'off') },
    { name: 'mode', label: t('cmd.mode'), desc: t('cmd.modeDesc'), arg: 'normal|plan|vuln', keys: 'ms moshi', run: (a) => setNewMode(['normal', 'plan', 'vuln'].includes(a) ? a : 'plan') },
    { name: 'init', label: t('cmd.init'), desc: t('cmd.initDesc'), keys: 'csh chushihua agents.md', run: () => { const tpl = findTemplate('init'); if (tpl) applyTemplate(tpl); } },
    { name: 'deepresearch', label: t('cmd.deepresearch'), desc: t('cmd.deepresearchDesc'), arg: t('cmd.argTopic'), keys: 'sddy diaoyan research', run: (a) => { const tpl = findTemplate('deepresearch'); if (tpl) applyTemplate(a ? fillTemplate(tpl, a) : tpl); } },
    { name: 'gitline', label: t('cmd.gitline'), desc: t('cmd.gitlineDesc'), keys: 'tj tijiao commit git', run: () => openGitLine(homeDir(), (x) => insertIntoGoal(x)) },
    { name: 'new-prompt', label: t('cmd.newPrompt'), desc: t('cmd.newPromptDesc'), arg: t('cmd.argIdea'), keys: 'tsc tishici prompt', run: (a) => openNewPrompt(homeDir(), a || goalText().trim(), (text) => insertIntoGoal(text, { replace: true })) },
    { name: 'review', label: t('run.review'), desc: t('cmd.reviewDesc'), keys: 'sc shencha', run: () => openReview(homeDir()) },
    { name: 'skills', label: t('cmd.skills'), desc: t('cmd.skillsDesc'), keys: 'jn jineng skill', run: () => openSkillsPicker(homeDir(), (x) => insertIntoGoal(x)) },
    { name: 'agents', label: t('cmd.agents'), desc: t('cmd.agentsDesc'), keys: 'dl daili agent', run: () => openAgentsPicker((x) => insertIntoGoal(x)) },
    { name: 'todo', label: t('cmd.todo'), desc: t('cmd.todoDesc'), keys: 'db daiban fixme', run: () => openTodoPicker(homeDir(), (x) => insertIntoGoal(x)) },
    { name: 'loop', label: t('loops.title'), desc: t('cmd.loopHomeDesc'), arg: t('cmd.argLoop'), keys: 'xh xunhuan loop', run: (a) => openLoops({ dir: homeDir(), spec: a || goalText().trim(), settings: app.newSettings }) },
    { name: 'notebook', label: t('run.notebook'), desc: t('cmd.notebookDesc'), keys: 'bjb biji', run: () => openNotebook(homeDir()) },
    { name: 'usage', label: t('usage.title'), keys: 'yl yongliang tokens', run: () => openUsage() },
    { name: 'mcp', label: 'MCP', keys: 'mcp', run: () => openSettings('mcp') },
    { name: 'hooks', label: t('palette.hooks'), keys: 'gz gouzi', run: () => openSettings('hooks') },
    { name: 'settings', label: t('settings.title'), keys: 'sz shezhi', run: () => openSettings() },
    { name: 'help', label: t('help.title'), keys: 'bz bangzhu', run: openHelp },
  ];
  for (const c of app.commands || []) {
    if (list.some((x) => x.name === c.name)) continue;
    list.push({
      name: c.name,
      label: c.description || oneLine(c.command, 60),
      desc: c.type === 'execute' ? t('cmd.customExec') : t('cmd.customPromptHome'),
      arg: c.command.includes('$ARGUMENTS') ? t('cmd.argArgs') : '',
      keys: c.name,
      run: (a) => {
        const text = c.command.includes('$ARGUMENTS') ? c.command.split('$ARGUMENTS').join(a) : a ? `${c.command} ${a}` : c.command;
        if (c.type === 'execute') runExecuteCommand(homeDir(), text, { onSend: (out) => insertIntoGoal(out) });
        else insertIntoGoal(text);
      },
    });
  }
  return list;
};

// ---------- global shortcuts ----------
let lastEsc = 0;
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && !isNative) {
    const name = { k: 'palette', n: 'new', ',': 'settings', '/': 'help' }[e.key.toLowerCase()];
    if (name) {
      e.preventDefault();
      appCommand(name);
      return;
    }
  }
  if (e.key !== 'Escape' || e.isComposing) return;
  if (paletteOpen()) {
    closePalette();
    return;
  }
  if (popoverOpen()) {
    closePopover();
    return;
  }
  if (modalOpen()) {
    closeModal();
    return;
  }
  // Esc twice in a task opens the rollback panel (snow-cli's double-ESC rollback menu)
  if (app.currentId && !document.activeElement?.value) {
    if (Date.now() - lastEsc < 600) {
      lastEsc = 0;
      runAction('rollback');
    } else lastEsc = Date.now();
  }
});
/** Native menu items (⌘N, ⌘, …) come through here too */
function appCommand(name) {
  if (name === 'palette' && paletteOpen()) {
    closePalette();
    return;
  }
  closePalette();
  if (name === 'new') {
    closeModal();
    location.hash = '#new';
    focusGoal();
  } else if (name === 'settings') {
    openSettings();
  } else if (name === 'help') {
    openHelp();
  } else if (name === 'palette') {
    openCommandPalette();
  } else if (name === 'usage') {
    openUsage();
  }
}
window.__wbloopApp = { command: appCommand };

// ---------- routing ----------
function showView(name) {
  $('#view-new').classList.toggle('hidden', name !== 'new');
  $('#view-run').classList.toggle('hidden', name !== 'run');
}

function route() {
  closePopover();
  const m = location.hash.match(/^#run\/(.+)$/);
  if (m) {
    if (app.currentId !== m[1] || !app.es) openRun(m[1]);
    showView('run');
    $$('.run-item').forEach((li) => li.classList.toggle('active', li.dataset.id === m[1]));
    setTimeout(refreshCommands, 800);
    return;
  }
  closeRun();
  $$('.run-item').forEach((li) => li.classList.remove('active'));
  showView('new');
  renderHero();
  updateHomeChips();
  refreshCommands();
  focusGoal();
}

window.addEventListener('hashchange', route);

Object.assign(actions, { refreshEnv, refreshRuns, renderAccounts, setDensity, refreshCommands, renderHeader });
registerPanels();

(async function init() {
  applyTheme(document.documentElement.dataset.theme);
  initHome();
  initThread();
  initContextMenus();
  await Promise.all([refreshEnv(), refreshRuns(), loadTemplates(), loadUi(), refreshCommands()]);
  if (!location.hash) {
    const active = app.runs.find((r) => ACTIVE.has(r.status));
    location.hash = active ? `#run/${active.id}` : '#new';
  }
  route();
  refreshQuota();
  setInterval(refreshRuns, 4000);
  setInterval(refreshEnv, 30000);
  setInterval(() => refreshQuota(), 180000);
  setInterval(() => {
    if (app.state && ACTIVE.has(app.state.status)) renderHeader();
  }, 15000);
})();
