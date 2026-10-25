// Panels in dialogs: settings, accounts and quota, changes, rollback, help.
import { $, $$, ACTIVE, actions, api, app, applyTheme, armButton, esc, fmtClock, fmtDuration, fmtRelative, fmtTime, native, oneLine, toast } from './core.js';
import { BRAND, EMBLEM, ICON } from './brand.js';
import { LANGS, lang, t } from './i18n.js';
import { REPLY_LANGS, SAFETY_POLICIES, bindSeg, formGroup, formRow, gptModelList, mountSettingsForm, numberControl, readSettingsForm, seg, segValue, switchControl } from './forms.js';
import { closeModal, confirmDialog, openModal } from './overlay.js';
import { applyDensity } from './thread.js';
import { openLoops, openUsage } from './tools.js';

// ---------- settings ----------
const SETTING_TABS = [
  { id: 'general', icon: 'globe' },
  { id: 'defaults', icon: 'sliders' },
  { id: 'prompts', icon: 'prompt' },
  { id: 'agents', icon: 'agents' },
  { id: 'safety', icon: 'shield' },
  { id: 'hooks', icon: 'hook' },
  { id: 'skills', icon: 'sparkle' },
  { id: 'mcp', icon: 'plug' },
  { id: 'long', icon: 'hourglass' },
  { id: 'system', icon: 'data' },
];

const ROLE_KEYS = ['lead', 'executor', 'teammate', 'reviewer', 'advisor'];
const KNOWN_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskList'];
const HOOK_TOOL_TYPES = new Set(['beforeToolCall', 'toolConfirmation', 'afterToolCall']);
const HOOK_PROMPT_TYPES = new Set(['onSubAgentComplete', 'onStop']);
const HOOK_CONTEXT_TYPES = new Set(['onSessionStart', 'onUserMessage', 'beforeSubAgentStart']);

const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;

export async function openSettings(tab = 'general') {
  const cfg = app.env?.config;
  if (!cfg) return;
  let data;
  try {
    data = await api('/api/settings-data');
  } catch (err) {
    toast(err.message);
    return;
  }
  const theme = document.documentElement.dataset.theme || 'system';
  const density = cfg.ui?.density || 'full';
  const sys = cfg.prompts?.system || {};
  const role = cfg.prompts?.role || { mode: 'rules', file: 'ROLE.md' };
  const panes = {
    general: `<div class="pane-title">${esc(t('settings.general'))}</div><p class="pane-lede">${esc(t('settings.generalLede'))}</p>
      ${formGroup('', [
        formRow(t('settings.language'), seg('s-lang', LANGS.map((l) => [l.id, l.name]), lang), { hint: t('settings.languageHint') }),
        formRow(t('settings.theme'), seg('s-theme', [['system', t('settings.themeSystem')], ['light', t('settings.themeLight')], ['dark', t('settings.themeDark')]], theme), { hint: t('settings.themeHint') }),
        formRow(t('settings.density'), seg('s-density', [['full', t('density.full')], ['compact', t('density.compact')], ['hidden', t('density.hidden')]], density), { hint: t('settings.densityHint') }),
      ])}`,
    defaults: `<div class="pane-title">${esc(t('settings.defaults'))}</div><p class="pane-lede">${esc(t('settings.defaultsLede'))}</p><div id="s-form"></div>
      <div class="form-group"><div class="group-title">${esc(t('profiles.title'))}<span class="gt-side">${esc(t('profiles.side'))}</span></div><div id="s-profiles"></div>
        <div class="inline-add"><input type="text" id="s-prof-name" placeholder="${esc(t('profiles.namePlaceholder'))}" autocomplete="off"><button class="btn sm" type="button" id="s-prof-save">${esc(t('profiles.save'))}</button></div></div>`,
    prompts: `<div class="pane-title">${esc(t('settings.prompts'))}</div><p class="pane-lede">${esc(t('settings.promptsLede'))}</p>
      <div class="form-group"><div class="group-title">${esc(t('prompts.system'))}<span class="gt-side">${esc(t('prompts.vars'))}</span></div>
        ${ROLE_KEYS.map((r) => {
          const cur = sys[r]?.mode === 'custom' ? 'custom' : 'builtin';
          return `<div class="role-card" data-role="${r}">
            <div class="role-head"><b>${esc(t(`role.${r}`))}</b><span class="muted">${esc(t(`role.${r}.desc`))}</span><span class="spacer"></span>
              ${seg(`s-role-${r}`, [['builtin', t('prompts.builtin')], ['custom', t('prompts.custom')]], cur)}
              <button class="btn ghost xs" type="button" data-view-role="${r}">${esc(t('prompts.view'))}</button></div>
            <textarea class="mono role-text${cur === 'custom' ? '' : ' hidden'}" id="s-role-text-${r}" rows="10" spellcheck="false" placeholder="${esc(t('prompts.customPlaceholder'))}">${esc(sys[r]?.text || '')}</textarea>
          </div>`;
        }).join('')}
        <div class="hint">${esc(t('prompts.customHint'))}</div></div>
      <div class="form-group"><div class="group-title">${esc(t('prompts.rules'))}</div>
        ${formRow(t('prompts.forGpt'), `<textarea id="s-rule-gpt" rows="4" placeholder="${esc(t('prompts.forGptPlaceholder'))}">${esc(cfg.prompts?.gpt || '')}</textarea>`, { forId: 's-rule-gpt', hint: t('prompts.forGptHint') })}
        ${formRow(t('prompts.forWb'), `<textarea id="s-rule-wb" rows="4" placeholder="${esc(t('prompts.forWbPlaceholder'))}">${esc(cfg.prompts?.workbuddy || '')}</textarea>`, { forId: 's-rule-wb', hint: t('prompts.forWbHint') })}</div>
      <div class="form-group"><div class="group-title">ROLE.md</div>
        ${formRow(t('prompts.roleMode'), `<select id="s-role-mode">${opt('off', t('prompts.roleOff'), role.mode)}${opt('rules', t('prompts.roleRules'), role.mode)}${opt('override', t('prompts.roleOverride'), role.mode)}</select>`, { forId: 's-role-mode', hint: t('prompts.roleHint') })}
        ${formRow(t('prompts.roleFile'), `<input type="text" id="s-role-file" value="${esc(role.file || 'ROLE.md')}" spellcheck="false">`, { forId: 's-role-file', hint: t('prompts.roleFileHint', { dir: '~/.wbloop' }) })}</div>`,
    agents: `<div class="pane-title">${esc(t('settings.agents'))}</div><p class="pane-lede">${esc(t('settings.agentsLede'))}</p>
      ${formRow(t('agents.enabled'), switchControl('s-agents-on', cfg.subagents?.enabled !== false, t('agents.enabledSwitch')))}
      <div class="rule-list" id="s-agent-list"></div>
      <div class="form-group"><div class="group-title">${esc(t('agents.addTitle'))}<span class="gt-side">${esc(t('agents.addSide'))}</span></div>
        <div class="agent-form">
          <div class="two"><input type="text" id="s-ag-id" placeholder="${esc(t('agents.idPlaceholder'))}" spellcheck="false"><input type="text" id="s-ag-name" placeholder="${esc(t('agents.namePlaceholder'))}"></div>
          <input type="text" id="s-ag-desc" placeholder="${esc(t('agents.descPlaceholder'))}">
          <textarea id="s-ag-prompt" rows="6" placeholder="${esc(t('agents.promptPlaceholder'))}"></textarea>
          <div class="tool-checks">${KNOWN_TOOLS.map((x) => `<label class="check sm"><input type="checkbox" value="${x}"${['Read', 'Glob', 'Grep'].includes(x) ? ' checked' : ''}><span>${x}</span></label>`).join('')}</div>
          <div><button class="btn sm" type="button" id="s-ag-add">${ICON.plus}${esc(t('agents.add'))}</button></div>
        </div></div>`,
    safety: `<div class="pane-title">${esc(t('settings.safety'))}</div><p class="pane-lede">${esc(t('settings.safetyLede'))}</p>
      ${formGroup('', [
        formRow(t('form.safety'), `<select id="s-policy">${SAFETY_POLICIES().map(([v, l]) => opt(v, l, cfg.safety?.policy || 'ask')).join('')}</select>`, { forId: 's-policy', hint: t('safety.policyHint') }),
        formRow(t('safety.timeout'), numberControl('s-ap-min', cfg.safety?.timeoutMin || 10, t('common.minutes')), { forId: 's-ap-min', hint: t('safety.timeoutHint') }),
      ])}
      <div class="group-title">${esc(t('safety.rules'))}</div>
      <div class="rule-list" id="s-rules"></div>
      <div class="inline-add"><input type="text" id="s-rule-pattern" class="mono" placeholder="${esc(t('safety.patternPlaceholder'))}" spellcheck="false"><input type="text" id="s-rule-desc" placeholder="${esc(t('safety.descPlaceholder'))}"><button class="btn sm" type="button" id="s-rule-add">${esc(t('safety.addRule'))}</button></div>`,
    hooks: `<div class="pane-title">${esc(t('settings.hooks'))}</div><p class="pane-lede">${esc(t('settings.hooksLede'))}</p>
      ${formRow(t('hooks.enabled'), switchControl('s-hooks-on', cfg.hooks?.enabled !== false, t('hooks.enabledSwitch')), { hint: t('hooks.filesHint', { dir: data.hooksDir.replace(app.env.home, '~') }) })}
      <div id="s-hook-list"></div>`,
    skills: `<div class="pane-title">${esc(t('settings.skills'))}</div><p class="pane-lede">${esc(t('settings.skillsLede'))}</p>
      ${formRow(t('skills.enabled'), switchControl('s-skills-on', cfg.skills?.enabled !== false, t('skills.enabledSwitch')))}
      <div class="rule-list" id="s-skill-list"></div>
      <div class="inline-add"><input type="text" id="s-sk-name" placeholder="${esc(t('skills.namePlaceholder'))}" spellcheck="false"><input type="text" id="s-sk-desc" placeholder="${esc(t('skills.descPlaceholder'))}"><button class="btn sm" type="button" id="s-sk-add">${esc(t('skills.create'))}</button></div>
      ${formRow(t('skills.extraDirs'), `<textarea id="s-sk-dirs" rows="2" spellcheck="false" placeholder="~/.claude/skills">${esc((cfg.skills?.extraDirs || []).join('\n'))}</textarea>`, { forId: 's-sk-dirs', hint: t('skills.extraDirsHint') })}
      <div class="form-group"><div class="group-title">${esc(t('commands.title'))}<span class="gt-side">${esc(t('commands.side'))}</span></div>
        <div class="rule-list" id="s-cmd-list"></div>
        <div class="agent-form">
          <div class="two"><input type="text" id="s-cmd-name" placeholder="${esc(t('commands.namePlaceholder'))}" spellcheck="false"><select id="s-cmd-type">${opt('prompt', t('commands.typePrompt'), 'prompt')}${opt('execute', t('commands.typeExecute'), 'prompt')}</select></div>
          <textarea id="s-cmd-text" rows="3" placeholder="${esc(t('commands.textPlaceholder'))}"></textarea>
          <input type="text" id="s-cmd-desc" placeholder="${esc(t('commands.descPlaceholder'))}">
          <div><button class="btn sm" type="button" id="s-cmd-add">${ICON.plus}${esc(t('commands.add'))}</button></div>
        </div></div>`,
    mcp: `<div class="pane-title">MCP</div><p class="pane-lede">${esc(t('settings.mcpLede'))}</p>
      ${formRow(t('mcp.enabled'), switchControl('s-mcp-on', cfg.mcp?.enabled !== false, t('mcp.enabledSwitch')))}
      <div class="rule-list" id="s-mcp-list"></div>
      <textarea id="s-mcp-json" class="mono" rows="14" spellcheck="false">${esc(JSON.stringify(data.mcp, null, 2))}</textarea>
      <div class="hint">${esc(t('mcp.jsonHint'))}</div>
      <div style="margin-top:10px"><button class="btn sm" type="button" id="s-mcp-save">${esc(t('mcp.saveJson'))}</button></div>`,
    long: `<div class="pane-title">${esc(t('settings.long'))}</div><p class="pane-lede">${esc(t('settings.longLede'))}</p>
      ${formGroup('', [
        formRow(t('long.turns'), numberControl('s-turns', cfg.workbuddy.maxTurnsPerCall, t('long.turnsUnit')), { forId: 's-turns', hint: t('long.turnsHint') }),
        formRow(t('long.cont'), numberControl('s-cont', cfg.workbuddy.maxContinuations, t('long.contUnit'), 0), { forId: 's-cont', hint: t('long.contHint') }),
        formRow(t('long.idle'), numberControl('s-idle', cfg.workbuddy.idleTimeoutMin, t('common.minutes')), { forId: 's-idle', hint: t('long.idleHint') }),
        formRow(t('long.wait'), numberControl('s-wait', cfg.loop.waitOnLimitHours, t('common.hours')), { forId: 's-wait', hint: t('long.waitHint') }),
        formRow(t('long.checkMin'), numberControl('s-check-min', cfg.loop.checkTimeoutMin || 15, t('common.minutes')), { forId: 's-check-min', hint: t('long.checkMinHint') }),
        formRow(t('long.autocompact'), `<input type="text" id="s-autocompact" value="${esc(cfg.workbuddy.autocompact || '')}" placeholder="auto / 400k / 1m" spellcheck="false" style="width:180px">`, { forId: 's-autocompact', hint: t('long.autocompactHint') }),
      ])}`,
    system: `<div class="pane-title">${esc(t('settings.system'))}</div><p class="pane-lede">${esc(t('settings.systemLede'))}</p>
      ${formGroup('', [
        formRow(t('system.notify'), switchControl('s-notify', cfg.system.notify, t('system.notifySwitch'))),
        formRow(t('system.caffeinate'), switchControl('s-caff', cfg.system.caffeinate, t('system.caffeinateSwitch')), { hint: t('system.caffeinateHint') }),
        formRow(t('system.notebook'), switchControl('s-nb', cfg.notebook?.enabled !== false, t('system.notebookSwitch')), { hint: t('system.notebookHint') }),
        formRow(t('system.cleanup'), `<div class="unit"><select id="s-clean-days" style="width:150px">${[7, 30, 90].map((d) => `<option value="${d}"${d === 30 ? ' selected' : ''}>${esc(t('system.daysAgo', { n: d }))}</option>`).join('')}</select><button class="btn sm" type="button" id="s-clean">${esc(t('system.cleanupBtn'))}</button></div>`, { hint: t('system.cleanupHint') }),
        formRow(t('system.data'), `<div class="unit"><button class="btn sm" type="button" id="s-open-data">${esc(t('run.openInFinder'))}</button><button class="btn sm" type="button" id="s-usage">${ICON.chart}${esc(t('usage.title'))}</button><button class="btn sm" type="button" id="s-loops">${ICON.repeat}${esc(t('loops.title'))}</button></div>`),
        formRow(t('system.backup'), `<div class="unit"><button class="btn sm" type="button" id="s-export">${esc(t('system.export'))}</button><label class="btn sm"><input type="file" id="s-import" accept=".json" class="hidden">${esc(t('system.import'))}</label></div>`, { hint: t('system.backupHint') }),
      ])}`,
  };
  const body = openModal(t('settings.title'), `
    <nav class="tab-nav">${SETTING_TABS.map((x) => `<button type="button" data-tab="${x.id}" class="${x.id === tab ? 'on' : ''}">${ICON[x.icon]}<span>${esc(t(`settings.${x.id}`))}</span></button>`).join('')}</nav>
    <div class="tab-panes">${SETTING_TABS.map((x) => `<section class="tab-pane${x.id === tab ? ' on' : ''}" data-pane="${x.id}">${panes[x.id]}</section>`).join('')}</div>`, {
    size: 'mid tabs',
    foot: `<span class="note">${esc(t('settings.footNote'))}</span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="s-save">${esc(t('common.save'))}</button>`,
  });
  mountSettingsForm($('#s-form', body), 's', cfg, { perm: true, autonomy: true });
  $$('.tab-nav [data-tab]', body).forEach((b) => {
    b.onclick = () => {
      $$('.tab-nav [data-tab]', body).forEach((x) => x.classList.toggle('on', x === b));
      $$('.tab-pane', body).forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
    };
  });

  // general: language reloads the page; theme and density apply at once
  bindSeg(body, 's-lang', async (v) => {
    if (v === lang) return;
    try {
      await api('/api/config', { method: 'PUT', body: { ui: { language: v } } });
      native?.postMessage({ type: 'language', value: v });
      location.reload();
    } catch (err) {
      toast(err.message);
    }
  });
  bindSeg(body, 's-theme', async (v) => {
    applyTheme(v);
    api('/api/config', { method: 'PUT', body: { ui: { theme: v } } }).catch((err) => toast(err.message));
  });
  bindSeg(body, 's-density', (v) => {
    cfg.ui = { ...(cfg.ui || {}), density: v };
    applyDensity();
    api('/api/config', { method: 'PUT', body: { ui: { density: v } } }).catch((err) => toast(err.message));
  });

  // profiles
  const renderProfiles = () => {
    const list = app.env.config.profiles?.list || [];
    const active = app.env.config.profiles?.active || '';
    $('#s-profiles', body).innerHTML = list.length ? `<div class="rule-list">${list.map((p) => `<div class="rule-item"><div class="ri-main"><div class="ri-title">${esc(p.name)}${p.id === active ? ` <span class="badge gold">${esc(t('profiles.active'))}</span>` : ''}</div>
      <div class="ri-sub">${esc([p.settings.codex?.model, p.settings.workbuddy?.model, p.settings.team?.mode && p.settings.team.mode !== 'off' ? `team ${p.settings.team.mode}` : ''].filter(Boolean).join(' · '))}</div></div>
      <button class="btn ghost xs" type="button" data-prof-apply="${esc(p.id)}">${esc(t('profiles.apply'))}</button><button class="icon-btn" type="button" data-prof-del="${esc(p.id)}" title="${esc(t('common.delete'))}">${ICON.trash}</button></div>`).join('')}</div>` : `<p class="muted" style="font-size:12.5px">${esc(t('profiles.none'))}</p>`;
  };
  renderProfiles();
  $('#s-profiles', body).addEventListener('click', async (e) => {
    const ap = e.target.closest('[data-prof-apply]');
    const del = e.target.closest('[data-prof-del]');
    try {
      if (ap) {
        app.env.config = await api(`/api/profiles/${ap.dataset.profApply}/apply`, { method: 'POST', body: {} });
        toast(t('profiles.applied'));
        closeModal();
        app.newSettings = null;
        actions.refreshEnv?.();
      } else if (del) {
        app.env.config = await api(`/api/profiles/${del.dataset.profDel}`, { method: 'DELETE' });
        renderProfiles();
      }
    } catch (err) {
      toast(err.message);
    }
  });
  $('#s-prof-save', body).onclick = async () => {
    try {
      const st = readSettingsForm($('#s-form', body), 's');
      app.env.config = await api('/api/profiles', { method: 'POST', body: { name: $('#s-prof-name', body).value, settings: st } });
      $('#s-prof-name', body).value = '';
      renderProfiles();
      toast(t('profiles.saved'));
    } catch (err) {
      toast(err.message);
    }
  };

  // prompts: built-in or custom per role
  for (const r of ROLE_KEYS) {
    bindSeg(body, `s-role-${r}`, async (v) => {
      const ta = $(`#s-role-text-${r}`, body);
      ta.classList.toggle('hidden', v !== 'custom');
      if (v === 'custom' && !ta.value.trim()) {
        try {
          ta.value = (await api(`/api/prompts/preview?role=${r}`)).text.replace(/\n\nSystem Environment:[\s\S]*$/, '');
        } catch (err) {
          toast(err.message);
        }
      }
    });
  }
  $$('[data-view-role]', body).forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api(`/api/prompts/preview?role=${b.dataset.viewRole}`);
        const win = openModal(t('prompts.viewTitle', { role: t(`role.${b.dataset.viewRole}`) }), `<pre class="prompt">${esc(r.text)}</pre>`, { size: 'wide', subtitle: t('prompts.viewSubtitle'), onClose: () => setTimeout(() => openSettings('prompts'), 0) });
        win.scrollTop = 0;
      } catch (err) {
        toast(err.message);
      }
    };
  });

  // sub-agents
  let agentsData = data.subagents;
  let customAgents = [...(cfg.subagents?.custom || [])];
  let disabledAgents = new Set(cfg.subagents?.disabled || []);
  const renderAgents = () => {
    $('#s-agent-list', body).innerHTML = agentsData.map((a) => `<div class="rule-item${disabledAgents.has(a.id) ? ' off' : ''}">
      <label class="switch sm"><input type="checkbox" data-agent-toggle="${esc(a.id)}"${disabledAgents.has(a.id) ? '' : ' checked'}><span class="track"></span></label>
      <div class="ri-main"><div class="ri-title">#${esc(a.id)} <span class="muted">${esc(a.name)}</span> <span class="pk-tag">${esc(t(`agents.source.${a.source}`))}</span>${a.role ? ` <span class="pk-tag" title="${esc(a.role.file)}">ROLE</span>` : ''}</div><div class="ri-sub">${esc(oneLine(a.description, 160))}${a.tools?.length ? ` · ${esc(a.tools.join(', '))}` : ''}</div></div>
      <button class="btn ghost xs" type="button" data-agent-role="${esc(a.id)}">${esc(t('agents.rules'))}</button>
      <button class="btn ghost xs" type="button" data-agent-view="${esc(a.id)}">${esc(t('prompts.view'))}</button>
      ${a.source === 'custom' ? `<button class="icon-btn" type="button" data-agent-del="${esc(a.id)}" title="${esc(t('common.delete'))}">${ICON.trash}</button>` : ''}</div>`).join('');
  };
  renderAgents();
  $('#s-agent-list', body).addEventListener('change', (e) => {
    const tg = e.target.closest('[data-agent-toggle]');
    if (!tg) return;
    if (tg.checked) disabledAgents.delete(tg.dataset.agentToggle);
    else disabledAgents.add(tg.dataset.agentToggle);
    renderAgents();
  });
  $('#s-agent-list', body).addEventListener('click', (e) => {
    const v = e.target.closest('[data-agent-view]');
    const d = e.target.closest('[data-agent-del]');
    const r = e.target.closest('[data-agent-role]');
    if (r) {
      // ROLE-<id>.md in ~/.wbloop (snow-cli /role-subagent); saved at once, like hooks
      const a = agentsData.find((x) => x.id === r.dataset.agentRole);
      const file = `ROLE-${a.id}.md`;
      const m = openModal(t('agents.rulesTitle', { id: a.id }), `<p class="muted" style="font-size:12.5px;margin:0 0 10px">${esc(t('agents.rulesHint', { file, dir: '~/.wbloop' }))}</p>
        <textarea id="ag-role" rows="10" spellcheck="false" placeholder="${esc(t('agents.rulesPlaceholder'))}">${esc(a.role?.scope === 'global' ? a.role.text : '')}</textarea>`, {
        size: 'mid',
        subtitle: a.name,
        foot: `<span class="note">${esc(t('agents.rulesNote'))}</span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="ag-role-save">${esc(t('common.save'))}</button>`,
        onClose: () => setTimeout(() => openSettings('agents'), 0),
      });
      $('#ag-role-save').onclick = async () => {
        try {
          const res = await api('/api/agents/role', { method: 'PUT', body: { id: a.id, text: $('#ag-role', m).value } });
          toast(res.removed ? t('agents.rulesRemoved', { file }) : t('agents.rulesSaved', { file }));
          closeModal();
        } catch (err) {
          toast(err.message);
        }
      };
    } else if (v) {
      const a = agentsData.find((x) => x.id === v.dataset.agentView);
      openModal(`#${a.id}`, `<pre class="prompt">${esc(a.prompt)}</pre>`, { size: 'mid', subtitle: a.name, onClose: () => setTimeout(() => openSettings('agents'), 0) });
    } else if (d) {
      customAgents = customAgents.filter((x) => x.id !== d.dataset.agentDel);
      agentsData = agentsData.filter((x) => x.id !== d.dataset.agentDel);
      renderAgents();
    }
  });
  $('#s-ag-add', body).onclick = () => {
    const id = $('#s-ag-id', body).value.trim().replace(/[^\w.-]+/g, '_');
    const prompt = $('#s-ag-prompt', body).value.trim();
    if (!id || !prompt) {
      toast(t('agents.needIdPrompt'));
      return;
    }
    const tools = $$('.tool-checks input:checked', body).map((x) => x.value);
    const rec = { id, name: $('#s-ag-name', body).value.trim() || id, description: $('#s-ag-desc', body).value.trim(), prompt, tools };
    customAgents = [...customAgents.filter((x) => x.id !== id), rec];
    agentsData = [...agentsData.filter((x) => x.id !== id), { ...rec, source: 'custom' }];
    for (const s of ['#s-ag-id', '#s-ag-name', '#s-ag-desc', '#s-ag-prompt']) $(s, body).value = '';
    renderAgents();
    toast(t('agents.addedNote'));
  };

  // safety rules
  let customRules = [...(cfg.safety?.custom || [])];
  let disabledRules = new Set(cfg.safety?.disabled || []);
  const renderRules = () => {
    const rules = [...data.safety.filter((r) => r.builtin), ...customRules.map((r) => ({ ...r, builtin: false }))];
    $('#s-rules', body).innerHTML = rules.map((r) => {
      const on = r.builtin ? !disabledRules.has(r.id) : r.enabled !== false;
      return `<div class="rule-item${on ? '' : ' off'}"><label class="switch sm"><input type="checkbox" data-rule="${esc(r.id)}" data-builtin="${r.builtin ? 1 : 0}"${on ? ' checked' : ''}><span class="track"></span></label>
        <div class="ri-main"><div class="ri-title">${esc(r.description || r.pattern)}${r.builtin ? '' : ` <span class="pk-tag">${esc(t('safety.custom'))}</span>`}</div><div class="ri-sub mono">${esc(r.pattern)}</div></div>
        ${r.builtin ? '' : `<button class="icon-btn" type="button" data-rule-del="${esc(r.id)}" title="${esc(t('common.delete'))}">${ICON.trash}</button>`}</div>`;
    }).join('');
  };
  renderRules();
  $('#s-rules', body).addEventListener('change', (e) => {
    const x = e.target.closest('[data-rule]');
    if (!x) return;
    if (x.dataset.builtin === '1') {
      if (x.checked) disabledRules.delete(x.dataset.rule);
      else disabledRules.add(x.dataset.rule);
    } else {
      customRules = customRules.map((r) => (r.id === x.dataset.rule ? { ...r, enabled: x.checked } : r));
    }
    renderRules();
  });
  $('#s-rules', body).addEventListener('click', (e) => {
    const d = e.target.closest('[data-rule-del]');
    if (!d) return;
    customRules = customRules.filter((r) => r.id !== d.dataset.ruleDel);
    renderRules();
  });
  $('#s-rule-add', body).onclick = () => {
    const pattern = $('#s-rule-pattern', body).value.trim();
    if (!pattern) return;
    customRules.push({ id: Math.random().toString(16).slice(2, 10), pattern, description: $('#s-rule-desc', body).value.trim(), enabled: true });
    $('#s-rule-pattern', body).value = '';
    $('#s-rule-desc', body).value = '';
    renderRules();
  };

  // hooks (files; saved immediately)
  const hooks = data.hooks;
  const renderHooks = () => {
    $('#s-hook-list', body).innerHTML = data.hookTypes.map((type) => {
      const rules = hooks[type] || [];
      const tool = HOOK_TOOL_TYPES.has(type);
      const types = [['command', t('hooks.command')], ...(HOOK_PROMPT_TYPES.has(type) ? [['prompt', t('hooks.prompt')]] : []), ...(HOOK_CONTEXT_TYPES.has(type) ? [['context', t('hooks.context')]] : [])];
      return `<details class="hook-type"${rules.length ? ' open' : ''}><summary><b>${esc(type)}</b><span class="muted">${esc(t(`hooks.type.${type}`))}</span><span class="spacer"></span>${rules.length ? `<span class="badge gold">${rules.length}</span>` : ''}</summary>
        <div class="rule-list">${rules.map((r, i) => `<div class="rule-item"><div class="ri-main"><div class="ri-title">${esc(r.description || t('hooks.untitled'))}${tool && r.matcher ? ` <span class="pk-tag mono">${esc(r.matcher)}</span>` : ''}</div>
          <div class="ri-sub mono">${r.hooks.map((h) => esc(`${h.enabled === false ? '○ ' : ''}${h.type}: ${oneLine(h.command || h.prompt || h.content || '', 120)}`)).join('<br>')}</div></div>
          <button class="icon-btn" type="button" data-hook-del="${esc(type)}:${i}" title="${esc(t('common.delete'))}">${ICON.trash}</button></div>`).join('')}</div>
        <div class="agent-form hook-form" data-type="${esc(type)}">
          <div class="two"><input type="text" class="hk-desc" placeholder="${esc(t('hooks.descPlaceholder'))}">${tool ? `<input type="text" class="hk-matcher mono" placeholder="${esc(t('hooks.matcherPlaceholder'))}" spellcheck="false">` : ''}</div>
          <div class="two"><select class="hk-kind">${types.map(([v, l]) => opt(v, l, 'command')).join('')}</select><input type="number" class="hk-timeout" min="500" step="500" value="10000" title="${esc(t('hooks.timeoutTitle'))}"></div>
          <textarea class="hk-text mono" rows="2" spellcheck="false" placeholder="${esc(t('hooks.textPlaceholder'))}"></textarea>
          <div><button class="btn sm" type="button" data-hook-add="${esc(type)}">${ICON.plus}${esc(t('hooks.add'))}</button></div>
        </div></details>`;
    }).join('');
  };
  renderHooks();
  const saveHookType = async (type) => {
    try {
      const r = await api(`/api/hooks/${type}`, { method: 'PUT', body: { rules: hooks[type] || [] } });
      Object.assign(hooks, r.hooks);
      renderHooks();
      toast(t('common.saved'));
    } catch (err) {
      toast(err.message);
    }
  };
  $('#s-hook-list', body).addEventListener('click', (e) => {
    const del = e.target.closest('[data-hook-del]');
    const add = e.target.closest('[data-hook-add]');
    if (del) {
      const [type, i] = del.dataset.hookDel.split(':');
      hooks[type] = (hooks[type] || []).filter((_, k) => k !== Number(i));
      saveHookType(type);
    } else if (add) {
      const type = add.dataset.hookAdd;
      const form = add.closest('.hook-form');
      const kind = $('.hk-kind', form).value;
      const text = $('.hk-text', form).value.trim();
      if (!text) return;
      const action = { type: kind, enabled: true, ...(kind === 'command' ? { command: text, timeout: Number($('.hk-timeout', form).value) || 10000 } : kind === 'prompt' ? { prompt: text } : { content: text }) };
      hooks[type] = [...(hooks[type] || []), { description: $('.hk-desc', form).value.trim(), ...(HOOK_TOOL_TYPES.has(type) ? { matcher: $('.hk-matcher', form)?.value.trim() || '' } : {}), hooks: [action] }];
      saveHookType(type);
    }
  });

  // skills and custom commands (files; saved immediately) — enabling/disabling skills is saved with "Save"
  let disabledSkills = new Set(cfg.skills?.disabled || []);
  const renderSkills = () => {
    $('#s-skill-list', body).innerHTML = data.skills.length ? data.skills.map((s) => `<div class="rule-item${disabledSkills.has(s.name) ? ' off' : ''}"><label class="switch sm"><input type="checkbox" data-skill="${esc(s.name)}"${disabledSkills.has(s.name) ? '' : ' checked'}><span class="track"></span></label>
      <div class="ri-main"><div class="ri-title">${esc(s.name)} <span class="pk-tag">${esc(s.source)}</span></div><div class="ri-sub">${esc(oneLine(s.description, 160))}</div></div>
      <button class="btn ghost xs" type="button" data-reveal="${esc(s.file)}">${esc(t('skills.open'))}</button></div>`).join('') : `<p class="muted" style="font-size:12.5px">${esc(t('skills.none'))}</p>`;
  };
  renderSkills();
  $('#s-skill-list', body).addEventListener('change', (e) => {
    const x = e.target.closest('[data-skill]');
    if (!x) return;
    if (x.checked) disabledSkills.delete(x.dataset.skill);
    else disabledSkills.add(x.dataset.skill);
    renderSkills();
  });
  body.addEventListener('click', (e) => {
    const r = e.target.closest('[data-reveal]');
    if (r) api('/api/reveal', { method: 'POST', body: { path: r.dataset.reveal } }).catch((err) => toast(err.message));
  });
  $('#s-sk-add', body).onclick = async () => {
    try {
      const made = await api('/api/skills', { method: 'POST', body: { name: $('#s-sk-name', body).value, description: $('#s-sk-desc', body).value } });
      data.skills = (await api('/api/settings-data')).skills;
      renderSkills();
      toast(t('skills.created'), { action: { label: t('run.showInFinder'), run: () => api('/api/reveal', { method: 'POST', body: { path: made.file } }) } });
      $('#s-sk-name', body).value = '';
      $('#s-sk-desc', body).value = '';
    } catch (err) {
      toast(err.message);
    }
  };
  const renderCommands = () => {
    $('#s-cmd-list', body).innerHTML = data.commands.length ? data.commands.map((c) => `<div class="rule-item"><div class="ri-main"><div class="ri-title mono">/${esc(c.name)} <span class="pk-tag">${esc(c.type === 'execute' ? t('commands.typeExecute') : t('commands.typePrompt'))}</span>${c.scope === 'project' ? ` <span class="pk-tag">${esc(t('tools.project'))}</span>` : ''}</div>
      <div class="ri-sub">${esc(c.description || oneLine(c.command, 140))}</div></div>
      ${c.scope === 'global' ? `<button class="icon-btn" type="button" data-cmd-del="${esc(c.name)}" title="${esc(t('common.delete'))}">${ICON.trash}</button>` : ''}</div>`).join('') : `<p class="muted" style="font-size:12.5px">${esc(t('commands.none'))}</p>`;
  };
  renderCommands();
  $('#s-cmd-list', body).addEventListener('click', async (e) => {
    const d = e.target.closest('[data-cmd-del]');
    if (!d) return;
    try {
      data.commands = await api(`/api/commands/${encodeURIComponent(d.dataset.cmdDel)}`, { method: 'DELETE' });
      app.commands = data.commands;
      renderCommands();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#s-cmd-add', body).onclick = async () => {
    try {
      data.commands = await api('/api/commands', { method: 'POST', body: { name: $('#s-cmd-name', body).value, type: $('#s-cmd-type', body).value, command: $('#s-cmd-text', body).value, description: $('#s-cmd-desc', body).value } });
      app.commands = data.commands;
      renderCommands();
      for (const s of ['#s-cmd-name', '#s-cmd-text', '#s-cmd-desc']) $(s, body).value = '';
      toast(t('common.saved'));
    } catch (err) {
      toast(err.message);
    }
  };

  // MCP
  const renderMcp = (summary) => {
    $('#s-mcp-list', body).innerHTML = summary.length ? summary.map((m) => `<div class="rule-item${m.enabled ? '' : ' off'}"><div class="ri-main"><div class="ri-title">${esc(m.name)} <span class="pk-tag">${esc(m.kind)}</span>${m.targets.map((x) => ` <span class="pk-tag">${esc(x === 'gpt' ? 'GPT' : 'WorkBuddy')}</span>`).join('')}</div><div class="ri-sub mono">${esc(oneLine(m.detail, 160))}</div></div></div>`).join('') : `<p class="muted" style="font-size:12.5px">${esc(t('mcp.none'))}</p>`;
  };
  renderMcp(data.mcpSummary);
  $('#s-mcp-save', body).onclick = async () => {
    try {
      const r = await api('/api/mcp', { method: 'PUT', body: { text: $('#s-mcp-json', body).value } });
      $('#s-mcp-json', body).value = JSON.stringify(r, null, 2);
      renderMcp((await api('/api/settings-data')).mcpSummary);
      toast(t('common.saved'));
    } catch (err) {
      toast(err.message);
    }
  };

  // system
  armButton($('#s-clean', body), t('system.cleanupConfirm'), async () => {
    try {
      const r = await api('/api/runs/cleanup', { method: 'POST', body: { days: Number($('#s-clean-days', body).value) } });
      toast(r.deleted ? t('system.cleaned', { n: r.deleted }) : t('system.nothingToClean'));
      actions.refreshRuns?.();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#s-open-data', body).onclick = () => api('/api/open', { method: 'POST', body: { path: app.env.dataDir } }).catch((err) => toast(err.message));
  $('#s-usage', body).onclick = () => openUsage();
  $('#s-loops', body).onclick = () => openLoops({ dir: app.newDir });
  $('#s-export', body).onclick = async () => {
    try {
      const r = await api('/api/settings/export', { method: 'POST', body: {} });
      toast(t('system.exported'), { action: { label: t('run.showInFinder'), run: () => api('/api/reveal', { method: 'POST', body: { path: r.path } }) } });
    } catch (err) {
      toast(err.message);
    }
  };
  $('#s-import', body).onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!(await confirmDialog({ title: t('system.importTitle'), text: t('system.importText'), ok: t('system.import') }))) return;
      await api('/api/settings/import', { method: 'POST', body: json });
      toast(t('system.imported'));
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast(err.message);
    }
  };

  $('#s-save').onclick = async () => {
    const st = readSettingsForm($('#s-form', body), 's');
    const num = (id, def, min = 1) => {
      const n = Math.round(Number($(`#${id}`, body).value));
      return Number.isFinite(n) && n >= min ? n : def;
    };
    const system = {};
    for (const r of ROLE_KEYS) system[r] = { mode: segValue(body, `s-role-${r}`) === 'custom' ? 'custom' : 'builtin', text: $(`#s-role-text-${r}`, body).value };
    try {
      await api('/api/config', {
        method: 'PUT',
        body: {
          codex: st.codex,
          workbuddy: {
            ...st.workbuddy,
            maxTurnsPerCall: num('s-turns', cfg.workbuddy.maxTurnsPerCall),
            maxContinuations: num('s-cont', cfg.workbuddy.maxContinuations, 0),
            idleTimeoutMin: num('s-idle', cfg.workbuddy.idleTimeoutMin),
            autocompact: $('#s-autocompact', body).value.trim(),
          },
          loop: { ...st.loop, waitOnLimitHours: num('s-wait', cfg.loop.waitOnLimitHours), checkTimeoutMin: num('s-check-min', cfg.loop.checkTimeoutMin || 15) },
          team: st.team,
          agents: st.agents,
          prompts: { gpt: $('#s-rule-gpt', body).value.trim(), workbuddy: $('#s-rule-wb', body).value.trim(), system, role: { mode: $('#s-role-mode', body).value, file: $('#s-role-file', body).value.trim() || 'ROLE.md' } },
          subagents: { enabled: $('#s-agents-on', body).checked, disabled: [...disabledAgents], custom: customAgents },
          safety: { policy: $('#s-policy', body).value, timeoutMin: num('s-ap-min', cfg.safety?.timeoutMin || 10), disabled: [...disabledRules], custom: customRules },
          hooks: { enabled: $('#s-hooks-on', body).checked },
          skills: { enabled: $('#s-skills-on', body).checked, disabled: [...disabledSkills], extraDirs: $('#s-sk-dirs', body).value.split('\n').map((x) => x.trim()).filter(Boolean) },
          mcp: { enabled: $('#s-mcp-on', body).checked },
          notebook: { enabled: $('#s-nb', body).checked },
          system: { notify: $('#s-notify', body).checked, caffeinate: $('#s-caff', body).checked },
        },
      });
      toast(t('common.saved'));
      closeModal();
      app.newSettings = null;
      actions.refreshEnv?.();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- GPT: login and quota ----------
function meter(label, w) {
  if (!w) return '';
  const left = Math.max(0, Math.round(100 - w.usedPercent));
  const span = w.windowMins >= 1440 ? t('quota.days', { n: Math.round(w.windowMins / 1440) }) : t('quota.hours', { n: Math.round(w.windowMins / 60) });
  return `<div class="meter${left <= 15 ? ' low' : ''}">
    <div class="top"><span>${esc(t('quota.window', { label, span }))}</span><span class="v">${esc(t('quota.left', { n: left }))}</span></div>
    <div class="bar"><i style="width:${left}%"></i></div>
    <div class="sub">${w.resetsAt ? esc(t('quota.resets', { time: fmtClock(new Date(w.resetsAt).toISOString()) })) : ''}${w.stale ? ` · ${esc(t('quota.stale'))}` : ''}</div>
  </div>`;
}

export function quotaText(q) {
  if (!q) return '';
  const p = q.primary ? Math.max(0, Math.round(100 - q.primary.usedPercent)) : null;
  const s = q.secondary ? Math.max(0, Math.round(100 - q.secondary.usedPercent)) : null;
  return [p != null ? `5h ${p}%` : '', s != null ? `${t('quota.weekShort')} ${s}%` : ''].filter(Boolean).join(' · ');
}

export async function openGptPanel() {
  const c = app.env?.codex;
  if (!c) return;
  if (!c.installed) {
    openModal('GPT (Codex)', `<p>${esc(t('gpt.notInstalled'))}</p><pre class="prompt">npm i -g @openai/codex\ncodex login</pre>`);
    return;
  }
  const render = (q, loading) => {
    const models = gptModelList().map((m) => `${esc(m.id)}${m.unavailable ? ` ${esc(t('form.unavailable'))}` : ''}`).join(', ');
    const plan = q?.planType ? { plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', team: 'ChatGPT Team', business: 'ChatGPT Business', enterprise: 'ChatGPT Enterprise', free: 'ChatGPT Free' }[q.planType] || q.planType : '';
    return `
      <div class="group-title"><span class="emb gpt">${EMBLEM.gpt}</span>${esc(t('gpt.quota'))}${loading ? ' <span class="spinner" style="margin-left:4px"></span>' : ''}<span class="gt-side">${q ? esc(`${q.source === 'live' ? t('gpt.live') : t('gpt.fromSession')} · ${fmtRelative(new Date(q.at).toISOString())}`) : ''}</span></div>
      ${q ? `${meter(t('gpt.window5h'), q.primary)}${meter(t('gpt.windowWeek'), q.secondary)}
        <p class="muted" style="font-size:12.5px">${plan ? `${esc(plan)} · ` : ''}${esc(t('gpt.quotaNote'))}${q.resetCredits ? ` ${esc(t('gpt.resetCredits', { n: q.resetCredits }))}` : ''}${q.reached ? ` ${esc(t('gpt.reached'))}` : ''}</p>`
        : `<p class="muted">${esc(loading ? t('common.loading') : t('gpt.noQuota'))}</p>`}
      <div class="form-group">
        <div class="group-title">${esc(t('gpt.cli'))}</div>
        <div class="kv">
          <div class="k">${esc(t('gpt.status'))}</div><div>${esc(c.loggedIn ? c.statusText : t('cli.notLoggedIn'))}</div>
          <div class="k">${esc(t('gpt.version'))}</div><div class="mono">${esc(c.path)} (${esc(c.version)})</div>
          <div class="k">${esc(t('gpt.defaultModel'))}</div><div>${esc(c.defaultModel || '-')}</div>
          <div class="k">${esc(t('gpt.models'))}</div><div>${models || '-'}</div>
        </div>
        <p class="muted" style="font-size:12.5px;margin:0">${esc(t('gpt.cliNote'))}</p>
      </div>`;
  };
  const body = openModal('GPT (Codex)', render(app.quota, true), {
    subtitle: t('gpt.subtitle'),
    foot: `<span class="note"></span><button class="btn" type="button" id="btn-quota-refresh">${esc(t('gpt.refreshQuota'))}</button><button class="btn" type="button" id="btn-codex-login">${esc(c.loggedIn ? t('gpt.relogin') : t('gpt.login'))}</button>`,
  });
  const load = async (force) => {
    try {
      const r = await api(`/api/quota${force ? '?force=1' : ''}`);
      app.quota = r.quota;
      actions.renderAccounts?.();
    } catch {
      // keep what we have
    }
    if (body.isConnected) body.innerHTML = render(app.quota, false);
  };
  load(false);
  $('#btn-quota-refresh').onclick = () => {
    body.innerHTML = render(app.quota, true);
    load(true);
  };
  $('#btn-codex-login').onclick = async () => {
    try {
      await api('/api/login/codex', { method: 'POST', body: {} });
      toast(t('gpt.loginOpened'));
      setTimeout(() => actions.refreshEnv?.(), 8000);
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- WorkBuddy: login ----------
export function openWbPanel() {
  const w = app.env?.workbuddy;
  if (!w) return;
  if (!w.installed) {
    openModal('WorkBuddy', `<p>${esc(t('wb.notInstalled'))}</p>`);
    return;
  }
  if (!w.loggedIn) {
    startWbLogin();
    return;
  }
  openModal('WorkBuddy', `
    <div class="group-title"><span class="emb wb">${EMBLEM.wb}</span>${esc(t('wb.account'))}</div>
    <div class="kv">
      <div class="k">${esc(t('wb.account'))}</div><div>${esc(w.nickname || t('srv.wb.loggedIn'))}</div>
      <div class="k">${esc(t('wb.app'))}</div><div class="mono">${esc(w.app)} (${esc(w.appVersion)}, core ${esc(w.cliVersion)})</div>
      <div class="k">${esc(t('wb.validUntil'))}</div><div>${w.refreshExpiresAt ? new Date(w.refreshExpiresAt).toLocaleString() : '-'}</div>
      <div class="k">${esc(t('wb.modelInfo'))}</div><div>${esc(w.modelsSource === 'cloud' ? t('form.modelsCloud', { time: fmtTime(new Date(w.modelsUpdatedAt).toISOString()) }) : t('form.modelsBundled'))}</div>
    </div>
    <p class="muted" style="font-size:12.5px">${esc(t('wb.separateLogin', { app: BRAND.name }))}</p>`, {
    subtitle: t('wb.subtitle'),
    foot: `<span class="note"></span><button class="btn danger" type="button" id="btn-wb-logout">${esc(t('wb.logout'))}</button><button class="btn" type="button" id="btn-wb-relogin">${esc(t('gpt.relogin'))}</button>`,
  });
  $('#btn-wb-logout').onclick = async () => {
    try {
      await api('/api/logout/workbuddy', { method: 'POST', body: {} });
      toast(t('wb.loggedOut'));
      closeModal();
      actions.refreshEnv?.();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#btn-wb-relogin').onclick = startWbLogin;
}

let loginPoll = null;

export function startWbLogin() {
  const body = openModal(t('run.wbLogin'), `
    <p>${esc(t('wb.loginIntro'))}</p>
    ${formRow(t('wb.site'), `<select id="wb-login-method"><option value="internal">${esc(t('wb.siteChina'))}</option><option value="external">${esc(t('wb.siteIntl'))}</option></select>`, { forId: 'wb-login-method' })}
    <div id="wb-login-status" class="muted"></div>`, {
    foot: `<span class="note"></span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="btn-wb-login-go">${esc(t('wb.openLogin'))}</button>`,
    onClose: () => clearInterval(loginPoll),
  });
  $('#btn-wb-login-go').onclick = async () => {
    const method = $('#wb-login-method', body).value;
    const status = $('#wb-login-status', body);
    status.innerHTML = `<span class="spinner"></span> ${esc(t('wb.starting'))}`;
    try {
      await api('/api/login/workbuddy', { method: 'POST', body: { method } });
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    clearInterval(loginPoll);
    loginPoll = setInterval(async () => {
      const job = await api('/api/login/workbuddy').catch(() => null);
      if (!job) return;
      if (job.state === 'waiting') {
        status.innerHTML = `<span class="spinner"></span> ${esc(t('wb.waiting'))} <a href="#" id="wb-login-link">${esc(t('wb.openAgain'))}</a>`;
        const link = $('#wb-login-link', body);
        if (link) {
          link.onclick = (e) => {
            e.preventDefault();
            api('/api/open', { method: 'POST', body: { path: job.authUrl } });
          };
        }
      } else if (job.state === 'done') {
        clearInterval(loginPoll);
        status.innerHTML = `<span style="color:var(--ok)">✓ ${esc(t('wb.loginOk'))}${job.nickname ? `: ${esc(job.nickname)}` : ''}</span>`;
        actions.refreshEnv?.();
        setTimeout(closeModal, 1200);
      } else if (job.state === 'error') {
        clearInterval(loginPoll);
        status.innerHTML = `<span class="error">${esc(job.message || t('wb.loginFail'))}</span>`;
      }
    }, 1500);
  };
}

// ---------- changes ----------
export async function showDiff(url, title) {
  const body = openModal(title, `<div class="muted"><span class="spinner"></span> ${esc(t('common.loading'))}</div>`, { size: 'wide' });
  try {
    const d = await api(url);
    const lines = String(d.patch || '').split('\n');
    const max = 20000;
    let html = '';
    lines.slice(0, max).forEach((line, i) => {
      let cls = '';
      if (line.startsWith('diff --git')) cls = 'file';
      else if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
      else if (/^(<<<<<<<|=======|>>>>>>>)/.test(line.slice(1))) cls = 'conflict';
      html += `<div class="${cls}" ${cls === 'file' ? `id="dl-${i}"` : ''}>${esc(line) || ' '}</div>`;
    });
    if (lines.length > max) html += `<div class="muted">${esc(t('diff.more', { n: lines.length - max, cmd: d.command || '' }))}</div>`;
    const fileIdx = [];
    lines.slice(0, max).forEach((line, i) => {
      if (line.startsWith('diff --git')) fileIdx.push({ i, name: line.replace(/^diff --git a\/(.+?) b\/.*$/, '$1') });
    });
    $('#modal-subtitle').textContent = fileIdx.length ? t('diff.files', { n: fileIdx.length }) : '';
    body.innerHTML = `<div class="diff-view"><div class="diff-files">${fileIdx.map((f) => `<div data-jump="${f.i}">${esc(f.name)}</div>`).join('') || `<span class="muted">${esc(t('diff.noText'))}</span>`}</div><div class="diff-code">${html}</div></div>`;
    body.querySelectorAll('[data-jump]').forEach((x) => {
      x.onclick = () => $(`#dl-${x.dataset.jump}`, body)?.scrollIntoView({ block: 'start' });
    });
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- rollback ----------
const restoreText = (s) => t(`restore.${s}`);

export async function openRollback(id, round = null) {
  const body = openModal(t('run.rollback'), `<div class="muted"><span class="spinner"></span> ${esc(t('restore.reading'))}</div>`, {
    size: 'mid',
    subtitle: t('restore.subtitle'),
  });
  let data;
  try {
    data = await api(`/api/runs/${id}/checkpoints`);
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  if (!data.enabled) {
    body.innerHTML = `<p class="muted">${esc(data.reason)}</p>`;
    return;
  }
  if (!data.points.length) {
    body.innerHTML = `<p class="muted">${esc(t('restore.none'))}</p>`;
    return;
  }
  const alive = data.alive || ACTIVE.has(data.status);
  // from a round's "rollback" button: "before round N"; otherwise the latest point that differs from now
  const want = round != null ? data.points.find((p) => (p.kind === 'start' && p.round === round) || (p.aliasKind === 'start' && p.aliasRound === round)) : null;
  let selected = (want || data.points.find((p) => !p.current && p.kind !== 'safety') || data.points[0]).commit;
  const render = () => {
    body.innerHTML = `
      ${alive ? `<div class="notice warn" style="margin-bottom:14px"><span class="msg"><span class="ic">${ICON.warn}</span>${esc(t('restore.running'))}</span><span class="btns"><button class="btn sm" type="button" id="rb-stop">${esc(t('restore.stopTask'))}</button></span></div>` : ''}
      <div class="cp-list">${data.points.map((p) => `<div class="cp${p.commit === selected ? ' on' : ''}" data-commit="${esc(p.commit)}">
          <span class="dotline"></span>
          <div class="t"><div class="t1">${esc(p.label)}${p.alias ? `<span class="muted"> (= ${esc(p.alias)})</span>` : ''}${p.current ? ` <span class="badge gold">${esc(t('restore.current'))}</span>` : ''}${p.team ? ` <span class="badge">${esc(t('restore.team'))}</span>` : ''}</div>
          <div class="t2">${esc(p.at ? `${fmtClock(p.at)} · ${fmtRelative(p.at)}` : '')}${p.kind === 'end' && p.files != null ? ` · ${esc(t('restore.changedIn', { n: p.files }))}` : ''}${p.kind === 'safety' ? ` · ${esc(t('restore.undo'))}` : ''}</div></div>
          <span class="mono muted" style="font-size:11px">${esc(p.commit.slice(0, 7))}</span>
        </div>`).join('')}</div>
      <div class="cp-preview" id="rb-preview"><div class="muted" style="font-size:12.5px"><span class="spinner"></span> ${esc(t('restore.computing'))}</div></div>`;
    $$('.cp', body).forEach((x) => {
      x.onclick = () => {
        selected = x.dataset.commit;
        render();
      };
    });
    const stop = $('#rb-stop', body);
    if (stop) {
      stop.onclick = async () => {
        await api(`/api/runs/${id}/control`, { method: 'POST', body: { cmd: 'stop' } }).catch((err) => toast(err.message));
        toast(t('run.toastStop'));
        setTimeout(() => openRollback(id, round), 2500);
      };
    }
    preview();
  };
  const preview = async () => {
    const box = $('#rb-preview', body);
    const commit = selected;
    try {
      const p = await api(`/api/runs/${id}/restore-preview?commit=${encodeURIComponent(commit)}`);
      if (commit !== selected || !box.isConnected) return;
      const counts = { M: 0, D: 0, A: 0 };
      p.files.forEach((f) => {
        counts[f.status] = (counts[f.status] || 0) + 1;
      });
      box.innerHTML = p.files.length
        ? `<div style="font-size:12.5px;color:var(--ink-2);margin-bottom:6px">${esc(t('restore.summary', { parts: ['M', 'D', 'A'].filter((k) => counts[k]).map((k) => t(`restore.count.${k}`, { n: counts[k] })).join(', ') }))}</div>
           <ul class="files">${p.files.slice(0, 300).map((f) => `<li><span class="st ${f.status === 'D' ? 'D' : f.status === 'A' ? 'A' : ''}">${esc(f.status)}</span><span>${esc(f.path)}</span><span class="num">${esc(restoreText(f.status))}</span></li>`).join('')}</ul>`
        : `<div class="muted" style="font-size:12.5px">${esc(t('restore.same'))}</div>`;
      $('#rb-go').disabled = alive || !p.files.length;
    } catch (err) {
      if (box.isConnected) box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  };
  $('#modal-foot').innerHTML = `<span class="note">${esc(t('restore.note'))}</span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="rb-go" disabled>${esc(t('restore.go'))}</button>`;
  $('#modal-foot').classList.remove('hidden');
  render();
  $('#rb-go').onclick = async () => {
    const point = data.points.find((p) => p.commit === selected);
    try {
      const r = await api(`/api/runs/${id}/restore`, { method: 'POST', body: { commit: selected } });
      closeModal();
      toast(t('restore.done', { label: point.label }), { action: { label: t('restore.undoBtn'), run: () => undoRestore(id, r.safety) } });
    } catch (err) {
      toast(err.message);
    }
  };
}

async function undoRestore(id, safety) {
  try {
    await api(`/api/runs/${id}/restore`, { method: 'POST', body: { commit: safety } });
    toast(t('restore.undone'));
  } catch (err) {
    toast(err.message);
  }
}

// ---------- help ----------
export function openHelp() {
  const keys = [
    ['help.k.palette', '⌘K'], ['help.k.new', '⌘N'], ['help.k.settings', '⌘,'], ['help.k.help', '⌘/'],
    ['help.k.start', '⌘↩'], ['help.k.send', '↩'], ['help.k.newline', '⇧↩'], ['help.k.cut', '⌥↩'],
    ['help.k.history', '↑ ↓'], ['help.k.close', 'esc'], ['help.k.rollback', 'esc esc'], ['help.k.tab', 'Tab'],
    ['help.k.file', '@'], ['help.k.agent', '#'], ['help.k.mate', '>>'], ['help.k.inject', '!`cmd`'],
  ];
  const cmds = [
    ['/cut …', 'help.c.cut'], ['/btw …', 'help.c.btw'], ['/approve', 'help.c.approve'], ['/pause /resume /stop', 'help.c.pause'],
    ['/team off|auto|always', 'help.c.team'], ['/yolo', 'help.c.yolo'], ['/compact', 'help.c.compact'], ['/review', 'help.c.review'],
    ['/skills /agents /todo', 'help.c.pickers'], ['/new-prompt …', 'help.c.newPrompt'], ['/loop 30m …', 'help.c.loop'], ['/notebook', 'help.c.notebook'],
    ['/rollback /diff', 'help.c.rollback'], ['/export /copy', 'help.c.export'], ['/rounds /budget /check', 'help.c.limits'], ['/usage /tool-display', 'help.c.usage'],
    ['/template /init /mode', 'help.c.init'], ['/gitline', 'help.c.gitline'], ['/deepresearch …', 'help.c.deepresearch'], ['/<custom>', 'help.c.custom'],
  ];
  openModal(t('help.title'), `
    <div class="loop-diagram">
      <span class="node"><span class="emb user">${EMBLEM.user}</span>${esc(t('help.d.goal'))}</span><span class="arr">→</span>
      <span class="node"><span class="emb gpt">${EMBLEM.gpt}</span>${esc(t('help.d.plan'))}</span><span class="arr">→</span>
      <span class="node"><span class="emb wb">${EMBLEM.wb}</span>${esc(t('help.d.work'))}</span><span class="arr">→</span>
      <span class="node"><span class="emb gpt">${EMBLEM.gpt}</span>${esc(t('help.d.audit'))}</span><span class="arr">↺</span>
      <span class="node"><span class="emb rev">${EMBLEM.rev}</span>${esc(t('help.d.review'))}</span>
    </div>
    <p class="muted" style="font-size:12.5px;text-align:center;margin-top:-6px">${esc(t('help.loopNote'))}</p>
    <div class="form-group"><div class="group-title">${esc(t('help.features'))}</div>
      <div class="help-cmds">${['team', 'agents', 'prompts', 'safety', 'hooks', 'skills', 'mcp', 'loops', 'notebook', 'modes'].map((k) => `<b class="hf">${esc(t(`help.f.${k}`))}</b><span>${esc(t(`help.f.${k}.desc`))}</span>`).join('')}</div></div>
    <div class="form-group"><div class="group-title">${esc(t('help.shortcuts'))}</div>
      <div class="help-grid">${keys.map(([a, b]) => `<div class="row"><span>${esc(t(a))}</span><span class="kbd">${esc(b)}</span></div>`).join('')}</div></div>
    <div class="form-group"><div class="group-title">${esc(t('help.commands'))}<span class="gt-side">${esc(t('help.imeNote'))}</span></div>
      <div class="help-cmds">${cmds.map(([a, b]) => `<code>${esc(a)}</code><span>${esc(t(b))}</span>`).join('')}</div></div>
    <div class="form-group"><div class="group-title">${esc(t('help.aboutName'))}</div>
      <p style="font-size:13px;line-height:1.85;margin:0">${t('help.nameStory', { name: `<b>${esc(BRAND.name)}</b>`, greek: `<i>${esc(BRAND.greek)}</i>` })}</p></div>`, { size: 'mid', subtitle: `${BRAND.name} · ${BRAND.name === BRAND.latin ? BRAND.greek : BRAND.latin}` });
}

export function registerPanels() {
  Object.assign(actions, { openSettings, openGptPanel, openWbPanel, startWbLogin, showDiff, openRollback, openHelp });
}

export { fmtDuration, REPLY_LANGS };
