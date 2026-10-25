// The model and run settings form (shared by a new task, "adjust this task" and the defaults), and the start-time picker.
import { $, $$, api, app, esc, fmtClock, fmtCtx, fmtNum, fmtTime, merge, oneLine, tEffort, toast } from './core.js';
import { EMBLEM, ICON } from './brand.js';
import { t } from './i18n.js';
import { closePopover, openPopover } from './overlay.js';

const GPT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const WB_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function effortLabel(e) {
  return `${tEffort(e)} (${e})`;
}

export function gptModelList() {
  return (app.env?.codex.models || []).filter((m) => m.visible);
}

export function wbModelList() {
  const list = app.env?.workbuddy.models;
  return list?.length ? list : [{ id: 'auto', name: 'Auto', reasoning: true, efforts: WB_EFFORTS, defaultEffort: '', context: null, badges: [] }];
}

export function wbModel(id) {
  return wbModelList().find((m) => m.id === id) || { id, name: id || 'Auto', reasoning: true, efforts: WB_EFFORTS, defaultEffort: '', context: null, badges: [] };
}

function creditsLabel(m) {
  if (m.credits == null) return m.id === 'auto' ? t('form.creditsVary') : '';
  const base = `${fmtNum(m.credits)}x`;
  if (m.creditsNow != null && m.creditsNow !== m.credits) return m.creditsNow === 0 ? t('form.creditsFree', { base }) : t('form.creditsNow', { now: `${fmtNum(m.creditsNow)}x`, base });
  return base;
}

export function wbEffortText(set) {
  const e = set?.effort;
  return e ? tEffort(e) : t('form.defaultThinking');
}

export function formRow(label, control, { hint = '', forId = '', hintKey = '' } = {}) {
  const lab = forId ? `<label for="${forId}">${label}</label>` : `<div class="label">${label}</div>`;
  return `<div class="form-row">${lab}<div class="control">${control}<div class="hint"${hintKey ? ` data-hint="${hintKey}"` : ''}>${hint}</div></div></div>`;
}

export function formGroup(title, rows, { emblem = '', icon = '' } = {}) {
  const lead = emblem ? `<span class="emb ${emblem}">${EMBLEM[emblem]}</span>` : icon ? `<span class="emb">${ICON[icon] || ''}</span>` : '';
  return `<div class="form-group">${title ? `<div class="group-title">${lead}${title}</div>` : ''}${rows.filter(Boolean).join('')}</div>`;
}

export function switchControl(id, checked, text) {
  return `<label class="switch"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span class="track"></span><span>${text}</span></label>`;
}

export function numberControl(id, value, unit, min = 1, step = 1) {
  return `<div class="unit"><input id="${id}" type="number" min="${min}" step="${step}" value="${esc(value)}"><span>${unit}</span></div>`;
}

export const seg = (id, options, value) => `<div class="seg" id="${id}">${options.map(([v, label]) => `<button type="button" data-v="${esc(v)}" class="${v === value ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;

export function bindSeg(root, id, onPick) {
  $$(`#${id} button`, root).forEach((b) => {
    b.onclick = () => {
      $$(`#${id} button`, root).forEach((x) => x.classList.toggle('on', x === b));
      onPick?.(b.dataset.v);
      b.closest('.seg')?.dispatchEvent(new Event('change', { bubbles: true }));
    };
  });
}

export const segValue = (root, id) => $(`#${id} button.on`, root)?.dataset.v;

const option = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;

function modelsSourceText() {
  const w = app.env?.workbuddy;
  if (!w) return '';
  if (w.modelsSource === 'cloud') return t('form.modelsCloud', { time: fmtTime(w.modelsUpdatedAt ? new Date(w.modelsUpdatedAt).toISOString() : '') });
  return t('form.modelsBundled');
}

export const TEAM_MODES = () => [['off', t('team.off')], ['auto', t('team.auto')], ['always', t('team.always')]];
export const TASK_MODES = () => [['normal', t('mode.normal')], ['plan', t('mode.plan')], ['vuln', t('mode.vuln')]];
export const REPLY_LANGS = () => [['auto', t('replyLang.auto')], ['en', 'English'], ['zh', '中文'], ['ja', '日本語']];
export const SAFETY_POLICIES = () => [['ask', t('safety.policy.ask')], ['deny', t('safety.policy.deny')], ['allow', t('safety.policy.allow')]];

function settingsFormHtml(p, st, opts = {}) {
  const gptModel = st.codex?.model || app.env?.codex.defaultModel || '';
  const gptList = gptModelList();
  if (gptModel && !gptList.some((m) => m.id === gptModel)) gptList.unshift({ id: gptModel, name: gptModel });
  const gptOptions = gptList.map((m) => `<option value="${esc(m.id)}"${m.id === gptModel ? ' selected' : m.unavailable ? ' disabled' : ''}>${esc(m.name || m.id)}${m.unavailable ? ` ${esc(t('form.unavailable'))}` : ''}</option>`).join('');
  const wbId = st.workbuddy?.model || 'auto';
  const wbList = [...wbModelList()];
  if (!wbList.some((m) => m.id === wbId)) wbList.push(wbModel(wbId));
  const wbOptions = wbList.map((m) => {
    const extra = [creditsLabel(m), m.badges?.[0]?.label].filter(Boolean).join(' · ');
    return `<option value="${esc(m.id)}"${m.id === wbId ? ' selected' : ''}>${esc(m.name)}${extra ? `　${esc(extra)}` : ''}</option>`;
  }).join('');
  const perm = st.workbuddy?.permissionMode === 'fullAccess' ? 'fullAccess' : 'bypassPermissions';
  const autonomy = st.loop?.autonomy === 'ask' ? 'ask' : 'auto';
  const teamMode = ['auto', 'always'].includes(st.team?.mode) ? st.team.mode : 'off';
  const taskMode = ['plan', 'vuln'].includes(st.agents?.mode) ? st.agents.mode : 'normal';
  const reply = ['en', 'zh', 'ja'].includes(st.agents?.replyLanguage) ? st.agents.replyLanguage : 'auto';
  const policy = ['deny', 'allow'].includes(st.safety?.policy) ? st.safety.policy : 'ask';
  return [
    formGroup(t('form.gptGroup'), [
      formRow(t('form.model'), `<select id="${p}-gpt-model">${gptOptions}</select>`, { forId: `${p}-gpt-model`, hintKey: 'gpt-model' }),
      formRow(t('form.reasoning'), `<select id="${p}-gpt-effort"></select>`, { forId: `${p}-gpt-effort`, hint: t('form.reasoningHint') }),
      formRow(t('form.webSearch'), switchControl(`${p}-web`, Boolean(st.codex?.webSearch), t('form.webSearchSwitch')), { hint: t('form.webSearchHint') }),
      formRow(t('form.codexHome'), `<input type="text" id="${p}-codex-home" value="${esc(st.codex?.home || '')}" placeholder="~/.codex" spellcheck="false">`, { forId: `${p}-codex-home`, hint: t('form.codexHomeHint') }),
      formRow(t('form.gptContext'), numberControl(`${p}-codex-ctx`, st.codex?.contextWindow || 0, t('form.tokens')), { forId: `${p}-codex-ctx`, hint: t('form.gptContextHint') }),
    ], { emblem: 'gpt' }),
    formGroup(`${t('form.wbGroup')}<span class="gt-side">${esc(modelsSourceText())}${app.env?.workbuddy.loggedIn ? ` · <button class="link" type="button" data-refresh-models>${esc(t('form.refresh'))}</button>` : ''}</span>`, [
      formRow(t('form.model'), `<select id="${p}-wb-model">${wbOptions}</select>`, { forId: `${p}-wb-model`, hintKey: 'wb-model' }),
      formRow(t('form.thinking'), `<select id="${p}-wb-effort"></select>`, { forId: `${p}-wb-effort`, hintKey: 'wb-effort' }),
      formRow(t('form.context'), `<select id="${p}-wb-ctx"></select>`, { forId: `${p}-wb-ctx`, hintKey: 'wb-ctx' }),
      opts.perm ? formRow(t('form.permission'), `<select id="${p}-perm">${option('bypassPermissions', t('form.permBypass'), perm)}${option('fullAccess', t('form.permFull'), perm)}</select>`, { forId: `${p}-perm`, hint: t('form.permHint') }) : '',
      formRow(t('form.addDirs'), `<textarea id="${p}-dirs" rows="2" spellcheck="false" placeholder="${esc(t('form.addDirsPlaceholder'))}">${esc((st.workbuddy?.addDirs || []).join('\n'))}</textarea>`, { forId: `${p}-dirs`, hint: t('form.addDirsHint') }),
    ], { emblem: 'wb' }),
    formGroup(t('form.collabGroup'), [
      formRow(t('form.team'), `${seg(`${p}-team`, TEAM_MODES(), teamMode)}<div class="unit" style="margin-top:8px"><span>${esc(t('form.maxTeammates'))}</span><input id="${p}-mates" type="number" min="2" max="6" value="${Number(st.team?.maxTeammates) || 3}" style="width:80px"></div>`, { hint: t('form.teamHint') }),
      formRow(t('form.mode'), `<select id="${p}-mode">${TASK_MODES().map(([v, l]) => option(v, l, taskMode)).join('')}</select>`, { forId: `${p}-mode`, hint: t('form.modeHint') }),
      formRow(t('form.replyLang'), `<select id="${p}-reply">${REPLY_LANGS().map(([v, l]) => option(v, l, reply)).join('')}</select>`, { forId: `${p}-reply`, hint: t('form.replyLangHint') }),
    ], { icon: 'team' }),
    formGroup(t('form.flowGroup'), [
      formRow(t('form.maxRounds'), `<input id="${p}-rounds" type="number" min="1" max="500" value="${Number(st.loop?.maxRounds) || 30}">`,
        { forId: `${p}-rounds`, hint: opts.roundsHint || t('form.maxRoundsHint') }),
      formRow(t('form.budget'), numberControl(`${p}-budget`, Number(st.loop?.tokenBudgetM) || 0, t('form.budgetUnit'), 0, 0.5), { forId: `${p}-budget`, hint: t('form.budgetHint') }),
      formRow(t('form.check'), `<input id="${p}-check" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(t('form.checkPlaceholder'))}" value="${esc(st.loop?.checkCommand || '')}">`,
        { forId: `${p}-check`, hint: t('form.checkHint') }),
      opts.autonomy ? formRow(t('form.autonomy'), `<select id="${p}-autonomy">${option('auto', t('form.autonomyAuto'), autonomy)}${option('ask', t('form.autonomyAsk'), autonomy)}</select>`,
        { forId: `${p}-autonomy`, hint: t('form.autonomyHint') }) : '',
      formRow(t('form.review'), switchControl(`${p}-review`, st.loop?.finalReview !== false, t('form.reviewSwitch')), { hint: t('form.reviewHint') }),
      formRow(t('form.safety'), `<select id="${p}-policy">${SAFETY_POLICIES().map(([v, l]) => option(v, l, policy)).join('')}</select>`, { forId: `${p}-policy`, hint: t('form.safetyHint') }),
    ], { icon: 'repeat' }),
  ].join('');
}

function setHint(root, key, html) {
  const box = root.querySelector(`[data-hint="${key}"]`);
  if (box) box.innerHTML = html || '';
}

function bindSettingsForm(root, p, st, onChange) {
  const gptSel = $(`#${p}-gpt-model`, root);
  const gptEff = $(`#${p}-gpt-effort`, root);
  const wbSel = $(`#${p}-wb-model`, root);
  const wbEff = $(`#${p}-wb-effort`, root);
  const wbCtx = $(`#${p}-wb-ctx`, root);
  const syncGpt = (want) => {
    const m = gptModelList().find((x) => x.id === gptSel.value);
    const levels = (m?.efforts || []).filter((e) => [...GPT_EFFORTS, 'minimal', 'ultra'].includes(e));
    const list = levels.length ? levels : GPT_EFFORTS;
    const cur = want ?? gptEff.value;
    gptEff.innerHTML = list.map((e) => `<option value="${e}">${esc(effortLabel(e))}</option>`).join('');
    gptEff.value = list.includes(cur) ? cur : list.includes('high') ? 'high' : list[list.length - 1];
    setHint(root, 'gpt-model', m ? esc([m.description && oneLine(m.description, 90), m.contextWindow ? t('form.contextOf', { n: fmtCtx(m.contextWindow) || m.contextWindow }) : ''].filter(Boolean).join(' · ')) : '');
  };
  const syncWb = (wantEffort, wantCtx) => {
    const m = wbModel(wbSel.value);
    const curEffort = wantEffort ?? wbEff.value;
    const curCtx = String(wantCtx ?? wbCtx.value);
    if (!m.reasoning) {
      wbEff.innerHTML = `<option value="">${esc(t('form.notAdjustable'))}</option>`;
      wbEff.disabled = true;
    } else {
      wbEff.disabled = false;
      const options = [...m.efforts, ...(m.canDisableThinking ? ['off'] : [])];
      const def = m.defaultEffort ? t('form.defaultOf', { v: tEffort(m.defaultEffort) }) : t('form.default');
      wbEff.innerHTML = `<option value="">${esc(def)}</option>${options.map((e) => `<option value="${e}">${esc(e === 'off' ? tEffort('off') : effortLabel(e))}</option>`).join('')}`;
      wbEff.value = options.includes(curEffort) ? curEffort : '';
    }
    if (m.context) {
      wbCtx.disabled = false;
      wbCtx.innerHTML = `<option value="">${esc(t('form.defaultOf', { v: fmtCtx(m.context.default) }))}</option>${m.context.options.map((n) => `<option value="${n}">${fmtCtx(n)}</option>`).join('')}`;
      wbCtx.value = m.context.options.map(String).includes(curCtx) ? curCtx : '';
    } else {
      wbCtx.innerHTML = `<option value="">${esc(m.maxInput ? t('form.fixedCtx', { n: fmtCtx(m.maxInput) || m.maxInput }) : t('form.notAdjustable'))}</option>`;
      wbCtx.disabled = true;
    }
    const badges = (m.badges || []).map((b) => `<span class="badge${b.kind === 'tier' ? ' tier' : ''}" title="${esc(b.text)}">${esc(b.label)}</span>`).join('');
    const promo = (m.badges || []).filter((b) => b.text).map((b) => b.text).join('; ');
    const credits = creditsLabel(m);
    const next = m.nextDiscount ? t('form.nextDiscount', { label: m.nextDiscount.label || t('form.discount'), time: fmtClock(m.nextDiscount.at) }) : '';
    setHint(root, 'wb-model', [badges, esc([credits && m.credits != null ? t('form.creditsCurrent', { v: credits }) : '', m.description, promo, next].filter(Boolean).join(' · '))].join(' '));
    setHint(root, 'wb-effort', !m.reasoning ? t('form.noEffort')
      : m.id === 'auto' ? t('form.effortAuto')
        : `${t('form.effortHint')}${m.canDisableThinking ? ` ${t('form.effortOff')}` : ''}`);
    setHint(root, 'wb-ctx', m.context ? t('form.ctxHint') : t('form.ctxNone'));
  };
  gptSel.addEventListener('change', () => syncGpt());
  wbSel.addEventListener('change', () => syncWb());
  bindSeg(root, `${p}-team`);
  if (onChange) {
    root.querySelectorAll('select, input, textarea, .seg').forEach((input) => {
      input.addEventListener('change', onChange);
      input.addEventListener('input', onChange);
    });
  }
  syncGpt(st.codex?.effort || 'high');
  syncWb(st.workbuddy?.effort || '', st.workbuddy?.contextWindow || '');
}

export function readSettingsForm(root, p) {
  const v = (id) => $(`#${p}-${id}`, root);
  const out = {
    codex: { model: v('gpt-model').value, effort: v('gpt-effort').value, webSearch: v('web').checked },
    workbuddy: {
      model: v('wb-model').value,
      effort: v('wb-effort').value,
      contextWindow: Number(v('wb-ctx').value) || 0,
      addDirs: v('dirs').value.split('\n').map((x) => x.trim()).filter(Boolean),
    },
    team: { mode: segValue(root, `${p}-team`) || 'off', maxTeammates: Math.max(2, Math.min(6, Math.round(Number(v('mates').value)) || 3)) },
    agents: { mode: v('mode').value, replyLanguage: v('reply').value },
    loop: {
      maxRounds: Math.max(1, Math.min(500, Math.round(Number(v('rounds').value)) || 30)),
      tokenBudgetM: Math.max(0, Number(v('budget').value) || 0),
      finalReview: v('review').checked,
      checkCommand: v('check').value.trim(),
    },
    safety: { policy: v('policy').value },
  };
  if (v('perm')) out.workbuddy.permissionMode = v('perm').value;
  if (v('autonomy')) out.loop.autonomy = v('autonomy').value;
  return out;
}

/** Renders and binds the form; "refresh" re-renders with the values already chosen. */
export function mountSettingsForm(box, p, st, opts = {}, onChange) {
  box.innerHTML = settingsFormHtml(p, st, opts);
  bindSettingsForm(box, p, st, onChange);
  const link = $('[data-refresh-models]', box);
  if (!link) return;
  link.onclick = async () => {
    link.textContent = t('form.refreshing');
    link.disabled = true;
    try {
      app.env = await api('/api/workbuddy/models/refresh', { method: 'POST', body: {} });
      toast(t('form.modelsUpdated'));
    } catch (err) {
      toast(err.message);
    }
    mountSettingsForm(box, p, merge(st, readSettingsForm(box, p)), opts, onChange);
    onChange?.();
  };
}

export function settingsSummary(st) {
  const ctx = st.workbuddy?.contextWindow ? ` · ${fmtCtx(st.workbuddy.contextWindow)}` : '';
  const parts = [
    `GPT ${st.codex?.model || t('form.default')}${st.codex?.effort ? ` · ${tEffort(st.codex.effort)}` : ''}`,
    `WorkBuddy ${wbModel(st.workbuddy?.model || 'auto').name} · ${wbEffortText(st.workbuddy)}${ctx}`,
  ];
  if (st.team?.mode && st.team.mode !== 'off') parts.push(`${t('form.team')}: ${TEAM_MODES().find(([v]) => v === st.team.mode)?.[1]}`);
  if (st.agents?.mode && st.agents.mode !== 'normal') parts.push(TASK_MODES().find(([v]) => v === st.agents.mode)?.[1]);
  if (st.loop?.checkCommand) parts.push(`${t('form.check')}: ${st.loop.checkCommand}`);
  return parts.join('　');
}

// ---------- scheduled start ----------

/** Today's or tomorrow's HH:MM (tomorrow when it has passed already) */
function nextAt(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now() + 60_000) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export function scheduleLabel(iso) {
  return iso ? t('schedule.startsAt', { time: fmtClock(iso) }) : t('schedule.now');
}

/** Pick a start time. onPick(iso | '') */
export function openSchedulePopover(anchor, { current = '', modelId = 'auto', onPick }) {
  const m = wbModel(modelId);
  const options = [{ at: '', label: t('schedule.now'), desc: '' }];
  if (m.nextDiscount) options.push({ at: m.nextDiscount.at, label: t('schedule.atDiscount', { label: m.nextDiscount.label || t('form.discount') }), desc: fmtClock(m.nextDiscount.at) });
  options.push({ at: nextAt(23, 0), label: t('schedule.tonight'), desc: '' });
  options.push({ at: nextAt(1, 0), label: t('schedule.lateNight'), desc: fmtClock(nextAt(1, 0)) });
  options.push({ at: nextAt(7, 0), label: t('schedule.morning'), desc: fmtClock(nextAt(7, 0)) });
  const pop = openPopover(anchor, `
    <div class="menu-label">${esc(t('schedule.when'))}</div>
    ${options.map((o, i) => `<button class="menu-item${(o.at || '') === (current || '') ? ' checked' : ''}" type="button" data-i="${i}"><span>${esc(o.label)}</span>${o.desc && (o.at || '') !== (current || '') ? `<span class="desc">${esc(o.desc)}</span>` : ''}</button>`).join('')}
    <div class="menu-sep"></div>
    <div class="row" style="display:flex;gap:8px;align-items:center;padding:4px 8px 6px"><span class="muted" style="font-size:12.5px;white-space:nowrap">${esc(t('schedule.pick'))}</span><input type="time" id="sched-time" value="${current ? new Date(current).toTimeString().slice(0, 5) : '23:00'}" style="width:118px"><button class="btn sm" type="button" id="sched-ok">${esc(t('common.ok'))}</button></div>
    <div class="hint" style="padding:0 10px 6px;margin:0">${esc(t('schedule.hint'))}${m.nextDiscount?.text ? `<br>${esc(m.nextDiscount.text)}` : ''}</div>`, { align: 'left', className: 'time-pop' });
  pop.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => {
      closePopover();
      onPick(options[Number(b.dataset.i)].at);
    };
  });
  $('#sched-ok', pop).onclick = () => {
    const [h, mm] = String($('#sched-time', pop).value || '').split(':').map(Number);
    if (!Number.isFinite(h)) return;
    closePopover();
    onPick(nextAt(h, mm || 0));
  };
}
