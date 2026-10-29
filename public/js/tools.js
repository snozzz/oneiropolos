// Tools reached from the composer and the palette, ported from snow-cli: command injection (!`cmd` / !!`cmd`),
// skills (/skills), TODO comments (/todo), sub-agent picker (/agents), git commits (/gitline), code review (/review),
// prompt generator (/new-prompt), usage (/usage), loops (/loop), the project notebook (/notebook) and the team board (>>).
import { $, $$, api, app, el, esc, fmtClock, fmtDuration, fmtRelative, fmtTime, fmtTokens, md, oneLine, shortPath, toast } from './core.js';
import { ICON } from './brand.js';
import { ENGINE_NAMES } from './engines.js';
import { t } from './i18n.js';
import { closeModal, confirmDialog, fuzzyScore, openModal } from './overlay.js';

// ---------- !`cmd` (output goes into the message) and !!`cmd` (only shown to you) ----------

const INJECT_RE = /(!!?)`([^`]+)`(?:<(\d+)>)?/g;

async function runShell(dir, command, timeoutMs) {
  let r = await api('/api/exec', { method: 'POST', body: { dir, command, timeoutMs } });
  if (r.needsConfirm) {
    const ok = await confirmDialog({ title: t('tools.sensitiveTitle'), text: `${esc(t('tools.sensitiveText', { rule: r.rule.description }))}<br><code>${esc(command)}</code>`, ok: t('tools.runAnyway'), danger: true });
    if (!ok) return null;
    r = await api('/api/exec', { method: 'POST', body: { dir, command, timeoutMs, confirmed: true } });
  }
  return r;
}

function outputBlock(r) {
  const status = r.timedOut ? t('tools.timedOut') : `exit ${r.code}`;
  return `$ ${r.command}  (${status}, ${fmtDuration(r.durationMs)})\n${r.output || ''}`;
}

export function showCommandOutput(results, title = t('tools.outputTitle')) {
  openModal(title, results.map((r) => `<pre class="prompt" style="margin-bottom:10px">${esc(outputBlock(r))}</pre>`).join(''), { size: 'mid' });
}

/** Returns the text to send (with !`cmd` replaced by its output), or null when nothing is left to send. */
export async function expandInjections(text, dir) {
  if (!INJECT_RE.test(text)) return text;
  INJECT_RE.lastIndex = 0;
  if (!dir) throw new Error(t('home.needDir'));
  const shown = [];
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INJECT_RE)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const r = await runShell(dir, m[2], Number(m[3]) || 30_000);
    if (!r) return null;
    if (m[1] === '!!') shown.push(r);
    else out += `\n\`\`\`\n${outputBlock(r)}\n\`\`\`\n`;
  }
  out += text.slice(last);
  if (shown.length) showCommandOutput(shown, t('tools.bashTitle'));
  const rest = out.trim();
  return rest ? rest : null;
}

/** "execute" custom commands: run in the working directory and show the output, with "send to GPT" when in a task. */
export async function runExecuteCommand(dir, command, { onSend } = {}) {
  if (!dir) {
    toast(t('home.needDir'));
    return;
  }
  const body = openModal(t('tools.outputTitle'), `<div class="muted"><span class="spinner"></span> $ ${esc(command)}</div>`, { size: 'mid' });
  const r = await runShell(dir, command, 120_000).catch((err) => ({ error: err.message }));
  if (!body.isConnected) return;
  if (!r) {
    closeModal();
    return;
  }
  if (r.error) {
    body.innerHTML = `<p class="error">${esc(r.error)}</p>`;
    return;
  }
  body.innerHTML = `<pre class="prompt">${esc(outputBlock(r))}</pre>`;
  if (onSend) {
    $('#modal-foot').innerHTML = `<span class="note"></span><button class="btn" type="button" data-close>${esc(t('common.close'))}</button><button class="btn primary" type="button" id="exec-send">${esc(t('tools.sendToGpt'))}</button>`;
    $('#modal-foot').classList.remove('hidden');
    $('#exec-send').onclick = () => {
      closeModal();
      onSend(`\`\`\`\n${outputBlock(r)}\n\`\`\``);
    };
  }
}

// ---------- pickers ----------

function pickerModal({ title, subtitle = '', items, render, search = (x) => '', onPick, extra = '', footNote = '' }) {
  const body = openModal(title, `<input type="search" id="pk-q" placeholder="${esc(t('tools.search'))}" autocomplete="off" spellcheck="false" style="margin-bottom:10px">${extra}<div class="pick-list" id="pk-list"></div>`, {
    subtitle,
    size: 'mid',
    foot: footNote ? `<span class="note">${footNote}</span><button class="btn" type="button" data-close>${esc(t('common.close'))}</button>` : '',
  });
  const list = $('#pk-list', body);
  let shown = [];
  let index = 0;
  const draw = () => {
    const q = $('#pk-q', body).value.trim();
    shown = items.map((it) => ({ it, s: fuzzyScore(q, search(it)) })).filter((x) => x.s > 0).sort((a, b) => (q ? b.s - a.s : 0)).map((x) => x.it).slice(0, 200);
    index = Math.min(index, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((it, i) => `<button class="pick-item${i === index ? ' on' : ''}" type="button" data-i="${i}">${render(it)}</button>`).join('') || `<div class="muted" style="padding:10px">${esc(t('palette.empty'))}</div>`;
  };
  $('#pk-q', body).addEventListener('input', () => {
    index = 0;
    draw();
  });
  $('#pk-q', body).addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      draw();
      $('.pick-item.on', list)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && shown[index]) {
      e.preventDefault();
      onPick(shown[index], body);
    }
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) onPick(shown[Number(b.dataset.i)], body);
  });
  draw();
  setTimeout(() => $('#pk-q', body)?.focus(), 30);
  return body;
}

/** /skills: pick a skill and inject its SKILL.md (snow-cli /skills-), with optional extra text for $ARGUMENTS. */
export async function openSkillsPicker(dir, onInsert) {
  let skills = [];
  try {
    skills = await api(`/api/skills${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (!skills.length) {
    openModal(t('tools.skillsTitle'), `<p class="muted">${esc(t('tools.noSkills'))}</p>`, { subtitle: t('tools.skillsSubtitle') });
    return;
  }
  pickerModal({
    title: t('tools.skillsTitle'),
    subtitle: t('tools.skillsSubtitle'),
    items: skills,
    search: (s) => `${s.name} ${s.description}`,
    render: (s) => `<span class="pk-main">${ICON.sparkle}<b>${esc(s.name)}</b><span class="pk-tag">${esc(s.scope === 'project' ? t('tools.project') : t('tools.global'))}</span></span><span class="pk-sub">${esc(s.description || '')}</span>`,
    extra: `<input type="text" id="pk-append" placeholder="${esc(t('tools.skillAppend'))}" autocomplete="off" style="margin-bottom:10px">`,
    onPick: async (s, body) => {
      const append = $('#pk-append', body)?.value.trim() || '';
      try {
        const full = await api(`/api/skills/read?name=${encodeURIComponent(s.name)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`);
        let content = full.content;
        if (content.includes('$ARGUMENTS')) content = content.split('$ARGUMENTS').join(append);
        const block = `# Skill: ${s.name}\n(${full.file})\n\n${content.trim()}\n${append && !full.content.includes('$ARGUMENTS') ? `\n[User Append]\n${append}\n` : ''}# Skill End`;
        closeModal();
        onInsert(block);
      } catch (err) {
        toast(err.message);
      }
    },
  });
}

/** /todo: TODO/FIXME comments in the working directory (snow-cli /todo-). */
export async function openTodoPicker(dir, onInsert) {
  if (!dir) {
    toast(t('home.needDir'));
    return;
  }
  let data;
  try {
    data = await api(`/api/fs/todos?dir=${encodeURIComponent(dir)}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  if (!data.todos.length) {
    openModal(t('tools.todoTitle'), `<p class="muted">${esc(t('tools.noTodos'))}</p>`);
    return;
  }
  pickerModal({
    title: t('tools.todoTitle'),
    subtitle: t('tools.todoSubtitle', { n: data.todos.length }),
    items: data.todos,
    search: (x) => `${x.file} ${x.text} ${x.tag}`,
    render: (x) => `<span class="pk-main"><span class="pk-tag ${x.tag === 'FIXME' ? 'warn' : ''}">${esc(x.tag)}</span><b>${esc(x.text || '…')}</b></span><span class="pk-sub mono">${esc(x.file)}:${x.line}</span>`,
    onPick: (x) => {
      closeModal();
      onInsert(t('tools.todoInsert', { tag: x.tag, file: `${x.file}:${x.line}`, text: x.text }));
    },
  });
}

/** /agents: insert a #agent mention. */
export function openAgentsPicker(onInsert) {
  const list = (app.env?.subagents || []).filter((a) => a.enabled);
  pickerModal({
    title: t('tools.agentsTitle'),
    subtitle: t('tools.agentsSubtitle'),
    items: list,
    search: (a) => `${a.id} ${a.name} ${a.description}`,
    render: (a) => `<span class="pk-main">${ICON.agents}<b>#${esc(a.id)}</b><span class="pk-tag">${esc(a.name)}</span></span><span class="pk-sub">${esc(a.description || '')}</span>`,
    onPick: (a) => {
      closeModal();
      onInsert(`#${a.id} `);
    },
  });
}

/** /gitline: put commits, or the staged / unstaged changes, into the message (snow-cli's GitLine blocks). */
export async function openGitLine(dir, onInsert) {
  if (!dir) {
    toast(t('home.needDir'));
    return;
  }
  const body = openModal(t('tools.gitlineTitle'), `<div class="muted"><span class="spinner"></span> ${esc(t('tools.loading'))}</div>`, { size: 'mid', subtitle: t('tools.gitlineSubtitle') });
  let info;
  try {
    info = await api(`/api/git?dir=${encodeURIComponent(dir)}`);
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  const targets = [];
  if (info.isRepo) {
    if (info.staged) targets.push({ id: 'staged', label: t('review.staged'), sub: t('tools.files', { n: info.staged }) });
    if (info.unstaged) targets.push({ id: 'unstaged', label: t('review.unstaged'), sub: t('tools.files', { n: info.unstaged }) });
    for (const c of info.commits) targets.push({ id: c.sha, label: c.subject, sub: `${c.sha.slice(0, 7)} · ${c.author} · ${fmtRelative(c.date)}`, commit: true });
  }
  if (!targets.length) {
    body.innerHTML = `<p class="muted">${esc(info.isRepo ? t('tools.gitlineNothing') : t('tools.reviewNotRepo'))}</p>`;
    return;
  }
  body.innerHTML = `<div class="muted" style="font-size:12.5px;margin-bottom:8px">${esc(t('tools.branch', { branch: info.branch }))}</div>
    <div class="check-list" id="gl-list">${targets.map((x, i) => `<label class="check-row${x.commit ? ' commit' : ''}"><input type="checkbox" value="${esc(x.id)}"${i === 0 ? ' checked' : ''}><span class="cr-main">${esc(x.label)}</span><span class="cr-sub">${esc(x.sub)}</span></label>`).join('')}</div>`;
  $('#modal-foot').innerHTML = `<span class="note">${esc(t('tools.gitlineNote'))}</span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="gl-go">${ICON.plus}${esc(t('tools.gitlineInsert'))}</button>`;
  $('#modal-foot').classList.remove('hidden');
  $('#gl-go').onclick = async () => {
    const picked = $$('#gl-list input:checked', body).map((x) => x.value);
    if (!picked.length) {
      toast(t('tools.gitlinePick'));
      return;
    }
    $('#gl-go').disabled = true;
    try {
      const blocks = [];
      for (const target of picked) blocks.push((await api(`/api/git/line?dir=${encodeURIComponent(dir)}&target=${encodeURIComponent(target)}`)).text);
      closeModal();
      onInsert(blocks.join('\n\n'));
    } catch (err) {
      toast(err.message);
      if ($('#gl-go')) $('#gl-go').disabled = false;
    }
  };
}

// ---------- jobs: /review and /new-prompt run as read-only GPT turns ----------

async function pollJob(id, onUpdate) {
  for (;;) {
    let job;
    try {
      job = await api(`/api/jobs/${id}`);
    } catch (err) {
      onUpdate({ status: 'failed', error: err.message });
      return;
    }
    onUpdate(job);
    if (job.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function jobView(job, { doneHtml }) {
  if (job.status === 'running') return `<div class="g-status"><span class="spinner"></span><span>${esc(t('tools.thinking'))}</span><span class="last">${esc(job.last || '')}</span></div>`;
  if (job.status === 'failed') return `<p class="error">${esc(job.error || t('tools.failed'))}</p>`;
  return doneHtml(job);
}

/** /review: choose staged/unstaged changes, commits or this task's changes; GPT reviews them read-only. */
export async function openReview(dir, runId = '') {
  if (!dir) {
    toast(t('home.needDir'));
    return;
  }
  const body = openModal(t('tools.reviewTitle'), `<div class="muted"><span class="spinner"></span> ${esc(t('tools.loading'))}</div>`, { size: 'mid', subtitle: t('tools.reviewSubtitle') });
  let info;
  try {
    info = await api(`/api/git?dir=${encodeURIComponent(dir)}`);
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  const targets = [];
  if (runId) targets.push({ id: 'task', label: t('review.task'), sub: t('tools.reviewTaskSub') });
  if (info.isRepo) {
    if (info.staged) targets.push({ id: 'staged', label: t('review.staged'), sub: t('tools.files', { n: info.staged }) });
    if (info.unstaged) targets.push({ id: 'unstaged', label: t('review.unstaged'), sub: t('tools.files', { n: info.unstaged }) });
    for (const c of info.commits) targets.push({ id: c.sha, label: c.subject, sub: `${c.sha.slice(0, 7)} · ${c.author} · ${fmtRelative(c.date)}`, commit: true });
  }
  if (!targets.length) {
    body.innerHTML = `<p class="muted">${esc(info.isRepo ? t('tools.reviewNothing') : t('tools.reviewNotRepo'))}</p>`;
    return;
  }
  const chosen = new Set([targets[0].id]);
  body.innerHTML = `${info.isRepo ? `<div class="muted" style="font-size:12.5px;margin-bottom:8px">${esc(t('tools.branch', { branch: info.branch }))}</div>` : ''}
    <div class="check-list" id="rv-list">${targets.map((x) => `<label class="check-row${x.commit ? ' commit' : ''}"><input type="checkbox" value="${esc(x.id)}"${chosen.has(x.id) ? ' checked' : ''}><span class="cr-main">${esc(x.label)}</span><span class="cr-sub">${esc(x.sub)}</span></label>`).join('')}</div>
    <textarea id="rv-notes" rows="2" placeholder="${esc(t('tools.reviewNotes'))}" style="margin-top:12px"></textarea>
    <div id="rv-result" style="margin-top:14px"></div>`;
  $('#modal-foot').innerHTML = `<span class="note">${esc(t('tools.reviewNote'))}</span><button class="btn" type="button" data-close>${esc(t('common.close'))}</button><button class="btn primary" type="button" id="rv-go">${ICON.eye}${esc(t('tools.reviewGo'))}</button>`;
  $('#modal-foot').classList.remove('hidden');
  $('#rv-go').onclick = async () => {
    const picked = $$('#rv-list input:checked', body).map((x) => x.value);
    if (!picked.length) {
      toast(t('srv.review.noTarget'));
      return;
    }
    $('#rv-go').disabled = true;
    const res = $('#rv-result', body);
    try {
      const job = await api('/api/review', { method: 'POST', body: { dir, targets: picked, notes: $('#rv-notes', body).value, runId } });
      await pollJob(job.id, (j) => {
        if (!res.isConnected) return;
        res.innerHTML = jobView(j, { doneHtml: (x) => `<div class="review-out md">${md(x.answer)}</div><div class="muted" style="font-size:11.5px;margin-top:6px">${esc([x.model, x.durationMs ? fmtDuration(x.durationMs) : ''].filter(Boolean).join(' · '))}</div>` });
      });
    } catch (err) {
      res.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
    if ($('#rv-go')) $('#rv-go').disabled = false;
  };
}

/** /new-prompt: turn a rough idea into a structured task (accept puts it into the goal box, not sent). */
export function openNewPrompt(dir, seed, onAccept) {
  const body = openModal(t('tools.newPromptTitle'), `
    <textarea id="np-req" rows="3" placeholder="${esc(t('tools.newPromptPlaceholder'))}">${esc(seed || '')}</textarea>
    <div id="np-out" style="margin-top:14px"></div>`, {
    size: 'mid',
    subtitle: dir ? t('tools.newPromptSubtitleDir', { dir: shortPath(dir) }) : t('tools.newPromptSubtitle'),
    foot: `<span class="note"></span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn" type="button" id="np-go">${ICON.wand}${esc(t('tools.generate'))}</button><button class="btn primary" type="button" id="np-ok" disabled>${esc(t('tools.useIt'))}</button>`,
  });
  let result = '';
  const go = async () => {
    const req = $('#np-req', body).value.trim();
    if (!req) return;
    $('#np-go').disabled = true;
    $('#np-ok').disabled = true;
    const out = $('#np-out', body);
    try {
      const job = await api('/api/new-prompt', { method: 'POST', body: { dir, requirement: req } });
      await pollJob(job.id, (j) => {
        if (!out.isConnected) return;
        out.innerHTML = jobView(j, { doneHtml: (x) => `<pre class="prompt">${esc(x.answer)}</pre>` });
        if (j.status === 'done') {
          result = j.answer.trim();
          $('#np-ok').disabled = !result;
          $('#np-go').textContent = t('tools.regenerate');
        }
      });
    } catch (err) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
    if ($('#np-go')) $('#np-go').disabled = false;
  };
  $('#np-go').onclick = go;
  $('#np-ok').onclick = () => {
    closeModal();
    onAccept(result);
  };
  setTimeout(() => $('#np-req', body)?.focus(), 30);
  if (seed) go();
}

// ---------- /usage ----------

export async function openUsage(period = '30d') {
  const periods = [['24h', t('usage.24h')], ['7d', t('usage.7d')], ['30d', t('usage.30d')], ['12m', t('usage.12m')]];
  const body = openModal(t('usage.title'), `<div class="seg" id="us-p">${periods.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === period ? 'on' : ''}">${esc(l)}</button>`).join('')}</div><div id="us-body" style="margin-top:16px"><span class="spinner"></span></div>`, { size: 'mid', subtitle: t('usage.subtitle') });
  const load = async (p) => {
    const box = $('#us-body', body);
    let r;
    try {
      r = await api(`/api/usage?period=${p}`);
    } catch (err) {
      box.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      return;
    }
    const max = Math.max(1, ...r.byDay.map((d) => d.gpt + d.workbuddy));
    const card = (who, v) => `<div class="stat"><div class="k">${esc(who)}</div><div class="v">${fmtTokens(v.in + v.out)}</div><div class="s">${esc(t('usage.detail', { calls: v.calls, input: fmtTokens(v.in), cached: fmtTokens(v.cached), output: fmtTokens(v.out) }))}</div></div>`;
    const lead = t('usage.lead');
    const exec = t('usage.exec');
    const modelCell = (m) => (m.engine && !m.model.toLowerCase().includes(ENGINE_NAMES[m.engine]?.toLowerCase()) ? `${ENGINE_NAMES[m.engine] || m.engine} · ${m.model}` : m.model);
    box.innerHTML = `<div class="stats">${card(lead, r.totals.gpt)}${card(exec, r.totals.workbuddy)}</div>
      ${r.byDay.some((d) => d.gpt + d.workbuddy) ? `<div class="bars" title="${esc(t('usage.barsTitle'))}">${r.byDay.map((d) => `<div class="bar-col" title="${esc(`${d.key}: ${lead} ${fmtTokens(d.gpt)} · ${exec} ${fmtTokens(d.workbuddy)}`)}"><i class="wb" style="height:${(d.workbuddy / max) * 100}%"></i><i class="gpt" style="height:${(d.gpt / max) * 100}%"></i></div>`).join('')}</div>
        <div class="bars-legend"><span><i class="gpt"></i>${esc(lead)}</span><span><i class="wb"></i>${esc(exec)}</span><span class="muted">${esc(r.byDay[0].key)} – ${esc(r.byDay[r.byDay.length - 1].key)}</span></div>` : `<p class="muted">${esc(t('usage.none'))}</p>`}
      ${r.byModel.length ? `<table class="tbl"><thead><tr><th>${esc(t('usage.model'))}</th><th>${esc(t('usage.calls'))}</th><th>${esc(t('usage.input'))}</th><th>${esc(t('usage.cached'))}</th><th>${esc(t('usage.output'))}</th></tr></thead><tbody>${r.byModel.map((m) => `<tr><td><span class="dot ${m.agent === 'gpt' ? 'gpt' : 'wb'}"></span>${esc(modelCell(m))}</td><td>${m.calls}</td><td>${fmtTokens(m.in)}</td><td>${fmtTokens(m.cached)}</td><td>${fmtTokens(m.out)}</td></tr>`).join('')}</tbody></table>` : ''}`;
  };
  $$('#us-p button', body).forEach((b) => {
    b.onclick = () => {
      $$('#us-p button', body).forEach((x) => x.classList.toggle('on', x === b));
      load(b.dataset.v);
    };
  });
  load(period);
}

// ---------- /loop ----------

export async function openLoops({ spec = '', dir = '', runId = '', settings = null } = {}) {
  const body = openModal(t('loops.title'), `
    <div class="loop-new">
      <input type="text" id="lp-spec" placeholder="${esc(t('loops.placeholder'))}" value="${esc(spec)}" autocomplete="off">
      <div class="hint">${esc(runId ? t('loops.hintRun') : dir ? t('loops.hintDir', { dir: shortPath(dir) }) : t('loops.hintNoDir'))}</div>
    </div>
    <div class="group-title" style="margin-top:18px">${esc(t('loops.existing'))}</div>
    <div id="lp-list"><span class="spinner"></span></div>`, {
    size: 'mid',
    subtitle: t('loops.subtitle'),
    foot: `<span class="note">${esc(t('loops.note'))}</span><button class="btn" type="button" data-close>${esc(t('common.close'))}</button><button class="btn primary" type="button" id="lp-add"${!dir && !runId ? ' disabled' : ''}>${ICON.repeat}${esc(t('loops.add'))}</button>`,
  });
  const render = async () => {
    let list = [];
    try {
      list = (await api('/api/settings-data')).loops;
    } catch (err) {
      $('#lp-list', body).innerHTML = `<p class="error">${esc(err.message)}</p>`;
      return;
    }
    $('#lp-list', body).innerHTML = list.length ? `<div class="rule-list">${list.map((l) => `<div class="rule-item${l.enabled ? '' : ' off'}">
        <label class="switch sm"><input type="checkbox" data-toggle="${esc(l.id)}"${l.enabled ? ' checked' : ''}><span class="track"></span></label>
        <div class="ri-main"><div class="ri-title">${esc(l.schedule.type === 'daily' ? t('loops.daily', { time: l.schedule.time }) : t('loops.every', { n: Math.round(l.schedule.ms / 60000) }))} · ${esc(oneLine(l.prompt, 80))}</div>
        <div class="ri-sub">${esc(l.kind === 'message' ? t('loops.toTask', { id: l.runId }) : t('loops.newTaskIn', { dir: shortPath(l.workdir) }))} · ${esc(t('loops.next', { time: fmtClock(l.nextRunAt) }))}${l.runs ? ` · ${esc(t('loops.runs', { n: l.runs }))}` : ''}${l.lastError ? ` · <span class="error">${esc(l.lastError)}</span>` : ''}</div></div>
        <button class="icon-btn" type="button" data-del="${esc(l.id)}" title="${esc(t('common.delete'))}">${ICON.trash}</button></div>`).join('')}</div>` : `<p class="muted">${esc(t('loops.none'))}</p>`;
  };
  $('#lp-list', body).addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      await api(`/api/loops/${del.dataset.del}`, { method: 'DELETE' }).catch((err) => toast(err.message));
      render();
    }
  });
  $('#lp-list', body).addEventListener('change', async (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      await api(`/api/loops/${tg.dataset.toggle}`, { method: 'PATCH', body: { enabled: tg.checked } }).catch((err) => toast(err.message));
      render();
    }
  });
  $('#lp-add').onclick = async () => {
    try {
      const rec = await api('/api/loops', { method: 'POST', body: { kind: runId ? 'message' : 'task', spec: $('#lp-spec', body).value, dir, runId, settings } });
      toast(t('loops.added', { time: fmtClock(rec.nextRunAt) }));
      $('#lp-spec', body).value = '';
      render();
    } catch (err) {
      toast(err.message);
    }
  };
  render();
}

// ---------- /notebook ----------

export async function openNotebook(dir) {
  if (!dir) {
    toast(t('home.needDir'));
    return;
  }
  let nb;
  try {
    nb = await api(`/api/notebook?dir=${encodeURIComponent(dir)}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  const body = openModal(t('notebook.title'), `<textarea id="nb-text" rows="18" class="mono" spellcheck="false" placeholder="${esc(t('notebook.placeholder'))}">${esc(nb.text)}</textarea>`, {
    size: 'mid',
    subtitle: t('notebook.subtitle', { dir: shortPath(dir) }),
    foot: `<span class="note mono">${esc(shortPath(nb.file))}</span><button class="btn" type="button" data-close>${esc(t('common.cancel'))}</button><button class="btn primary" type="button" id="nb-save">${esc(t('common.save'))}</button>`,
  });
  $('#nb-save').onclick = async () => {
    try {
      await api('/api/notebook', { method: 'PUT', body: { dir, text: $('#nb-text', body).value } });
      toast(t('common.saved'));
      closeModal();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- the team board of a round ----------

export async function openBoard(runId, round, members = []) {
  const body = openModal(t('team.boardTitle', { n: round }), `<pre class="prompt" id="bd-text"><span class="spinner"></span></pre>
    <div class="board-post"><select id="bd-to"><option value="">${esc(t('team.toEveryone'))}</option>${members.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}</select><input type="text" id="bd-msg" placeholder="${esc(t('team.postPlaceholder'))}" autocomplete="off"><button class="btn primary sm" type="button" id="bd-send">${esc(t('team.post'))}</button></div>`, {
    size: 'mid',
    subtitle: t('team.boardSubtitle'),
  });
  const load = async () => {
    try {
      const r = await api(`/api/runs/${runId}/board?round=${round}`);
      if ($('#bd-text', body)) $('#bd-text', body).textContent = r.text || t('team.boardEmpty');
    } catch (err) {
      if ($('#bd-text', body)) $('#bd-text', body).textContent = err.message;
    }
  };
  $('#bd-send').onclick = async () => {
    const text = $('#bd-msg', body).value.trim();
    if (!text) return;
    try {
      await api(`/api/runs/${runId}/board`, { method: 'POST', body: { round, member: $('#bd-to', body).value, text } });
      $('#bd-msg', body).value = '';
      load();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#bd-msg', body).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) $('#bd-send').click();
  });
  load();
}

export { fmtTime };
