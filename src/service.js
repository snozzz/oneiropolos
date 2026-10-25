import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brandName } from './brand.js';
import { codexInfo, codexRateLimitsFromRollouts, codexRateLimitsLive, defaultCodexModel, findCodex, listCodexModels, runCodexTurn } from './codex.js';
import { DEFAULTS, deepMerge, loadConfig, replaceConfig, saveConfig, taskSettings } from './config.js';
import { allStatus, engine, roleNames, roleSpec } from './engines/index.js';
import { deleteCommand as delCmd, expandCommand, listCommands, saveCommand } from './commands.js';
import { GLOBAL_HOOKS_DIR, HOOK_TYPES, readHookDir, writeHookType } from './hooks.js';
import { clockText, currentLang, fmtDuration, locale, t } from './i18n.js';
import { loadLoops, addLoop as addLoopRec, deleteLoop as delLoop, ensureLooper, updateLoop } from './loops.js';
import { loadMcp, mcpSummary, saveMcp } from './mcp.js';
import { readNotebook, writeNotebook } from './notebook.js';
import { DATA_DIR, ROOT, ensureDirs } from './paths.js';
import * as P from './prompts.js';
import { BUILTIN_RULES, decideApproval, matchSensitive, pendingApprovals, safetyRules } from './safety.js';
import { createSkill, listSkills, readSkill } from './skills.js';
import { Snapshotter } from './snapshot.js';
import { listSubagents, writeAgentRole } from './subagents.js';
import { ROLES, buildSystemPrompt } from './sysprompts.js';
import { ACTIVE_STATUSES, appendControl, appendEvent, createRun, deleteRun, effectiveStatus, isRunnerAlive, listRuns, readEvents, readState, runDir, writeState } from './store.js';
import { boardFile, postToBoard } from './team.js';
import { listTemplates, saveTemplate } from './templates.js';
import { usageReport } from './usage.js';
import { baseChildEnv, execText, findExecutable, nowIso, oneLine, readJson, runProcess, truncate, writeJsonAtomic } from './util.js';
import { findWorkBuddy, listWbModels, refreshWbCloudConfig, wbAuthState, wbCloudConfig, wbLogin, wbLogout } from './workbuddy.js';

// ---------- engines: sign-in state of every engine, cached briefly (each check starts the engine's CLI) ----------

let engineCache = null;

export async function engineStatus({ force = false } = {}) {
  if (!force && engineCache && Date.now() - engineCache.at < 60_000) return engineCache.value;
  const value = await allStatus(loadConfig());
  engineCache = { at: Date.now(), value };
  return value;
}

const signIns = new Map();

function publicSignIn(id) {
  const j = signIns.get(id);
  if (!j) return null;
  const { state, authUrl, message, startedAt, account, canPaste } = j;
  return { engine: id, state, authUrl: authUrl || '', message: message || '', startedAt, account: account || '', canPaste: Boolean(canPaste) };
}

/** Starts an engine's own sign-in (browser); one attempt per engine at a time. */
export function startSignIn(id, opts = {}) {
  const eng = engine(id);
  if (!eng) throw new Error(`unknown engine: ${id}`);
  const cur = signIns.get(id);
  if (cur && ['starting', 'waiting'].includes(cur.state)) return publicSignIn(id);
  const ctrl = new AbortController();
  const job = { state: 'starting', startedAt: new Date().toISOString(), ctrl };
  signIns.set(id, job);
  Promise.resolve()
    .then(() => eng.login(loadConfig(), { ...opts, signal: ctrl.signal, onUpdate: (u) => Object.assign(job, u) }))
    .then((r) => Object.assign(job, r?.ok ? { state: 'done', account: r.account || '' } : { state: ctrl.signal.aborted ? 'cancelled' : 'error', message: r?.error || '' }))
    .catch((err) => Object.assign(job, { state: 'error', message: err.message }))
    .finally(() => {
      engineCache = null;
    });
  return publicSignIn(id);
}

export function getSignIn(id) {
  return publicSignIn(id) || { engine: id, state: 'idle' };
}

export function cancelSignIn(id) {
  const j = signIns.get(id);
  j?.ctrl?.abort();
  if (j && ['starting', 'waiting'].includes(j.state)) j.state = 'cancelled';
  return getSignIn(id);
}

/** Claude: the code shown by the sign-in page when its localhost callback could not be reached. */
export function sendSignInCode(id, code) {
  if (id !== 'claude' || !engine('claude').sendCode(code)) throw new Error(t('srv.acct.noPending'));
  return getSignIn(id);
}

export async function signOut(id) {
  const eng = engine(id);
  if (!eng) throw new Error(`unknown engine: ${id}`);
  await eng.logout(loadConfig());
  if (id === 'deepseek') engine('deepseek').setApiKey('');
  engineCache = null;
  return engineStatus({ force: true });
}

export function setEngineKey(id, key) {
  if (id !== 'deepseek') throw new Error(`no API keys for ${id}`);
  engine('deepseek').setApiKey(key);
  engineCache = null;
  return engineStatus({ force: true });
}

function engineModels(cfg) {
  const out = {};
  for (const id of ['chatgpt', 'claude', 'deepseek', 'workbuddy']) {
    try {
      out[id] = { models: engine(id).models(cfg), defaultModel: engine(id).defaultModel(cfg), efforts: engine(id).EFFORTS || [] };
    } catch {
      out[id] = { models: [], defaultModel: '', efforts: [] };
    }
  }
  return out;
}

export async function getEnvironment() {
  const cfg = loadConfig();
  const codex = findCodex(cfg.codex.path);
  const wb = findWorkBuddy(cfg.workbuddy.appPath);
  const cinfo = await codexInfo(codex, cfg.codex.home).catch((err) => ({ installed: !!codex, loggedIn: false, error: err.message }));
  const auth = wbAuthState();
  const wbModels = wb ? listWbModels(wb) : { models: [], source: 'none', updatedAt: null };
  return {
    config: cfg,
    lang: currentLang(),
    codex: { ...cinfo, models: listCodexModels(cfg.codex.home), defaultModel: cfg.codex.model || defaultCodexModel(cfg.codex.home) },
    workbuddy: {
      installed: !!wb,
      app: wb?.app || null,
      appVersion: wb?.appVersion || '',
      cliVersion: wb?.cliVersion || '',
      loggedIn: auth.loggedIn,
      nickname: auth.nickname || '',
      refreshExpiresAt: auth.refreshExpiresAt || null,
      models: wbModels.models,
      modelsSource: wbModels.source,
      modelsUpdatedAt: wbModels.updatedAt,
      modelsRefreshing: Boolean(modelRefresh),
    },
    engines: await engineStatus(),
    engineModels: engineModels(cfg),
    subagents: listSubagents({ ...cfg, subagents: { ...cfg.subagents, disabled: [] } }).map((a) => ({ id: a.id, name: a.name, description: a.description, source: a.source, enabled: !(cfg.subagents?.disabled || []).includes(a.id) })),
    login: loginJob ? publicLoginJob() : null,
    home: os.homedir(),
    dataDir: DATA_DIR,
    node: process.version,
  };
}

export function resolveWorkdir(input) {
  if (!input || !String(input).trim()) throw new Error(t('srv.dir.missing'));
  let dir = String(input).trim().replace(/^~(?=$|\/)/, os.homedir());
  dir = path.resolve(dir);
  if (!fs.existsSync(dir)) throw new Error(t('srv.dir.notFound', { dir }));
  if (!fs.statSync(dir).isDirectory()) throw new Error(t('srv.dir.notDir', { dir }));
  dir = fs.realpathSync(dir);
  if (dir === '/' || dir === os.homedir() || dir === '/Users') throw new Error(t('srv.dir.tooBroad'));
  return dir;
}

/** Scheduled start: within half a minute counts as "now"; at most 7 days ahead. */
export function resolveStartAt(startAt) {
  if (!startAt) return null;
  const at = Date.parse(startAt);
  if (!Number.isFinite(at)) throw new Error(t('srv.schedule.badTime'));
  if (at <= Date.now() + 30_000) return null;
  if (at - Date.now() > 7 * 86400_000) throw new Error(t('srv.schedule.tooFar'));
  return new Date(at).toISOString();
}

export function createTask({ goal, workdir, settings = {}, startAt = null }) {
  ensureDirs();
  const text = String(goal || '').trim();
  if (!text) throw new Error(t('srv.goal.missing'));
  const dir = resolveWorkdir(workdir);
  const busy = listRuns().find((r) => r.workdir === dir && ['running', 'waiting', 'paused', 'waiting_user', 'queued'].includes(r.status));
  if (busy) throw new Error(t('srv.dir.busy', { id: busy.id }));
  const merged = taskSettings(deepMerge(loadConfig(), settings || {}));
  if (!merged.codex.model) merged.codex.model = defaultCodexModel();
  return createRun({ goal: text, workdir: dir, settings: merged, scheduledAt: resolveStartAt(startAt) });
}

export function spawnRunner(runId) {
  const dir = runDir(runId);
  const log = fs.openSync(path.join(dir, 'runner.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'runner.js'), runId], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

/** Continue/start a task: send "resume" to a live runner, otherwise start a new runner. */
export function startOrResume(runId) {
  const s = readState(runId);
  if (!s) throw new Error(t('srv.runMissing', { id: runId }));
  if (isRunnerAlive(s)) {
    appendControl(runId, { cmd: 'resume' });
    return { resumed: true, pid: s.pid };
  }
  const pid = spawnRunner(runId);
  return { started: true, pid };
}

export function controlRun(runId, cmd, payload = {}) {
  const s = readState(runId);
  if (!s) throw new Error(t('srv.runMissing', { id: runId }));
  if (cmd === 'resume' || cmd === 'start') return startOrResume(runId);
  if (cmd === 'message' || cmd === 'cut') {
    const text = String(payload.text || '').trim();
    if (!text) throw new Error(t('srv.msg.empty'));
    // interrupting only means something for a running task; otherwise it is a normal message
    appendControl(runId, { cmd: cmd === 'cut' && isRunnerAlive(s) ? 'cut' : 'message', text });
    const status = effectiveStatus(s);
    // a finished/stopped task that gets a message continues automatically so GPT can handle the new requirement
    if (payload.autoResume !== false && !isRunnerAlive(s) && ['done', 'failed', 'stopped', 'interrupted'].includes(status)) {
      return { queued: true, ...startOrResume(runId) };
    }
    return { queued: true };
  }
  if (cmd === 'approve') {
    // Plan Mode: approve the plan. A live runner gets the command; otherwise update the state and start one.
    if (isRunnerAlive(s)) {
      appendControl(runId, { cmd: 'approve', text: payload.text || '' });
      return { ok: true };
    }
    if (s.phase !== 'approve') throw new Error(t('srv.plan.notWaiting'));
    s.planApproved = true;
    s.phase = 'work';
    s.userMessages = [...(s.userMessages || []), { t: nowIso(), text: P.planApprovedNote(String(payload.text || '').trim()), system: true }];
    writeState(s);
    appendEvent(runId, { kind: 'plan.approved', note: String(payload.text || '') });
    return { ok: true, ...startOrResume(runId) };
  }
  if (cmd === 'compact') {
    if (isRunnerAlive(s)) appendControl(runId, { cmd: 'compact' });
    else {
      s.wb = { ...(s.wb || {}), compactRequested: true };
      writeState(s);
    }
    return { ok: true };
  }
  if (cmd === 'settings') {
    if (!payload.patch || typeof payload.patch !== 'object') throw new Error('missing patch');
    if (isRunnerAlive(s)) appendControl(runId, { cmd: 'settings', patch: payload.patch });
    else {
      s.settings = deepMerge(s.settings, payload.patch);
      writeState(s);
    }
    return { ok: true };
  }
  if (cmd === 'stop' || cmd === 'pause') {
    if (!isRunnerAlive(s)) {
      if (s.status === 'queued') {
        s.status = 'stopped';
        writeState(s);
      }
      return { ok: true, notRunning: true };
    }
    appendControl(runId, { cmd });
    return { ok: true };
  }
  throw new Error(t('srv.unknownCommand', { cmd }));
}

// ---------- WorkBuddy model info (prices, promotions and context windows come from the server) ----------

let modelRefresh = null;

/** Refresh the server-side model config. No model call, no credits. */
export async function refreshWbModels() {
  const wb = findWorkBuddy(loadConfig().workbuddy.appPath);
  if (!wb) throw new Error(t('srv.wb.missing'));
  if (!wbAuthState().loggedIn) throw new Error(t('srv.wb.notLoggedIn'));
  modelRefresh ??= refreshWbCloudConfig(wb).finally(() => {
    modelRefresh = null;
  });
  await modelRefresh;
  return getEnvironment();
}

/** On UI start: refresh in the background when the cache is older than 2 hours (not while tasks run). */
export function refreshWbModelsIfStale(maxAgeMs = 2 * 3600_000) {
  const ts = wbCloudConfig()?.ts || 0;
  if (Date.now() - ts < maxAgeMs || !wbAuthState().loggedIn) return;
  if (listRuns().some((r) => ['running', 'waiting'].includes(r.status))) return;
  refreshWbModels().catch(() => {});
}

// ---------- WorkBuddy login (one flow at a time) ----------

let loginJob = null;

function publicLoginJob() {
  if (!loginJob) return null;
  const { state, authUrl, message, startedAt, account } = loginJob;
  return { state, authUrl, message, startedAt, nickname: account?.userName || '' };
}

export function startWbLogin({ method = 'internal' } = {}) {
  const cfg = loadConfig();
  const wb = findWorkBuddy(cfg.workbuddy.appPath);
  if (!wb) throw new Error(t('srv.wb.missing'));
  if (loginJob && ['starting', 'waiting'].includes(loginJob.state)) return publicLoginJob();
  const ctrl = new AbortController();
  loginJob = { state: 'starting', startedAt: new Date().toISOString(), ctrl };
  wbLogin(wb, {
    method,
    signal: ctrl.signal,
    onUpdate: (u) => {
      Object.assign(loginJob, u);
    },
  }).then((res) => {
    if (res?.ok) Object.assign(loginJob, { state: 'done', account: res.account });
  });
  return publicLoginJob();
}

export function getWbLogin() {
  return publicLoginJob();
}

export function cancelWbLogin() {
  loginJob?.ctrl?.abort();
  if (loginJob) loginJob.state = 'cancelled';
  return publicLoginJob();
}

export async function logoutWb() {
  const cfg = loadConfig();
  const wb = findWorkBuddy(cfg.workbuddy.appPath);
  if (!wb) throw new Error(t('srv.wb.missing'));
  await wbLogout(wb);
  return { ok: true };
}

// ---------- GPT quota (5-hour and weekly windows of the ChatGPT subscription) ----------

let quotaCache = null;
let quotaInflight = null;

/** Live when possible (no quota used), otherwise the last value reported in a Codex session. Cached for 2 minutes. */
export async function getGptQuota({ force = false } = {}) {
  if (!force && quotaCache && Date.now() - quotaCache.fetchedAt < 120_000) return quotaCache.value;
  quotaInflight ??= (async () => {
    const cfg = loadConfig();
    const found = findCodex(cfg.codex.path);
    const value = (await codexRateLimitsLive(found, { home: cfg.codex.home }).catch(() => null)) || codexRateLimitsFromRollouts({ home: cfg.codex.home });
    quotaCache = { fetchedAt: Date.now(), value };
    return value;
  })().finally(() => {
    quotaInflight = null;
  });
  return quotaInflight;
}

// ---------- export the conversation (Markdown) ----------

function gptLabelTitle(label = '') {
  if (label === 'plan') return t('gpt.title.plan');
  if (label.startsWith('audit-')) return t('gpt.title.audit', { n: label.slice(6) });
  if (label.startsWith('review-')) return t('gpt.title.review', { n: label.split('-')[1] || 1 });
  if (label.startsWith('followup-')) return t('gpt.title.followup');
  if (label.startsWith('wrapup-')) return t('gpt.title.wrapup');
  return label;
}

const quote = (text) => String(text || '').trim().split('\n').map((l) => `> ${l}`).join('\n');
const localTime = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { hour12: false }) : '');

export function exportMarkdown(id) {
  const s = readState(id);
  if (!s) throw new Error(t('srv.runMissing', { id }));
  const { events } = readEvents(id, 0, 256 * 1024 * 1024);
  const set = s.settings || {};
  const title = oneLine(String(s.goal).split('\n').find((l) => l.trim()) || s.goal, 80);
  const elapsed = (s.finishedAt ? Date.parse(s.finishedAt) : Date.now()) - Date.parse(s.createdAt);
  const out = [
    `# ${title}`,
    '',
    `> ${t('export.header', { app: brandName(), time: localTime(nowIso()) })}`,
    `> ${t('export.meta', { status: t(`status.${effectiveStatus(s)}`), rounds: s.round, elapsed: fmtDuration(elapsed), dir: s.workdir })}`,
    `> GPT: ${set.codex?.model || '-'} (${set.codex?.effort || '-'}) · WorkBuddy: ${set.workbuddy?.model || 'auto'}${set.workbuddy?.effort ? ` (${set.workbuddy.effort})` : ''}${set.team?.mode && set.team.mode !== 'off' ? ` · ${t('export.team', { mode: set.team.mode })}` : ''}`,
    '',
    `## ${t('export.goal')}`,
    '',
    s.goal,
    '',
  ];
  if (s.plan?.length) {
    out.push(`## ${t('export.plan')}`, '', ...s.plan.map((p, i) => `${i + 1}. [${p.status === 'done' ? 'x' : ' '}] ${p.title}${p.status === 'doing' ? ` (${t('plan.doing')})` : ''}`), '');
  }
  out.push(`## ${t('export.process')}`, '');
  for (const ev of events) {
    const at = localTime(ev.t);
    if (ev.kind === 'gpt.result') {
      const o = ev.output || {};
      out.push(`### ${ev.label?.startsWith('review-') ? t('who.reviewer') : 'GPT'} · ${gptLabelTitle(ev.label)} (${t(`verdict.${o.verdict}`)} · ${at})`, '', o.assessment || '', '');
      if (o.issues?.length) out.push(...o.issues.map((i) => `- **${t(`severity.${i.severity}`)}**: ${i.detail}`), '');
      if (o.verdict === 'continue' && o.team?.length) out.push(`**${t('export.teamAssignments')}**`, '', ...o.team.map((m) => `- **${m.name}**${m.role ? ` (${m.role})` : ''}: ${oneLine(m.instruction, 400)}`), '');
      else if (o.verdict === 'continue' && o.next_instruction) out.push(`**${t('export.toWb')}**`, '', quote(o.next_instruction), '');
      if (o.verdict === 'ask_user' && o.question_for_user) out.push(`**${t('export.needYou')}**`, '', quote(o.question_for_user), '');
    } else if (ev.kind === 'wb.end') {
      const head = [ev.member ? `${ev.member}` : '', t('round.n', { n: ev.round }), ev.model, ev.toolCount != null ? t('export.tools', { n: ev.toolCount }) : '', ev.durationMs ? fmtDuration(ev.durationMs) : ''].filter(Boolean).join(' · ');
      out.push(`### WorkBuddy · ${head}`, '');
      if (!ev.ok) out.push(`*${t('export.notFinished', { err: oneLine((ev.errors || []).join('; '), 300) })}*`, '');
      if (ev.resultText) out.push(ev.resultText, '');
    } else if (ev.kind === 'round.diff' && ev.files) {
      const add = ev.files.reduce((n, f) => n + (Number(f.add) || 0), 0);
      const del = ev.files.reduce((n, f) => n + (Number(f.del) || 0), 0);
      out.push(ev.files.length ? t('export.changed', { n: ev.files.length, add, del }) : t('export.noChanges'), '');
      if (ev.files.length) out.push(...ev.files.slice(0, 120).map((f) => `- \`${f.status}\` ${f.path} (+${f.add} −${f.del})`), '');
      if (ev.conflicts?.length) out.push(`${t('export.conflicts')}: ${ev.conflicts.join(', ')}`, '');
    } else if (ev.kind === 'round.check') {
      out.push(t('export.check', { cmd: ev.command, result: ev.ok ? t('check.passed') : ev.timedOut ? t('check.timedOut') : t('check.failed', { code: ev.code }), time: fmtDuration(ev.durationMs) }), '');
    } else if (ev.kind === 'user.message') {
      out.push(`### ${t('who.you')} (${at})`, '', ev.text, '');
    } else if (ev.kind === 'restore') {
      out.push(`*${at} ${t('export.restored', { label: ev.labelKey ? t(ev.labelKey, ev.labelParams) : ev.label })}*`, '');
    } else if (ev.kind === 'approval.result' && ev.decision !== 'allow') {
      out.push(`*${at} ${t('export.gate', { cmd: oneLine(ev.command, 160), decision: t(`approval.${ev.decision}`) })}*`, '');
    } else if (ev.kind === 'done') {
      out.push(`## ${ev.aborted ? t('final.aborted') : t('final.done')}`, '', ev.summary || '', '');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Saves to the Downloads folder and returns the path. */
export function exportRun(id) {
  const md = exportMarkdown(id);
  const s = readState(id);
  const downloads = path.join(os.homedir(), 'Downloads');
  const dir = fs.existsSync(downloads) ? downloads : path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const title = oneLine(String(s.goal).split('\n').find((l) => l.trim()) || 'task', 24).replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/[…\s]+$/, '').trim() || 'task';
  const file = path.join(dir, `${brandName()}-${title}-${id}.md`);
  fs.writeFileSync(file, md);
  return { path: file, bytes: Buffer.byteLength(md) };
}

// ---------- rollback: restore the working directory to a snapshot of some round ----------

function cpLabel(p) {
  return t(p.labelKey, p.labelParams);
}

/** Points to go back to: before/after each round, before each rollback. Adjacent identical snapshots are merged. */
export async function listCheckpoints(id) {
  const s = readState(id);
  if (!s) throw new Error(t('srv.runMissing', { id }));
  if (!s.snapshot?.enabled) return { enabled: false, reason: s.snapshot?.reason || t('srv.snap.none'), points: [] };
  const raw = [];
  for (const r of s.rounds || []) {
    if (r.baseCommit) raw.push({ commit: r.baseCommit, labelKey: 'cp.start', labelParams: { n: r.round }, round: r.round, kind: 'start', at: r.startedAt || r.createdAt });
    if (r.endCommit) raw.push({ commit: r.endCommit, labelKey: 'cp.end', labelParams: { n: r.round }, round: r.round, kind: 'end', at: r.workerEndedAt || r.endedAt, files: r.diffFiles, team: Boolean(r.team?.length) });
  }
  for (const x of s.restores || []) raw.push({ commit: x.safety, labelKey: 'cp.safety', labelParams: { label: x.labelKey ? t(x.labelKey, x.labelParams) : x.label }, kind: 'safety', at: x.at });
  raw.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const snap = new Snapshotter(runDir(id), s.workdir);
  const [current, ...trees] = await Promise.all([
    snap.worktreeTree().catch(() => null),
    ...raw.map((p) => snap.run(['rev-parse', `${p.commit}^{tree}`]).then((r) => r.stdout.trim()).catch(() => '')),
  ]);
  const points = [];
  raw.forEach((p, i) => {
    const prev = points[points.length - 1];
    if (prev && trees[i] && prev.tree === trees[i] && p.kind !== 'safety' && prev.kind !== 'safety') {
      Object.assign(prev, { alias: cpLabel(p), aliasKind: p.kind, aliasRound: p.round });
      return;
    }
    points.push({ ...p, label: cpLabel(p), tree: trees[i] });
  });
  // the point identical to the current directory is marked "current"; restoring it would change nothing
  for (const p of points) p.current = Boolean(current) && p.tree === current;
  return { enabled: true, points: points.reverse(), alive: isRunnerAlive(s), status: effectiveStatus(s), restores: s.restores || [] };
}

async function findCheckpoint(id, commit) {
  const { enabled, points, reason } = await listCheckpoints(id);
  if (!enabled) throw new Error(reason);
  const point = points.find((p) => p.commit === commit);
  if (!point) throw new Error(t('srv.snap.notFound'));
  return point;
}

export async function restorePreview(id, commit) {
  const s = readState(id);
  await findCheckpoint(id, commit);
  const preview = await new Snapshotter(runDir(id), s.workdir).restorePreview(commit);
  if (!preview) throw new Error(t('srv.snap.cannotRead'));
  return preview;
}

export async function restoreRun(id, commit) {
  const s = readState(id);
  if (!s) throw new Error(t('srv.runMissing', { id }));
  if (isRunnerAlive(s)) throw new Error(t('srv.restore.running'));
  const point = await findCheckpoint(id, commit);
  const snap = new Snapshotter(runDir(id), s.workdir);
  const preview = await snap.restorePreview(commit);
  const { safety } = await snap.restore(commit, point.label);
  const label = point.alias ? `${point.label} (${point.alias})` : point.label;
  const rec = { at: nowIso(), to: commit, label, labelKey: point.labelKey, labelParams: point.labelParams, safety, files: preview?.files.length ?? null };
  const fresh = readState(id);
  fresh.restores = [...(fresh.restores || []), rec];
  // tell GPT next time that the files were restored
  fresh.userMessages = [...(fresh.userMessages || []), { t: rec.at, text: P.restoreNote(t(point.labelKey, point.labelParams, 'en')), system: true }];
  writeState(fresh);
  appendEvent(id, { kind: 'restore', ...rec });
  return { ok: true, ...rec, preview };
}

// ---------- one-off GPT jobs: side questions (/btw), code review (/review), prompt generator (/new-prompt) ----------

const jobs = new Map();
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const asidesFile = (id) => path.join(runDir(id), 'asides.json');

function saveAside(id, rec) {
  const list = readJson(asidesFile(id), []);
  const i = list.findIndex((a) => a.id === rec.id);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  writeJsonAtomic(asidesFile(id), list.slice(-40));
}

function writeAdvisorPrompt(dir, workdir, settings) {
  const { text } = buildSystemPrompt('advisor', { settings, workdir, names: roleNames(settings) });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'advisor-system.md');
  fs.writeFileSync(file, text);
  return file;
}

/** Runs a read-only turn of the lead's engine in the background. onDone(result) persists the outcome. */
function runAdvisor({ jobId, prompt, cwd, settings, dir, kind, onDone }) {
  // a task from before roles existed ran with GPT as its lead
  const cfg = settings ? deepMerge(loadConfig(), { roles: DEFAULTS.roles, ...settings }) : loadConfig();
  const spec = roleSpec(cfg, 'lead');
  const eng = engine(spec.engine);
  const found = eng.find(cfg);
  if (!found) throw new Error(spec.engine === 'chatgpt' ? t('srv.codex.missing') : t('srv.pause.noEngine', { name: spec.name }));
  const live = { steps: 0, last: '' };
  jobs.set(jobId, { kind, live });
  const model = spec.model || (spec.engine === 'chatgpt' ? defaultCodexModel(cfg.codex?.home) : '');
  // Claude's sandbox lets Bash write in its working directory, so the advisor works from a scratch folder
  const workDir = spec.engine === 'claude' ? path.join(dir, `${jobId}-scratch`) : cwd;
  fs.mkdirSync(workDir, { recursive: true });
  eng.lead({
    cfg,
    found,
    prompt,
    cwd: workDir,
    newId: crypto.randomUUID(),
    model,
    effort: spec.engine === 'deepseek' ? 'high' : 'medium',
    sandbox: 'read-only',
    systemFile: writeAdvisorPrompt(dir, cwd, cfg),
    outFile: path.join(dir, `${jobId}.md`),
    rawFile: path.join(dir, `${jobId}.jsonl`),
    timeoutMs: 15 * 60_000,
    onEvent: (e) => {
      live.steps += 1;
      if (e.itemType === 'command_execution' && e.command) live.last = `$ ${oneLine(e.command, 120)}`;
      else if (e.itemType === 'reasoning' && e.text) live.last = oneLine(e.text, 120);
      else if (e.itemType === 'tool' && e.text) live.last = oneLine(e.text, 120);
    },
  }).then((r) => onDone({ ok: r.ok, text: r.text || '', error: r.ok ? null : oneLine(r.error?.message || 'failed', 300), durationMs: r.durationMs, model: model || spec.name }))
    .catch((err) => onDone({ ok: false, text: '', error: oneLine(err.message, 300), model: model || spec.name }))
    .finally(() => {
      jobs.delete(jobId);
      if (workDir !== cwd) fs.rmSync(workDir, { recursive: true, force: true });
    });
  return model || spec.name;
}

export function listAsides(id) {
  return readJson(asidesFile(id), []).map((a) => {
    const job = jobs.get(a.id);
    if (a.status === 'running' && !job) return { ...a, status: 'failed', error: t('srv.aside.interrupted') };
    return job ? { ...a, ...job.live } : a;
  });
}

export function askAside(id, question) {
  const s = readState(id);
  if (!s) throw new Error(t('srv.runMissing', { id }));
  const q = truncate(String(question || '').trim(), 4000);
  if (!q) throw new Error(t('srv.aside.empty'));
  if (listAsides(id).some((a) => a.status === 'running')) throw new Error(t('srv.aside.busy'));
  const rec = { id: crypto.randomBytes(5).toString('hex'), q, at: nowIso(), status: 'running', answer: '', model: s.settings?.codex?.model || '' };
  saveAside(id, rec);
  const lastRound = [...(s.rounds || [])].reverse().find((r) => r.worker);
  const cwd = fs.existsSync(s.workdir) ? s.workdir : runDir(id);
  runAdvisor({
    jobId: rec.id,
    kind: 'aside',
    prompt: P.asidePrompt({ goal: s.goal, workdir: s.workdir, plan: s.plan, lastAudit: s.lastAudit, lastReport: lastRound?.worker?.resultText, question: q }),
    cwd,
    settings: s.settings,
    dir: path.join(runDir(id), 'asides'),
    onDone: (r) => saveAside(id, { ...rec, status: r.ok ? 'done' : 'failed', answer: r.text, error: r.error, durationMs: r.durationMs }),
  });
  return rec;
}

function saveJob(rec) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  writeJsonAtomic(path.join(JOBS_DIR, `${rec.id}.json`), rec);
}

export function getJob(jobId) {
  if (!/^[0-9a-f]{10}$/.test(String(jobId))) throw new Error('bad job id');
  const rec = readJson(path.join(JOBS_DIR, `${jobId}.json`), null);
  if (!rec) throw new Error(t('srv.job.notFound'));
  const live = jobs.get(jobId)?.live;
  if (rec.status === 'running' && !jobs.has(jobId)) return { ...rec, status: 'failed', error: t('srv.aside.interrupted') };
  return live ? { ...rec, ...live } : rec;
}

function startJob(kind, { title, prompt, cwd, settings, meta = {} }) {
  const rec = { id: crypto.randomBytes(5).toString('hex'), kind, title, at: nowIso(), status: 'running', answer: '', ...meta };
  saveJob(rec);
  rec.model = runAdvisor({
    jobId: rec.id,
    kind,
    prompt,
    cwd,
    settings,
    dir: JOBS_DIR,
    onDone: (r) => saveJob({ ...rec, status: r.ok ? 'done' : 'failed', answer: r.text, error: r.error, durationMs: r.durationMs, model: r.model }),
  });
  return rec;
}

// ---------- git helpers for the review panel ----------

const GIT = () => findExecutable('git', ['/usr/bin']) || '/usr/bin/git';

async function git(dir, args, opts = {}) {
  return execText(GIT(), ['-C', dir, '-c', 'core.quotepath=false', ...args], { timeoutMs: 30_000, maxBytes: opts.maxBytes ?? 8_000_000 });
}

export async function gitInfo(dir) {
  const root = resolveWorkdir(dir);
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { isRepo: false, dir: root };
  const [branch, staged, unstaged, untracked, log] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['diff', '--cached', '--name-only']),
    git(root, ['diff', '--name-only']),
    git(root, ['ls-files', '--others', '--exclude-standard']),
    git(root, ['log', '-30', '--format=%H%x09%an%x09%aI%x09%s']),
  ]);
  const lines = (r) => r.stdout.split('\n').filter(Boolean);
  return {
    isRepo: true,
    dir: root,
    top: top.stdout.trim(),
    branch: branch.stdout.trim(),
    staged: lines(staged).length,
    unstaged: lines(unstaged).length + lines(untracked).length,
    commits: lines(log).map((l) => {
      const [sha, author, date, ...subject] = l.split('\t');
      return { sha, author, date, subject: subject.join('\t') };
    }),
  };
}

async function diffFor(dir, target, runId) {
  if (target === 'staged') return (await git(dir, ['diff', '--cached', '--no-color'])).stdout;
  if (target === 'unstaged') {
    const tracked = (await git(dir, ['diff', '--no-color'])).stdout;
    const untracked = (await git(dir, ['ls-files', '--others', '--exclude-standard'])).stdout.split('\n').filter(Boolean).slice(0, 50);
    const extra = [];
    for (const f of untracked) {
      try {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        if (text.length < 60_000 && !text.includes('\0')) extra.push(`diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${text.split('\n').map((l) => `+${l}`).join('\n')}`);
      } catch {
        // binary or unreadable
      }
    }
    return [tracked, ...extra].filter(Boolean).join('\n');
  }
  if (target === 'task' && runId) {
    const s = readState(runId);
    const first = s?.snapshot?.firstCommit;
    const last = [...(s?.rounds || [])].reverse().find((r) => r.endCommit)?.endCommit;
    if (!first || !last) return '';
    return new Snapshotter(runDir(runId), s.workdir).fullPatch(first, last);
  }
  if (/^[0-9a-f]{7,64}$/.test(String(target))) return (await git(dir, ['show', '--no-color', '--format=commit %H%nAuthor: %an%nDate: %aI%n%n%s%n%n%b', target])).stdout;
  return '';
}

const GITLINE_MAX = 40_000;

/**
 * /gitline (snow-cli): a commit, or the staged / unstaged changes, as a block to put into a message, in snow-cli's
 * format ("# GitLine: <id>" … "# GitLine End") so GPT sees where it starts and ends.
 */
export async function gitLine(dir, target) {
  const root = resolveWorkdir(dir);
  let head;
  let patch;
  if (target === 'staged' || target === 'unstaged') {
    patch = await diffFor(root, target);
    const files = new Set([...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1])).size;
    head = [`# GitLine: ${target}`, `Type: ${target}`, `Files: ${files}`];
  } else if (/^[0-9a-f]{7,64}$/.test(String(target))) {
    const meta = await git(root, ['show', '-s', '--format=%H%x09%an%x09%aI%x09%s', target]);
    if (meta.code !== 0) throw new Error(t('srv.git.badCommit', { sha: target }));
    const [sha, author, date, ...subject] = meta.stdout.trim().split('\t');
    patch = (await git(root, ['show', '--no-color', '--format=', target])).stdout;
    head = [`# GitLine: ${sha.slice(0, 12)}`, `Commit: ${sha}`, `Author: ${author}`, `Date: ${date}`, `Subject: ${subject.join('\t')}`];
  } else {
    throw new Error(t('srv.git.badTarget'));
  }
  patch = patch.trim();
  if (!patch) throw new Error(t('srv.git.empty'));
  if (patch.length > GITLINE_MAX) patch = `${patch.slice(0, GITLINE_MAX)}\n… (${t('srv.git.cut', { n: patch.length - GITLINE_MAX })})`;
  // a diff of a Markdown file can contain ``` itself: the fence is longer than any backtick run inside
  const fence = '`'.repeat(Math.max(3, ...[...patch.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return { text: `${head.join('\n')}\n\n${fence}git\n${patch}\n${fence}\n# GitLine End` };
}

/** /review: GPT reviews staged/unstaged changes, commits or a task's changes, without touching anything. */
export async function startReview({ dir, targets = [], notes = '', runId = '' }) {
  const root = resolveWorkdir(dir);
  const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean).slice(0, 10);
  if (!list.length) throw new Error(t('srv.review.noTarget'));
  const parts = [];
  for (const target of list) {
    const d = await diffFor(root, target, runId);
    if (d.trim()) parts.push(d);
  }
  const diff = parts.join('\n');
  if (!diff.trim()) throw new Error(t('srv.review.empty'));
  const settings = runId ? readState(runId)?.settings : loadConfig();
  const title = list.map((x) => (x === 'staged' ? t('review.staged') : x === 'unstaged' ? t('review.unstaged') : x === 'task' ? t('review.task') : x.slice(0, 7))).join(', ');
  return startJob('review', {
    title,
    prompt: P.codeReviewPrompt({ title, diff: truncate(diff, 180_000), notes: String(notes || '').trim(), workdir: root }),
    cwd: root,
    settings,
    meta: { dir: root, targets: list },
  });
}

function projectContext(dir) {
  if (!dir) return '';
  const lines = [`Working directory: ${dir}`];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !['.git', 'node_modules', '.venv', 'dist', 'build', '__pycache__'].includes(e.name)).slice(0, 40);
    lines.push(`Root entries: ${entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join(', ')}`);
  } catch {
    // unreadable
  }
  for (const f of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'AGENTS.md', 'README.md']) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      lines.push(`--- ${f} (excerpt) ---\n${truncate(text, 2500)}`);
    } catch {
      // missing
    }
  }
  return lines.join('\n');
}

/** /new-prompt: turn a rough requirement into a structured task description. */
export function startNewPrompt({ dir = '', requirement }) {
  const req = String(requirement || '').trim();
  if (!req) throw new Error(t('srv.newPrompt.empty'));
  let root = '';
  try {
    root = dir ? resolveWorkdir(dir) : '';
  } catch {
    root = '';
  }
  const cfg = loadConfig();
  const subagents = cfg.subagents?.enabled === false ? [] : listSubagents(cfg, root);
  return startJob('newprompt', {
    title: oneLine(req, 60),
    prompt: P.newPromptPrompt({ requirement: req, projectContext: projectContext(root), subagents }),
    cwd: root || DATA_DIR,
    settings: cfg,
    meta: { dir: root },
  });
}

// ---------- shell commands from the composer: !`cmd` injection, !!`cmd` bash mode, "execute" custom commands ----------

const SHELL = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';

export async function execCommand({ dir, command, timeoutMs = 30_000, confirmed = false }) {
  const root = resolveWorkdir(dir);
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error(t('srv.exec.empty'));
  const rule = matchSensitive(cmd, loadConfig());
  if (rule && !confirmed) return { needsConfirm: true, rule: { id: rule.id, description: rule.builtin ? t(`safety.rule.${rule.id}`) : rule.description || rule.pattern } };
  let output = '';
  const started = Date.now();
  const res = await runProcess(SHELL, ['-c', `{ ${cmd}\n} 2>&1`], {
    cwd: root,
    env: await baseChildEnv(),
    timeoutMs: Math.max(1000, Math.min(10 * 60_000, Number(timeoutMs) || 30_000)),
    onLine: (line) => {
      if (output.length < 200_000) output += `${line}\n`;
    },
  });
  return { command: cmd, code: res.code, timedOut: res.timedOut, output: output.replace(/\s+$/, ''), durationMs: Date.now() - started };
}

// ---------- cleanup ----------

export function cleanupRuns({ days = 30 } = {}) {
  const n = Math.max(1, Number(days) || 30);
  const cutoff = Date.now() - n * 86400_000;
  let deleted = 0;
  for (const r of listRuns()) {
    if (ACTIVE_STATUSES.has(r.status)) continue;
    const at = Date.parse(r.finishedAt || r.updatedAt || r.createdAt);
    if (!(at < cutoff)) continue;
    try {
      deleteRun(r.id);
      deleted += 1;
    } catch {
      // running ones are skipped
    }
  }
  return { deleted };
}

// ---------- files of the working directory (@ mentions) and TODO comments (/todo) ----------

const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'dist', 'build', 'target', '.cache', '.idea', '.vscode', '.workbuddy', '.codebuddy', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage', '.turbo', '.gradle', 'Pods', 'DerivedData']);

export async function listProjectFiles(input, { limit = 5000 } = {}) {
  const root = path.resolve(String(input || '').replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(t('srv.dir.notFound', { dir: root }));
  if (root === '/' || root === os.homedir()) return { root, files: [], truncated: false };
  if (fs.existsSync(path.join(root, '.git'))) {
    const r = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard'], { maxBytes: 6_000_000 });
    if (r.code === 0) {
      const files = [...new Set(r.stdout.split('\n').filter(Boolean))];
      return { root, files: files.slice(0, limit), truncated: files.length > limit };
    }
  }
  const files = [];
  const queue = [''];
  while (queue.length && files.length < limit) {
    const rel = queue.shift();
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (e.name === '.DS_Store' || WALK_SKIP.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (p.split('/').length < 10) queue.push(p);
      } else if (e.isFile()) {
        files.push(p);
        if (files.length >= limit) break;
      }
    }
  }
  return { root, files, truncated: files.length >= limit };
}

/** TODO / FIXME / HACK / XXX comments in the working directory (snow-cli /todo-). */
export async function listTodos(input) {
  const root = resolveWorkdir(input);
  const { files } = await listProjectFiles(root, { limit: 4000 });
  const out = [];
  const re = /\b(TODO|FIXME|HACK|XXX)\b[:：]?\s*(.*)$/;
  for (const rel of files) {
    if (out.length >= 300) break;
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|lock|min\.js|map|woff2?|ttf|mp4|mov|so|dylib|a|o|class|jar)$/i.test(rel)) continue;
    let text;
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.size > 1_000_000) continue;
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (!/TODO|FIXME|HACK|XXX/.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      const m = line.match(re);
      if (m && out.length < 300) out.push({ file: rel, line: i + 1, tag: m[1], text: oneLine(m[2] || line.trim(), 200) });
    });
  }
  return { root, todos: out };
}

// ---------- small UI preferences (shared by pages on different ports, so kept on the server) ----------

const UI_STATE_PATH = path.join(DATA_DIR, 'ui-state.json');

export function loadUiState() {
  return readJson(UI_STATE_PATH, {}) || {};
}

export function saveUiState(patch) {
  ensureDirs();
  const next = { ...loadUiState() };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!/^[\w.-]{1,40}$/.test(k)) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  if (JSON.stringify(next).length > 200_000) throw new Error('ui state too large');
  writeJsonAtomic(UI_STATE_PATH, next);
  return next;
}

// ---------- approvals (sensitive commands), the team board ----------

export function listApprovalsOf(id) {
  if (!readState(id)) throw new Error(t('srv.runMissing', { id }));
  return pendingApprovals(id);
}

export function answerApproval(id, reqId, body) {
  return decideApproval(id, reqId, { decision: body.decision, reason: body.reason, always: Boolean(body.always), by: 'user' });
}

export function postBoard(id, { round, member, text }) {
  const s = readState(id);
  if (!s) throw new Error(t('srv.runMissing', { id }));
  const r = Number(round) || s.round;
  const msg = String(text || '').trim();
  if (!msg) throw new Error(t('srv.msg.empty'));
  if (!fs.existsSync(boardFile(id, r))) throw new Error(t('srv.team.noBoard'));
  postToBoard({ runId: id, round: r, from: 'user', to: member || '', text: msg });
  appendEvent(id, { kind: 'team.note', round: r, member: member || null, text: msg });
  return { ok: true };
}

// ---------- settings sub-systems ----------

export function settingsData(dir = '') {
  const cfg = loadConfig();
  let root = '';
  try {
    root = dir ? resolveWorkdir(dir) : '';
  } catch {
    root = '';
  }
  return {
    safety: safetyRules(cfg).map((r) => ({ ...r, description: r.builtin ? t(`safety.rule.${r.id}`) : r.description })),
    builtinRuleIds: BUILTIN_RULES.map((r) => r.id),
    hooks: readHookDir(GLOBAL_HOOKS_DIR),
    hookTypes: HOOK_TYPES,
    hooksDir: GLOBAL_HOOKS_DIR,
    skills: listSkills(cfg, root, { includeDisabled: true }),
    commands: listCommands(root),
    mcp: loadMcp(),
    mcpSummary: mcpSummary(cfg),
    subagents: listSubagents({ ...cfg, subagents: { ...cfg.subagents, disabled: [] } }, root).map((a) => ({ ...a, enabled: !(cfg.subagents?.disabled || []).includes(a.id) })),
    loops: loadLoops(),
    dataDir: DATA_DIR,
  };
}

/** The built-in system prompt of a role, for "view built-in" in settings (with a sample context). */
export function systemPromptPreview(role, dir = '') {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  const cfg = loadConfig();
  const builtinCfg = deepMerge(cfg, { prompts: { system: { [role]: { mode: 'builtin' } }, role: { mode: 'off' } } });
  const workdir = dir || path.join(os.homedir(), 'project');
  const ctx = {
    settings: builtinCfg,
    workdir,
    sandbox: { mode: 'workspace-write', cwd: path.join(DATA_DIR, 'runs', '<task>', 'gpt-scratch') },
    subagents: cfg.subagents?.enabled === false ? [] : listSubagents(cfg, dir),
    skills: cfg.skills?.enabled === false ? [] : listSkills(cfg, dir),
    notebookPath: cfg.notebook?.enabled === false ? null : path.join(DATA_DIR, 'notebooks', 'project-xxxxxxxxxx.md'),
    extraDirs: cfg.workbuddy?.addDirs || [],
    mode: cfg.agents?.mode || 'normal',
    team: cfg.team,
    teammate: { member: { name: 'backend', role: 'API developer', owns: 'src/api/**' }, workspace: path.join(DATA_DIR, 'runs', '<task>', 'team', 'r1', 'backend', 'ws'), board: path.join(DATA_DIR, 'runs', '<task>', 'team', 'r1', 'BOARD.md'), roster: '- backend (API developer) — owns: src/api/**\n- tests (QA) — owns: tests/**' },
  };
  return { role, text: buildSystemPrompt(role, ctx).text };
}

export function saveHooks(type, rules) {
  return { rules: writeHookType(type, rules), hooks: readHookDir(GLOBAL_HOOKS_DIR) };
}

export { createSkill, readSkill, saveCommand, saveMcp, usageReport, readNotebook, writeNotebook, expandCommand, updateLoop, writeAgentRole };

export function removeCommand(name) {
  return delCmd(name);
}

export function addLoop(body) {
  let settings = null;
  if (body.kind !== 'message') settings = body.settings || null;
  const rec = addLoopRec({ kind: body.kind === 'message' ? 'message' : 'task', spec: body.spec, workdir: body.kind === 'message' ? '' : resolveWorkdir(body.dir), runId: body.runId || '', settings });
  return rec;
}

export function removeLoop(id) {
  return delLoop(id);
}

export function startLooperIfNeeded() {
  try {
    ensureLooper();
  } catch {
    // loops are optional
  }
}

// ---------- profiles (snow-cli /profiles): named sets of model and run settings ----------

const PROFILE_KEYS = ['roles', 'codex', 'claude', 'deepseek', 'workbuddy', 'loop', 'team', 'agents'];

export function saveProfile({ name, settings }) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) throw new Error(t('srv.profile.noName'));
  const cfg = loadConfig();
  const src = settings && typeof settings === 'object' ? settings : cfg;
  const picked = {};
  for (const k of PROFILE_KEYS) if (src[k]) picked[k] = src[k];
  // where the programs live is a property of this Mac, not of a profile
  for (const sec of ['codex', 'claude', 'deepseek', 'workbuddy']) {
    if (!picked[sec]) continue;
    picked[sec] = { ...picked[sec] };
    for (const k of ['path', 'appPath', 'home']) delete picked[sec][k];
  }
  const list = [...(cfg.profiles?.list || [])];
  const existing = list.find((p) => p.name === n);
  if (existing) existing.settings = picked;
  else list.push({ id: crypto.randomBytes(4).toString('hex'), name: n, settings: picked });
  return replaceConfig('profiles', { active: existing?.id || list[list.length - 1].id, list });
}

export function applyProfile(id) {
  const cfg = loadConfig();
  const p = (cfg.profiles?.list || []).find((x) => x.id === id);
  if (!p) throw new Error(t('srv.profile.notFound'));
  saveConfig(p.settings);
  return replaceConfig('profiles', { active: p.id, list: cfg.profiles.list });
}

export function deleteProfile(id) {
  const cfg = loadConfig();
  const list = (cfg.profiles?.list || []).filter((x) => x.id !== id);
  return replaceConfig('profiles', { active: cfg.profiles?.active === id ? '' : cfg.profiles?.active || '', list });
}

// ---------- settings export / import (snow-cli /config export|import) ----------

export function exportSettings() {
  const data = {
    app: 'oneiropolos',
    version: 1,
    exportedAt: nowIso(),
    config: readJson(path.join(DATA_DIR, 'config.json'), {}),
    hooks: readHookDir(GLOBAL_HOOKS_DIR),
    mcp: loadMcp(),
    commands: listCommands().map(({ name, type, command, description }) => ({ name, type, command, description })),
    templates: listTemplates().custom.map(({ name, body }) => ({ name, body })),
  };
  const downloads = path.join(os.homedir(), 'Downloads');
  const dir = fs.existsSync(downloads) ? downloads : path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `oneiropolos-settings-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { path: file };
}

export function importSettings(data) {
  if (!data || typeof data !== 'object' || data.app !== 'oneiropolos') throw new Error(t('srv.import.bad'));
  if (data.config && typeof data.config === 'object') {
    const clean = { ...data.config };
    for (const k of Object.keys(clean)) if (!(k in DEFAULTS)) delete clean[k];
    saveConfig(clean);
  }
  if (data.hooks && typeof data.hooks === 'object') for (const type of HOOK_TYPES) if (Array.isArray(data.hooks[type])) writeHookType(type, data.hooks[type]);
  if (data.mcp?.mcpServers) saveMcp(data.mcp);
  for (const c of Array.isArray(data.commands) ? data.commands : []) {
    try {
      saveCommand(c);
    } catch {
      // skip invalid
    }
  }
  for (const tpl of Array.isArray(data.templates) ? data.templates : []) {
    try {
      saveTemplate(tpl);
    } catch {
      // skip invalid
    }
  }
  return { ok: true };
}

export function clockLabel(iso) {
  return clockText(Date.parse(iso));
}

export { listCommands };
