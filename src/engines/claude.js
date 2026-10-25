// Claude through the Claude Code CLI (Claude subscription login). It runs with its own config directory
// (CLAUDE_CONFIG_DIR, ~/.wbloop/claude-home by default), so the user's own ~/.claude hooks, plugins and memory never
// leak into a task and the app has a separate sign-in. Same stream-json protocol as WorkBuddy's core.
// Lead: Bash runs in Claude Code's sandbox with only the scratch directory writable; file-writing tools are removed.
import os from 'node:os';
import path from 'node:path';
import { t } from '../i18n.js';
import { DATA_DIR } from '../paths.js';
import { baseChildEnv, execText, findExecutable, oneLine, runProcess } from '../util.js';
import { leadError, leadEventMapper, leadText, leadUsage, runStreamJson } from './streamjson.js';

export const meta = { id: 'claude', name: 'Claude', vendor: 'Claude', section: 'claude', gate: true, agents: true, schema: true };

// tools that hang or make no sense unattended (questions, plan mode, scheduling, cross-session messaging, worktrees)
const DISALLOWED = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'ListAgents', 'DesignSync', 'EnterWorktree', 'ExitWorktree'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export function homeOf(cfg) {
  const h = String(cfg?.claude?.home || '').trim();
  return h ? path.resolve(h.replace(/^~(?=\/|$)/, os.homedir())) : path.join(DATA_DIR, 'claude-home');
}

export function find(cfg) {
  const configured = String(cfg?.claude?.path || '').trim();
  if (configured) return findExecutable(path.basename(configured), [path.dirname(configured)]);
  return findExecutable('claude', [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin']);
}

export async function env(cfg, bin) {
  const e = await baseChildEnv(bin ? [path.dirname(bin)] : []);
  // an API key or token in the shell would silently replace the subscription login
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete e[k];
  // a home of ~/.claude means "share the normal login": leave CLAUDE_CONFIG_DIR unset so the keychain entry matches
  const home = homeOf(cfg);
  if (home !== path.join(os.homedir(), '.claude')) e.CLAUDE_CONFIG_DIR = home;
  e.DISABLE_AUTOUPDATER = '1';
  return e;
}

export function classify(text) {
  const s = String(text || '');
  if (/not logged in|please run \/login|invalid api key|authentication_error|oauth token (has )?expired|\b401\b|unauthori[sz]ed/i.test(s)) return 'auth';
  if (/credit balance is too low|insufficient/i.test(s)) return 'credits';
  if (/usage limit|rate.?limit|\b429\b|limit reached|resets? (at|in)|too many requests/i.test(s)) return 'limit';
  if (/prompt is too long|context (window|length)|maximum context/i.test(s)) return 'context';
  if (/overloaded|\b529\b|\b50[0234]\b|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out/i.test(s)) return 'transient';
  return 'unknown';
}

export async function status(cfg) {
  const bin = find(cfg);
  if (!bin) return { installed: false, loggedIn: false };
  const e = await env(cfg, bin);
  const [ver, st] = await Promise.all([
    execText(bin, ['--version'], { env: e, timeoutMs: 15_000 }),
    execText(bin, ['auth', 'status', '--json'], { env: e, timeoutMs: 20_000 }),
  ]);
  let j = {};
  try {
    j = JSON.parse(st.stdout || '{}');
  } catch {
    j = {};
  }
  const plan = j.subscriptionType ? `Claude ${String(j.subscriptionType).replace(/^./, (c) => c.toUpperCase())}` : '';
  return { installed: true, loggedIn: Boolean(j.loggedIn), account: j.email || '', plan, version: (ver.stdout || '').trim().split(' ')[0] };
}

let loginChild = null;

/**
 * `claude auth login`: opens the browser and finishes on its own through a localhost callback. When the browser
 * cannot reach that callback, the page shows a code instead; sendCode() pipes it to the waiting CLI.
 */
export async function login(cfg, { onUpdate, signal } = {}) {
  const bin = find(cfg);
  if (!bin) throw new Error(t('srv.claude.missing'));
  onUpdate?.({ state: 'starting' });
  let authUrl = '';
  const seen = (chunk) => {
    const m = String(chunk).replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '').match(/https:\/\/\S+/);
    if (m && !authUrl) {
      authUrl = m[0];
      onUpdate?.({ state: 'waiting', authUrl, canPaste: true });
    }
  };
  const r = await runProcess(bin, ['auth', 'login', '--claudeai'], {
    env: await env(cfg, bin),
    signal,
    timeoutMs: 10 * 60_000,
    keepStdin: true,
    onSpawn: (child) => {
      loginChild = child;
    },
    onLine: seen,
    onStderr: seen,
  });
  loginChild = null;
  if (r.aborted) return { ok: false, error: t('srv.cancelled') };
  const st = await status(cfg);
  return st.loggedIn ? { ok: true, account: st.account } : { ok: false, error: oneLine(r.stderr, 300) || t('srv.claude.loginFailed') };
}

export function sendCode(code) {
  if (!loginChild) return false;
  try {
    loginChild.stdin.write(`${String(code).trim()}\n`);
    return true;
  } catch {
    return false;
  }
}

export async function logout(cfg) {
  const bin = find(cfg);
  if (!bin) throw new Error(t('srv.claude.missing'));
  await runProcess(bin, ['auth', 'logout'], { env: await env(cfg, bin), timeoutMs: 30_000 });
  return { ok: true };
}

// aliases follow the newest model of each line; "" lets the account pick
export function models() {
  return [
    { id: '', name: 'Default', efforts: EFFORTS, defaultEffort: '' },
    { id: 'fable', name: 'Fable', efforts: EFFORTS, defaultEffort: 'high' },
    { id: 'opus', name: 'Opus', efforts: EFFORTS, defaultEffort: 'high' },
    { id: 'sonnet', name: 'Sonnet', efforts: EFFORTS, defaultEffort: 'high' },
    { id: 'haiku', name: 'Haiku', efforts: EFFORTS, defaultEffort: 'medium' },
  ];
}

export function defaultModel() {
  return '';
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function baseArgs(o) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'];
  if (o.model) args.push('--model', o.model);
  if (o.effort && EFFORTS.includes(o.effort)) args.push('--effort', o.effort);
  if (o.resume) args.push('--resume', o.sessionId);
  else args.push('--session-id', o.sessionId);
  if (o.systemFile) args.push('--system-prompt-file', o.systemFile);
  if (o.mcpConfig) args.push('--mcp-config', o.mcpConfig);
  return args;
}

/** One lead turn: read-only tools, Bash sandboxed to the scratch directory, the verdict through --json-schema. */
export async function lead(o) {
  const bin = o.found;
  const args = [
    ...baseArgs({ ...o, sessionId: o.threadId || o.newId, resume: Boolean(o.threadId) }),
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', [...WRITE_TOOLS, ...DISALLOWED].join(','),
    '--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } }),
  ];
  if (o.schema) args.push('--json-schema', o.schema);
  const r = await runStreamJson({
    command: bin, args, env: await env(o.cfg, bin), cwd: o.cwd, prompt: o.prompt, sessionId: o.threadId || o.newId,
    onEvent: leadEventMapper(o.onEvent), signal: o.signal, timeoutMs: o.timeoutMs, rawFile: o.rawFile, classify, crashKey: 'srv.engine.crashed',
  });
  if (r.sessionId) o.onEvent?.({ kind: 'gpt.thread', threadId: r.sessionId });
  return { ok: r.ok && Boolean(leadText(r)), threadId: r.sessionId, text: leadText(r), usage: leadUsage(r.usage), error: leadError(r.ok && !leadText(r) ? { ...r, ok: false, errors: [t('srv.engine.noReply')] } : r), durationMs: r.durationMs };
}

/** One executor call, like WorkBuddy's: hooks for the safety gate, sub-agents, extra folders, live partial output. */
export async function exec(o) {
  const bin = o.found;
  const args = [
    ...baseArgs(o),
    '--permission-mode', 'bypassPermissions',
    '--max-turns', String(o.maxTurns || 80),
    '--disallowedTools', DISALLOWED.join(','),
  ];
  if (o.onLive) args.push('--include-partial-messages');
  if (o.hooks && Object.keys(o.hooks).length) args.push('--settings', JSON.stringify({ hooks: o.hooks }));
  if (o.agents) args.push('--agents', o.agents);
  for (const d of o.addDirs || []) if (d) args.push('--add-dir', d);
  return runStreamJson({
    command: bin, args, env: await env(o.cfg, bin), cwd: o.cwd, prompt: o.prompt, sessionId: o.sessionId,
    onEvent: o.onEvent, onLive: o.onLive, signal: o.signal, timeoutMs: o.timeoutMs, idleTimeoutMs: o.idleTimeoutMs, rawFile: o.rawFile, classify, crashKey: 'srv.engine.crashed',
  });
}
