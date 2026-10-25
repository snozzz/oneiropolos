import fs from 'node:fs';
import path from 'node:path';
import { MODEL_UNSUPPORTED_RE, nextFallbackModel, recordModelResult } from './codex.js';
import { deepMerge } from './config.js';
import { engine, engineOf, roleNames, roleSpec } from './engines/index.js';
import { loadHookRules, runHooks } from './hooks.js';
import { clockText, setRoleNames, t } from './i18n.js';
import { codexMcpArgs, wbMcpConfig } from './mcp.js';
import { NOTEBOOK_DIR, ensureNotebook } from './notebook.js';
import { ROOT } from './paths.js';
import * as P from './prompts.js';
import { cancelPending, gateLog } from './safety.js';
import { GPT_OUTPUT_SCHEMA, ensureSchemaFile, normalizeGptOutput } from './schema.js';
import { listSkills } from './skills.js';
import { Snapshotter } from './snapshot.js';
import { agentsArg, listSubagents } from './subagents.js';
import { buildSystemPrompt } from './sysprompts.js';
import { appendEvent, isRunnerProcess, livePath, readControl, readState, roundDir, runDir, writeState } from './store.js';
import { SleepGuard, notify } from './system.js';
import { applyTree, initBoard, mergeCommits, prepareWorkspace, removeWorkspace, rosterText, snapshotWorkspace, teamRoundDir } from './team.js';
import { recordUsage } from './usage.js';
import { baseChildEnv, extractJsonObject, isTempPath, nowIso, oneLine, readJson, runProcess, sleep, truncate, truncateMiddle, uuid, writeJsonAtomic } from './util.js';
import { wbAuthState } from './workbuddy.js';

class StopSignal extends Error {
  constructor() {
    super('stopped');
    this.name = 'StopSignal';
  }
}

// Something the user has to handle (login, quota, configuration): the task pauses; "Continue" resumes where it was.
// The message is stored as { key, params } so the UI can show it in the current language.
class PauseSignal extends Error {
  constructor(key, params = undefined, { byUser = false } = {}) {
    super(t(key, params));
    this.name = 'PauseSignal';
    this.key = key;
    this.params = params;
    this.byUser = byUser;
  }
}

// WBLOOP_TEST_FAST=1 shrinks all waits to milliseconds
const WAIT_SCALE = process.env.WBLOOP_TEST_FAST ? 0.0005 : 1;
const LIMIT_WAITS_MIN = [5, 10, 15, 30, 30, 60].map((m) => m * WAIT_SCALE);
const TRANSIENT_WAITS_SEC = [15, 60, 180, 600].map((x) => x * WAIT_SCALE);
const LOST_THREAD_RE = /no (rollout|session|conversation|thread)[^\n]{0,40}found|(thread|session|rollout)[^\n]{0,40}not found|failed to (resume|load)/i;
const LOST_WB_SESSION_RE = /(session|conversation)[^\n]{0,40}(not found|does not exist|不存在)|No conversation found/i;
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TaskList', 'TaskGet', 'ToolSearch', 'NotebookRead', 'WebSearch', 'WebFetch']);
const CHECK_SHELL = fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
const GATE = path.join(ROOT, 'src', 'hook-gate.js');

function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) ctrl.abort();
    else s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export class Orchestrator {
  constructor(runId, { onEvent } = {}) {
    this.id = runId;
    this.dir = runDir(runId);
    this.state = readState(runId);
    if (!this.state) throw new Error(t('srv.runMissing', { id: runId }));
    this.onEvent = onEvent;
    this.abort = new AbortController();
    this.stopRequested = false;
    this.pauseRequested = false;
    this.resumeRequested = false;
    this.approveRequested = null;
    // the step in progress (one GPT turn, or one WorkBuddy round incl. continuations / all teammates):
    // "interrupt" ends only this step, not the task
    this.step = null;
    this.polling = null;
    this.sleepGuard = new SleepGuard(this.state.settings?.system?.caffeinate !== false);
  }

  get cfg() {
    return this.state.settings;
  }

  save() {
    if (this.orphaned) return;
    writeState(this.state);
  }

  emit(kind, data = {}) {
    if (this.orphaned) return;
    const ev = { kind, ...data };
    appendEvent(this.id, ev);
    try {
      this.onEvent?.({ t: nowIso(), ...ev });
    } catch {
      // console printer errors are irrelevant
    }
  }

  /** An info line in the timeline, re-rendered by the UI in its own language. */
  info(key, params, extra = {}) {
    this.emit('info', { key, params, text: t(key, params), ...extra });
  }

  setStatus(status, message = null) {
    const m = typeof message === 'string' ? { text: message } : message ? { key: message.key, params: message.params, text: t(message.key, message.params) } : null;
    this.state.status = status;
    this.state.message = m?.text ?? null;
    this.state.messageKey = m?.key ?? null;
    this.state.messageParams = m?.params ?? null;
    this.save();
    this.emit('run.status', { status, message: m?.text ?? null, key: m?.key, params: m?.params });
  }

  notify(whatKey, message) {
    if (this.cfg.system?.notify !== false) notify(t('notify.title', { what: t(whatKey) }), oneLine(message, 200));
  }

  requestStop() {
    this.stopRequested = true;
    this.abort.abort();
  }

  beginStep(kind) {
    const ctrl = new AbortController();
    const step = { kind, ctrl, cut: false };
    this.step = step;
    return { step, signal: anySignal([this.abort.signal, ctrl.signal]) };
  }

  endStep(step) {
    if (this.step === step) this.step = null;
  }

  // ---------- control channel: the UI/CLI send commands through control.jsonl ----------

  async pollControl() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const { commands, offset } = readControl(this.id, this.state.controlOffset || 0);
      if (!commands.length) return;
      this.state.controlOffset = offset;
      for (const c of commands) await this.applyControl(c);
      this.save();
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  async applyControl(c) {
    // stop/pause/resume left over from a previous runner are ignored; messages and settings still apply
    if (this.initialPoll && ['stop', 'pause', 'resume', 'approve'].includes(c.cmd)) return;
    switch (c.cmd) {
      case 'stop':
        this.info('srv.ctl.stop');
        this.requestStop();
        break;
      case 'pause':
        if (!this.pauseRequested) this.info('srv.ctl.pause');
        this.pauseRequested = true;
        break;
      case 'resume':
        this.pauseRequested = false;
        this.resumeRequested = true;
        break;
      case 'approve':
        this.approveRequested = { note: String(c.text || '').trim() };
        break;
      case 'compact':
        this.state.wb.compactRequested = true;
        this.info('srv.ctl.compact');
        break;
      case 'message':
      case 'cut': {
        let text = String(c.text || '').trim();
        let context = '';
        if (text && this.hooksOn) {
          const r = await runHooks('onUserMessage', { message: text, source: 'normal', runId: this.id, cwd: this.state.workdir, messageCount: this.state.userMessages.length }, { workdir: this.state.workdir, env: this.hookEnv() });
          this.hookEvent('onUserMessage', r);
          if (r.blocked) {
            this.emit('error', { message: t('srv.hook.messageBlocked', { msg: oneLine(r.blocked.message, 300) }) });
            text = '';
          } else {
            if (r.replaced != null && r.replaced.trim()) text = r.replaced.trim();
            context = r.additionalContext || '';
          }
        }
        if (text) {
          this.state.userMessages.push({ t: c.t || nowIso(), text, ...(context ? { context } : {}) });
          this.emit('user.message', { text, cut: c.cmd === 'cut' || undefined });
        }
        // interrupt: end the current step and let GPT handle the message right away (the task keeps running)
        if (c.cmd === 'cut' && this.step && !this.initialPoll) {
          this.step.cut = true;
          this.step.ctrl.abort();
        }
        break;
      }
      case 'settings':
        if (c.patch && typeof c.patch === 'object') {
          this.state.settings = deepMerge(this.state.settings, c.patch);
          this.info('srv.ctl.settings', { patch: oneLine(JSON.stringify(c.patch), 300) });
        }
        break;
      default:
        break;
    }
  }

  get hooksOn() {
    return this.cfg.hooks?.enabled !== false;
  }

  hookEnv(extra = {}) {
    return { WBLOOP_RUN_ID: this.id, ...extra };
  }

  hookEvent(type, r, extra = {}) {
    if (!r?.ran) return;
    this.emit('hook', { type, ran: r.ran, blocked: r.blocked ? oneLine(r.blocked.message, 300) : null, replaced: r.replaced != null, context: Boolean(r.additionalContext), prompt: Boolean(r.prompt), ...extra });
  }

  /**
   * The lead's sandbox and working directory, fixed once chosen so resumed sessions stay consistent. ChatGPT follows
   * codex.sandbox; Claude always works from a scratch directory (its sandbox keeps writes there); WorkBuddy and
   * DeepSeek read the project in place, read-only.
   */
  resolveGptSandbox() {
    const s = this.state;
    const leadId = engineOf(this.cfg, 'lead');
    if (s.gpt.sandbox && (s.gpt.sandbox.engine || 'chatgpt') !== leadId) s.gpt.sandbox = null;
    if (!s.gpt.sandbox) {
      if (leadId === 'claude') {
        s.gpt.sandbox = { mode: 'workspace-write', cwd: path.join(this.dir, 'gpt-scratch'), engine: leadId };
      } else if (leadId !== 'chatgpt') {
        s.gpt.sandbox = { mode: 'read-only', cwd: s.workdir, engine: leadId };
      } else if (s.gpt.threadId) {
        s.gpt.sandbox = { mode: 'read-only', cwd: s.workdir };
      } else if ((this.cfg.codex.sandbox || 'scratch') === 'scratch' && !isTempPath(s.workdir)) {
        s.gpt.sandbox = { mode: 'workspace-write', cwd: path.join(this.dir, 'gpt-scratch') };
      } else {
        s.gpt.sandbox = { mode: 'read-only', cwd: s.workdir };
      }
    }
    if (s.gpt.sandbox.mode === 'workspace-write') fs.mkdirSync(s.gpt.sandbox.cwd, { recursive: true });
    return s.gpt.sandbox;
  }

  // ---------- everything the system prompts and WorkBuddy calls need ----------

  get mode() {
    const m = this.cfg.agents?.mode;
    return m === 'plan' || m === 'vuln' ? m : 'normal';
  }

  get teamCfg() {
    const tm = this.cfg.team || {};
    return { mode: ['auto', 'always'].includes(tm.mode) ? tm.mode : 'off', maxTeammates: Math.max(2, Math.min(6, Number(tm.maxTeammates) || 3)) };
  }

  extraDirs() {
    return (this.cfg.workbuddy?.addDirs || []).map(String).filter((d) => {
      try {
        return path.isAbsolute(d) && fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /** Context shared by all system prompts of this run (computed per call: ROLE.md, skills and agents may change). */
  promptContext(extra = {}) {
    const s = this.state;
    const subagents = this.cfg.subagents?.enabled === false ? [] : listSubagents(this.cfg, s.workdir);
    const skills = this.cfg.skills?.enabled === false ? [] : listSkills(this.cfg, s.workdir);
    let notebookPath = null;
    if (this.cfg.notebook?.enabled !== false) {
      try {
        notebookPath = ensureNotebook(s.workdir);
      } catch {
        notebookPath = null;
      }
    }
    const names = roleNames(this.cfg);
    const execEngine = engineOf(this.cfg, 'executor');
    return { settings: this.cfg, workdir: s.workdir, sandbox: this.sandbox, subagents: engine(execEngine).meta.agents ? subagents : [], skills, notebookPath, extraDirs: this.extraDirs(), mode: this.mode, team: this.teamCfg, names, execEngine, gate: engine(execEngine).meta.gate, ...extra };
  }

  /** Writes the system prompt of a role to a file in the run directory (Codex and WorkBuddy both read it from there). */
  writeSystemPrompt(role, ctx, name = role) {
    const { text, source } = buildSystemPrompt(role, ctx);
    const dir = path.join(this.dir, 'prompts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, text);
    return { file, source };
  }

  /** WorkBuddy hooks (--settings): the safety gate and the user's tool hooks, both handled by src/hook-gate.js. */
  wbHooks({ round, member }) {
    const policy = this.cfg.safety?.policy || 'ask';
    const userPre = this.hooksOn && (loadHookRules('beforeToolCall', this.state.workdir).length || loadHookRules('toolConfirmation', this.state.workdir).length);
    const userPost = this.hooksOn && loadHookRules('afterToolCall', this.state.workdir).length;
    const args = `--run ${this.id} --round ${round}${member ? ` --member ${sh(member)}` : ''}`;
    const cmd = (phase) => `${sh(process.execPath)} ${sh(GATE)} ${phase} ${args}`;
    const hooks = {};
    if (policy !== 'allow' || userPre) {
      const timeout = Math.max(1, Number(this.cfg.safety?.timeoutMin) || 10) * 60 + 90;
      hooks.PreToolUse = [{ matcher: userPre ? '' : 'Bash|PowerShell', hooks: [{ type: 'command', command: cmd('pre'), timeout }] }];
    }
    if (userPost) hooks.PostToolUse = [{ matcher: '', hooks: [{ type: 'command', command: cmd('post'), timeout: 600 }] }];
    return hooks;
  }

  /** Options of one executor call; each engine takes what it supports (hooks and sub-agents only where they exist). */
  execCallOptions({ round, member, cwd, sysFile, extraDirs = [] }) {
    const wbc = this.cfg.workbuddy;
    const spec = roleSpec(this.cfg, 'executor');
    const eng = engine(spec.engine);
    const ctx = this.promptContext();
    const dirs = new Set([...this.extraDirs(), ...extraDirs]);
    if (ctx.notebookPath) dirs.add(NOTEBOOK_DIR);
    for (const sk of ctx.skills) if (!sk.dir.startsWith(`${this.state.workdir}${path.sep}`)) dirs.add(path.dirname(sk.dir));
    const approvalMin = eng.meta.gate && (this.cfg.safety?.policy || 'ask') === 'ask' ? Math.max(1, Number(this.cfg.safety?.timeoutMin) || 10) + 5 : 0;
    return {
      cfg: this.cfg,
      found: this.execFound,
      cwd,
      model: spec.model,
      effort: spec.effort,
      contextWindow: Number(wbc.contextWindow) || 0,
      permissionMode: wbc.permissionMode,
      maxTurns: wbc.maxTurnsPerCall,
      tools: wbc.tools || undefined,
      systemFile: sysFile,
      agents: eng.meta.agents && ctx.subagents.length ? agentsArg(ctx.subagents) : '',
      hooks: eng.meta.gate ? this.wbHooks({ round, member }) : {},
      mcpConfig: wbMcpConfig(this.cfg),
      mcpArgs: codexMcpArgs(this.cfg),
      addDirs: [...dirs],
      autocompact: wbc.autocompact || '',
      timeoutMs: (wbc.callTimeoutMin || 90) * 60_000,
      idleTimeoutMs: Math.max(wbc.idleTimeoutMin || 20, approvalMin) * 60_000,
    };
  }

  // ---------- main flow ----------

  async run() {
    const s = this.state;
    if (s.pid && s.pid !== process.pid && isRunnerProcess(s.pid) && ['running', 'paused', 'waiting_user', 'waiting'].includes(s.status)) {
      throw new Error(t('srv.runBusy', { pid: s.pid }));
    }
    const interrupted = ['running', 'waiting'].includes(s.status) && !s.scheduledAt;
    s.pid = process.pid;
    s.error = null;
    s.wb = s.wb || { sessionId: null, sessionStarted: false, sessions: 0, handoff: null };
    this.initialPoll = true;
    await this.pollControl();
    this.initialPoll = false;
    if (s.phase === 'finish') {
      if (!s.userMessages.length) {
        this.info('srv.finishedNeedMessage');
        this.save();
        return;
      }
      // a finished task got new requirements: let GPT plan the follow-up
      s.phase = 'followup';
      s.abortReason = null;
      s.reviewCount = 0;
      s.finishedAt = null;
      s.stopHookAsked = false;
    }
    this.timer = setInterval(() => {
      // the task's folder was deleted under us: nobody can see or control this task any more, so end quietly
      if (!fs.existsSync(this.dir)) {
        this.orphaned = true;
        this.requestStop();
        return;
      }
      this.pollControl().catch(() => {});
    }, 1000);
    try {
      this.findEngines();
      if (!fs.existsSync(s.workdir)) throw new PauseSignal('srv.pause.noDir', { dir: s.workdir });
      this.schemaPath = ensureSchemaFile();
      this.sandbox = this.resolveGptSandbox();
      this.snap = new Snapshotter(this.dir, s.workdir);
      if (s.snapshot.enabled === false) {
        this.snap.disabledReason = s.snapshot.reason || t('srv.snap.off');
      } else {
        const ok = await this.snap.init();
        s.snapshot.enabled = ok;
        s.snapshot.reason = this.snap.disabledReason;
        if (!ok) this.emit('info', { text: this.snap.disabledReason });
      }
      if (s.scheduledAt) await this.waitForSchedule();
      await this.sessionStartHooks(interrupted);
      this.setStatus('running', interrupted ? { key: 'srv.resumedFromCrash' } : null);
      if (interrupted) this.info('srv.resumedFromCrashInfo');
      this.sleepGuard.hold();
      await this.mainLoop();
    } catch (err) {
      if (err instanceof StopSignal || this.stopRequested) {
        this.setStatus('stopped', { key: 'srv.stoppedCanContinue' });
        await this.stopHooks('stopped');
      } else if (err instanceof PauseSignal) {
        // environment problems before starting (codex/WorkBuddy missing, directory gone): "Continue" checks again
        this.setStatus('stopped', { key: err.key, params: err.params });
        this.notify('notify.cannotStart', err.message);
      } else {
        s.error = err.stack || err.message;
        this.setStatus('failed', { key: 'srv.programError', params: { msg: oneLine(err.message, 300) } });
        this.emit('error', { message: err.message });
        this.notify('notify.error', err.message);
      }
    } finally {
      clearInterval(this.timer);
      this.sleepGuard.release();
      try {
        cancelPending(this.id);
      } catch {
        // nothing pending
      }
    }
  }

  /** Finds the CLI of each role's engine (again after "Continue": the user may have switched engines meanwhile). */
  findEngines() {
    const lead = roleSpec(this.cfg, 'lead');
    const exec = roleSpec(this.cfg, 'executor');
    setRoleNames(roleNames(this.cfg));
    this.leadFound = engine(lead.engine).find(this.cfg);
    this.execFound = engine(exec.engine).find(this.cfg);
    if (!this.leadFound) throw new PauseSignal(lead.engine === 'chatgpt' ? 'srv.pause.noCodex' : 'srv.pause.noEngine', { name: lead.name });
    if (!this.execFound) throw new PauseSignal(exec.engine === 'workbuddy' ? 'srv.pause.noWb' : 'srv.pause.noEngine', { name: exec.name });
  }

  async sessionStartHooks(resumed) {
    if (!this.hooksOn) return;
    const s = this.state;
    const r = await runHooks('onSessionStart', { runId: this.id, goal: s.goal, cwd: s.workdir, resumed: Boolean(resumed || s.round > 0) }, { workdir: s.workdir, env: this.hookEnv() });
    this.hookEvent('onSessionStart', r);
    if (r.blocked) throw new PauseSignal('srv.hook.blocked', { type: 'onSessionStart', msg: oneLine(r.blocked.message, 300) });
    if (r.additionalContext) {
      s.hookContext = [s.hookContext, r.additionalContext].filter(Boolean).join('\n\n');
      this.save();
    }
  }

  async stopHooks(status) {
    if (!this.hooksOn) return null;
    const s = this.state;
    const summary = (s.lastReview?.verdict === 'done' ? s.lastReview : s.lastAudit)?.assessment || '';
    try {
      const r = await runHooks('onStop', { runId: this.id, status, goal: s.goal, cwd: s.workdir, summary, rounds: s.round, messages: s.userMessages.map((m) => ({ role: 'user', content: m.text })) }, { workdir: s.workdir, env: this.hookEnv() });
      this.hookEvent('onStop', r);
      return r;
    } catch {
      return null;
    }
  }

  /** Scheduled start: wait until the time (or "Start now"). Idle sleep is prevented meanwhile so the time isn't missed. */
  async waitForSchedule() {
    const s = this.state;
    const at = Date.parse(s.scheduledAt);
    if (Number.isFinite(at) && at > Date.now()) {
      this.resumeRequested = false;
      s.status = 'waiting';
      s.message = t('srv.schedule.waiting', { time: clockText(at) });
      s.messageKey = 'srv.schedule.waiting';
      s.messageParams = { at: s.scheduledAt };
      this.save();
      this.emit('schedule', { at: s.scheduledAt });
      this.sleepGuard.hold();
      while (Date.now() < at && !this.resumeRequested) {
        if (this.stopRequested) throw new StopSignal();
        await sleep(Math.min(1000, Math.max(10, at - Date.now())));
      }
      this.info(this.resumeRequested ? 'srv.schedule.early' : 'srv.schedule.now');
      this.resumeRequested = false;
    }
    s.scheduledAt = null;
    this.save();
  }

  async mainLoop() {
    for (;;) {
      await this.pollControl();
      if (this.stopRequested) throw new StopSignal();
      if (this.pauseRequested) await this.pauseUntilResumed({ key: 'srv.paused' }, false);
      const phase = this.state.phase;
      if (phase === 'finish') {
        // new requirements arrived before finishing (e.g. during the review): hand them to GPT first
        if (this.state.userMessages.length && !this.state.abortReason) {
          this.state.phase = 'followup';
          this.save();
          continue;
        }
        if (await this.finish()) return;
        continue;
      }
      try {
        if (phase === 'plan') await this.doPlan();
        else if (phase === 'approve') await this.doApprove();
        else if (phase === 'work') await this.doWork();
        else if (phase === 'audit') await this.doAudit();
        else if (phase === 'followup') await this.doFollowup();
        else if (phase === 'review') await this.doReview();
        else if (phase === 'ask') await this.doAsk();
        else throw new Error(`unknown phase: ${phase}`);
      } catch (err) {
        if (err instanceof PauseSignal) {
          await this.pauseUntilResumed({ key: err.key, params: err.params }, !err.byUser);
          continue;
        }
        throw err;
      }
    }
  }

  async pauseUntilResumed(message, isProblem) {
    this.pauseRequested = false;
    this.resumeRequested = false;
    this.sleepGuard.release();
    this.setStatus('paused', message);
    if (isProblem) this.notify('notify.paused', t(message.key, message.params));
    while (!this.resumeRequested) {
      if (this.stopRequested) throw new StopSignal();
      await sleep(1000);
    }
    this.resumeRequested = false;
    this.sleepGuard.hold();
    this.setStatus('running', null);
  }

  async waitFor(ms, key, params, { signal } = {}) {
    const until = Date.now() + ms;
    const reason = t(key, params);
    this.state.status = 'waiting';
    this.state.message = reason;
    this.state.messageKey = key;
    this.state.messageParams = params || null;
    this.save();
    this.emit('wait', { reason, key, params, until: new Date(until).toISOString() });
    while (Date.now() < until) {
      if (this.stopRequested) throw new StopSignal();
      if (this.pauseRequested) throw new PauseSignal('srv.paused', undefined, { byUser: true });
      if (signal?.aborted) break;
      await sleep(Math.min(1000, until - Date.now()));
    }
    this.setStatus('running', null);
  }

  /** Returns true when the task really ended (an onStop prompt hook may send it back to the user first). */
  async finish() {
    const s = this.state;
    if (!s.abortReason && !s.stopHookAsked) {
      const r = await this.stopHooks('done');
      if (r?.prompt) {
        s.stopHookAsked = true;
        s.question = r.prompt;
        s.askThen = 'followup';
        s.phase = 'ask';
        this.save();
        return false;
      }
    }
    s.finishedAt = nowIso();
    if (s.abortReason) {
      this.setStatus('failed', { key: 'srv.aborted', params: { msg: oneLine(s.abortReason, 300) } });
      this.notify('notify.aborted', s.abortReason);
    } else {
      s.progress = 100;
      const verdictSource = s.lastReview?.verdict === 'done' ? s.lastReview : s.lastAudit;
      this.setStatus('done', verdictSource?.assessment ? oneLine(verdictSource.assessment, 300) : { key: 'srv.goalDone' });
      this.notify('notify.done', verdictSource?.assessment || s.goal);
    }
    this.emit('done', { summary: (s.lastReview?.verdict === 'done' ? s.lastReview : s.lastAudit)?.assessment || '', rounds: s.round, stats: s.stats, aborted: !!s.abortReason });
    return true;
  }

  // ---------- rounds ----------

  roundRec(n) {
    return this.state.rounds.find((r) => r.round === n);
  }

  ensureRoundDir(n) {
    const dir = roundDir(this.id, n);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Throttled (250 ms) writes of WorkBuddy's partial output to live.json (live.<member>.json for teammates). */
  liveWriter(round, member = null) {
    const file = member ? path.join(this.dir, `live.${member}.json`) : livePath(this.id);
    let timer = null;
    let pending = null;
    let last = 0;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (!pending) return;
      last = Date.now();
      try {
        writeJsonAtomic(file, { round, member, at: last, ...pending });
      } catch {
        // the live view is best effort
      }
      pending = null;
    };
    return {
      update: (snap) => {
        pending = snap;
        if (!snap.blocks.length || Date.now() - last >= 250) flush();
        else timer ??= setTimeout(flush, 250 - (Date.now() - last));
      },
      close: () => {
        pending = { blocks: [] };
        flush();
      },
    };
  }

  /** A new round from GPT's output. Team assignments are used only when Team Mode is on and there are 2+ of them. */
  newRound(out, source, reviewerNote = null) {
    const s = this.state;
    let team = Array.isArray(out.team) ? out.team : [];
    let instruction = out.next_instruction;
    const teamOn = this.teamCfg.mode !== 'off';
    if (team.length > this.teamCfg.maxTeammates) {
      this.info('srv.team.trimmed', { n: team.length, max: this.teamCfg.maxTeammates });
      team = team.slice(0, this.teamCfg.maxTeammates);
    }
    if (!teamOn || team.length < 2) {
      if (!instruction && team.length) instruction = team.map((m) => (team.length > 1 ? `## ${m.name}${m.role ? ` (${m.role})` : ''}\n${m.instruction}` : m.instruction)).join('\n\n');
      else if (team.length === 1) instruction = team[0].instruction;
      team = [];
    }
    if (!instruction) instruction = team.map((m) => `${m.name}: ${oneLine(m.instruction, 200)}`).join('\n');
    s.round += 1;
    s.pendingInstruction = instruction;
    s.instructionSource = source;
    s.rounds.push({
      round: s.round,
      instruction,
      source,
      reviewerNote,
      team: team.length ? team : null,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
      worker: null,
      audit: null,
      baseCommit: null,
      endCommit: null,
      diffFiles: null,
      workerInFlight: false,
    });
  }

  applyOutput(out, { keepPlan = false } = {}) {
    const s = this.state;
    if (!keepPlan && out.plan?.length) s.plan = out.plan;
    s.progress = out.progress;
    s.lastAudit = out;
  }

  routeVerdict(out, from, extra = {}) {
    const s = this.state;
    if (out.verdict === 'continue') {
      this.newRound(out, from === 'review' ? 'reviewer' : 'gpt', extra.reviewerNote || null);
      // Plan Mode: the first instruction waits for the user's approval of the plan
      s.phase = this.mode === 'plan' && !s.planApproved ? 'approve' : 'work';
    } else if (out.verdict === 'done') {
      s.phase = from !== 'review' && this.cfg.loop.finalReview && s.reviewCount < 2 ? 'review' : 'finish';
    } else if (out.verdict === 'ask_user') {
      s.question = out.question_for_user;
      s.askThen = 'followup';
      s.phase = 'ask';
    } else {
      s.abortReason = out.assessment || t('srv.abortDefault');
      s.phase = 'finish';
    }
    this.save();
  }

  // ---------- one GPT turn (retries, rate-limit waits, JSON repair, re-answer after an interrupt) ----------

  /**
   * consumes: whether this turn "consumes" the queued user messages (removes them on success). The independent
   * review and the wrap-up only look at them; the Lead handles them. The prompt already contains all messages so far.
   */
  async gptTurn({ prompt, threadKey, label, round, consumes = true, role = 'lead' }) {
    const s = this.state;
    let base = prompt;
    let appendix = '';
    let interjections = [];
    // messages already in the prompt (removed on success); messages arriving meanwhile wait for the next turn
    let shown = s.userMessages.length;
    let jsonRetries = 0;
    let transientTries = 0;
    let limitTries = 0;
    let rebuilt = false;
    const triedModels = [];
    const limitDeadline = Date.now() + (this.cfg.loop.waitOnLimitHours || 8) * 3600_000;
    const rawDir = round ? this.ensureRoundDir(round) : this.dir;
    for (;;) {
      if (this.stopRequested) throw new StopSignal();
      const c = this.cfg.codex;
      const spec = roleSpec(this.cfg, 'lead');
      const eng = engine(spec.engine);
      setRoleNames(roleNames(this.cfg));
      // the lead's engine changed since this thread was made (settings of a running task): start a new thread from a recap
      if (s.gpt[threadKey] && (s.gpt.engine || 'chatgpt') !== spec.engine) {
        s.gpt.threadId = null;
        s.gpt.reviewThreadId = null;
        this.info('srv.gpt.engineChanged', { name: spec.name });
        if (threadKey === 'threadId' && !rebuilt) {
          rebuilt = true;
          base = `${P.recapPrompt({ goal: s.goal, workdir: s.workdir, maxRounds: this.cfg.loop.maxRounds, plan: s.plan, lastAudit: s.lastAudit, rounds: s.rounds, checkCommand: this.cfg.loop.checkCommand, team: this.teamCfg, mode: this.mode })}\n\n---\n\n${prompt}`;
        }
      }
      s.gpt.engine = spec.engine;
      const found = eng.find(this.cfg);
      if (!found) throw new PauseSignal(spec.engine === 'chatgpt' ? 'srv.pause.noCodex' : 'srv.pause.noEngine', { name: spec.name });
      this.sandbox = this.resolveGptSandbox();
      const currentPrompt = appendix ? `${base}\n\n${appendix}` : base;
      const sys = this.writeSystemPrompt(role, this.promptContext());
      s.stats.gptTurns += 1;
      this.save();
      this.emit('gpt.start', { label, round, resume: Boolean(s.gpt[threadKey]), prompt: truncate(currentPrompt, 24_000), system: sys.source, engine: spec.engine });
      const { step, signal } = this.beginStep('gpt');
      const r = await eng.lead({
        cfg: this.cfg,
        found,
        runId: this.id,
        threadId: s.gpt[threadKey],
        newId: uuid(),
        prompt: currentPrompt,
        cwd: this.sandbox.cwd,
        model: spec.model,
        effort: spec.effort,
        sandbox: this.sandbox.mode,
        schemaPath: this.schemaPath,
        schema: JSON.stringify(GPT_OUTPUT_SCHEMA),
        systemFile: sys.file,
        webSearch: Boolean(c.webSearch),
        mcpArgs: codexMcpArgs(this.cfg),
        mcpConfig: wbMcpConfig(this.cfg),
        outFile: path.join(this.dir, `gpt-last-${threadKey}.txt`),
        rawFile: path.join(rawDir, `gpt-${label}.jsonl`),
        onEvent: (e) => this.emit(e.kind, { ...e, label, round }),
        signal,
        timeoutMs: (c.turnTimeoutMin || 40) * 60_000,
      });
      this.endStep(step);
      if (r.threadId) s.gpt[threadKey] = r.threadId;
      if (r.usage) {
        s.stats.gptIn += r.usage.input_tokens || 0;
        s.stats.gptCachedIn += r.usage.cached_input_tokens || 0;
        s.stats.gptOut += r.usage.output_tokens || 0;
        recordUsage({ agent: 'gpt', engine: spec.engine, model: spec.model, input: r.usage.input_tokens || 0, cached: r.usage.cached_input_tokens || 0, output: r.usage.output_tokens || 0, runId: this.id, kind: label });
      }
      this.save();

      if (!r.ok) {
        const kind = r.error?.kind;
        const msg = r.error?.message || 'unknown error';
        if (kind === 'aborted' && step.cut && !this.stopRequested) {
          // the interrupted prompt may or may not be in the session: resend all of it plus the messages of this step
          interjections = interjections.concat(s.userMessages.slice(shown));
          shown = s.userMessages.length;
          if (interjections.length) appendix = P.interjectionNote(interjections);
          this.info('srv.gpt.cutRetry', undefined, { label, round });
          continue;
        }
        if (kind === 'aborted' || this.stopRequested) throw new StopSignal();
        this.emit('gpt.error', { label, round, message: msg, errorKind: kind });
        if (!rebuilt && s.gpt[threadKey] && LOST_THREAD_RE.test(msg)) {
          rebuilt = true;
          s.gpt[threadKey] = null;
          this.save();
          if (threadKey === 'threadId') {
            base = `${P.recapPrompt({ goal: s.goal, workdir: s.workdir, maxRounds: this.cfg.loop.maxRounds, plan: s.plan, lastAudit: s.lastAudit, rounds: s.rounds, checkCommand: this.cfg.loop.checkCommand, team: this.teamCfg, mode: this.mode })}\n\n---\n\n${prompt}`;
          }
          this.info('srv.gpt.rebuilt');
          continue;
        }
        if (spec.engine === 'chatgpt' && spec.model && MODEL_UNSUPPORTED_RE.test(msg)) {
          recordModelResult(spec.model, false, msg);
          triedModels.push(spec.model);
          const next = nextFallbackModel(triedModels);
          if (next) {
            this.info('srv.gpt.modelSwitch', { from: spec.model, to: next });
            this.state.settings.codex.model = next;
            if (this.state.settings.roles?.lead?.model) this.state.settings.roles.lead.model = next;
            this.save();
            continue;
          }
        }
        if (kind === 'auth') throw new PauseSignal('srv.pause.gptAuth', { msg: oneLine(msg, 200), name: spec.name });
        if (kind === 'config') throw new PauseSignal('srv.pause.gptConfig', { msg: oneLine(msg, 300) });
        if (kind === 'limit') {
          const waitMin = LIMIT_WAITS_MIN[Math.min(limitTries, LIMIT_WAITS_MIN.length - 1)];
          limitTries += 1;
          if (Date.now() + waitMin * 60_000 > limitDeadline) throw new PauseSignal('srv.pause.gptLimit', { msg: oneLine(msg, 200) });
          await this.waitFor(waitMin * 60_000, 'srv.wait.gptLimit', { msg: oneLine(msg, 160), min: Math.round(waitMin) });
          continue;
        }
        if (transientTries >= TRANSIENT_WAITS_SEC.length) throw new PauseSignal('srv.pause.gptFailing', { msg: oneLine(msg, 300) });
        const waitSec = TRANSIENT_WAITS_SEC[transientTries];
        transientTries += 1;
        await this.waitFor(waitSec * 1000, 'srv.wait.gptRetry', { msg: oneLine(msg, 160), sec: Math.round(waitSec) });
        continue;
      }

      const norm = normalizeGptOutput(extractJsonObject(r.text));
      if (norm.error) {
        this.emit('gpt.error', { label, round, message: t('srv.gpt.badFormat', { err: norm.error }), errorKind: 'format' });
        if (jsonRetries < 2 && s.gpt[threadKey]) {
          jsonRetries += 1;
          // the resumed session already holds the previous prompt (with any interjections): just ask for a valid answer
          base = P.retryJsonPrompt(norm.error);
          appendix = '';
          interjections = [];
          continue;
        }
        throw new PauseSignal('srv.pause.gptUnparsable', { err: norm.error });
      }
      if (spec.engine === 'chatgpt' && spec.model) recordModelResult(spec.model, true);
      if (consumes && shown) s.userMessages.splice(0, shown);
      this.emit('gpt.result', { label, round, output: norm.value, durationMs: r.durationMs, usage: r.usage, model: spec.model || spec.name, engine: spec.engine });
      this.save();
      return norm.value;
    }
  }

  // ---------- the check command: run by the program itself, the result goes straight to GPT ----------

  async runCheck({ round, scope = 'round', rdir = null }) {
    const lc = this.cfg.loop;
    const command = String(lc.checkCommand || '').trim();
    if (!command) return null;
    this.emit('check.start', { round, scope, command });
    const started = Date.now();
    let output = '';
    const res = await runProcess(CHECK_SHELL, ['-c', `{ ${command}\n} 2>&1`], {
      cwd: this.state.workdir,
      env: await baseChildEnv(),
      signal: this.abort.signal,
      timeoutMs: (lc.checkTimeoutMin || 15) * 60_000,
      onLine: (line) => {
        output += `${line}\n`;
        if (output.length > 400_000) output = output.slice(-200_000);
      },
    });
    if (res.aborted || this.stopRequested) throw new StopSignal();
    const text = output.replace(/\s+$/, '');
    const check = {
      command,
      code: res.code,
      timedOut: res.timedOut,
      ok: res.code === 0 && !res.timedOut,
      durationMs: Date.now() - started,
      output: truncateMiddle(text, 6000),
      at: nowIso(),
    };
    if (rdir) writeJsonAtomic(path.join(rdir, 'check.json'), { ...check, output: truncateMiddle(text, 60_000) });
    this.emit('round.check', { round, scope, ...check, output: truncateMiddle(text, 4000) });
    return check;
  }

  // ---------- phases ----------

  takeHookContext() {
    const ctx = this.state.hookContext || '';
    this.state.hookContext = null;
    return ctx;
  }

  async doPlan() {
    const s = this.state;
    this.emit('phase', { phase: 'plan' });
    const snapshotNote = this.snap.disabledReason ? `(Note: file snapshots are off for this task — ${this.snap.disabledReason})` : '';
    const prompt = P.plannerPrompt({
      goal: s.goal, workdir: s.workdir, maxRounds: this.cfg.loop.maxRounds, snapshotNote, checkCommand: this.cfg.loop.checkCommand,
      userMessages: s.userMessages, hookContext: this.takeHookContext(), mode: this.mode, extraDirs: this.extraDirs(), team: this.teamCfg,
    });
    const out = await this.gptTurn({ prompt, threadKey: 'threadId', label: 'plan' });
    this.applyOutput(out);
    this.routeVerdict(out, 'plan');
  }

  /** Plan Mode: wait for the user to approve the plan (or to ask for changes with a message). */
  async doApprove() {
    const s = this.state;
    const rec = this.roundRec(s.round);
    if (!rec) {
      s.phase = 'followup';
      this.save();
      return;
    }
    this.approveRequested = null;
    this.sleepGuard.release();
    this.setStatus('waiting_user', { key: 'srv.plan.awaiting' });
    this.emit('plan.approval', { round: rec.round, plan: s.plan, instruction: truncate(rec.instruction, 8000) });
    this.notify('notify.planReady', oneLine(s.lastAudit?.assessment || s.goal, 200));
    const before = s.userMessages.length;
    while (!this.approveRequested && s.userMessages.length === before) {
      if (this.stopRequested) throw new StopSignal();
      await sleep(700);
    }
    this.sleepGuard.hold();
    if (this.approveRequested) {
      s.planApproved = true;
      s.userMessages.push({ t: nowIso(), text: P.planApprovedNote(this.approveRequested.note), system: true });
      this.emit('plan.approved', { note: this.approveRequested.note || '' });
      this.approveRequested = null;
      s.phase = 'work';
    } else {
      // changes requested: drop the pending round and let GPT revise the plan
      s.rounds = s.rounds.filter((r) => r !== rec);
      s.round = rec.round - 1;
      s.phase = 'followup';
    }
    this.setStatus('running', null);
    this.save();
  }

  /** Round or token limit reached: GPT writes a wrap-up first; if it finds the goal already met, finish as done. */
  async doWrapUp(rec, reason) {
    const s = this.state;
    const used = this.tokensUsedM();
    const out = await this.gptTurn({
      prompt: P.wrapUpPrompt({ maxRounds: this.cfg.loop.maxRounds, instruction: rec.instruction, reason, budgetText: `${used.toFixed(2)}M / ${this.cfg.loop.tokenBudgetM}M tokens` }),
      threadKey: 'threadId',
      label: `wrapup-${rec.round}`,
      round: rec.round - 1 || undefined,
      consumes: false,
    });
    rec.wrapUp = { at: nowIso(), verdict: out.verdict, reason };
    this.applyOutput(out);
    if (out.verdict === 'continue') {
      if (out.next_instruction) {
        rec.instruction = out.next_instruction;
        rec.team = null;
        s.pendingInstruction = out.next_instruction;
      }
      this.save();
      return;
    }
    // any other verdict: drop the round that never started and follow the verdict
    s.rounds = s.rounds.filter((r) => r !== rec);
    s.round = rec.round - 1;
    this.routeVerdict(out, 'wrapup');
  }

  tokensUsedM() {
    const st = this.state.stats || {};
    return ((st.gptIn || 0) + (st.gptOut || 0) + (st.wbIn || 0) + (st.wbOut || 0)) / 1e6;
  }

  async doWork() {
    const s = this.state;
    const lc = this.cfg.loop;
    const round = s.round;
    const rec = this.roundRec(round);
    if (!rec) throw new Error(`missing record of round ${round}`);
    if (round > lc.maxRounds) {
      if (!rec.wrapUp) await this.doWrapUp(rec, 'rounds');
      if (s.phase !== 'work') return;
      throw new PauseSignal('srv.pause.maxRounds', { n: lc.maxRounds });
    }
    const budget = Number(lc.tokenBudgetM) || 0;
    if (budget > 0 && !rec.startedAt && this.tokensUsedM() >= budget) {
      if (!rec.wrapUp || rec.wrapUp.reason !== 'budget' || rec.wrapUp.budget !== budget) {
        await this.doWrapUp(rec, 'budget');
        if (rec.wrapUp) rec.wrapUp.budget = budget;
      }
      if (s.phase !== 'work') return;
      throw new PauseSignal('srv.pause.budget', { used: this.tokensUsedM().toFixed(2), budget });
    }
    if (engineOf(this.cfg, 'executor') === 'workbuddy' && !wbAuthState().loggedIn) throw new PauseSignal('srv.pause.wbLogin');
    this.emit('phase', { phase: 'work', round, team: rec.team ? rec.team.map((m) => m.name) : undefined });
    const rdir = this.ensureRoundDir(round);
    fs.writeFileSync(path.join(rdir, 'instruction.md'), rec.instruction);
    rec.startedAt = rec.startedAt || nowIso();
    if (!rec.baseCommit && !this.snap.disabledReason) {
      rec.baseCommit = await this.snap.commit(`round ${round} start`);
      if (!s.snapshot.firstCommit) s.snapshot.firstCommit = rec.baseCommit;
    }
    this.save();

    if (rec.team?.length && rec.baseCommit && !this.snap.disabledReason) {
      await this.doTeamWork(rec, rdir);
    } else {
      if (rec.team?.length) {
        // Team Mode needs snapshots to merge; without them the round runs as a single Executor
        this.info('srv.team.noSnapshots');
        rec.instruction = rec.team.map((m) => `## ${m.name}${m.role ? ` (${m.role})` : ''}\n${m.instruction}`).join('\n\n');
        rec.team = null;
      }
      await this.doSingleWork(rec, rdir);
    }

    let diff = null;
    if (!this.snap.disabledReason && rec.baseCommit) {
      rec.endCommit = await this.snap.commit(`round ${round} end`);
      diff = rec.endCommit ? await this.snap.diff(rec.baseCommit, rec.endCommit, (lc.diffMaxKB || 48) * 1024) : null;
      if (diff) {
        writeJsonAtomic(path.join(rdir, 'diff.json'), diff);
        rec.diffFiles = diff.files.length;
      }
    }
    if (rec.diffFiles == null) {
      // without snapshots, fall back to the files the tool calls wrote
      const toolCalls = readJson(path.join(rdir, 'tools.json'), []);
      const touched = new Set(toolCalls.filter((x) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(x.name)).map((x) => x.summary));
      rec.touchedFiles = [...touched].slice(0, 200);
    }
    this.emit('round.diff', {
      round,
      files: diff ? diff.files.slice(0, 300) : null,
      touched: rec.touchedFiles || null,
      truncated: diff?.truncated || false,
      patchBytes: diff?.patchBytes || 0,
      command: diff?.command || null,
      disabled: this.snap.disabledReason || null,
      conflicts: rec.merge?.conflicts?.length ? rec.merge.conflicts : undefined,
    });
    // run the check after the snapshot, so files it produces (build output …) don't count as this round's changes
    if (lc.checkCommand && !rec.check) {
      rec.check = await this.runCheck({ round, rdir });
      if (rec.check) rec.check.output = undefined;
    }
    rec.workerEndedAt = nowIso();
    if (rec.hookPrompt && !rec.hookAsked) {
      // an onSubAgentComplete "prompt" hook: ask the user before GPT audits
      rec.hookAsked = true;
      s.question = rec.hookPrompt;
      s.askThen = 'audit';
      s.phase = 'ask';
    } else {
      s.phase = 'audit';
    }
    this.save();
  }

  /** Hooks around one executor run: beforeSubAgentStart may rewrite or extend the prompt. */
  async beforeAgentHooks({ agentId, agentName, prompt, cwd, round }) {
    if (!this.hooksOn) return prompt;
    const r = await runHooks('beforeSubAgentStart', { agentId, agentName, prompt, cwd, runId: this.id, round }, { workdir: this.state.workdir, env: this.hookEnv({ WBLOOP_ROUND: String(round) }) });
    this.hookEvent('beforeSubAgentStart', r, { round, member: agentId === 'workbuddy' ? undefined : agentName });
    if (r.newPrompt) return r.newPrompt;
    if (r.additionalContext) return `${r.additionalContext}\n\n${prompt}`;
    return prompt;
  }

  async afterAgentHooks({ rec, agentId, agentName, worker }) {
    if (!this.hooksOn) return;
    const r = await runHooks('onSubAgentComplete', {
      agentId, agentName, round: rec.round, runId: this.id, success: Boolean(worker?.ok),
      content: worker?.resultText || (worker?.lastTexts || []).join('\n\n'),
      usage: worker?.usage || null,
    }, { workdir: this.state.workdir, env: this.hookEnv({ WBLOOP_ROUND: String(rec.round) }) });
    this.hookEvent('onSubAgentComplete', r, { round: rec.round, member: agentId === 'workbuddy' ? undefined : agentName });
    if (r.additionalContext) rec.hookNotes = [rec.hookNotes, `${agentName}: ${r.additionalContext}`].filter(Boolean).join('\n');
    if (r.prompt) rec.hookPrompt = r.prompt;
    if (r.blocked) throw new PauseSignal('srv.hook.blocked', { type: 'onSubAgentComplete', msg: oneLine(r.blocked.message, 300) });
  }

  /** Starts a fresh WorkBuddy session with a handover note (context overflow, lost session, /compact). */
  async rotateSession(slot, reasonKey) {
    const s = this.state;
    if (this.hooksOn) {
      const r = await runHooks('beforeCompress', { runId: this.id, reason: reasonKey, sessionId: slot.sessionId, round: s.round }, { workdir: s.workdir, env: this.hookEnv() });
      this.hookEvent('beforeCompress', r);
    }
    slot.sessionId = uuid();
    slot.sessionStarted = false;
    slot.sessions = (slot.sessions || 0) + 1;
    slot.handoff = P.handoffNote({ goal: s.goal, plan: s.plan, lastAssessment: s.lastAudit?.assessment, reason: t(reasonKey, undefined, 'en') });
    this.info('srv.wb.rotate', { reason: t(reasonKey) });
  }

  async doSingleWork(rec, rdir) {
    const s = this.state;
    const round = rec.round;
    if (!s.wb.sessionId) {
      s.wb.sessionId = uuid();
      s.wb.sessionStarted = false;
      s.wb.sessions = (s.wb.sessions || 0) + 1;
    }
    if (s.wb.compactRequested && !rec.workerInFlight) {
      s.wb.compactRequested = false;
      await this.rotateSession(s.wb, 'srv.reason.compact');
    }
    const sys = this.writeSystemPrompt('executor', this.promptContext());
    const first = await this.beforeAgentHooks({
      agentId: 'workbuddy',
      agentName: 'WorkBuddy',
      prompt: P.workerPrompt({ round, instruction: rec.instruction, workdir: s.workdir, handoff: s.wb.sessionStarted ? null : s.wb.handoff }),
      cwd: s.workdir,
      round,
    });
    const { step, signal } = this.beginStep('work');
    let agg;
    try {
      agg = await this.runExecutor({
        rec,
        round,
        member: null,
        cwd: s.workdir,
        slot: s.wb,
        firstPrompt: first,
        sysFile: sys.file,
        rdir,
        toolsFile: path.join(rdir, 'tools.json'),
        inFlight: rec.workerInFlight,
        setInFlight: (v) => {
          rec.workerInFlight = v;
        },
        prevAgg: rec.worker,
        onAgg: (a) => {
          rec.worker = a;
        },
        step,
        signal,
      });
    } finally {
      this.endStep(step);
    }
    rec.worker = agg;
    rec.worker.blocked = gateLog(this.id, round).filter((e) => e.decision !== 'allow' && !e.member).map((e) => ({ command: e.command, decision: e.decision, reason: e.reason || e.by }));
    this.save();
    await this.afterAgentHooks({ rec, agentId: 'workbuddy', agentName: 'WorkBuddy', worker: agg });
  }

  /**
   * One executor (the single WorkBuddy or one teammate) for one round: runs WorkBuddy, continues automatically after
   * step limits and transient errors, waits out rate limits, rotates the session on context overflow.
   * Returns the aggregate worker record.
   */
  async runExecutor({ rec, round, member, cwd, slot, firstPrompt, sysFile, rdir, toolsFile, inFlight, setInFlight, prevAgg, onAgg, step, signal, extraDirs = [] }) {
    const s = this.state;
    const wbc = this.cfg.workbuddy;
    const lc = this.cfg.loop;
    const toolCalls = readJson(toolsFile, []);
    const agg = prevAgg || { ok: false, calls: 0, continuations: 0, durationMs: 0, toolCount: 0, resultText: '', lastTexts: [], errors: [], permissionDenials: [], model: '', usage: { input: 0, cached: 0, output: 0 } };
    agg.usage = agg.usage || { input: 0, cached: 0, output: 0 };
    const instruction = member ? rec.team.find((m) => m.name === member)?.instruction || rec.instruction : rec.instruction;
    // with an established session send a short continuation; if it never started (crash on launch), use a new id
    // and resend the full instruction
    const resumePrompt = (reason) => {
      if (slot.sessionStarted) return P.continuationPrompt({ round, reason, instruction });
      slot.sessionId = uuid();
      return firstPrompt;
    };
    let prompt;
    if (inFlight) {
      agg.continuations += 1;
      prompt = resumePrompt(t('srv.reason.restart', undefined, 'en'));
    } else {
      prompt = firstPrompt;
    }
    let transientTries = 0;
    let limitTries = 0;
    let rotated = false;
    const limitDeadline = Date.now() + (lc.waitOnLimitHours || 8) * 3600_000;
    const tag = member ? { member } : {};

    for (;;) {
      if (this.stopRequested) throw new StopSignal();
      const spec = roleSpec(this.cfg, 'executor');
      const eng = engine(spec.engine);
      setRoleNames(roleNames(this.cfg));
      this.execFound = eng.find(this.cfg);
      if (!this.execFound) throw new PauseSignal(spec.engine === 'workbuddy' ? 'srv.pause.noWb' : 'srv.pause.noEngine', { name: spec.name });
      // a session belongs to one engine: after a switch, start fresh with a handover note
      if (slot.engine && slot.engine !== spec.engine) {
        await this.rotateSession(slot, 'srv.reason.engineChanged');
        prompt = member ? firstPrompt : P.workerPrompt({ round, instruction, workdir: s.workdir, handoff: slot.handoff });
      }
      slot.engine = spec.engine;
      setInFlight(true);
      s.stats.wbCalls += 1;
      this.save();
      this.emit('wb.start', { round, ...tag, resume: slot.sessionStarted, sessionId: slot.sessionId, continuation: agg.calls > 0, prompt: truncate(prompt, 24_000), engine: spec.engine });
      const live = this.liveWriter(round, member);
      const r = await eng.exec({
        ...this.execCallOptions({ round, member, cwd, sysFile, extraDirs }),
        sessionId: slot.sessionId,
        resume: slot.sessionStarted,
        prompt,
        onEvent: (e) => {
          if (e.kind === 'wb.init' && !slot.sessionStarted) {
            slot.sessionStarted = true;
            slot.handoff = null;
            this.save();
          }
          this.emit(e.kind, { ...e, round, ...tag });
        },
        onLive: live.update,
        signal,
        rawFile: path.join(rdir, member ? `workbuddy.${member}.jsonl` : 'workbuddy.jsonl'),
      });
      live.close();
      try {
        cancelPending(this.id, { round });
      } catch {
        // nothing pending
      }
      // interrupted by the user: not an error and no continuation — straight to the audit with the message
      const cut = step.cut && !r.ok && r.errorKind === 'aborted' && !this.stopRequested;
      if (cut) {
        r.errorKind = 'cut';
        r.errors = [t('srv.wb.cut')];
      }
      if (r.sawInit && !slot.sessionStarted) {
        slot.sessionStarted = true;
        slot.handoff = null;
      }
      // engines that name their own sessions (ChatGPT, DeepSeek) report the id to resume
      if (r.sessionId && r.sawInit) slot.sessionId = r.sessionId;
      toolCalls.push(...r.toolCalls);
      writeJsonAtomic(toolsFile, toolCalls);
      agg.calls += 1;
      agg.durationMs += r.durationMs;
      agg.toolCount = toolCalls.length;
      agg.model = r.model || agg.model;
      if (r.resultText) agg.resultText = truncate(r.resultText, 12_000);
      if (r.lastTexts.length) agg.lastTexts = r.lastTexts.map((x) => truncate(x, 4000));
      agg.permissionDenials = [...agg.permissionDenials, ...r.permissionDenials].slice(-20);
      agg.ok = r.ok;
      agg.interrupted = cut || undefined;
      agg.subtype = r.subtype;
      agg.errorKind = r.errorKind;
      agg.errors = r.ok ? [] : r.errors.map((e) => truncate(e, 1500));
      let usage = null;
      if (r.usage) {
        usage = { input: (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0), cached: r.usage.cache_read_input_tokens || 0, output: r.usage.output_tokens || 0 };
        s.stats.wbIn += usage.input;
        s.stats.wbOut += usage.output;
        agg.usage.input += usage.input;
        agg.usage.cached += usage.cached;
        agg.usage.output += usage.output;
        recordUsage({ agent: 'workbuddy', engine: spec.engine, model: r.model || spec.model, input: usage.input, cached: usage.cached, output: usage.output, runId: this.id, kind: member ? `team:${member}` : 'round' });
      }
      onAgg(agg);
      this.save();
      this.emit('wb.end', {
        round, ...tag, ok: r.ok, subtype: r.subtype, errors: r.errors, errorKind: r.errorKind, numTurns: r.numTurns,
        durationMs: r.durationMs, toolCount: r.toolCalls.length, model: r.model, resultText: truncate(r.resultText, 8000), usage,
      });
      if (r.ok) break;
      if (cut) {
        this.info('srv.wb.cutInfo', undefined, { round, ...tag });
        break;
      }

      const kind = r.errorKind;
      const errText = r.errors.join('\n');
      if (kind === 'aborted' || this.stopRequested) throw new StopSignal();
      if (kind === 'auth') throw new PauseSignal(spec.engine === 'workbuddy' ? 'srv.pause.wbAuth' : 'srv.pause.execAuth', { name: spec.name, msg: oneLine(errText, 200) });
      if (kind === 'credits') throw new PauseSignal('srv.pause.wbCredits', { msg: oneLine(errText, 200), name: spec.name });
      if (!rotated && (kind === 'context' || (slot.sessionStarted && LOST_WB_SESSION_RE.test(errText)))) {
        rotated = true;
        await this.rotateSession(slot, kind === 'context' ? 'srv.reason.context' : 'srv.reason.lostSession');
        prompt = member ? firstPrompt : P.workerPrompt({ round, instruction, workdir: s.workdir, handoff: slot.handoff });
        continue;
      }
      if (kind === 'limit') {
        const waitMin = LIMIT_WAITS_MIN[Math.min(limitTries, LIMIT_WAITS_MIN.length - 1)];
        limitTries += 1;
        if (Date.now() + waitMin * 60_000 > limitDeadline) throw new PauseSignal('srv.pause.wbLimit', { msg: oneLine(errText, 200) });
        await this.waitFor(waitMin * 60_000, 'srv.wait.wbLimit', { msg: oneLine(errText, 160), min: Math.round(waitMin) }, { signal });
        prompt = resumePrompt(t('srv.reason.limit', undefined, 'en'));
        continue;
      }
      if (agg.continuations >= (wbc.maxContinuations ?? 4)) {
        this.info('srv.wb.gaveUp', { round, n: agg.continuations }, tag);
        break;
      }
      if (kind !== 'max_turns') {
        const waitSec = TRANSIENT_WAITS_SEC[Math.min(transientTries, TRANSIENT_WAITS_SEC.length - 1)];
        transientTries += 1;
        await this.waitFor(waitSec * 1000, 'srv.wait.wbRetry', { msg: oneLine(errText, 160), sec: Math.round(waitSec) }, { signal });
      }
      agg.continuations += 1;
      prompt = resumePrompt(kind === 'max_turns' ? t('srv.reason.maxTurns', undefined, 'en') : oneLine(errText, 120));
    }
    setInFlight(false);
    this.save();
    return agg;
  }

  // ---------- Team Mode: several WorkBuddy teammates in parallel, merged back afterwards ----------

  async doTeamWork(rec, rdir) {
    const s = this.state;
    const round = rec.round;
    const members = rec.team;
    rec.teamState = rec.teamState || {};
    s.stats.teamRounds = (s.stats.teamRounds || 0) + (rec.teamStartedAt ? 0 : 1);
    rec.teamStartedAt = rec.teamStartedAt || nowIso();
    const board = initBoard({ runId: this.id, round, summary: oneLine(rec.instruction, 500), members });
    const roster = rosterText(members);
    this.emit('team.start', { round, members: members.map((m) => ({ name: m.name, role: m.role, owns: m.owns })), board });
    const { step, signal } = this.beginStep('work');
    try {
      // 1. private copies (APFS clones) of the working directory
      for (const m of members) {
        const st = rec.teamState[m.name] || (rec.teamState[m.name] = { sessionId: uuid(), sessionStarted: false, sessions: 1, handoff: null, done: false, inFlight: false });
        if (st.done || st.workspace) continue;
        this.info('srv.team.preparing', { name: m.name }, { round, member: m.name });
        const ws = await prepareWorkspace({ runId: this.id, round, slug: m.name, workdir: s.workdir, signal });
        st.workspace = ws.dir;
        if (ws.warning) this.emit('info', { text: `${m.name}: ${oneLine(ws.warning, 300)}`, round, member: m.name });
        this.save();
      }
      // 2. everyone works in parallel
      const results = await Promise.allSettled(members.map(async (m) => {
        const st = rec.teamState[m.name];
        if (st.done) return st.worker;
        const ctx = this.promptContext({ teammate: { member: m, workspace: st.workspace, board, roster } });
        const sys = this.writeSystemPrompt('teammate', ctx, `teammate-${m.name}`);
        const first = await this.beforeAgentHooks({
          agentId: 'teammate',
          agentName: m.name,
          prompt: P.teammatePrompt({ round, member: m, instruction: m.instruction, workspace: st.workspace, board, roster, workdir: s.workdir }),
          cwd: st.workspace,
          round,
        });
        const agg = await this.runExecutor({
          rec,
          round,
          member: m.name,
          cwd: st.workspace,
          slot: st,
          firstPrompt: first,
          sysFile: sys.file,
          rdir,
          toolsFile: path.join(rdir, `tools.${m.name}.json`),
          inFlight: st.inFlight,
          setInFlight: (v) => {
            st.inFlight = v;
          },
          prevAgg: st.worker,
          onAgg: (a) => {
            st.worker = a;
          },
          step,
          signal,
          extraDirs: [teamRoundDir(this.id, round)],
        });
        st.worker = agg;
        st.worker.blocked = gateLog(this.id, round).filter((e) => e.decision !== 'allow' && e.member === m.name).map((e) => ({ command: e.command, decision: e.decision, reason: e.reason || e.by }));
        st.done = true;
        this.save();
        await this.afterAgentHooks({ rec, agentId: 'teammate', agentName: m.name, worker: agg });
        return agg;
      }));
      const failure = results.find((x) => x.status === 'rejected');
      if (failure) {
        if (failure.reason instanceof StopSignal || this.stopRequested) throw new StopSignal();
        throw failure.reason;
      }
    } finally {
      this.endStep(step);
    }
    // a cut ends every teammate; their partial work is still merged and audited
    rec.worker = this.teamWorkerSummary(rec);
    // 3. snapshot every copy and merge
    if (!rec.merge) {
      this.emit('team.merging', { round });
      const outcomes = [];
      for (const m of members) {
        const st = rec.teamState[m.name];
        try {
          const snapRes = await snapshotWorkspace(this.snap, { ws: st.workspace, base: rec.baseCommit, label: `round ${round} teammate ${m.name}`, indexFile: path.join(teamRoundDir(this.id, round), m.name, 'index') });
          st.commit = snapRes.commit;
          st.files = snapRes.files.map((f) => `${f.status} ${f.path}`);
          outcomes.push({ name: m.name, commit: snapRes.commit });
        } catch (err) {
          st.files = null;
          outcomes.push({ name: m.name, commit: null, error: err.message });
        }
      }
      // the main directory may have changed during the round (by hand): merge that state in first
      let start = rec.baseCommit;
      const mainTree = await this.snap.worktreeTree();
      const baseTree = (await this.snap.run(['rev-parse', `${rec.baseCommit}^{tree}`])).stdout.trim();
      if (mainTree && mainTree !== baseTree) {
        start = (await this.snap.commit(`round ${round} main directory during team work`)) || rec.baseCommit;
        this.info('srv.team.mainChanged', { round });
      }
      const merged = await mergeCommits(this.snap, { start, members: outcomes.filter((o) => o.commit) });
      const errors = [...outcomes.filter((o) => o.error).map((o) => `${o.name}: ${o.error}`), ...merged.errors];
      if (merged.commit !== start) await applyTree(this.snap, merged.tree);
      rec.merge = { at: nowIso(), conflicts: merged.conflicts, merged: merged.merged, errors };
      this.emit('team.merged', { round, conflicts: merged.conflicts, merged: merged.merged, errors });
      if (merged.conflicts.length) this.info('srv.team.conflicts', { n: merged.conflicts.length }, { round });
      this.save();
      for (const m of members) {
        try {
          removeWorkspace(this.id, round, m.name);
        } catch {
          // a leftover copy only costs disk space
        }
      }
    }
  }

  teamWorkerSummary(rec) {
    const states = rec.team.map((m) => rec.teamState?.[m.name]?.worker).filter(Boolean);
    return {
      ok: states.length === rec.team.length && states.every((w) => w.ok),
      interrupted: states.some((w) => w.interrupted) || undefined,
      calls: states.reduce((n, w) => n + (w.calls || 0), 0),
      continuations: states.reduce((n, w) => n + (w.continuations || 0), 0),
      durationMs: Math.max(0, ...states.map((w) => w.durationMs || 0)),
      toolCount: states.reduce((n, w) => n + (w.toolCount || 0), 0),
      model: states.map((w) => w.model).find(Boolean) || '',
      resultText: '',
      lastTexts: [],
      errors: states.flatMap((w) => w.errors || []),
      permissionDenials: states.flatMap((w) => w.permissionDenials || []).slice(-20),
      team: true,
    };
  }

  async doAudit() {
    const s = this.state;
    const round = s.round;
    const rec = this.roundRec(round);
    this.emit('phase', { phase: 'audit', round });
    const rdir = this.ensureRoundDir(round);
    const diff = readJson(path.join(rdir, 'diff.json'), null);
    const toolCalls = readJson(path.join(rdir, 'tools.json'), []);
    const check = rec.check ? readJson(path.join(rdir, 'check.json'), rec.check) : null;
    let stagnant = 0;
    for (let i = s.rounds.length - 1; i >= 0; i--) {
      const r = s.rounds[i];
      if (r.diffFiles === 0) stagnant += 1;
      else break;
    }
    const snapshotNote = this.snap.disabledReason
      ? `(Snapshots are off: ${this.snap.disabledReason})\nFiles written this round:\n${(rec.touchedFiles || []).map((f) => `- ${f}`).join('\n') || '(none)'}`
      : '';
    const team = rec.team?.length
      ? rec.team.map((m) => ({ ...m, worker: rec.teamState?.[m.name]?.worker, files: rec.teamState?.[m.name]?.files ?? null, toolCalls: readJson(path.join(rdir, `tools.${m.name}.json`), []) }))
      : null;
    const writes = team ? team.reduce((n, m) => n + m.toolCalls.filter((x) => !READ_ONLY_TOOLS.has(x.name)).length, 0) : toolCalls.filter((x) => !READ_ONLY_TOOLS.has(x.name)).length;
    const budget = Number(this.cfg.loop.tokenBudgetM) || 0;
    const prompt = P.auditPrompt({
      round,
      remaining: Math.max(0, this.cfg.loop.maxRounds - round),
      instruction: rec.instruction,
      instructionSource: rec.source,
      worker: { ...rec.worker, toolCalls },
      diff,
      snapshotNote,
      userMessages: s.userMessages,
      stagnantRounds: stagnant,
      reviewerNote: rec.reviewerNote,
      check: check ? { ...check, output: truncateMiddle(check.output || '', 6000) } : null,
      team,
      merge: rec.merge,
      hookNotes: [rec.hookNotes, this.takeHookContext()].filter(Boolean).join('\n') || '',
      budget: budget ? `token budget used: ${this.tokensUsedM().toFixed(2)}M of ${budget}M` : '',
    });
    this.emit('audit.start', { round, files: rec.diffFiles ?? null, writes });
    const out = await this.gptTurn({ prompt, threadKey: 'threadId', label: `audit-${round}`, round });
    rec.audit = out;
    rec.endedAt = nowIso();
    this.applyOutput(out);
    this.routeVerdict(out, 'audit');
  }

  async doFollowup() {
    const s = this.state;
    this.emit('phase', { phase: 'followup', round: s.round });
    const note = s.lastAudit ? null : '(This is the first planning request of the task.)';
    const hook = this.takeHookContext();
    const out = await this.gptTurn({ prompt: P.followupPrompt({ userMessages: s.userMessages, note: [note, hook ? `## Context from the user's hooks\n${hook}` : ''].filter(Boolean).join('\n\n') }), threadKey: 'threadId', label: `followup-${s.round}`, round: s.round || undefined });
    this.applyOutput(out);
    this.routeVerdict(out, 'followup');
  }

  async doReview() {
    const s = this.state;
    s.reviewCount += 1;
    s.gpt.reviewThreadId = null;
    this.save();
    this.emit('phase', { phase: 'review', round: s.round });
    let diff = null;
    if (!this.snap.disabledReason && s.snapshot.firstCommit) {
      const head = await this.snap.commit(`final review ${s.reviewCount}`);
      if (head) diff = await this.snap.diff(s.snapshot.firstCommit, head, (this.cfg.loop.diffMaxKB || 48) * 1024);
    }
    const check = this.cfg.loop.checkCommand ? await this.runCheck({ round: s.round, scope: 'review' }) : null;
    const prompt = P.reviewerPrompt({ goal: s.goal, workdir: s.workdir, lastAudit: s.lastAudit, rounds: s.rounds, diff, userMessages: s.userMessages, check });
    // the reviewer only reads the user's messages; the Lead handles them
    const out = await this.gptTurn({ prompt, threadKey: 'reviewThreadId', label: `review-${s.reviewCount}`, round: s.round || undefined, consumes: false, role: 'reviewer' });
    s.lastReview = out;
    if (out.verdict === 'continue') {
      s.progress = Math.min(s.progress, out.progress || s.progress);
      this.routeVerdict({ ...out, team: [] }, 'review', { reviewerNote: P.reviewerNoteForAuditor(out) });
    } else if (out.verdict === 'done') {
      s.phase = 'finish';
      this.save();
    } else {
      this.applyOutput(out, { keepPlan: true });
      this.routeVerdict(out, 'review');
    }
  }

  async doAsk() {
    const s = this.state;
    // program notes (plan approved, rollback) are not an answer from the user
    const answered = () => s.userMessages.some((m) => !m.system);
    if (!answered()) {
      this.sleepGuard.release();
      this.setStatus('waiting_user', s.question);
      this.emit('ask', { question: s.question });
      this.notify('notify.needYou', s.question || '');
      while (!answered()) {
        if (this.stopRequested) throw new StopSignal();
        await sleep(1000);
      }
      this.sleepGuard.hold();
      this.setStatus('running', null);
    }
    s.question = null;
    s.phase = s.askThen === 'audit' ? 'audit' : 'followup';
    s.askThen = null;
    this.save();
  }
}

export async function runOrchestrator(runId, opts = {}) {
  const orch = new Orchestrator(runId, opts);
  await orch.run();
  return orch.state;
}
