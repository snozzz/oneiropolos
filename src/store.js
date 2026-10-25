import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR, ensureDirs } from './paths.js';
import { t } from './i18n.js';
import { isPidAlive, newRunId, nowIso, readJson, writeJsonAtomic } from './util.js';

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
export const ACTIVE_STATUSES = new Set(['queued', 'running', 'paused', 'waiting_user', 'waiting']);

export function isValidRunId(id) {
  return typeof id === 'string' && RUN_ID_RE.test(id);
}

export function runDir(id) {
  if (!isValidRunId(id)) throw new Error(`invalid task id: ${id}`);
  return path.join(RUNS_DIR, id);
}

const statePath = (id) => path.join(runDir(id), 'state.json');
// Sidebar-only facts (a name the user gave the task, pinned or not), kept apart from state.json so the UI never
// races the runner writing state.
const metaPath = (id) => path.join(runDir(id), 'meta.json');
export const eventsPath = (id) => path.join(runDir(id), 'events.jsonl');
const controlPath = (id) => path.join(runDir(id), 'control.jsonl');
export const roundDir = (id, n) => path.join(runDir(id), 'rounds', String(n));
// What WorkBuddy is generating right now (partial snapshot), only for the live view; not part of the event log
export const livePath = (id) => path.join(runDir(id), 'live.json');

export function createRun({ goal, workdir, settings, scheduledAt = null }) {
  ensureDirs();
  const id = newRunId();
  fs.mkdirSync(path.join(runDir(id), 'rounds'), { recursive: true });
  const now = nowIso();
  const state = {
    id,
    goal,
    workdir,
    settings,
    createdAt: now,
    updatedAt: now,
    status: 'queued', // queued | running | paused | waiting_user | waiting | done | failed | stopped | interrupted
    phase: 'plan', // plan | approve | work | audit | followup | review | ask | finish
    round: 0,
    gpt: { threadId: null, reviewThreadId: null },
    wb: { sessionId: null, sessionStarted: false, sessions: 0, handoff: null },
    pendingInstruction: null,
    instructionSource: 'gpt',
    plan: [],
    progress: 0,
    lastAudit: null,
    lastReview: null,
    question: null,
    rounds: [],
    userMessages: [],
    controlOffset: 0,
    reviewCount: 0,
    snapshot: { enabled: null, reason: null, firstCommit: null },
    stats: { gptTurns: 0, wbCalls: 0, gptIn: 0, gptCachedIn: 0, gptOut: 0, wbIn: 0, wbOut: 0, teamRounds: 0 },
    scheduledAt, // scheduled start (ISO); until then the runner only waits
    restores: [], // rollbacks: { at, to, label, safety }
    planApproved: false, // Plan Mode: the user approved the plan
    hookContext: null, // additionalContext from hooks, handed to the next GPT prompt
    askThen: null, // phase after the user answered a question (followup | audit)
    stopHookAsked: false,
    message: null,
    messageKey: null,
    messageParams: null,
    error: null,
    pid: null,
    finishedAt: null,
  };
  writeState(state);
  return state;
}

export function readState(id) {
  return readJson(statePath(id), null);
}

export function writeState(state) {
  state.updatedAt = nowIso();
  writeJsonAtomic(statePath(state.id), state);
}

// The UI asks for the state several times a second; cache ps results for a few seconds
const runnerCache = new Map();

export function isRunnerProcess(pid) {
  if (!isPidAlive(pid)) return false;
  const hit = runnerCache.get(pid);
  if (hit && Date.now() - hit.at < 3000) return hit.value;
  let value = false;
  try {
    const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    value = /runner\.js|wbloop/.test(cmd);
  } catch {
    value = false;
  }
  runnerCache.set(pid, { at: Date.now(), value });
  return value;
}

export function isRunnerAlive(state) {
  return Boolean(state?.pid) && ACTIVE_STATUSES.has(state.status) && isRunnerProcess(state.pid);
}

/** The status shown to the outside: "running" without a live runner process shows as interrupted. */
export function effectiveStatus(state) {
  if (!state) return 'unknown';
  if (state.status === 'queued') {
    // queued for over a minute without a runner (crashed on launch …): treat as interrupted so it can be continued
    const stale = !state.pid && Date.now() - Date.parse(state.createdAt) > 60_000;
    return stale ? 'interrupted' : 'queued';
  }
  if (ACTIVE_STATUSES.has(state.status) && !isRunnerAlive(state)) return 'interrupted';
  return state.status;
}

export function readMeta(id) {
  const m = readJson(metaPath(id), {}) || {};
  return { title: typeof m.title === 'string' ? m.title : '', pinned: m.pinned ? String(m.pinned) : null };
}

/** patch: { title?: string ('' = back to the goal's first line), pinned?: boolean } */
export function writeMeta(id, patch = {}) {
  if (!readState(id)) throw new Error(t('srv.runMissing', { id }));
  const m = readMeta(id);
  if (typeof patch.title === 'string') m.title = patch.title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (typeof patch.pinned === 'boolean') m.pinned = patch.pinned ? nowIso() : null;
  writeJsonAtomic(metaPath(id), m);
  return m;
}

export function listRuns() {
  ensureDirs();
  const out = [];
  for (const id of fs.readdirSync(RUNS_DIR)) {
    if (!isValidRunId(id)) continue;
    const s = readState(id);
    if (!s) continue;
    const meta = readMeta(id);
    out.push({
      id: s.id,
      goal: s.goal,
      title: meta.title,
      pinned: meta.pinned,
      workdir: s.workdir,
      status: effectiveStatus(s),
      phase: s.phase,
      round: s.round,
      maxRounds: s.settings?.loop?.maxRounds,
      progress: s.progress,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      finishedAt: s.finishedAt,
      scheduledAt: s.scheduledAt || null,
      question: s.status === 'waiting_user' ? s.question : null,
      error: s.error,
      mode: s.settings?.agents?.mode || 'normal',
      team: s.settings?.team?.mode || 'off',
    });
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export function deleteRun(id) {
  const s = readState(id);
  if (s && isRunnerAlive(s)) throw new Error(t('srv.stillRunning'));
  fs.rmSync(runDir(id), { recursive: true, force: true });
}

export function appendEvent(id, event) {
  const line = `${JSON.stringify({ t: nowIso(), ...event })}\n`;
  fs.appendFileSync(eventsPath(id), line);
}

/** Complete event lines starting at byte offset `offset`. */
export function readEvents(id, offset = 0, maxBytes = 4 * 1024 * 1024) {
  const file = eventsPath(id);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { events: [], offset };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (offset >= size) return { events: [], offset };
    const len = Math.min(size - offset, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { events: [], offset };
    const text = buf.subarray(0, lastNl + 1).toString('utf8');
    const events = [];
    let pos = offset;
    for (const line of text.split('\n')) {
      if (!line) continue;
      pos += Buffer.byteLength(line) + 1;
      try {
        events.push({ ...JSON.parse(line), _o: pos });
      } catch {
        // skip broken line
      }
    }
    return { events, offset: offset + lastNl + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

export function appendControl(id, cmd) {
  fs.appendFileSync(controlPath(id), `${JSON.stringify({ t: nowIso(), ...cmd })}\n`);
}

export function readControl(id, offset = 0) {
  const file = controlPath(id);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { commands: [], offset };
  }
  if (offset >= buf.length) return { commands: [], offset };
  const chunk = buf.subarray(offset);
  const lastNl = chunk.lastIndexOf(0x0a);
  if (lastNl < 0) return { commands: [], offset };
  const commands = [];
  for (const line of chunk.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      commands.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return { commands, offset: offset + lastNl + 1 };
}
