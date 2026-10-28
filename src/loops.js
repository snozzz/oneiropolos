// Scheduled loops (snow-cli /loop, docs/usage/09.4): run a goal as a new task, or send a message to an existing task,
// every N minutes/hours or every day at HH:MM. Loops live in ~/.wbloop/loops.json; a small detached daemon
// (src/looper.js) fires them, so they keep running when the app is closed. A trigger is skipped while the previous
// task of the same loop is still running.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LOG_DIR, ROOT, ensureDirs } from './paths.js';
import { t } from './i18n.js';
import { isPidAlive, readJson, writeJsonAtomic } from './util.js';

export const LOOPS_FILE = path.join(DATA_DIR, 'loops.json');
export const LOOPER_PID = path.join(DATA_DIR, 'looper.pid');
const MAX_LOOPS = 50;
const UNIT_MS = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 };
const UNIT_WORDS = [
  [/^(s|sec|secs|second|seconds|秒)$/i, 's'],
  [/^(m|min|mins|minute|minutes|分|分钟|分鐘)$/i, 'm'],
  [/^(h|hr|hrs|hour|hours|小时|小時|時間|时)$/i, 'h'],
  [/^(d|day|days|天|日)$/i, 'd'],
];

function unitOf(word) {
  for (const [re, u] of UNIT_WORDS) if (re.test(word)) return u;
  return null;
}

/** "5m", "8h30m", "1d12h" → ms; null when it is not a duration. */
export function parseDuration(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!/^(\d+\s*[a-z一-鿿぀-ヿ]+\s*)+$/i.test(s)) return null;
  let total = 0;
  for (const m of s.matchAll(/(\d+)\s*([a-z一-鿿぀-ヿ]+)/gi)) {
    const u = unitOf(m[2]);
    if (!u) return null;
    total += Number(m[1]) * UNIT_MS[u];
  }
  return total > 0 ? total : null;
}

function normTime(hh, mm) {
  const h = Number(hh);
  const m = Number(mm);
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Parses snow-cli style loop specs (plus Chinese/Japanese variants):
 *   5m <prompt> · <prompt> every 2 hours · daily 09:30 <prompt> · at 18:00 <prompt> · every day at 09:30 <prompt>
 *   <prompt> every day at 09:30 · 每天 09:30 <prompt> · 每 2 小时 <prompt> · 毎日 09:30 <prompt>
 * Without a schedule the default is every 10 minutes. Returns { schedule, prompt } or throws.
 */
export function parseLoopSpec(input) {
  let s = String(input || '').trim();
  let schedule = null;
  let m;
  if ((m = s.match(/^(?:daily|at|every\s+day\s+at|每天|每日|毎日)\s*(\d{1,2}):(\d{2})\s+([\s\S]+)$/i))) {
    schedule = { type: 'daily', time: normTime(m[1], m[2]) };
    s = m[3];
  } else if ((m = s.match(/^([\s\S]+?)\s+(?:every\s+day\s+at|daily\s+at|daily)\s+(\d{1,2}):(\d{2})$/i))) {
    schedule = { type: 'daily', time: normTime(m[2], m[3]) };
    s = m[1];
  } else if ((m = s.match(/^([\s\S]+?)\s+every\s+(\d+)\s*([a-z]+)$/i))) {
    const ms = parseDuration(`${m[2]}${m[3]}`);
    if (ms) {
      schedule = { type: 'interval', ms };
      s = m[1];
    }
  } else if ((m = s.match(/^(?:每|毎)\s*(\d+)\s*([一-鿿぀-ヿ]+?)(?:一次|ごと|毎)?\s+([\s\S]+)$/))) {
    const ms = parseDuration(`${m[1]}${m[2]}`);
    if (ms) {
      schedule = { type: 'interval', ms };
      s = m[3];
    }
  } else {
    const first = s.split(/\s+/)[0];
    const ms = parseDuration(first);
    if (ms) {
      schedule = { type: 'interval', ms };
      s = s.slice(first.length).trim();
    }
  }
  if (schedule?.type === 'daily' && !schedule.time) throw new Error(t('srv.loop.badTime'));
  if (!schedule) schedule = { type: 'interval', ms: 10 * 60_000 };
  if (schedule.type === 'interval' && schedule.ms < 60_000) throw new Error(t('srv.loop.tooShort'));
  const prompt = s.trim();
  if (!prompt) throw new Error(t('srv.loop.noPrompt'));
  return { schedule, prompt };
}

export function nextRunAt(schedule, from = Date.now()) {
  if (schedule.type === 'daily') {
    const [h, m] = schedule.time.split(':').map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return new Date(from + schedule.ms).toISOString();
}

export function loadLoops() {
  const list = readJson(LOOPS_FILE, [])?.loops ?? readJson(LOOPS_FILE, []);
  return Array.isArray(list) ? list : [];
}

export function saveLoops(list) {
  ensureDirs();
  writeJsonAtomic(LOOPS_FILE, { loops: list });
}

export function addLoop({ kind = 'task', spec, workdir = '', runId = '', settings = null }) {
  const { schedule, prompt } = parseLoopSpec(spec);
  const loops = loadLoops();
  if (loops.filter((l) => l.enabled).length >= MAX_LOOPS) throw new Error(t('srv.loop.tooMany', { n: MAX_LOOPS }));
  if (kind === 'task' && !workdir) throw new Error(t('srv.loop.noDir'));
  if (kind === 'message' && !runId) throw new Error(t('srv.loop.noRun'));
  const rec = {
    id: crypto.randomBytes(4).toString('hex'),
    kind,
    prompt,
    workdir,
    runId,
    settings,
    schedule,
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: nextRunAt(schedule),
    lastRunAt: null,
    lastRunId: kind === 'message' ? runId : null,
    runs: 0,
    skipped: 0,
    lastError: null,
  };
  loops.push(rec);
  saveLoops(loops);
  ensureLooper();
  return rec;
}

export function updateLoop(id, patch) {
  const loops = loadLoops();
  const l = loops.find((x) => x.id === id);
  if (!l) throw new Error(t('srv.loop.notFound', { id }));
  if (patch.enabled != null) {
    l.enabled = Boolean(patch.enabled);
    if (l.enabled) l.nextRunAt = nextRunAt(l.schedule);
  }
  saveLoops(loops);
  if (l.enabled) ensureLooper();
  return l;
}

export function deleteLoop(id) {
  const loops = loadLoops();
  const next = loops.filter((x) => x.id !== id);
  if (next.length === loops.length) throw new Error(t('srv.loop.notFound', { id }));
  saveLoops(next);
  return next;
}

export function looperAlive() {
  const pid = Number(readJson(LOOPER_PID, null)?.pid);
  return pid && isPidAlive(pid) ? pid : 0;
}

/** Starts the loop daemon when there are enabled loops and it is not already running. */
export function ensureLooper() {
  if (!loadLoops().some((l) => l.enabled)) return 0;
  const alive = looperAlive();
  if (alive) return alive;
  ensureDirs();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const log = fs.openSync(path.join(LOG_DIR, 'looper.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'looper.js')], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env, cwd: DATA_DIR });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}
