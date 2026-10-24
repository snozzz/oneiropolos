import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './paths.js';
import { t } from './i18n.js';
import { baseChildEnv, execText, findExecutable, isExecutable, oneLine, readJson, runProcess, truncate, writeJsonAtomic } from './util.js';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

export function findCodex(configuredPath = '') {
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath);
  const onPath = findExecutable('codex');
  if (onPath) candidates.push(onPath);
  candidates.push('/Applications/Codex.app/Contents/Resources/codex');
  for (const file of candidates) {
    if (file && isExecutable(file)) {
      // the npm-installed codex is a `#!/usr/bin/env node` script: the node next to it must be on PATH
      return { path: file, binDir: path.dirname(file) };
    }
  }
  return null;
}

export async function codexEnv(found) {
  const env = await baseChildEnv(found ? [found.binDir] : []);
  // an API key in the user's shell must not override the ChatGPT subscription login
  delete env.OPENAI_API_KEY;
  return env;
}

export async function codexInfo(found) {
  if (!found) return { installed: false, loggedIn: false };
  const env = await codexEnv(found);
  const [ver, status] = await Promise.all([
    execText(found.path, ['--version'], { env, timeoutMs: 15_000 }),
    execText(found.path, ['login', 'status'], { env, timeoutMs: 15_000 }),
  ]);
  const statusText = `${status.stdout}\n${status.stderr}`.trim();
  return {
    installed: true,
    path: found.path,
    version: ver.stdout.trim() || ver.stderr.trim(),
    loggedIn: /logged in/i.test(statusText) && !/not logged in/i.test(statusText),
    chatgpt: /chatgpt/i.test(statusText),
    statusText: oneLine(statusText.split('\n').filter((l) => !/ERROR|WARN/.test(l)).join(' '), 200),
  };
}

export function listCodexModels() {
  const cache = readJson(path.join(CODEX_HOME, 'models_cache.json'), null);
  const models = Array.isArray(cache?.models) ? cache.models : [];
  const bad = readJson(path.join(DATA_DIR, 'codex-models.json'), {})?.bad || {};
  return models
    .filter((m) => m && m.slug)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({
      id: m.slug,
      name: m.display_name || m.slug,
      visible: m.visibility !== 'hide',
      efforts: (m.supported_reasoning_levels || []).map((x) => (typeof x === 'string' ? x : x.effort)).filter(Boolean),
      defaultEffort: m.default_reasoning_level || '',
      contextWindow: m.context_window || null,
      description: m.description || '',
      unavailable: Boolean(bad[m.slug]),
    }));
}

// The model cache may list models this account cannot use (the server rejects them); remember what was tried.
const MODEL_HEALTH_PATH = path.join(DATA_DIR, 'codex-models.json');
export const MODEL_UNSUPPORTED_RE = /model[^\n]{0,80}not supported|not supported[^\n]{0,60}model|unknown model|model_not_found|model[^\n]{0,40}does not exist/i;

function readModelHealth() {
  return readJson(MODEL_HEALTH_PATH, { good: '', bad: {} });
}

export function recordModelResult(model, ok, message = '') {
  if (!model) return;
  const health = readModelHealth();
  health.bad = health.bad || {};
  if (ok) {
    health.good = model;
    delete health.bad[model];
  } else {
    health.bad[model] = { at: new Date().toISOString(), message: String(message).slice(0, 300) };
    if (health.good === model) health.good = '';
  }
  try {
    ensureDirs();
    writeJsonAtomic(MODEL_HEALTH_PATH, health);
  } catch {
    // best effort
  }
}

export function unavailableModels() {
  return Object.keys(readModelHealth().bad || {});
}

export function defaultCodexModel() {
  const health = readModelHealth();
  const visible = listCodexModels().filter((m) => m.visible);
  if (health.good && (!visible.length || visible.some((m) => m.id === health.good))) return health.good;
  const bad = new Set(Object.keys(health.bad || {}));
  return visible.find((m) => !bad.has(m.id))?.id || '';
}

/** When the current model is unavailable, pick the next one by priority that was neither tried nor rejected. */
export function nextFallbackModel(tried = []) {
  const skip = new Set([...tried, ...unavailableModels()]);
  const health = readModelHealth();
  if (health.good && !skip.has(health.good)) return health.good;
  return listCodexModels().filter((m) => m.visible).find((m) => !skip.has(m.id))?.id || '';
}

export function classifyError(text) {
  const s = String(text || '');
  if (/usage.?limit|rate.?limit|\b429\b|too many requests|quota|exceeded your|try again (in|at)|limit (reached|resets)/i.test(s)) return 'limit';
  if (/\b401\b|unauthori[sz]ed|not logged in|please (log ?in|sign in)|refresh.?token|token.{0,20}expired|\b403\b/i.test(s)) return 'auth';
  if (/not supported|invalid_request_error|unknown model|model .{0,40}not found|invalid value/i.test(s)) return 'config';
  if (/stream disconnected|disconnect|connection|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|timed? ?out|\b50[0234]\b|internal server error|overloaded|unavailable|EOF/i.test(s)) return 'transient';
  return 'unknown';
}

function unwrapErrorMessage(message) {
  // codex error events often carry the whole HTTP response body in message
  try {
    const parsed = JSON.parse(message);
    return parsed?.error?.message || parsed?.message || message;
  } catch {
    return message;
  }
}

function condenseItem(phase, item) {
  if (!item || typeof item !== 'object') return null;
  const base = { kind: 'gpt.item', phase, itemType: item.type, id: item.id };
  switch (item.type) {
    case 'agent_message':
      return { ...base, text: item.text || '' };
    case 'reasoning':
      return { ...base, text: truncate(item.text || '', 4000) };
    case 'command_execution':
      return {
        ...base,
        command: item.command || '',
        exitCode: item.exit_code ?? null,
        status: item.status,
        output: phase === 'completed' ? truncate(item.aggregated_output || '', 3000) : '',
      };
    case 'file_change':
      return { ...base, changes: (item.changes || []).map((c) => `${c.kind || ''} ${c.path || ''}`.trim()), status: item.status };
    case 'mcp_tool_call':
      return { ...base, text: `${item.server || ''}.${item.tool || ''}`, status: item.status };
    case 'web_search':
      return { ...base, text: item.query || '' };
    case 'todo_list':
      return { ...base, todos: (item.items || []).map((t) => ({ text: t.text, done: !!t.completed })) };
    case 'error':
      return { ...base, text: item.message || '' };
    default:
      return { ...base, text: oneLine(JSON.stringify(item), 300) };
  }
}

/**
 * Runs one GPT turn (codex exec / codex exec resume).
 * New sessions pick the sandbox with -s, resumed ones with -c sandbox_mode (the resume subcommand has no -s).
 * instructionsFile replaces Codex's built-in base instructions completely (model_instructions_file).
 */
export async function runCodexTurn(opts) {
  const {
    found, threadId, prompt, cwd, model, effort, sandbox = 'read-only', schemaPath,
    outFile, rawFile, onEvent, signal, timeoutMs, instructionsFile, webSearch = false, extraArgs = [],
  } = opts;
  if (!found) throw new Error(t('srv.codex.missing'));
  const args = ['exec'];
  if (threadId) args.push('resume');
  args.push('--json', '--skip-git-repo-check', '--ignore-user-config');
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (instructionsFile) args.push('-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`);
  if (webSearch) args.push('-c', 'web_search="live"');
  args.push(...extraArgs);
  if (threadId) args.push('-c', `sandbox_mode="${sandbox}"`);
  else args.push('-s', sandbox, '-C', cwd);
  if (schemaPath) args.push('--output-schema', schemaPath);
  if (outFile) {
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      // ignore
    }
    args.push('-o', outFile);
  }
  if (threadId) args.push(threadId);
  args.push('-');

  const started = Date.now();
  let newThreadId = threadId || null;
  let lastAgentMessage = '';
  let usage = null;
  const errors = [];

  const res = await runProcess(found.path, args, {
    cwd,
    env: await codexEnv(found),
    input: prompt,
    signal,
    timeoutMs,
    rawFile,
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      switch (ev.type) {
        case 'thread.started':
          newThreadId = ev.thread_id || newThreadId;
          onEvent?.({ kind: 'gpt.thread', threadId: newThreadId });
          break;
        case 'item.started':
        case 'item.completed': {
          const phase = ev.type === 'item.started' ? 'started' : 'completed';
          const item = ev.item;
          if (phase === 'completed' && item?.type === 'agent_message') lastAgentMessage = item.text || lastAgentMessage;
          if (phase === 'completed' && item?.type === 'error') {
            // notices such as missing model metadata are not failures
            if (!/metadata/i.test(item.message || '')) errors.push(item.message || '');
          }
          if (phase === 'started' && item?.type !== 'command_execution') break;
          const condensed = condenseItem(phase, item);
          if (condensed) onEvent?.(condensed);
          break;
        }
        case 'turn.completed':
          usage = ev.usage || null;
          break;
        case 'turn.failed':
          errors.push(unwrapErrorMessage(ev.error?.message || 'turn failed'));
          break;
        case 'error':
          errors.push(unwrapErrorMessage(ev.message || 'error'));
          break;
        default:
          break;
      }
    },
  });

  let text = '';
  if (outFile) {
    try {
      text = fs.readFileSync(outFile, 'utf8');
    } catch {
      // fall back to streamed message
    }
  }
  if (!text) text = lastAgentMessage;

  const failed = res.aborted || res.timedOut || res.error || (res.code !== 0 && !text) || (!text && errors.length > 0);
  let error = null;
  if (failed) {
    const stderrTail = String(res.stderr || '').split('\n').filter((l) => l.trim() && !/Reading additional input|models_manager/.test(l)).slice(-6).join('\n');
    const message = res.aborted
      ? t('srv.stopped')
      : res.timedOut
        ? t('srv.codex.timeout', { min: Math.round(timeoutMs / 60000) })
        : errors.join('\n') || res.error?.message || stderrTail || t('srv.codex.exit', { code: res.code });
    error = { message: truncate(message, 2000), kind: res.aborted ? 'aborted' : res.timedOut ? 'transient' : classifyError(message) };
  }
  return { ok: !failed, threadId: newThreadId, text, usage, error, durationMs: Date.now() - started };
}

// ---------- Codex quota of the ChatGPT subscription (5-hour and weekly windows) ----------

function normWindow(w, { ms = false } = {}) {
  if (!w || typeof w !== 'object') return null;
  const used = Number(w.usedPercent ?? w.used_percent);
  const mins = Number(w.windowDurationMins ?? w.window_minutes);
  const resets = Number(w.resetsAt ?? w.resets_at);
  if (!Number.isFinite(used)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMins: Number.isFinite(mins) ? mins : null,
    resetsAt: Number.isFinite(resets) && resets > 0 ? (ms ? resets : resets * 1000) : null,
  };
}

/** Normalised for the UI; windows past their reset time count as 0% used (happens with data from older sessions). */
export function normalizeRateLimits(raw, { source, at = Date.now(), resetCredits = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const fix = (w) => (w && w.resetsAt && w.resetsAt <= Date.now() ? { ...w, usedPercent: 0, stale: true } : w);
  const primary = fix(normWindow(raw.primary));
  const secondary = fix(normWindow(raw.secondary));
  if (!primary && !secondary) return null;
  return {
    source,
    at,
    planType: raw.planType || raw.plan_type || '',
    primary,
    secondary,
    reached: raw.rateLimitReachedType || raw.rate_limit_reached_type || null,
    resetCredits,
  };
}

/**
 * Reads the live quota through `codex app-server` (account/rateLimits/read): no model call, no quota used.
 * app-server is the same line-delimited JSON-RPC interface the official Codex extension and desktop app use.
 */
export async function codexRateLimitsLive(found, { timeoutMs = 20_000 } = {}) {
  if (!found) return null;
  const env = await codexEnv(found);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(found.path, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    let buf = '';
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // gone
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (obj) => {
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {
        finish(null);
      }
    };
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          const r = msg.result || {};
          const credits = Array.isArray(r.rateLimitResetCredits?.credits)
            ? r.rateLimitResetCredits.credits.filter((c) => c?.status === 'available').length
            : null;
          finish(msg.error ? null : normalizeRateLimits(r.rateLimits, { source: 'live', resetCredits: credits }));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'wbloop', title: 'Oneiropolos', version: '1' } } });
  });
}

/** Fallback: the last quota reported in recent Codex session logs (rollout-*.jsonl). */
export function codexRateLimitsFromRollouts({ days = 7 } = {}) {
  const root = path.join(CODEX_HOME, 'sessions');
  const files = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const day = new Date(now.getTime() - d * 86400_000);
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
      try {
        files.push({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs });
      } catch {
        // vanished
      }
    }
    if (files.length >= 40) break;
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files.slice(0, 12)) {
    let text = '';
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 512 * 1024);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len);
      fs.closeSync(fd);
      text = b.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) continue;
      try {
        const ev = JSON.parse(line);
        const rl = ev.payload?.rate_limits;
        const at = Date.parse(ev.timestamp) || Date.now();
        const out = normalizeRateLimits(rl, { source: 'rollout', at });
        if (out) return out;
      } catch {
        // partial line at the chunk start
      }
    }
  }
  return null;
}

export function startCodexLogin(found, onLine) {
  return (async () => {
    const env = await codexEnv(found);
    return runProcess(found.path, ['login'], {
      env,
      timeoutMs: 10 * 60_000,
      onLine,
      onStderr: (chunk) => chunk.split('\n').filter(Boolean).forEach((l) => onLine?.(l)),
    });
  })();
}
