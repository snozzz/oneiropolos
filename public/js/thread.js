// The task view: you and GPT on the right, WorkBuddy (or its teammates) on the left; events render live.
import {
  $, $$, ACTIVE, TOKEN, actions, api, app, collapsible, copyText, el, esc, firstLine, fixCollapsibles, fmtClock, fmtCtx, fmtDuration,
  fmtTime, fmtTokens, md, mdInline, msgText, oneLine, shortPath, tEffort, tPhase, tSeverity, tStatus, tVerdict, toast,
} from './core.js';
import { DONE_VERSE, EMBLEM, ICON, LAUREL } from './brand.js';
import { autosize, enhanceComposer } from './composer.js';
import { t } from './i18n.js';
import { TASK_MODES, TEAM_MODES, mountSettingsForm, readSettingsForm, wbEffortText, wbModel } from './forms.js';
import { closeModal, closePopover, confirmDialog, menuItem, openModal, openPopover } from './overlay.js';
import { expandInjections, openAgentsPicker, openBoard, openGitLine, openLoops, openNewPrompt, openNotebook, openReview, openSkillsPicker, openTodoPicker, openUsage, runExecuteCommand } from './tools.js';

const toolText = (name) => {
  const k = `tool.${name}`;
  const v = t(k);
  return v === k ? name : v;
};
const MINOR_TOOLS = /^(Read|Glob|Grep|Task\w+|ToolSearch|ListMcpResources|NotebookRead)$/;
// commands worth a second look: forced deletes, rewriting git history, sudo, piping downloads into a shell …
const RISKY_RE = /\brm\s+-[a-zA-Z]*[rf]|\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx]|push\b[^\n]*(\s-f\b|--force)|branch\s+-D)|\bsudo\b|\bchmod\s+-R\s+777|\bmkfs\b|\bdd\s+if=|\bcurl\b[^|\n]*\|\s*(ba|z)?sh\b|\bwget\b[^|\n]*\|\s*(ba|z)?sh\b|\bshutdown\b|\breboot\b/;

const scroller = () => $('#chat-scroll');
const nearBottom = () => {
  const m = scroller();
  return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
};
const scrollBottom = () => {
  const m = scroller();
  m.scrollTop = m.scrollHeight;
};

function resetThread() {
  app.t = { gpt: new Map(), wb: new Map(), teams: new Map(), tools: new Map(), thinking: new WeakMap(), prompts: new Map(), checks: new Map(), approvals: new Map(), goal: null, lastGpt: '', lastWb: '' };
  $('#timeline').innerHTML = '';
  $('#approvals').innerHTML = '';
}

export function applyDensity() {
  const d = app.env?.config?.ui?.density || 'full';
  $('#timeline').classList.toggle('compact', d === 'compact');
  $('#timeline').classList.toggle('no-process', d === 'hidden');
}

export function openRun(id) {
  if (app.es) app.es.close();
  app.currentId = id;
  app.state = null;
  app.caughtUp = false;
  resetThread();
  applyDensity();
  $('#run-header').innerHTML = `<div class="chat-sub" style="padding:6px 0">${esc(t('common.loading'))}</div>`;
  $('#run-notice').classList.add('hidden');
  closeAside();
  const es = new EventSource(`/api/runs/${id}/events?token=${encodeURIComponent(TOKEN)}`);
  app.es = es;
  es.onmessage = (msg) => {
    if (app.es !== es) return;
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    const stick = app.caughtUp && nearBottom();
    handleEvent(ev);
    if (stick) scrollBottom();
  };
  es.addEventListener('state', (msg) => {
    if (app.es !== es) return;
    app.state = JSON.parse(msg.data);
    ensureGoalBubble();
    renderHeader();
    renderNotice();
    syncWbFromState();
  });
  es.addEventListener('live', (msg) => {
    if (app.es !== es) return;
    const stick = nearBottom();
    renderLive(JSON.parse(msg.data));
    if (stick) scrollBottom();
  });
  es.addEventListener('caught-up', () => {
    if (app.es !== es || app.caughtUp) return;
    app.caughtUp = true;
    fixCollapsibles($('#timeline'));
    openActiveProcess();
    renderApprovals();
    scrollBottom();
  });
}

export function closeRun() {
  if (app.es) app.es.close();
  app.es = null;
  app.currentId = null;
  app.state = null;
  closeAside();
  clearInterval(approvalTimer);
  approvalTimer = null;
}

/** Long paths keep only the last two parts */
export function tailPath(p) {
  const s = shortPath(p);
  return s.length <= 40 ? s : `…/${s.split('/').slice(-2).join('/')}`;
}

const isScheduled = (s) => s?.status === 'waiting' && s.scheduledAt && Date.parse(s.scheduledAt) > Date.now();
const isRunning = (s) => ['running', 'waiting'].includes(s?.status) && !isScheduled(s);
const awaitingPlan = (s) => s?.status === 'waiting_user' && s.phase === 'approve';

const hbtn = (act, icon, text, kind = 'ghost', title = '') => `<button class="btn sm ${kind}" type="button" data-act="${act}"${title ? ` title="${esc(title)}"` : ''}>${icon ? ICON[icon] : ''}${text ? `<span>${esc(text)}</span>` : ''}</button>`;

/** The purge badge: shows the state the last composed system prompt actually had. */
const purgeSize = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
/** A started task reports what it really injected; one that never ran falls back to the global slot. */
function purgeOf(s = app.state) {
  if (s?.purge) return s.purge;
  if (!s || !s.round) return app.env?.purge;
  return null;
}
function purgeChip(pg) {
  if (!pg?.enabled) return '';
  const why = pg.active ? t('purge.active') : t(`purge.why.${pg.reason || 'off'}`);
  const title = `${pg.label} — ${why}\n${pg.file}${pg.active ? ` · ${purgeSize(pg.bytes)}` : ''}`;
  return `<button class="chip-in purge${pg.active ? ' on' : ''}" type="button" data-act="purge" title="${esc(title)}">${ICON.shield}${esc(pg.label)}</button>`;
}

/** What the badge opens: the slot, the file it read, and the one command that changes it. */
function purgePopoverHtml() {
  const pg = purgeOf();
  if (!pg?.enabled) return `<div class="plan-pop"><h4>${esc(pg?.label || 'PURGE')}</h4><p class="muted">${esc(t('purge.why.off'))}</p></div>`;
  const state = pg.active ? t('purge.active') : t(`purge.why.${pg.reason || 'off'}`);
  return `<div class="plan-pop">
    <h4>${esc(pg.label)} · ${esc(state)}</h4>
    <p class="purge-file">${esc(shortPath(pg.file))}</p>
    <div class="stats">${esc(pg.mode)} · ${esc(pg.roles.join(', '))}${pg.active ? ` · ${esc(purgeSize(pg.bytes))}` : ''}${pg.truncated ? ` · ${esc(t('purge.truncated'))}` : ''}</div>
    <p class="purge-hint">${esc(t('purge.hint'))}</p>
    <code class="purge-cmd">wbloop config purge.enabled=${pg.enabled ? 'false' : 'true'}</code>
  </div>`;
}

export function renderHeader() {
  const s = app.state;
  if (!s) return;
  const status = s.status;
  const set = s.settings || {};
  const btns = [];
  if (isScheduled(s)) btns.push(hbtn('resume', 'play', t('run.startNow'), 'primary'), hbtn('stop', 'stop', t('common.cancel')));
  else if (awaitingPlan(s)) btns.push(hbtn('approve', 'check', t('run.approvePlan'), 'primary'), hbtn('stop', 'stop', t('run.stop')));
  else if (isRunning(s)) btns.push(hbtn('pause', 'pause', t('run.pause'), 'ghost', t('run.pauseTitle')), hbtn('stop', 'stop', t('run.stop')));
  else if (status === 'paused') btns.push(hbtn('resume', 'play', t('run.continue'), 'primary'), hbtn('stop', 'stop', t('run.stop')));
  else if (status === 'waiting_user' || status === 'queued') btns.push(hbtn('stop', 'stop', t('run.stop')));
  else if (['stopped', 'interrupted', 'failed'].includes(status)) btns.push(hbtn('resume', 'play', t('run.continue'), 'primary'));
  const plan = s.plan || [];
  const planDone = plan.filter((p) => p.status === 'done').length;
  const elapsed = (s.finishedAt ? new Date(s.finishedAt) : new Date()) - new Date(s.createdAt);
  const wbSet = set.workbuddy || {};
  const phase = isScheduled(s) ? t('run.scheduledAt', { time: fmtClock(s.scheduledAt) }) : status === 'running' ? tPhase(s.phase) : tStatus(status);
  const asideOpen = !$('#aside-drawer').classList.contains('hidden');
  const team = set.team?.mode && set.team.mode !== 'off' ? TEAM_MODES().find(([v]) => v === set.team.mode)?.[1] : '';
  const mode = set.agents?.mode && set.agents.mode !== 'normal' ? TASK_MODES().find(([v]) => v === set.agents.mode)?.[1] : '';
  $('#run-header').innerHTML = `
    <div class="head-row">
      <div class="chat-title" title="${esc(s.goal)}">${esc(firstLine(s.goal, 120))}</div>
      <div class="head-btns">
        ${plan.length ? hbtn('plan', 'list', t('run.planCount', { done: planDone, n: plan.length })) : ''}
        ${btns.join('')}
        <span class="sep"></span>
        <button class="icon-btn${asideOpen ? ' on' : ''}" type="button" data-act="aside" title="${esc(t('run.asideTitle'))}">${ICON.aside}</button>
        <button class="icon-btn" type="button" data-act="settings" title="${esc(t('run.adjust'))}">${ICON.sliders}</button>
        <button class="icon-btn" type="button" data-act="more" title="${esc(t('run.more'))}" aria-label="${esc(t('run.more'))}">${ICON.more}</button>
      </div>
    </div>
    <div class="chat-sub">
      <span class="status"><span class="sglyph ${esc(status)}"><span class="pip"></span></span>${esc(phase)}</span>
      <span>${esc(t('run.roundOf', { n: s.round, max: set.loop?.maxRounds ?? '?' }))}</span>
      <span>${esc(t('home.progress', { n: s.progress ?? 0 }))}</span>
      ${(() => {
        const d = fmtDuration(isScheduled(s) ? Date.parse(s.scheduledAt) - Date.now() : elapsed);
        return d ? `<span>${esc(isScheduled(s) ? t('run.startsIn', { d }) : t('run.elapsed', { d }))}</span>` : '';
      })()}
      <span title="${esc(`GPT: ${set.codex?.model || '-'} · ${set.codex?.effort ? tEffort(set.codex.effort) : ''}`)}">GPT ${esc(set.codex?.model || t('form.default'))}</span>
      ${purgeChip(purgeOf(s))}
      <span title="${esc(`WorkBuddy: ${wbModel(wbSet.model || 'auto').name} · ${wbEffortText(wbSet)}${wbSet.contextWindow ? ` · ${fmtCtx(wbSet.contextWindow)}` : ''}`)}">WorkBuddy ${esc(wbModel(wbSet.model || 'auto').name)}</span>
      ${team ? `<span class="chip-in">${ICON.team}${esc(team)}</span>` : ''}
      ${mode ? `<span class="chip-in">${esc(mode)}</span>` : ''}
      ${set.loop?.checkCommand ? `<span title="${esc(set.loop.checkCommand)}">${esc(t('run.checkOn'))}</span>` : ''}
      <span><a data-act="openDir" title="${esc(t('run.openDirTitle', { dir: s.workdir }))}">${esc(tailPath(s.workdir))}</a></span>
    </div>
    ${ACTIVE.has(status) ? `<div class="progress-line" style="width:${Math.max(0, Math.min(100, s.progress || 0))}%"></div>` : ''}`;
}

function renderNotice() {
  const s = app.state;
  if (!s) return;
  const box = $('#run-notice');
  const status = s.status;
  const show = (kind, icon, text, buttons = '') => {
    box.className = `notice ${kind}`;
    box.innerHTML = `<span class="msg"><span class="ic">${ICON[icon]}</span>${esc(text)}</span>${buttons ? `<span class="btns">${buttons}</span>` : ''}`;
  };
  const b = (act, text, kind = '') => `<button class="btn sm ${kind}" type="button" data-act="${act}">${esc(text)}</button>`;
  const message = msgText(s);
  let placeholder = t('run.placeholder');
  if (isScheduled(s)) {
    show('gold', 'clock', t('run.noticeScheduled', { time: fmtClock(s.scheduledAt) }), b('resume', t('run.startNow'), 'primary'));
  } else if (awaitingPlan(s)) {
    show('gold', 'list', t('run.noticePlan'), `${b('plan', t('run.viewPlan'))}${b('approve', t('run.approvePlan'), 'primary')}`);
    placeholder = t('run.placeholderPlan');
  } else if (status === 'paused' && message) {
    const needLogin = s.messageKey === 'srv.pause.wbLogin' || s.messageKey === 'srv.pause.wbAuth';
    show('warn', 'pause', message, `${needLogin ? b('wblogin', t('run.wbLogin')) : ''}${b('resume', t('run.continue'), 'primary')}`);
  } else if (status === 'waiting' && message) {
    show('warn', 'hourglass', message);
  } else if (status === 'failed' && message) {
    show('err', 'x', message, b('resume', t('run.retry'), 'primary'));
  } else if (status === 'stopped' && message && s.messageKey !== 'srv.stoppedCanContinue') {
    show('warn', 'stop', message, b('resume', t('run.continue'), 'primary'));
  } else if (status === 'interrupted') {
    show('warn', 'warn', t('run.noticeInterrupted'), b('resume', t('run.continue'), 'primary'));
  } else if (status === 'waiting_user') {
    show('warn', 'help', s.question ? t('run.noticeAskQ', { q: oneLine(s.question, 300) }) : t('run.noticeAsk'));
    placeholder = t('run.placeholderReply');
  } else if (status === 'done') {
    show('ok', 'check', t('run.noticeDone', { n: s.round }));
  } else {
    box.className = 'notice hidden';
    box.innerHTML = '';
  }
  if (['done', 'stopped', 'failed', 'interrupted'].includes(status)) placeholder = t('run.placeholderMore');
  if (isScheduled(s)) placeholder = t('run.placeholderScheduled');
  $('#msg-input').placeholder = placeholder;
  const teamRound = currentTeam();
  $('#composer-hint').innerHTML = [
    `<b>↩</b> ${esc(t('run.hintSend'))}`, `<b>⇧↩</b> ${esc(t('run.hintNewline'))}`,
    isRunning(s) ? `<b>⌥↩</b> ${esc(t('run.hintCut'))}` : '',
    `<b>/</b> ${esc(t('run.hintCommands'))}`, `<b>@</b> ${esc(t('run.hintFiles'))}`, `<b>#</b> ${esc(t('run.hintAgents'))}`,
    teamRound ? `<b>&gt;&gt;</b> ${esc(t('run.hintMates'))}` : '',
  ].filter(Boolean).join(' · ');
}

/** The team round in progress (its teammates can receive ">>name" messages through the board). */
function currentTeam() {
  const s = app.state;
  if (!s || !isRunning(s) || s.phase !== 'work') return null;
  const rec = (s.rounds || []).find((r) => r.round === s.round);
  return rec?.team?.length ? rec : null;
}

// ---------- actions ----------
export async function runAction(act, anchor) {
  const id = app.currentId;
  if (!id) return;
  try {
    if (act === 'pause' || act === 'stop' || act === 'resume') {
      await api(`/api/runs/${id}/control`, { method: 'POST', body: { cmd: act } });
      toast({ pause: t('run.toastPause'), stop: t('run.toastStop'), resume: isScheduled(app.state) ? t('run.toastStartNow') : t('run.toastResume') }[act]);
    } else if (act === 'approve') {
      await api(`/api/runs/${id}/control`, { method: 'POST', body: { cmd: 'approve', text: '' } });
      toast(t('run.toastApproved'));
    } else if (act === 'delete') {
      if (!(await confirmDialog({ title: t('run.deleteTitle'), text: t('run.deleteText'), ok: t('common.delete'), danger: true }))) return;
      await api(`/api/runs/${id}`, { method: 'DELETE' });
      location.hash = '#new';
    } else if (act === 'openDir') {
      await api('/api/open', { method: 'POST', body: { path: app.state.workdir } });
    } else if (act === 'wblogin') {
      actions.startWbLogin?.();
    } else if (act === 'settings') {
      runSettingsModal();
    } else if (act === 'alldiff') {
      actions.showDiff?.(`/api/runs/${id}/diff`, t('run.allChanges'));
    } else if (act === 'rollback') {
      actions.openRollback?.(id);
    } else if (act === 'export') {
      await exportRun();
    } else if (act === 'copy') {
      copyLast();
    } else if (act === 'compact') {
      await api(`/api/runs/${id}/control`, { method: 'POST', body: { cmd: 'compact' } });
      toast(t('run.toastCompact'));
    } else if (act === 'review') {
      openReview(app.state.workdir, id);
    } else if (act === 'notebook') {
      openNotebook(app.state.workdir);
    } else if (act === 'loop') {
      openLoops({ runId: id });
    } else if (act === 'aside') {
      toggleAside();
      renderHeader();
      return;
    } else if (act === 'purge') {
      openPopover(anchor, purgePopoverHtml(), { className: 'plan-pop-wrap' });
      return;
    } else if (act === 'plan') {
      openPopover(anchor || $('[data-act="plan"]', $('#run-header')) || $('#run-header'), planPopoverHtml(), { className: 'plan-pop-wrap' });
      return;
    } else if (act === 'more') {
      const canDelete = !ACTIVE.has(app.state?.status) || app.state?.status === 'queued';
      const pop = openPopover(anchor, [
        menuItem({ act: 'alldiff', icon: 'diff', label: t('run.allChanges') }),
        menuItem({ act: 'rollback', icon: 'rollback', label: t('run.rollback') }),
        menuItem({ act: 'review', icon: 'eye', label: t('run.review') }),
        menuItem({ act: 'export', icon: 'export', label: t('run.export') }),
        menuItem({ act: 'copy', icon: 'copy', label: t('run.copyLast') }),
        `<div class="menu-sep"></div>`,
        menuItem({ act: 'notebook', icon: 'book', label: t('run.notebook') }),
        menuItem({ act: 'loop', icon: 'repeat', label: t('run.loop') }),
        menuItem({ act: 'compact', icon: 'compress', label: t('run.compact') }),
        menuItem({ act: 'openDir', icon: 'finder', label: t('run.openInFinder') }),
        canDelete ? `<div class="menu-sep"></div>${menuItem({ act: 'delete', icon: 'trash', label: t('run.delete'), danger: true })}` : '',
      ].join(''));
      pop.onclick = (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        closePopover();
        runAction(btn.dataset.act, btn);
      };
      return;
    }
  } catch (err) {
    toast(err.message);
  }
  setTimeout(() => actions.refreshRuns?.(), 500);
}

for (const sel of ['#run-header', '#run-notice']) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) runAction(b.dataset.act, b);
  });
}

function planPopoverHtml() {
  const s = app.state;
  const st = s.stats || {};
  const items = (s.plan || []).map((p) => `<li class="${esc(p.status)}"><span class="mark">${p.status === 'done' ? '✓' : p.status === 'doing' ? '◆' : '○'}</span><span>${esc(p.title)}</span></li>`).join('');
  return `<div class="plan-pop"><h4>${esc(t('run.planTitle'))}</h4><ol>${items}</ol>
    <div class="stats">
      ${esc(t('run.statsGpt', { n: st.gptTurns || 0, input: fmtTokens(st.gptIn), cached: fmtTokens(st.gptCachedIn), output: fmtTokens(st.gptOut) }))}<br>
      ${esc(t('run.statsWb', { n: st.wbCalls || 0, input: fmtTokens(st.wbIn), output: fmtTokens(st.wbOut) }))}${st.teamRounds ? `<br>${esc(t('run.statsTeam', { n: st.teamRounds }))}` : ''}
    </div></div>`;
}

export function runSettingsModal() {
  const s = app.state;
  if (!s) return;
  const live = ACTIVE.has(s.status);
  const roundsHint = `${s.round ? `${t('run.nowRound', { n: s.round })} ` : ''}${t('form.maxRoundsHint')}`;
  const body = openModal(t('run.adjust'), '<div id="r-form"></div>', {
    subtitle: firstLine(s.goal, 60),
    size: 'mid',
    foot: `<span class="note">${esc(live ? t('run.adjustLive') : t('run.adjustLater'))}</span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="r-save">${esc(t('common.save'))}</button>`,
  });
  mountSettingsForm($('#r-form', body), 'r', s.settings, { roundsHint });
  $('#r-save').onclick = async () => {
    const patch = readSettingsForm($('#r-form', body), 'r');
    try {
      await api(`/api/runs/${s.id}/control`, { method: 'POST', body: { cmd: 'settings', patch } });
      toast(t('run.updated'));
      closeModal();
    } catch (err) {
      toast(err.message);
    }
  };
}

async function exportRun() {
  const r = await api(`/api/runs/${app.currentId}/export`, { method: 'POST', body: {} });
  toast(t('run.exported', { path: shortPath(r.path) }), { action: { label: t('run.showInFinder'), run: () => api('/api/reveal', { method: 'POST', body: { path: r.path } }).catch((err) => toast(err.message)) } });
}

function copyLast() {
  const text = app.t.lastGpt || app.t.lastWb;
  if (!text) {
    toast(t('run.nothingToCopy'));
    return;
  }
  copyText(text);
}

// ---------- the conversation ----------
const appendThread = (node) => $('#timeline').appendChild(node);
const emb = (kind) => `<span class="emb ${kind}">${EMBLEM[kind]}</span>`;

function ensureGoalBubble() {
  if (app.t.goal || !app.state) return;
  const s = app.state;
  app.t.goal = el(`<div class="msg right user">
    <div class="msg-head"><span class="meta">${esc(fmtTime(s.createdAt))}</span><span class="who">${esc(t('who.you'))}</span>${emb('user')}</div>
    <div class="card">${collapsible(md(s.goal), 'goal')}</div></div>`);
  $('#timeline').prepend(app.t.goal);
  fixCollapsibles(app.t.goal);
}

function userBubble(ev) {
  appendThread(el(`<div class="msg right user">
    <div class="msg-head">${ev.cut ? `<span class="tag">${esc(t('run.cutTag'))}</span>` : ''}<span class="meta">${esc(fmtTime(ev.t))}</span><span class="who">${esc(t('who.you'))}</span>${emb('user')}</div>
    <div class="card"><div class="md">${md(ev.text)}</div></div></div>`));
}

function sysLine(text, cls = '', time = '') {
  appendThread(el(`<div class="sys ${cls}"><span>${esc(text)}${time ? ` <span class="time">· ${esc(fmtTime(time))}</span>` : ''}</span></div>`));
}

function gptTitle(label) {
  if (label === 'plan') return t('gpt.title.plan');
  if (label.startsWith('audit-')) return t('gpt.title.audit', { n: label.slice(6) });
  if (label.startsWith('review-')) return t('gpt.title.review', { n: label.split('-')[1] || 1 });
  if (label.startsWith('followup-')) return t('gpt.title.followup');
  if (label.startsWith('wrapup-')) return t('gpt.title.wrapup');
  return label;
}

function ensureGptCard(label) {
  if (app.t.gpt.has(label)) return app.t.gpt.get(label);
  const rev = label.startsWith('review-');
  const wrap = label.startsWith('wrapup-');
  const node = appendThread(el(`
    <div class="msg right gpt${rev ? ' rev' : ''}${wrap ? ' wrap' : ''}">
      <div class="msg-head"><span class="meta g-meta"></span><span class="g-verdict"></span><span class="what">${esc(gptTitle(label))}</span><span class="who">${esc(rev ? t('who.reviewer') : 'GPT')}</span>${emb(rev ? 'rev' : 'gpt')}</div>
      <div class="card">
        <details class="g-steps hidden"><summary>${ICON.chev.replace('<svg', '<svg class="chev" width="10" height="10"')}<span class="g-n-label"></span></summary><ol class="steps"></ol></details>
        <div class="g-status"><span class="moonwait">${EMBLEM.user}</span><span class="txt">${esc(t('run.thinking'))}</span><span class="last"></span></div>
        <div class="g-body"></div>
      </div>
      <div class="msg-time"><button class="link" type="button" data-prompt="${esc(label)}">${esc(t('run.promptToGpt'))}</button></div>
    </div>`));
  const c = { node, label, n: 0, cmd: null, done: false };
  app.t.gpt.set(label, c);
  return c;
}

const gptCardFor = (ev) => ensureGptCard(ev.label || 'plan');

function addGptStep(c, html, cls = '', output = '') {
  const steps = $('.g-steps', c.node);
  steps.classList.remove('hidden');
  const li = el(`<li class="${cls}">${html}</li>`);
  if (output) li.dataset.out = output;
  $('.steps', c.node).appendChild(li);
  c.n += 1;
  $('.g-n-label', c.node).textContent = t('run.gptSteps', { n: c.n });
  return li;
}

function setGptLast(c, text) {
  if (c.done) return;
  $('.g-status .txt', c.node).textContent = t('run.checking');
  $('.g-status .last', c.node).textContent = text;
}

function renderGptResult(c, out, meta) {
  c.done = true;
  $('.g-status', c.node).classList.add('hidden');
  const key = `g-${c.label}`;
  const issues = (out.issues || []).map((i) => `<li class="${esc(i.severity)}"><span class="sev">${esc(tSeverity(i.severity))}</span>${mdInline(i.detail)}</li>`).join('');
  let html = collapsible(md(out.assessment || ''), `${key}-a`);
  if ((c.label === 'plan' || c.label.startsWith('wrapup-') || c.label.startsWith('followup-')) && out.plan?.length) html += `<ol class="plan-list">${out.plan.map((p) => `<li>${esc(p.title)}${p.status === 'done' ? ` <span class="badge">${esc(t('verdict.done'))}</span>` : ''}</li>`).join('')}</ol>`;
  if (issues) html += `<ul class="issues">${issues}</ul>`;
  if (out.verdict === 'ask_user' && out.question_for_user) {
    html += `<div class="handoff ask"><div class="handoff-label">${esc(t('run.needYou'))}</div><div class="handoff-body md">${md(out.question_for_user)}</div></div>`;
  }
  if (out.verdict === 'continue' && out.team?.length) {
    html += `<div class="handoff team"><div class="handoff-label">${ICON.team}${esc(t('run.toTeam', { n: out.team.length }))}</div>
      ${out.next_instruction ? `<div class="handoff-body">${collapsible(md(out.next_instruction), `${key}-i`)}</div>` : ''}
      <div class="assign-list">${out.team.map((m, i) => `<div class="assign"><div class="assign-head"><b>${esc(m.name)}</b>${m.role ? `<span class="muted">${esc(m.role)}</span>` : ''}${m.owns ? `<span class="owns mono" title="${esc(t('run.owns'))}">${esc(oneLine(m.owns, 80))}</span>` : ''}</div>${collapsible(md(m.instruction), `${key}-t${i}`)}</div>`).join('')}</div></div>`;
  } else if (out.verdict === 'continue' && out.next_instruction) {
    const label = c.label.startsWith('wrapup-') ? t('run.toWbAfterLimit') : c.label === 'plan' && app.state?.settings?.agents?.mode === 'plan' ? t('run.toWbAfterApproval') : t('run.toWb');
    html += `<div class="handoff"><div class="handoff-label">${emb('wb')}${esc(label)}</div><div class="handoff-body">${collapsible(md(out.next_instruction), `${key}-i`)}</div></div>`;
  }
  $('.g-body', c.node).innerHTML = html;
  $('.g-verdict', c.node).innerHTML = `<span class="verdict ${esc(out.verdict)}">${esc(tVerdict(out.verdict))}</span>`;
  $('.g-meta', c.node).textContent = [meta, Number.isFinite(out.progress) ? t('home.progress', { n: out.progress }) : ''].filter(Boolean).join(' · ');
  app.t.lastGpt = [out.assessment, out.next_instruction ? `\n${t('run.toWb')}:\n${out.next_instruction}` : ''].filter(Boolean).join('\n');
  fixCollapsibles(c.node);
}

// WorkBuddy: one message per round — the process (expandable), the report, changes, the check command.
// In Team Mode the round holds one lane per teammate, and changes/check belong to the whole round.
const WB_INNER = () => `
  <div class="process">
    <button class="process-toggle" type="button">${ICON.chev.replace('<svg', '<svg class="chev" width="10" height="10"')}<span class="p-label">${esc(t('run.process'))}</span></button>
    <div class="process-list"></div>
  </div>
  <div class="wb-waiting"><span class="spinner"></span>${esc(t('run.starting'))}</div>
  <div class="wb-report-wrap hidden"><div class="wb-section-label">${esc(t('run.report'))}</div><div class="wb-report"></div></div>
  <div class="wb-error hidden"></div>`;

function laneObject(node, n, member) {
  const c = { node, n, member, steps: 0, list: $('.process-list', node), liveNode: null, liveLabel: '', userToggled: false, ended: false };
  $('.process-toggle', node).onclick = () => {
    c.userToggled = true;
    setProcessOpen(c, !$('.process', node).classList.contains('open'));
  };
  if (app.caughtUp) setProcessOpen(c, true);
  return c;
}

function ensureWbCard(n) {
  if (app.t.wb.has(`${n}`)) return app.t.wb.get(`${n}`);
  const node = appendThread(el(`
    <div class="msg wb" id="wb-${n}">
      <div class="msg-head">${emb('wb')}<span class="who">WorkBuddy</span><span class="what">${esc(t('round.n', { n }))}</span><span class="meta w-meta"></span><span class="spacer"></span><button class="btn ghost xs act" type="button" data-prompt="wb-${n}">${esc(t('run.instructionReceived'))}</button></div>
      <div class="wb-body">${WB_INNER()}
        <div class="round-foot hidden"></div>
        <div class="checkline hidden"></div>
      </div>
    </div>`));
  const c = laneObject(node, n, null);
  c.round = node;
  app.t.wb.set(`${n}`, c);
  updateProcessLabel(c);
  return c;
}

function ensureTeamCard(n, members = null) {
  if (app.t.teams.has(n)) return app.t.teams.get(n);
  const node = appendThread(el(`
    <div class="msg wb team" id="wb-${n}">
      <div class="msg-head">${emb('wb')}<span class="who">${esc(t('run.wbTeam'))}</span><span class="what">${esc(t('round.n', { n }))}</span><span class="meta w-meta"></span><span class="spacer"></span><button class="btn ghost xs act" type="button" data-board="${n}">${ICON.list}${esc(t('team.board'))}</button></div>
      <div class="wb-body"><div class="lanes"></div>
        <div class="merge-line hidden"></div>
        <div class="round-foot hidden"></div>
        <div class="checkline hidden"></div>
      </div>
    </div>`));
  const team = { node, n, lanes: new Map(), members: members || [] };
  app.t.teams.set(n, team);
  return team;
}

function ensureLane(n, member, info = {}) {
  const key = `${n}:${member}`;
  if (app.t.wb.has(key)) return app.t.wb.get(key);
  const team = ensureTeamCard(n);
  const node = el(`<div class="lane" data-member="${esc(member)}">
      <div class="lane-head"><span class="lane-name">${esc(member)}</span><span class="lane-role muted">${esc(info.role || '')}</span><span class="meta w-meta"></span><span class="spacer"></span><button class="btn ghost xs act" type="button" data-prompt="wb-${n}-${esc(member)}">${esc(t('run.instructionReceived'))}</button></div>
      ${WB_INNER()}</div>`);
  $('.lanes', team.node).appendChild(node);
  const c = laneObject(node, n, member);
  c.round = team.node;
  app.t.wb.set(key, c);
  team.lanes.set(member, c);
  updateProcessLabel(c);
  return c;
}

const wbFor = (ev) => (ev.member ? ensureLane(ev.round, ev.member) : ensureWbCard(ev.round));
/** Round-level parts (changes, check): the team card when the round had teammates. */
const roundBox = (n) => (app.t.teams.get(n)?.node) || ensureWbCard(n).node;

function setProcessOpen(c, open) {
  $('.process', c.node).classList.toggle('open', open);
}

function updateProcessLabel(c) {
  const parts = [t('run.processSteps', { n: c.steps })];
  if (c.liveLabel) parts.push(c.liveLabel);
  else if (!c.ended && app.state && app.state.round === c.n && app.state.phase === 'work' && ACTIVE.has(app.state.status)) parts.push(t('run.inProgress'));
  $('.p-label', c.node).textContent = parts.join(' · ');
}

function openActiveProcess() {
  const s = app.state;
  if (!s || s.phase !== 'work' || !ACTIVE.has(s.status)) return;
  for (const [key, c] of app.t.wb) if (key === `${s.round}` || key.startsWith(`${s.round}:`)) setProcessOpen(c, true);
}

function wbContainer(c, parent) {
  if (parent) {
    const p = app.t.tools.get(parent);
    if (p) {
      let ch = $(':scope > .children', p.node);
      if (!ch) {
        ch = el('<div class="children"></div>');
        p.node.appendChild(ch);
      }
      return ch;
    }
  }
  return c.list;
}

function addWbStep(c, node, parent) {
  const box = wbContainer(c, parent);
  if (box === c.list && c.liveNode) c.list.insertBefore(node, c.liveNode);
  else box.appendChild(node);
  $('.wb-waiting', c.node).classList.add('hidden');
  return node;
}

function changeStats(oldStr, newStr) {
  const a = String(oldStr ?? '').split('\n');
  const b = String(newStr ?? '').split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e += 1;
  return { s, e, a, b, del: a.length - s - e, add: b.length - s - e };
}

function diffLines(oldStr, newStr) {
  const { s, e, a, b } = changeStats(oldStr, newStr);
  const out = [];
  a.slice(Math.max(0, s - 2), s).forEach((l) => out.push(`<span class="dl ctx">  ${esc(l)}</span>`));
  a.slice(s, a.length - e).forEach((l) => out.push(`<span class="dl del">- ${esc(l)}</span>`));
  b.slice(s, b.length - e).forEach((l) => out.push(`<span class="dl add">+ ${esc(l)}</span>`));
  a.slice(a.length - e, Math.min(a.length, a.length - e + 2)).forEach((l) => out.push(`<span class="dl ctx">  ${esc(l)}</span>`));
  return out.join('');
}

function toolStat(name, input) {
  if (!input) return '';
  if (name === 'Edit') {
    const d = changeStats(input.old, input.new);
    return `+${d.add} −${d.del}`;
  }
  if (name === 'MultiEdit') {
    let add = 0;
    let del = 0;
    for (const x of input.edits || []) {
      const d = changeStats(x.old, x.new);
      add += d.add;
      del += d.del;
    }
    return `+${add} −${del}`;
  }
  if (name === 'Write' && input.lines) return t('run.lines', { n: input.lines });
  return '';
}

const dblock = (head, body, cls = '') => `<div class="dblock"><div class="dhead"><span>${head}</span></div><pre class="dpre ${cls}">${body}</pre></div>`;

function renderToolDetail(x) {
  const i = x.input || {};
  const parts = [];
  switch (x.name) {
    case 'Bash':
    case 'PowerShell':
      parts.push(dblock(esc(i.description || t('run.command')), esc(i.command ?? x.summary)));
      break;
    case 'Edit':
      parts.push(dblock(`${esc(i.file || x.summary)}${i.all ? ` ${esc(t('run.replaceAll'))}` : ''}`, diffLines(i.old ?? '', i.new ?? '')));
      break;
    case 'MultiEdit':
      (i.edits || []).forEach((e, k) => parts.push(dblock(`${esc(i.file || x.summary)} · #${k + 1}`, diffLines(e.old, e.new))));
      break;
    case 'Write':
      if (i.content != null) parts.push(dblock(`${esc(i.file || x.summary)} · ${esc(t('run.lines', { n: i.lines ?? '?' }))}`, esc(i.content)));
      break;
    case 'NotebookEdit':
      parts.push(dblock(esc(i.file || x.summary), esc(i.source || '')));
      break;
    case 'Agent':
    case 'Task':
      if (i.prompt) parts.push(dblock(`${esc(t('run.toSubagent'))}${i.type ? ` #${esc(i.type)}` : ''}: ${esc(i.description || '')}`, esc(i.prompt)));
      break;
    case 'WebFetch':
      if (i.prompt) parts.push(dblock(esc(i.url || ''), esc(i.prompt)));
      break;
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
      break;
    default:
      if (i.json && i.json !== '{}') parts.push(dblock(esc(t('run.args')), esc(i.json)));
  }
  if (x.result != null) parts.push(dblock(esc(x.isError ? t('run.error') : t('run.result')), esc(x.result || t('run.noOutput')), x.isError ? 'err' : ''));
  else parts.push(`<div class="muted" style="font-size:12px;margin:4px 0"><span class="spinner"></span> ${esc(t('run.running'))}</div>`);
  return parts.join('');
}

function toggleToolDetail(step) {
  const x = app.t.tools.get(step.dataset.tool);
  if (!x) return;
  let d = $(':scope > .step-detail', step);
  if (d) {
    d.remove();
    step.classList.remove('open');
    return;
  }
  d = el(`<div class="step-detail">${renderToolDetail(x)}</div>`);
  const ch = $(':scope > .children', step);
  if (ch) step.insertBefore(d, ch);
  else step.appendChild(d);
  step.classList.add('open');
}

/** A string field of a still-incomplete tool-argument JSON (what has been generated so far), for the live view. */
function partialJsonField(json, key) {
  const m = json.match(new RegExp(`"${key}"\\s*:\\s*"`));
  if (!m) return null;
  let out = '';
  for (let i = m.index + m[0].length; i < json.length; i += 1) {
    const ch = json[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const nx = json[i + 1];
    if (nx === undefined) break;
    if (nx === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += { n: '\n', t: '\t', r: '', b: '', f: '' }[nx] ?? nx;
    i += 1;
  }
  return out;
}

function liveToolView(b, workdir) {
  const file = partialJsonField(b.text, 'file_path');
  const body = ['content', 'new_string', 'command', 'prompt', 'query', 'url', 'pattern']
    .map((k) => partialJsonField(b.text, k)).find((v) => v != null);
  const rel = file && workdir && file.startsWith(`${workdir}/`) ? file.slice(workdir.length + 1) : file;
  return { label: t('run.preparing', { tool: toolText(b.name), file: rel || '' }).trim(), text: body ?? b.text };
}

function renderLive(snap) {
  const c = snap.member ? app.t?.wb.get(`${snap.round}:${snap.member}`) : app.t?.wb.get(`${snap.round}`);
  if (!c) return;
  const workdir = snap.member ? null : app.state?.workdir;
  const blocks = (snap.blocks || []).filter((b) => b.text && b.text.trim()).map((b) => (b.type === 'tool' ? { ...b, ...liveToolView(b, workdir) } : b));
  if (!blocks.length || c.ended) {
    c.liveNode?.remove();
    c.liveNode = null;
    c.liveLabel = '';
    updateProcessLabel(c);
    return;
  }
  const label = (b) => (b.type === 'thinking' ? t('run.liveThinking') : b.type === 'tool' ? b.label : t('run.liveWriting'));
  const tail = (s) => (s.length > 3000 ? `…${s.slice(-3000)}` : s);
  if (!c.liveNode) {
    c.liveNode = el('<div class="step live-wrap"></div>');
    c.list.appendChild(c.liveNode);
  }
  c.liveNode.innerHTML = blocks.map((b, k) => `<div class="live ${esc(b.type)}"><div class="live-label">${k === blocks.length - 1 ? '<span class="spinner"></span>' : ''}${esc(label(b))}</div><div class="live-text">${esc(tail(b.text))}${k === blocks.length - 1 ? '<span class="caret"></span>' : ''}</div></div>`).join('');
  c.liveNode.querySelectorAll('.live-text').forEach((x) => {
    x.scrollTop = x.scrollHeight;
  });
  $('.wb-waiting', c.node).classList.add('hidden');
  c.liveLabel = `${label(blocks[blocks.length - 1])}…`;
  updateProcessLabel(c);
}

function workerMeta(w) {
  return [w.model, w.toolCount != null ? t('run.tools', { n: w.toolCount }) : '', w.durationMs ? fmtDuration(w.durationMs) : '', w.continuations ? t('run.continued', { n: w.continuations }) : ''].filter(Boolean).join(' · ');
}

function syncWbFromState() {
  const s = app.state;
  if (!s) return;
  for (const c of app.t.wb.values()) {
    const rec = (s.rounds || []).find((r) => r.round === c.n);
    const w = c.member ? rec?.teamState?.[c.member]?.worker : rec?.worker;
    if (w && !w.team) $('.w-meta', c.node).textContent = workerMeta(w);
    const done = c.member ? rec?.teamState?.[c.member]?.done : false;
    if (rec && (done || rec.audit || s.round > c.n || !ACTIVE.has(s.status)) && !c.ended) {
      c.ended = true;
      c.liveNode?.remove();
      c.liveNode = null;
      c.liveLabel = '';
      $('.wb-waiting', c.node).classList.add('hidden');
    }
    updateProcessLabel(c);
  }
}

function renderCheck(n, ev) {
  const box = $('.checkline', roundBox(n));
  box.classList.remove('hidden');
  if (!ev) {
    box.className = 'checkline';
    box.innerHTML = `<span class="spinner"></span><span>${esc(t('run.checkRunning'))}</span>`;
    return;
  }
  app.t.checks.set(n, ev.output || '');
  const res = ev.timedOut ? t('check.timedOut') : ev.ok ? t('check.passed') : t('check.failed', { code: ev.code });
  box.className = `checkline ${ev.ok ? 'ok' : 'fail'}`;
  box.innerHTML = `<span>${esc(t('form.check'))}</span><span class="cmd">$ ${esc(oneLine(ev.command, 80))}</span><span class="res">${ev.ok ? ICON.check.replace('<svg', '<svg width="13" height="13"') : ''}${esc(res)}</span><span class="muted">${esc(fmtDuration(ev.durationMs))}</span><button class="btn ghost xs" type="button" data-check="${n}">${esc(t('run.output'))}</button>`;
}

/** A sensitive-command rule's name in the current language (built-in rules are translated; custom ones are the user's text). */
function ruleText(rule) {
  if (!rule) return '';
  const k = `safety.rule.${rule.id}`;
  const v = rule.builtin !== false ? t(k) : k;
  return v !== k ? v : rule.description || rule.id || '';
}

function hookText(ev) {
  if (ev.blocked) return t('run.hookBlocked', { type: ev.type, msg: ev.blocked });
  return t('run.hookRan', { type: ev.type, n: ev.ran }) + (ev.member ? ` · ${ev.member}` : '');
}

function handleEvent(ev) {
  switch (ev.kind) {
    case 'gpt.start': {
      const c = gptCardFor(ev);
      app.t.prompts.set(ev.label, ev.prompt);
      if (!c.done) $('.g-status .txt', c.node).textContent = ev.resume ? t('run.thinking') : t('run.newSessionThinking');
      break;
    }
    case 'gpt.item': {
      const c = gptCardFor(ev);
      if (ev.itemType === 'command_execution') {
        if (ev.phase === 'started') {
          c.cmd = addGptStep(c, `<span class="ic"><span class="spinner"></span></span><span class="sum">$ ${esc(ev.command)}</span>`);
          setGptLast(c, `$ ${oneLine(ev.command, 120)}`);
        } else {
          const html = `<span class="ic">${ev.exitCode === 0 ? '✓' : '✗'}</span><span class="sum">$ ${esc(ev.command)}${ev.exitCode !== 0 && ev.exitCode != null ? ` (exit ${ev.exitCode})` : ''}</span>`;
          const cls = ev.exitCode === 0 ? 'ok' : 'fail';
          if (c.cmd) {
            c.cmd.innerHTML = html;
            c.cmd.className = cls;
            if (ev.output) c.cmd.dataset.out = ev.output;
            c.cmd = null;
          } else addGptStep(c, html, cls, ev.output || '');
        }
      } else if (ev.itemType === 'reasoning' && ev.text) {
        addGptStep(c, `<span class="ic">◦</span><span>${esc(oneLine(ev.text, 400))}</span>`, 'thinking');
        setGptLast(c, oneLine(ev.text, 80));
      } else if (ev.itemType === 'agent_message' && ev.text && !ev.text.trim().startsWith('{')) {
        addGptStep(c, `<span class="ic">›</span><span>${esc(oneLine(ev.text, 500))}</span>`, 'text');
      } else if (ev.itemType === 'web_search') {
        addGptStep(c, `<span class="ic">↗</span><span class="sum">${esc(ev.text)}</span>`);
        setGptLast(c, `${t('run.searching')} ${oneLine(ev.text, 80)}`);
      } else if (ev.itemType === 'mcp_tool_call') {
        addGptStep(c, `<span class="ic">⌁</span><span class="sum">${esc(ev.text)}</span>`);
      } else if (ev.itemType === 'file_change') {
        addGptStep(c, `<span class="ic">✎</span><span class="sum">${esc((ev.changes || []).join(', '))}</span>`);
      } else if (ev.itemType === 'error' && ev.text && !/metadata/i.test(ev.text)) {
        addGptStep(c, `<span class="ic">!</span><span class="sum">${esc(ev.text)}</span>`, 'err');
      }
      break;
    }
    case 'gpt.result': {
      const c = gptCardFor(ev);
      renderGptResult(c, ev.output, [ev.model, ev.durationMs ? fmtDuration(ev.durationMs) : ''].filter(Boolean).join(' · '));
      break;
    }
    case 'gpt.error': {
      const c = gptCardFor(ev);
      addGptStep(c, `<span class="ic">!</span><span>${esc(oneLine(ev.message, 400))}</span>`, 'err');
      if (!c.done) $('.g-status .txt', c.node).textContent = t('run.gptErrorRetry');
      break;
    }
    case 'team.start': {
      const team = ensureTeamCard(ev.round, ev.members.map((m) => m.name));
      for (const m of ev.members) ensureLane(ev.round, m.name, m);
      team.members = ev.members.map((m) => m.name);
      break;
    }
    case 'team.merging':
      sysLine(t('run.teamMerging', { n: ev.round }), 'gold', ev.t);
      break;
    case 'team.merged': {
      const team = app.t.teams.get(ev.round);
      const line = team && $('.merge-line', team.node);
      const text = ev.conflicts.length ? t('run.teamConflicts', { n: ev.conflicts.length, files: ev.conflicts.slice(0, 6).join(', ') }) : t('run.teamMerged', { names: ev.merged.join(', ') || '-' });
      if (line) {
        line.classList.remove('hidden');
        line.className = `merge-line${ev.conflicts.length ? ' warn' : ''}`;
        line.innerHTML = `${ICON.team}<span>${esc(text)}</span>${ev.errors?.length ? `<span class="error">${esc(ev.errors.join('; '))}</span>` : ''}`;
      } else sysLine(text, ev.conflicts.length ? 'warn' : 'gold', ev.t);
      break;
    }
    case 'team.note':
      sysLine(t('run.boardNote', { to: ev.member || t('team.everyone'), text: oneLine(ev.text, 160) }), 'gold', ev.t);
      break;
    case 'wb.start': {
      const c = wbFor(ev);
      const pkey = ev.member ? `wb-${ev.round}-${ev.member}` : `wb-${ev.round}`;
      // "instruction received" keeps the first full instruction of the round (continuations are short notes)
      if (!ev.continuation || !app.t.prompts.has(pkey)) app.t.prompts.set(pkey, ev.prompt);
      c.ended = false;
      if (ev.continuation) addWbStep(c, el(`<div class="divider">↻ ${esc(ev.resume ? t('run.continuedResume') : t('run.continuedNew'))} · ${esc(fmtTime(ev.t))}</div>`));
      updateProcessLabel(c);
      break;
    }
    case 'wb.init': {
      const c = wbFor(ev);
      const meta = $('.w-meta', c.node);
      if (ev.model && !meta.textContent) meta.textContent = ev.model;
      break;
    }
    case 'wb.text': {
      const c = wbFor(ev);
      addWbStep(c, el(`<div class="step text"><div class="md">${md(ev.text || '')}</div></div>`), ev.parent);
      break;
    }
    case 'wb.thinking': {
      const c = wbFor(ev);
      const node = el(`<div class="step thinking"><div class="step-row"><span class="st">◦</span><span class="tname">${esc(t('run.think'))}</span><span class="tsum">${esc(oneLine(ev.text, 160))}</span></div></div>`);
      app.t.thinking.set(node, ev.text || '');
      addWbStep(c, node, ev.parent);
      break;
    }
    case 'wb.tool': {
      const c = wbFor(ev);
      const stat = toolStat(ev.name, ev.input);
      const risky = (ev.name === 'Bash' || ev.name === 'PowerShell') && RISKY_RE.test(ev.input?.command || ev.summary || '');
      const sub = ev.name === 'Agent' && ev.input?.type ? `<span class="agent-tag">#${esc(ev.input.type)}</span>` : '';
      const node = el(`<div class="step tool${MINOR_TOOLS.test(ev.name) ? ' minor' : ''}" data-tool="${esc(ev.id)}"><div class="step-row" title="${esc(ev.name)}"><span class="st"><span class="spinner"></span></span><span class="tname">${esc(toolText(ev.name))}</span>${sub}${risky ? `<span class="risk" title="${esc(t('run.riskyTitle'))}">${esc(t('run.risky'))}</span>` : ''}<span class="tsum">${esc(ev.summary || '')}</span>${stat ? `<span class="tstat">${esc(stat)}</span>` : ''}</div></div>`);
      app.t.tools.set(ev.id, { node, name: ev.name, input: ev.input || null, summary: ev.summary, result: null, isError: false });
      addWbStep(c, node, ev.parent);
      if (!ev.parent) {
        c.steps += 1;
        updateProcessLabel(c);
      }
      break;
    }
    case 'wb.tool_result': {
      const x = app.t.tools.get(ev.id);
      if (!x) break;
      x.result = ev.text ?? '';
      x.isError = Boolean(ev.isError);
      x.node.classList.add(ev.isError ? 'fail' : 'ok');
      $(':scope > .step-row .st', x.node).textContent = ev.isError ? '✗' : '✓';
      const d = $(':scope > .step-detail', x.node);
      if (d) d.innerHTML = renderToolDetail(x);
      break;
    }
    case 'wb.end': {
      const c = wbFor(ev);
      c.liveNode?.remove();
      c.liveNode = null;
      c.liveLabel = '';
      $('.wb-waiting', c.node).classList.add('hidden');
      if (!ev.ok) {
        const cut = ev.errorKind === 'cut';
        addWbStep(c, el(`<div class="divider${cut ? '' : ' err'}">${cut ? `■ ${esc(t('srv.wb.cut'))}` : esc(t('export.notFinished', { err: oneLine((ev.errors || []).join('; '), 300) }))}</div>`));
      }
      if (ev.resultText) {
        const wrap = $('.wb-report-wrap', c.node);
        wrap.classList.remove('hidden');
        $('.wb-report', c.node).innerHTML = collapsible(md(ev.resultText), `report-${ev.round}-${ev.member || ''}`);
        app.t.lastWb = ev.resultText;
        if (app.caughtUp) fixCollapsibles(wrap);
      }
      if (ev.member) {
        c.ended = true;
        if (!c.userToggled) setProcessOpen(c, false);
      }
      updateProcessLabel(c);
      break;
    }
    case 'round.diff': {
      const box = roundBox(ev.round);
      const foot = $('.round-foot', box);
      foot.classList.remove('hidden');
      if (ev.files) {
        const add = ev.files.reduce((n, f) => n + (Number(f.add) || 0), 0);
        const del = ev.files.reduce((n, f) => n + (Number(f.del) || 0), 0);
        const files = ev.files.slice(0, 80).map((f) => `<li><span class="st ${esc(f.status)}">${esc(f.status)}</span><span>${esc(f.path)}</span><span class="num"><span class="add">+${esc(f.add)}</span> <span class="del">-${esc(f.del)}</span></span></li>`).join('');
        foot.innerHTML = ev.files.length
          ? `<span>${esc(t('run.changedFiles', { n: ev.files.length }))}</span><span class="num add">+${add}</span><span class="num del">−${del}</span><button class="btn ghost xs" type="button" data-files>${ICON.list}${esc(t('run.files'))}</button><button class="btn ghost xs" type="button" data-diff="${ev.round}">${ICON.diff}diff</button><button class="btn ghost xs" type="button" data-rollback="${ev.round}" title="${esc(t('run.rollbackTitle'))}">${ICON.rollback}${esc(t('run.rollbackShort'))}</button><ul class="files hidden" style="flex-basis:100%">${files}</ul>`
          : `<span class="muted">${esc(t('export.noChanges'))}</span>`;
      } else {
        foot.innerHTML = `<span class="muted">${esc(ev.disabled || t('run.noSnapshot'))}${ev.touched?.length ? ` · ${esc(t('run.touched', { files: ev.touched.slice(0, 20).join(', ') }))}` : ''}</span>`;
      }
      break;
    }
    case 'check.start':
      if (ev.scope !== 'review') renderCheck(ev.round, null);
      break;
    case 'round.check':
      if (ev.scope === 'review') {
        sysLine(t('run.reviewCheck', { result: ev.ok ? t('check.passed') : ev.timedOut ? t('check.timedOut') : t('check.failed', { code: ev.code }) }), ev.ok ? '' : 'warn', ev.t);
        break;
      }
      renderCheck(ev.round, ev);
      break;
    case 'audit.start': {
      // this round's work is over: collapse processes nobody opened by hand, to keep the conversation tidy
      for (const [key, c] of app.t.wb) {
        if (key !== `${ev.round}` && !key.startsWith(`${ev.round}:`)) continue;
        c.ended = true;
        if (!c.userToggled) setProcessOpen(c, false);
        updateProcessLabel(c);
      }
      break;
    }
    case 'phase':
      if (ev.phase === 'plan') ensureGptCard('plan');
      break;
    case 'plan.approval':
      sysLine(t('run.planAwaiting'), 'gold', ev.t);
      break;
    case 'plan.approved':
      sysLine(ev.note ? t('run.planApprovedNote', { note: ev.note }) : t('run.planApproved'), 'gold', ev.t);
      break;
    case 'approval.request':
      app.t.approvals.set(ev.id, { ...ev, result: null });
      sysLine(t('run.approvalAsked', { cmd: oneLine(ev.command, 90), rule: ruleText(ev.rule) }) + (ev.member ? ` · ${ev.member}` : ''), 'warn', ev.t);
      renderApprovals();
      break;
    case 'approval.result':
      if (ev.id && app.t.approvals.has(ev.id)) app.t.approvals.get(ev.id).result = ev;
      if (ev.decision !== 'allow' || (ev.by !== 'policy' && ev.by !== 'always')) {
        sysLine(t('run.approvalResult', { cmd: oneLine(ev.command, 90), decision: t(`approval.${ev.decision}`), by: t(`approvalBy.${ev.by}`) }), ev.decision === 'allow' ? 'gold' : 'warn', ev.t);
      }
      renderApprovals();
      break;
    case 'hook':
      if (ev.blocked || ev.prompt || !app.caughtUp || (app.env?.config?.ui?.density || 'full') === 'full') {
        appendThread(el(`<div class="sys hook${ev.blocked ? ' err' : ''}"><span>${ICON.hook}${esc(hookText(ev))} <span class="time">· ${esc(fmtTime(ev.t))}</span></span></div>`));
      }
      break;
    case 'loop.fire':
      sysLine(t('run.loopFired', { text: oneLine(ev.text, 120) }), 'gold', ev.t);
      break;
    case 'schedule':
      sysLine(t('run.scheduleLine', { time: fmtClock(ev.at) }), 'gold', ev.t);
      break;
    case 'restore':
      sysLine(t('run.restored', { label: ev.labelKey ? t(ev.labelKey, ev.labelParams) : ev.label, n: ev.files ?? '?' }), 'gold', ev.t);
      break;
    case 'info':
      sysLine(msgText(ev, 'text'), '', ev.t);
      break;
    case 'wait':
      sysLine(t('run.waitLine', { reason: ev.key ? t(ev.key, ev.params) : ev.reason }), 'warn', ev.t);
      break;
    case 'error':
      sysLine(t('run.errorLine', { msg: ev.message }), 'err', ev.t);
      break;
    case 'user.message':
      userBubble(ev);
      break;
    case 'ask':
      sysLine(t('run.askLine'), 'warn', ev.t);
      break;
    case 'run.status':
      if (['paused', 'stopped', 'failed'].includes(ev.status) && (ev.message || ev.key)) sysLine(`${tStatus(ev.status)}: ${msgText(ev)}`, ev.status === 'failed' ? 'err' : 'warn', ev.t);
      break;
    case 'done': {
      const failed = ev.aborted;
      appendThread(el(`
        <div class="final${failed ? ' failed' : ''}">
          <div class="laurel">${failed ? ICON.x.replace('<svg', '<svg width="30" height="30"') : LAUREL}</div>
          <h4>${esc(failed ? t('final.aborted') : t('final.done'))}</h4>
          ${failed ? '' : `<div class="verse">${esc(DONE_VERSE.text)}<small>— ${esc(DONE_VERSE.src)}</small></div>`}
          <div class="meta">${esc(t('run.finalMeta', { n: ev.rounds, time: fmtTime(ev.t) }))}</div>
          ${ev.summary ? `<div class="md">${collapsible(md(ev.summary), `done-${ev.t}`)}</div>` : ''}
          <div class="btns"><button class="btn sm" type="button" data-alldiff="1">${ICON.diff}${esc(t('run.allChanges'))}</button><button class="btn sm" type="button" data-export="1">${ICON.export}${esc(t('run.export'))}</button><button class="btn sm ghost" type="button" data-act2="openDir">${ICON.finder}${esc(t('run.openInFinder'))}</button></div>
        </div>`));
      if (app.caughtUp) fixCollapsibles($('#timeline').lastElementChild);
      break;
    }
    default:
      break;
  }
}

$('#timeline').addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const key = toggle.dataset.toggle;
    const box = toggle.previousElementSibling;
    const open = !box.classList.contains('open');
    box.classList.toggle('open', open);
    toggle.textContent = open ? t('ui.collapse') : t('ui.expand');
    if (open) app.expanded.add(key);
    else app.expanded.delete(key);
    return;
  }
  const promptBtn = e.target.closest('[data-prompt]');
  if (promptBtn) {
    const text = app.t.prompts.get(promptBtn.dataset.prompt);
    openModal(promptBtn.dataset.prompt.startsWith('wb-') ? t('run.wbPromptTitle') : t('run.gptPromptTitle'), text ? `<pre class="prompt">${esc(text)}</pre>` : `<p class="muted">${esc(t('run.notSentYet'))}</p>`, { size: 'mid' });
    return;
  }
  const board = e.target.closest('[data-board]');
  if (board) {
    const n = Number(board.dataset.board);
    openBoard(app.currentId, n, app.t.teams.get(n)?.members || []);
    return;
  }
  const filesBtn = e.target.closest('[data-files]');
  if (filesBtn) {
    filesBtn.parentElement.querySelector('.files')?.classList.toggle('hidden');
    return;
  }
  const checkBtn = e.target.closest('[data-check]');
  if (checkBtn) {
    openModal(t('run.checkOutputTitle'), `<pre class="prompt">${esc(app.t.checks.get(Number(checkBtn.dataset.check)) || t('run.noOutput'))}</pre>`, { size: 'mid', subtitle: t('run.checkOutputSubtitle') });
    return;
  }
  const diffBtn = e.target.closest('[data-diff]');
  if (diffBtn) return actions.showDiff?.(`/api/runs/${app.currentId}/rounds/${diffBtn.dataset.diff}/diff`, t('run.roundChanges', { n: diffBtn.dataset.diff }));
  const rb = e.target.closest('[data-rollback]');
  if (rb) return actions.openRollback?.(app.currentId, Number(rb.dataset.rollback));
  if (e.target.closest('[data-alldiff]')) return actions.showDiff?.(`/api/runs/${app.currentId}/diff`, t('run.allChanges'));
  if (e.target.closest('[data-export]')) return exportRun().catch((err) => toast(err.message));
  if (e.target.closest('[data-act2="openDir"]')) {
    api('/api/open', { method: 'POST', body: { path: app.state?.workdir } }).catch((err) => toast(err.message));
    return;
  }
  const out = e.target.closest('li[data-out]');
  if (out) {
    const shown = $(':scope > .out', out);
    if (shown) shown.remove();
    else out.appendChild(el(`<pre class="dpre out">${esc(out.dataset.out)}</pre>`));
    return;
  }
  const row = e.target.closest('.step-row');
  if (row) {
    const step = row.parentElement;
    if (step.dataset.tool) {
      toggleToolDetail(step);
    } else if (step.classList.contains('thinking')) {
      const full = $(':scope > .thinking-full', step);
      if (full) full.remove();
      else step.appendChild(el(`<div class="thinking-full">${esc(app.t.thinking.get(step) || '')}</div>`));
    }
  }
});

// ---------- sensitive-command approvals (above the composer) ----------
let approvalTimer = null;

function pendingApprovals() {
  return [...(app.t?.approvals?.values() || [])].filter((a) => !a.result && Date.parse(a.expiresAt) > Date.now());
}

function renderApprovals() {
  const box = $('#approvals');
  if (!app.caughtUp) return;
  const list = pendingApprovals();
  box.innerHTML = list.map((a) => {
    const left = Math.max(0, Date.parse(a.expiresAt) - Date.now());
    return `<div class="approval" data-req="${esc(a.id)}">
      <div class="ap-head">${ICON.shield}<b>${esc(t('approval.title'))}</b><span class="muted">${esc(ruleText(a.rule))}</span>${a.member ? `<span class="pk-tag">${esc(a.member)}</span>` : ''}<span class="spacer"></span><span class="ap-left">${esc(t('approval.autoDeny', { d: fmtDuration(left) }))}</span></div>
      <pre class="ap-cmd">$ ${esc(a.command)}</pre>
      <div class="ap-actions"><input type="text" class="ap-reason" placeholder="${esc(t('approval.reasonPlaceholder'))}" autocomplete="off"><button class="btn sm" type="button" data-ap="deny">${esc(t('approval.btnDeny'))}</button><button class="btn sm" type="button" data-ap="always" title="${esc(t('approval.alwaysTitle'))}">${esc(t('approval.always'))}</button><button class="btn sm primary" type="button" data-ap="allow">${esc(t('approval.btnAllow'))}</button></div>
    </div>`;
  }).join('');
  if (list.length && !approvalTimer) approvalTimer = setInterval(() => renderApprovalsTick(), 1000);
  if (!list.length && approvalTimer) {
    clearInterval(approvalTimer);
    approvalTimer = null;
  }
}

function renderApprovalsTick() {
  const list = pendingApprovals();
  if (list.length !== $$('#approvals .approval').length) {
    renderApprovals();
    return;
  }
  for (const a of list) {
    const left = $(`#approvals [data-req="${a.id}"] .ap-left`);
    if (left) left.textContent = t('approval.autoDeny', { d: fmtDuration(Math.max(0, Date.parse(a.expiresAt) - Date.now())) });
  }
}

$('#approvals').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ap]');
  if (!b) return;
  const card = b.closest('[data-req]');
  const id = card.dataset.req;
  const reason = $('.ap-reason', card)?.value.trim() || '';
  const kind = b.dataset.ap;
  try {
    await api(`/api/runs/${app.currentId}/approvals/${id}`, { method: 'POST', body: { decision: kind === 'deny' ? 'deny' : 'allow', always: kind === 'always', reason } });
    card.remove();
    toast(kind === 'deny' ? t('approval.toastDenied') : t('approval.toastAllowed'));
  } catch (err) {
    toast(err.message);
  }
});

// ---------- the composer: message / reply / new requirement / interrupt / >> teammate ----------
const msgInput = $('#msg-input');
let msgComposer = null;

function clearInput() {
  msgInput.value = '';
  autosize(msgInput, 240);
  $('#btn-send').disabled = true;
}

async function sendMessage(text, { cut = false } = {}) {
  if (!text || !app.currentId) return;
  if (msgComposer.runSlash(text)) {
    clearInput();
    return;
  }
  // ">>name message" goes to a teammate's board (Team Mode)
  const mate = text.match(/^\s*>>(\S+)\s+([\s\S]+)$/);
  if (mate) {
    const team = currentTeam();
    if (!team) {
      toast(t('run.noTeamNow'));
      return;
    }
    try {
      await api(`/api/runs/${app.currentId}/board`, { method: 'POST', body: { round: team.round, member: mate[1], text: mate[2] } });
      msgComposer.remember(text);
      clearInput();
      toast(t('run.boardPosted', { name: mate[1] }));
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  let body = text;
  try {
    const expanded = await expandInjections(text, app.state?.workdir);
    if (expanded == null) {
      msgComposer.remember(text);
      clearInput();
      return;
    }
    body = expanded;
  } catch (err) {
    toast(err.message);
    return;
  }
  const running = isRunning(app.state);
  try {
    const r = await api(`/api/runs/${app.currentId}/control`, { method: 'POST', body: { cmd: cut && running ? 'cut' : 'message', text: body } });
    msgComposer.remember(text);
    clearInput();
    toast(r.started ? t('run.toastSubmitted') : cut && running ? t('run.toastCut') : app.state?.status === 'waiting_user' ? t('run.toastReplied') : t('run.toastMessage'));
    setTimeout(() => actions.refreshRuns?.(), 600);
  } catch (err) {
    toast(err.message);
  }
}

function insertIntoMessage(text) {
  msgInput.value = msgInput.value.trim() ? `${msgInput.value.replace(/\s+$/, '')}\n\n${text}` : text;
  autosize(msgInput, 240);
  $('#btn-send').disabled = !msgInput.value.trim();
  msgInput.focus();
  msgInput.setSelectionRange(msgInput.value.length, msgInput.value.length);
}

async function patchSettings(patch, valid, okText) {
  if (!valid) {
    toast(t('run.badArg'));
    return;
  }
  try {
    await api(`/api/runs/${app.currentId}/control`, { method: 'POST', body: { cmd: 'settings', patch } });
    toast(okText);
  } catch (err) {
    toast(err.message);
  }
}

/** Slash commands in the task view (custom commands from settings/projects come last). */
function runCommands() {
  const s = app.state;
  if (!s) return [];
  const running = isRunning(s);
  const set = s.settings || {};
  const list = [
    running && { name: 'cut', label: t('cmd.cut'), desc: t('cmd.cutDesc'), arg: t('cmd.argMessage'), keys: 'dd daduan interrupt', run: (a) => (a ? sendMessage(a, { cut: true }) : toast(t('cmd.cutNeedText'))) },
    { name: 'btw', label: t('cmd.btw'), desc: t('cmd.btwDesc'), arg: t('cmd.argQuestion'), keys: 'skww suikou ask aside', run: (a) => openAside(a) },
    awaitingPlan(s) && { name: 'approve', label: t('cmd.approve'), desc: t('cmd.approveDesc'), arg: t('cmd.argNote'), keys: 'pz pizhun yes ok', run: (a) => api(`/api/runs/${s.id}/control`, { method: 'POST', body: { cmd: 'approve', text: a } }).then(() => toast(t('run.toastApproved'))).catch((err) => toast(err.message)) },
    running && { name: 'pause', label: t('run.pause'), desc: t('run.pauseTitle'), keys: 'zt zanting', run: () => runAction('pause') },
    (['paused', 'stopped', 'interrupted', 'failed'].includes(s.status) || isScheduled(s)) && { name: 'resume', label: isScheduled(s) ? t('run.startNow') : t('run.continue'), keys: 'jx jixu continue', run: () => runAction('resume') },
    ACTIVE.has(s.status) && { name: 'stop', label: t('run.stop'), keys: 'tz tingzhi', run: () => runAction('stop') },
    { name: 'plan', label: t('cmd.plan'), keys: 'jh jihua', run: () => (s.plan?.length ? runAction('plan') : toast(t('run.noPlanYet'))) },
    { name: 'diff', label: t('run.allChanges'), keys: 'gd gaidong', run: () => runAction('alldiff') },
    { name: 'rollback', label: t('run.rollback'), desc: t('cmd.rollbackDesc'), keys: 'hg huigun undo', run: () => runAction('rollback') },
    { name: 'review', label: t('run.review'), desc: t('cmd.reviewDesc'), keys: 'sc shencha', run: () => runAction('review') },
    { name: 'export', label: t('run.export'), desc: t('cmd.exportDesc'), keys: 'dc daochu', run: () => runAction('export') },
    { name: 'copy', label: t('run.copyLast'), keys: 'fz fuzhi copy-last', run: () => copyLast() },
    { name: 'compact', label: t('run.compact'), desc: t('cmd.compactDesc'), keys: 'ys yasuo', run: () => runAction('compact') },
    { name: 'team', label: t('cmd.team'), desc: t('cmd.teamDesc'), arg: 'off|auto|always', keys: 'td tuandui', run: (a) => patchSettings({ team: { mode: a || (set.team?.mode === 'off' || !set.team?.mode ? 'auto' : 'off') } }, !a || ['off', 'auto', 'always'].includes(a), t('cmd.teamSet', { mode: a || (set.team?.mode === 'off' || !set.team?.mode ? 'auto' : 'off') })) },
    { name: 'yolo', label: t('cmd.yolo'), desc: t('cmd.yoloDesc'), keys: 'yolo', run: () => { const on = (set.safety?.policy || 'ask') !== 'allow'; patchSettings({ safety: { policy: on ? 'allow' : 'ask' } }, true, on ? t('cmd.yoloOn') : t('cmd.yoloOff')); } },
    { name: 'rounds', label: t('cmd.rounds'), arg: t('cmd.argNumber'), keys: 'ls lunshu max', run: (a) => patchSettings({ loop: { maxRounds: Math.max(1, Math.min(500, Math.round(Number(a)) || 0)) } }, Number(a) > 0, t('cmd.roundsSet', { n: Math.round(Number(a)) })) },
    { name: 'budget', label: t('cmd.budget'), desc: t('cmd.budgetDesc'), arg: t('cmd.argMillions'), keys: 'ys yusuan token', run: (a) => patchSettings({ loop: { tokenBudgetM: Math.max(0, Number(a) || 0) } }, a !== '' && Number(a) >= 0, Number(a) ? t('cmd.budgetSet', { n: Number(a) }) : t('cmd.budgetOff')) },
    { name: 'check', label: t('cmd.check'), desc: t('cmd.checkDesc'), arg: t('cmd.argCommand'), keys: 'ys yanshou test', run: (a) => patchSettings({ loop: { checkCommand: a } }, true, a ? t('cmd.checkSet', { cmd: a }) : t('cmd.checkOff')) },
    { name: 'skills', label: t('cmd.skills'), desc: t('cmd.skillsDesc'), keys: 'jn jineng skill', run: () => openSkillsPicker(s.workdir, insertIntoMessage) },
    { name: 'agents', label: t('cmd.agents'), desc: t('cmd.agentsDesc'), keys: 'dl daili agent', run: () => openAgentsPicker(insertIntoMessage) },
    { name: 'todo', label: t('cmd.todo'), desc: t('cmd.todoDesc'), keys: 'db daiban fixme', run: () => openTodoPicker(s.workdir, insertIntoMessage) },
    { name: 'gitline', label: t('cmd.gitline'), desc: t('cmd.gitlineDesc'), keys: 'tj tijiao commit git', run: () => openGitLine(s.workdir, insertIntoMessage) },
    { name: 'new-prompt', label: t('cmd.newPrompt'), desc: t('cmd.newPromptDesc'), arg: t('cmd.argIdea'), keys: 'tsc tishici prompt', run: (a) => openNewPrompt(s.workdir, a, insertIntoMessage) },
    { name: 'loop', label: t('run.loop'), desc: t('cmd.loopDesc'), arg: t('cmd.argLoop'), keys: 'xh xunhuan loop', run: (a) => openLoops({ runId: s.id, spec: a }) },
    { name: 'notebook', label: t('run.notebook'), desc: t('cmd.notebookDesc'), keys: 'bjb biji', run: () => openNotebook(s.workdir) },
    currentTeam() && { name: 'board', label: t('team.board'), desc: t('cmd.boardDesc'), keys: 'lyb liuyan', run: () => openBoard(s.id, s.round, currentTeam().team.map((m) => m.name)) },
    { name: 'usage', label: t('usage.title'), keys: 'yl yongliang tokens', run: () => openUsage() },
    { name: 'tool-display', label: t('cmd.display'), desc: t('cmd.displayDesc'), arg: 'full|compact|hidden', keys: 'xs xianshi density', run: (a) => actions.setDensity?.(a) },
    { name: 'settings', label: t('run.adjust'), keys: 'tz tiaozheng sz', run: () => runSettingsModal() },
    { name: 'help', label: t('cmd.help'), keys: 'bz bangzhu', run: () => actions.openHelp?.() },
  ].filter(Boolean);
  for (const c of app.commands || []) {
    if (list.some((x) => x.name === c.name)) continue;
    list.push({
      name: c.name,
      label: c.description || oneLine(c.command, 60),
      desc: c.type === 'execute' ? t('cmd.customExec') : t('cmd.customPrompt'),
      arg: c.command.includes('$ARGUMENTS') ? t('cmd.argArgs') : '',
      keys: c.name,
      run: (a) => {
        const text = c.command.includes('$ARGUMENTS') ? c.command.split('$ARGUMENTS').join(a) : a ? `${c.command} ${a}` : c.command;
        if (c.type === 'execute') runExecuteCommand(s.workdir, text, { onSend: (out) => sendMessage(out) });
        else sendMessage(text);
      },
    });
  }
  return list;
}

// ---------- side questions (drawer on the right) ----------
let asideTimer = null;

function closeAside() {
  $('#aside-drawer').classList.add('hidden');
  clearInterval(asideTimer);
  asideTimer = null;
}

function toggleAside() {
  if ($('#aside-drawer').classList.contains('hidden')) openAside();
  else closeAside();
}

export function openAside(question = '') {
  $('#aside-drawer').classList.remove('hidden');
  renderHeader();
  refreshAsides();
  const input = $('#aside-input');
  if (question) {
    input.value = question;
    askAside();
  } else {
    setTimeout(() => input.focus(), 30);
  }
}

async function refreshAsides() {
  if (!app.currentId || $('#aside-drawer').classList.contains('hidden')) return;
  let list = [];
  try {
    list = await api(`/api/runs/${app.currentId}/asides`);
  } catch {
    return;
  }
  const box = $('#aside-list');
  box.innerHTML = list.length ? list.map((a) => `<div class="aside-item">
      <div class="aside-q">${esc(a.q)}</div>
      <div class="aside-a">${a.status === 'running'
        ? `<div class="g-status"><span class="moonwait">${EMBLEM.user}</span><span>${esc(t('run.asideThinking'))}</span><span class="last">${esc(a.last || '')}</span></div>`
        : a.status === 'failed' ? `<div class="error">${esc(a.error || t('tools.failed'))}</div>` : `<div class="md">${md(a.answer)}</div><div class="meta">${esc([a.model, a.durationMs ? fmtDuration(a.durationMs) : '', fmtTime(a.at)].filter(Boolean).join(' · '))}</div>`}</div>
    </div>`).join('') : `<div class="drawer-empty">${esc(t('run.asideEmpty1'))}<br><br>${esc(t('run.asideEmpty2'))}</div>`;
  const running = list.some((a) => a.status === 'running');
  $('#aside-send').disabled = running || !$('#aside-input').value.trim();
  if (running && !asideTimer) asideTimer = setInterval(refreshAsides, 1500);
  if (!running && asideTimer) {
    clearInterval(asideTimer);
    asideTimer = null;
  }
  box.scrollTop = box.scrollHeight;
}

async function askAside() {
  const input = $('#aside-input');
  const q = input.value.trim();
  if (!q || !app.currentId) return;
  try {
    await api(`/api/runs/${app.currentId}/asides`, { method: 'POST', body: { question: q } });
    input.value = '';
    autosize(input, 160);
  } catch (err) {
    toast(err.message);
  }
  refreshAsides();
}

export function initThread() {
  msgComposer = enhanceComposer(msgInput, {
    box: $('#run-composer'),
    historyKey: 'msg',
    maxHeight: 240,
    submit: 'enter',
    onSubmit: (text, { alt }) => sendMessage(text, { cut: alt }),
    dir: () => app.state?.workdir || '',
    agents: () => (app.env?.subagents || []).filter((a) => a.enabled),
    teammates: () => currentTeam()?.team.map((m) => m.name) || [],
    commands: runCommands,
  });
  msgInput.addEventListener('input', () => {
    autosize(msgInput, 240);
    $('#btn-send').disabled = !msgInput.value.trim();
  });
  msgInput.addEventListener('history', () => {
    $('#btn-send').disabled = !msgInput.value.trim();
  });
  $('#btn-send').onclick = () => msgComposer.send(false);

  const asideInput = $('#aside-input');
  const asideComposer = enhanceComposer(asideInput, { box: $('#aside-composer'), historyKey: 'aside', maxHeight: 160, submit: 'enter', onSubmit: () => askAside() });
  asideInput.addEventListener('input', () => {
    autosize(asideInput, 160);
    $('#aside-send').disabled = !asideInput.value.trim();
  });
  $('#aside-send').onclick = () => asideComposer.send(false);
  $('#aside-close').onclick = () => {
    closeAside();
    renderHeader();
  };
}

/** Process display: full / compact (no thinking or reads) / hidden (reports only) — snow-cli /tool-display. */
export function setDensity(next) {
  const order = ['full', 'compact', 'hidden'];
  const cur = app.env?.config?.ui?.density || 'full';
  const v = order.includes(next) ? next : order[(order.indexOf(cur) + 1) % order.length];
  if (app.env?.config) app.env.config.ui = { ...(app.env.config.ui || {}), density: v };
  applyDensity();
  api('/api/config', { method: 'PUT', body: { ui: { density: v } } }).catch(() => {});
  toast(t(`density.toast.${v}`));
}

export { insertIntoMessage };
