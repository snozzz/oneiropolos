// DeepSeek through DeepSeek Harness, DeepSeek's own agent app. Its CLI is started straight from the signed app.asar
// with ELECTRON_RUN_AS_NODE (the same way the app's own launcher does), never through runtime/cli/bin/dsh, so local
// edits to that launcher or to an unpacked copy have no effect here. It runs with its own DSH_HOME
// (~/.wbloop/dsh-home): its own sign-in, profiles and sessions, separate from the desktop app's ~/.dsh.
//
// Sign-in: the account sign-in lives in DSH's web host, so `login` starts `dsh --profile web` in that home for a moment,
// asks it (account/startSignIn) for DeepSeek's authorization page, opens it, and waits until the grant is stored.
// An API key from platform.deepseek.com works too; it is kept in ~/.wbloop/keys.json (0600).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.js';
import { DATA_DIR } from '../paths.js';
import { baseChildEnv, oneLine, readJson, runProcess, sleep, truncate, writeJsonAtomic } from '../util.js';
import { openUrl } from '../workbuddy.js';
import { clip, leadEventMapper, summarizeToolInput, toolInputDetail } from './streamjson.js';

export const meta = { id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek', section: 'deepseek', gate: false, agents: false, schema: false };

const ENTRY_REL = 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
export const EFFORTS = ['off', 'low', 'high', 'max'];

export function homeOf(cfg) {
  const h = String(cfg?.deepseek?.home || '').trim();
  return h ? path.resolve(h.replace(/^~(?=\/|$)/, os.homedir())) : path.join(DATA_DIR, 'dsh-home');
}

export function find(cfg) {
  const candidates = [cfg?.deepseek?.appPath, '/Applications/DeepSeek Harness.app', path.join(os.homedir(), 'Applications/DeepSeek Harness.app')].filter(Boolean);
  for (const app of candidates) {
    const exe = path.join(app, 'Contents/MacOS/DeepSeek Harness');
    const asar = path.join(app, 'Contents/Resources/app.asar');
    if (fs.existsSync(exe) && fs.existsSync(asar)) {
      let version = '';
      try {
        version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8'))?.[1] || '';
      } catch {
        // unknown
      }
      return { app, exe, entry: path.join(app, ENTRY_REL), version };
    }
  }
  return null;
}

export function apiKey() {
  return String(readJson(KEYS_FILE, {})?.deepseek || '').trim();
}

export function setApiKey(key) {
  const all = readJson(KEYS_FILE, {}) || {};
  const v = String(key || '').trim();
  if (v) all.deepseek = v;
  else delete all.deepseek;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJsonAtomic(KEYS_FILE, all);
  fs.chmodSync(KEYS_FILE, 0o600);
}

/** The account grant lives in the harness home's credential store; its presence is all we need to know. */
function accountSignedIn(cfg) {
  try {
    return /^\s{2,}deepseek-account-platform\/default:/m.test(fs.readFileSync(path.join(homeOf(cfg), '.credentials.yaml'), 'utf8'));
  } catch {
    return false;
  }
}

async function env(cfg, found, extra = {}) {
  const e = await baseChildEnv();
  for (const k of Object.keys(e)) if (/^(ELECTRON_|DSH_)/.test(k)) delete e[k];
  // DSH only speaks HTTP proxies; a SOCKS all_proxy just prints a warning per run
  for (const k of ['ALL_PROXY', 'all_proxy']) if (/^socks/i.test(e[k] || '')) delete e[k];
  Object.assign(e, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: homeOf(cfg), ...extra });
  const key = apiKey();
  if (key) e.DEEPSEEK_API_KEY = key;
  else delete e.DEEPSEEK_API_KEY;
  fs.mkdirSync(homeOf(cfg), { recursive: true });
  return e;
}

export async function status(cfg) {
  const found = find(cfg);
  if (!found) return { installed: false, loggedIn: false };
  const account = accountSignedIn(cfg);
  const key = Boolean(apiKey());
  return { installed: true, loggedIn: account || key, account: account ? 'DeepSeek' : key ? 'API key' : '', via: account ? 'account' : key ? 'apikey' : '', version: found.version };
}

// ---------- the web host, briefly, for account sign-in / sign-out ----------

async function withWebHost(cfg, fn, { signal } = {}) {
  const found = find(cfg);
  if (!found) throw new Error(t('srv.deepseek.missing'));
  const child = spawn(found.exe, [found.entry, '--profile', 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'], {
    env: await env(cfg, found), cwd: homeOf(cfg), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err = (err + d).slice(-8000);
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // gone
    }
  };
  try {
    const deadline = Date.now() + 60_000;
    let url = null;
    while (!url) {
      if (signal?.aborted) throw new Error(t('srv.cancelled'));
      if (child.exitCode != null) throw new Error(t('srv.deepseek.hostFailed', { err: oneLine(err, 300) }));
      if (Date.now() > deadline) throw new Error(t('srv.deepseek.hostTimeout'));
      const m = /dsh web: (http:\/\/\S+)/.exec(out);
      if (m) url = new URL(m[1]);
      else await sleep(250);
    }
    const origin = url.origin;
    const r = await fetch(`${origin}/connect?token=${encodeURIComponent(url.searchParams.get('token') || '')}&interactions=none`, { redirect: 'manual' });
    const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error(t('srv.deepseek.hostFailed', { err: `connect ${r.status}` }));
    const call = async (method, args = {}) => {
      const res = await fetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.result) throw new Error(`${method}: HTTP ${res.status}`);
      if (!j.result.ok) throw new Error(j.result.error?.message || j.result.error?.code || method);
      return j.result.value;
    };
    return await fn({ call, origin, client: { version: found.version || '0', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 } });
  } finally {
    stop();
  }
}

export async function login(cfg, { onUpdate, signal } = {}) {
  onUpdate?.({ state: 'starting' });
  try {
    return await withWebHost(cfg, async ({ call, origin, client }) => {
      let s = await call('account/getState');
      if (s.status === 'credential-stored') return { ok: true, account: 'DeepSeek' };
      s = await call('account/startSignIn', { client, callbackOrigin: origin, loginSource: 'web' });
      const attemptId = s.attempt?.id;
      let opened = false;
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          await call('account/cancelSignIn', { attemptId }).catch(() => {});
          return { ok: false, error: t('srv.cancelled') };
        }
        if (s.status === 'credential-stored' || s.attempt?.phase === 'succeeded') return { ok: true, account: 'DeepSeek' };
        if (['failed', 'expired', 'cancelled'].includes(s.attempt?.phase)) return { ok: false, error: t('srv.deepseek.signInFailed', { why: s.attempt.errorCode || s.attempt.phase }) };
        if (s.attempt?.authorizeUrl && !opened) {
          opened = true;
          openUrl(s.attempt.authorizeUrl);
          onUpdate?.({ state: 'waiting', authUrl: s.attempt.authorizeUrl });
        }
        await sleep(1500);
        s = await call('account/getState');
      }
      await call('account/cancelSignIn', { attemptId }).catch(() => {});
      return { ok: false, error: t('srv.wb.loginTimeout') };
    }, { signal });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function logout(cfg) {
  if (accountSignedIn(cfg)) await withWebHost(cfg, ({ call, client }) => call('account/signOut', { client }));
  return { ok: true };
}

export function models() {
  return [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: EFFORTS, defaultEffort: 'high', contextWindow: 1_000_000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', efforts: EFFORTS, defaultEffort: 'high', contextWindow: 1_000_000 },
  ];
}

export function defaultModel() {
  return 'deepseek-flash';
}

// ---------- runs: `dsh --profile headless --json` with a per-call patch ----------

const TOOL_NAMES = { bash: 'Bash', read: 'Read', read_image: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', grep: 'Grep', web_search: 'WebSearch', web_fetch: 'WebFetch', todo_write: 'TodoWrite', subagent: 'Agent', subagent_fork: 'Agent', str_replace_editor: 'Edit' };

function toolName(name) {
  return TOOL_NAMES[name] || name;
}

function toolInput(name, input) {
  const i = input && typeof input === 'object' ? { ...input } : {};
  if (!i.file_path && i.path) i.file_path = i.path;
  if (name === 'WebSearch' && !i.query && Array.isArray(i.queries)) i.query = i.queries.join(' · ');
  return i;
}

function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (...keys) => keys.reduce((a, k) => a || Number(u[k]) || 0, 0);
  const cached = n('cacheReadTokens', 'cache_read_input_tokens', 'cachedInputTokens', 'cacheRead', 'prompt_cache_hit_tokens');
  const input = n('inputTokens', 'input_tokens', 'input', 'promptTokens', 'prompt_tokens');
  return { input, cached, output: n('outputTokens', 'output_tokens', 'output', 'completionTokens', 'completion_tokens') };
}

export function classify(text) {
  const s = String(text || '');
  if (/ACCOUNT_SIGN_IN_REQUIRED|ACCOUNT_TOKEN_INVALID|MISSING_CREDENTIAL|INVALID_CREDENTIAL|\b401\b|unauthori[sz]ed|sign.?in required/i.test(s)) return 'auth';
  if (/insufficient.?balance|\b402\b|余额不足|top.?up/i.test(s)) return 'credits';
  if (/\b429\b|rate.?limit|too many requests|server busy|服务繁忙/i.test(s)) return 'limit';
  if (/context.{0,20}(length|window|exceed)|too long/i.test(s)) return 'context';
  if (/\b50[0234]\b|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|timed? ?out|overloaded/i.test(s)) return 'transient';
  return 'unknown';
}

/** {{…}} in a persona template is a variable for DSH; literal braces in our prompt must not be read as one. */
const literal = (text) => String(text).replace(/\{\{/g, '{​{').replace(/\}\}/g, '}​}');

function writePatch(o, { readOnly }) {
  const useAccount = accountSignedIn(o.cfg) || !apiKey();
  const rows = [];
  // the shipped headless profile ignores stored sign-ins; turn the account route back on (DSH documents these rows)
  if (useAccount) rows.push({ id: 'credentials', disabled: false }, { id: 'authorization', disabled: false }, { id: 'deepseek-account', disabled: false });
  rows.push({ id: 'agent-default-model', config: { provider: useAccount ? 'deepseek-account' : 'deepseek-official', model: o.model || defaultModel(), ...(o.effort && EFFORTS.includes(o.effort) ? { reasoningEffort: o.effort } : {}) } });
  // unattended: nothing can be approved by a person, so the sandbox is the boundary (read-only for the lead)
  rows.push({ id: 'approval', config: { policy: 'never' } });
  rows.push({ id: 'sandbox-policy', config: { mode: readOnly ? 'read-only' : 'workspace-write', workspaceRoot: o.cwd } });
  if (o.systemText) rows.push({ id: 'system-prompt', config: { personaSuffix: literal(o.systemText) } });
  const file = path.join(path.dirname(o.rawFile || os.tmpdir()), `dsh-patch-${crypto.randomBytes(4).toString('hex')}.yml`);
  // JSON is YAML
  fs.writeFileSync(file, JSON.stringify(rows, null, 1));
  return file;
}

async function run(o, { readOnly, onEvent }) {
  const found = o.found;
  const started = Date.now();
  const patch = writePatch(o, { readOnly });
  const args = [found.entry, '--profile', 'headless', '--patch', patch, '--json'];
  if (o.resume && o.sessionId) args.push('--session-id', o.sessionId);
  args.push('-');
  const toolCalls = [];
  const index = new Map();
  const texts = [];
  const errors = [];
  let sessionId = o.resume ? o.sessionId : null;
  let finalText = null;
  let reason = null;
  const total = { input: 0, cached: 0, output: 0 };
  let hasUsage = false;
  const res = await runProcess(found.exe, args, {
    cwd: o.cwd,
    env: await env(o.cfg, found, { DSH_PERMISSION_MODE: readOnly ? 'read-only' : 'workspace-write' }),
    input: o.prompt,
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    rawFile: o.rawFile,
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'session') {
        sessionId = ev.sessionId || sessionId;
        onEvent({ kind: 'wb.init', sessionId, model: o.model || defaultModel() });
      } else if (ev.type === 'thinking' && ev.text) {
        onEvent({ kind: 'wb.thinking', text: truncate(ev.text, 8000) });
      } else if (ev.type === 'text' && ev.text) {
        texts.push(ev.text);
        onEvent({ kind: 'wb.text', text: truncate(ev.text, 20_000) });
      } else if (ev.type === 'tool_call') {
        const name = toolName(ev.tool);
        const input = toolInput(name, ev.input);
        const call = { id: ev.callId, name, summary: summarizeToolInput(name, input, o.cwd), ok: null };
        index.set(ev.callId, toolCalls.length);
        toolCalls.push(call);
        onEvent({ kind: 'wb.tool', id: ev.callId, name, summary: call.summary, input: toolInputDetail(name, input, o.cwd) });
      } else if (ev.type === 'tool_result') {
        const i = index.get(ev.callId);
        const isError = ev.status === 'error';
        if (i != null) toolCalls[i].ok = !isError;
        onEvent({ kind: 'wb.tool_result', id: ev.callId, isError, text: clip(typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? ''), 8000) });
      } else if (ev.type === 'status') {
        if (ev.phase === 'step_end' && ev.usage) {
          const u = usageOf(ev.usage);
          if (u) {
            hasUsage = true;
            total.input += u.input;
            total.cached += u.cached;
            total.output += u.output;
          }
        } else if (ev.phase === 'turn_end') {
          reason = ev.reason;
        }
      } else if (ev.type === 'final') {
        finalText = typeof ev.text === 'string' ? ev.text : '';
      } else if (ev.type === 'error') {
        errors.push(ev.message || ev.code || 'error');
      }
    },
  });
  try {
    fs.rmSync(patch, { force: true });
  } catch {
    // ignore
  }
  const reasonKind = typeof reason === 'string' ? reason : reason?.kind || '';
  if (reason?.error) errors.push(`${reason.error.code || ''} ${reason.error.message || ''}`.trim());
  const stderrTail = String(res.stderr || '').split('\n').filter((l) => /^dsh: /.test(l) && !/SOCKS proxy|reasoning:/.test(l)).slice(-4).join('\n');
  const ok = res.code === 0 && !res.aborted && !res.timedOut && !res.idleTimedOut && reasonKind !== 'error' && reasonKind !== 'aborted';
  if (!ok) {
    if (res.aborted) errors.push(t('srv.stopped'));
    else if (res.timedOut) errors.push(t('srv.wb.timeout', { min: Math.round(o.timeoutMs / 60000) }));
    else if (res.idleTimedOut) errors.push(t('srv.wb.idle', { min: Math.round(o.idleTimeoutMs / 60000) }));
    if (stderrTail) errors.push(stderrTail);
    if (!errors.length) errors.push(t('srv.engine.crashed', { code: res.code, signal: res.signal || '-' }));
  }
  const errorText = errors.join('\n');
  return {
    ok,
    sawInit: Boolean(sessionId),
    sessionId,
    model: o.model || defaultModel(),
    resultText: finalText ?? texts[texts.length - 1] ?? '',
    lastTexts: texts.slice(-3),
    subtype: ok ? 'success' : 'error',
    errors: ok ? [] : errors,
    errorKind: ok ? null : res.aborted ? 'aborted' : res.timedOut || res.idleTimedOut ? 'transient' : classify(errorText),
    maxTurnsHit: false,
    numTurns: null,
    usage: hasUsage ? { input_tokens: Math.max(0, total.input - total.cached), cache_read_input_tokens: total.cached, output_tokens: total.output } : null,
    permissionDenials: [],
    toolCalls,
    durationMs: Date.now() - started,
  };
}

export async function exec(o) {
  const systemText = o.systemFile ? fs.readFileSync(o.systemFile, 'utf8') : '';
  return run({ ...o, systemText }, { readOnly: false, onEvent: (e) => o.onEvent?.(e) });
}

/** A lead turn: read-only sandbox; no schema support, so the JSON contract (and the schema) ride in the system text. */
export async function lead(o) {
  const base = fs.readFileSync(o.systemFile, 'utf8');
  const systemText = o.schema ? `${base}\n\n## JSON Schema of your reply\n\`\`\`json\n${o.schema}\n\`\`\`\nReply with that one JSON object and nothing else.` : base;
  // the persona is part of the per-call profile, not of the session, so it goes with every call
  const r = await run({ ...o, sessionId: o.threadId, resume: Boolean(o.threadId), systemText }, { readOnly: true, onEvent: leadEventMapper(o.onEvent) });
  if (r.sessionId) o.onEvent?.({ kind: 'gpt.thread', threadId: r.sessionId });
  const u = r.usage;
  const text = r.resultText || '';
  return {
    ok: r.ok && Boolean(text),
    threadId: r.sessionId,
    text,
    usage: u ? { input_tokens: u.input_tokens + u.cache_read_input_tokens, cached_input_tokens: u.cache_read_input_tokens, output_tokens: u.output_tokens } : null,
    error: r.ok && text ? null : { message: oneLine(r.errors.join('\n') || t('srv.engine.noReply'), 2000), kind: r.errorKind === 'credits' ? 'limit' : r.errorKind === 'context' ? 'transient' : r.errorKind || 'unknown' },
    durationMs: r.durationMs,
  };
}
