// User hooks, compatible with snow-cli's hook files (docs/usage/07): one JSON file per hook type in
// ~/.wbloop/hooks/, <project>/.snow/hooks/ and <project>/.wbloop/hooks/. Each file looks like
//   { "<hookType>": [ { "description", "matcher"?, "hooks": [ { "type": "command"|"prompt"|"context", "command"?,
//     "prompt"?, "content"?, "timeout"? (ms), "enabled" } ] } ] }
// Command hooks get a JSON context on stdin. Exit codes: 0 = continue (stdout JSON may carry additionalContext/prompt/
// decision), 1 = warning / replace content with stderr (or stdout), 2+ = block / stop.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { SHELL, shellArgs, baseChildEnv, runProcess, truncate } from './util.js';

export const HOOK_TYPES = ['onSessionStart', 'onUserMessage', 'beforeToolCall', 'toolConfirmation', 'afterToolCall', 'beforeSubAgentStart', 'onSubAgentComplete', 'beforeCompress', 'onStop'];
export const TOOL_HOOKS = new Set(['beforeToolCall', 'toolConfirmation', 'afterToolCall']);
export const PROMPT_HOOKS = new Set(['onSubAgentComplete', 'onStop']);
export const CONTEXT_HOOKS = new Set(['onSessionStart', 'onUserMessage', 'beforeSubAgentStart']);

export const GLOBAL_HOOKS_DIR = path.join(DATA_DIR, 'hooks');


/** snow-cli tool names in matchers map to WorkBuddy's. */
const TOOL_ALIASES = {
  'terminal-execute': ['Bash', 'PowerShell'],
  'filesystem-read': ['Read'],
  'filesystem-create': ['Write'],
  'filesystem-edit': ['Edit', 'MultiEdit'],
  'filesystem-replaceedit': ['Edit', 'MultiEdit'],
  'websearch-search': ['WebSearch'],
  'websearch-fetch': ['WebFetch'],
  'askuser-ask_question': ['AskUserQuestion'],
};

export function hookDirs(workdir) {
  const dirs = [{ dir: GLOBAL_HOOKS_DIR, scope: 'global' }];
  if (workdir) dirs.push({ dir: path.join(workdir, '.snow', 'hooks'), scope: 'project' }, { dir: path.join(workdir, '.wbloop', 'hooks'), scope: 'project' });
  return dirs;
}

function readRules(file, type) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data?.[type];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function loadHookRules(type, workdir) {
  const out = [];
  for (const { dir, scope } of hookDirs(workdir)) {
    for (const rule of readRules(path.join(dir, `${type}.json`), type)) {
      if (!rule || !Array.isArray(rule.hooks)) continue;
      const actions = rule.hooks.filter((h) => h && h.enabled !== false && ['command', 'prompt', 'context'].includes(h.type || 'command'));
      if (actions.length) out.push({ ...rule, hooks: actions, scope });
    }
  }
  return out;
}

/** All rules of all types in one directory (for the settings UI). */
export function readHookDir(dir = GLOBAL_HOOKS_DIR) {
  const out = {};
  for (const type of HOOK_TYPES) out[type] = readRules(path.join(dir, `${type}.json`), type);
  return out;
}

export function writeHookType(type, rules, dir = GLOBAL_HOOKS_DIR) {
  if (!HOOK_TYPES.includes(type)) throw new Error(`unknown hook type: ${type}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${type}.json`);
  const clean = (Array.isArray(rules) ? rules : []).map((r) => ({
    description: String(r.description || '').slice(0, 300),
    ...(TOOL_HOOKS.has(type) ? { matcher: String(r.matcher || '').slice(0, 300) } : {}),
    hooks: (r.hooks || []).map((h) => {
      const t = ['command', 'prompt', 'context'].includes(h.type) ? h.type : 'command';
      const base = { type: t, enabled: h.enabled !== false };
      if (t === 'command') Object.assign(base, { command: String(h.command || ''), timeout: Math.max(500, Math.min(600_000, Number(h.timeout) || 10_000)) });
      if (t === 'prompt') Object.assign(base, { prompt: String(h.prompt || ''), timeout: Number(h.timeout) || 30_000 });
      if (t === 'context') base.content = String(h.content || '');
      return base;
    }).filter((h) => h.command || h.prompt || h.content),
  })).filter((r) => r.hooks.length);
  if (!clean.length) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, `${JSON.stringify({ [type]: clean }, null, 2)}\n`);
  return clean;
}

function globToRe(s) {
  return new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

/** matcher: empty or "*" = every tool; comma list of names (wildcards allowed, snow-cli names accepted); /regex/. */
export function matchTool(matcher, toolName) {
  const m = String(matcher || '').trim();
  if (!m || m === '*') return true;
  if (m.startsWith('/') && m.lastIndexOf('/') > 0) {
    try {
      return new RegExp(m.slice(1, m.lastIndexOf('/')), m.slice(m.lastIndexOf('/') + 1) || 'i').test(toolName);
    } catch {
      return false;
    }
  }
  return m.split(',').map((x) => x.trim()).filter(Boolean).some((item) => {
    const names = TOOL_ALIASES[item] || [item];
    if (names.some((n) => n.toLowerCase() === String(toolName).toLowerCase())) return true;
    if (item.includes('*')) {
      const re = globToRe(item);
      if (re.test(toolName)) return true;
      return Object.entries(TOOL_ALIASES).some(([alias, real]) => re.test(alias) && real.includes(toolName));
    }
    return false;
  });
}

/** Does any rule of this type need to run for some tool (used to decide which WorkBuddy hooks to install)? */
export function toolHookMatchers(workdir) {
  const out = {};
  for (const type of ['beforeToolCall', 'afterToolCall', 'toolConfirmation']) {
    const rules = loadHookRules(type, workdir);
    if (rules.length) out[type] = rules.map((r) => r.matcher || '*');
  }
  return out;
}

function parseJson(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Runs the matching hooks of one type. Returns
 *   { ran, blocked: {code, message} | null, replaced: string | null, additionalContext: string, prompt: string | null,
 *     display: string, decision: {result, reason} | null, newPrompt: string | null, results: [...] }
 * Nothing here throws: hooks fail open (a broken hook never stops a task, except an explicit exit ≥ 2).
 */
export async function runHooks(type, context, { workdir, toolName = '', env = {}, rules = null, signal } = {}) {
  const out = { ran: 0, blocked: null, replaced: null, additionalContext: '', prompt: null, display: '', decision: null, newPrompt: null, results: [] };
  if (!HOOK_TYPES.includes(type)) return out;
  const list = (rules || loadHookRules(type, workdir)).filter((r) => !TOOL_HOOKS.has(type) || matchTool(r.matcher, toolName));
  if (!list.length) return out;
  const childEnv = {
    ...(await baseChildEnv()),
    ...env,
    WBLOOP_HOOK_TYPE: type,
    WBLOOP_CWD: workdir || '',
    SNOW_CWD: workdir || '',
    SNOW_PLATFORM: 'oneiropolos',
  };
  if (env.WBLOOP_RUN_ID) childEnv.SNOW_SESSION_ID = env.WBLOOP_RUN_ID;
  const input = JSON.stringify(context);
  const addCtx = [];
  for (const rule of list) {
    for (const h of rule.hooks) {
      const kind = h.type || 'command';
      if (kind === 'context') {
        if (!CONTEXT_HOOKS.has(type)) continue;
        const j = parseJson(h.content);
        if (j?.prompt && type === 'beforeSubAgentStart') out.newPrompt = String(j.prompt);
        else addCtx.push(String(j?.additionalContext ?? h.content));
        if (j?.display) out.display = String(j.display);
        out.ran += 1;
        out.results.push({ description: rule.description, kind, ok: true });
        continue;
      }
      if (kind === 'prompt') {
        if (!PROMPT_HOOKS.has(type)) continue;
        let text = String(h.prompt || '');
        for (const ph of ['$SUBAGENTRESULT$', '$STOPSESSION$', '$TOOLSRESULT$']) text = text.split(ph).join(truncate(input, 4000));
        out.prompt = text;
        out.ran += 1;
        out.results.push({ description: rule.description, kind, ok: true });
        continue;
      }
      if (!h.command) continue;
      let stdout = '';
      const res = await runProcess(SHELL, shellArgs(h.command), {
        cwd: workdir && fs.existsSync(workdir) ? workdir : DATA_DIR,
        env: childEnv,
        input,
        signal,
        timeoutMs: Math.max(500, Number(h.timeout) || 10_000),
        onLine: (line) => {
          if (stdout.length < 200_000) stdout += `${line}\n`;
        },
      });
      out.ran += 1;
      const stderr = String(res.stderr || '').trim();
      const code = res.timedOut ? null : res.code;
      out.results.push({ description: rule.description, kind, code, timedOut: res.timedOut, stdout: truncate(stdout.trim(), 2000), stderr: truncate(stderr, 2000) });
      if (res.timedOut || code == null) continue; // fail open
      const json = code === 0 ? parseJson(stdout) : null;
      if (code === 0) {
        if (json) {
          const extra = json.additionalContext ?? json.hookSpecificOutput?.additionalContext;
          if (extra && CONTEXT_HOOKS.has(type)) addCtx.push(String(extra));
          if (json.prompt && type === 'beforeSubAgentStart') out.newPrompt = String(json.prompt);
          if (json.display) out.display = String(json.display);
          if (json.result || json.decision) out.decision = { result: String(json.result || json.decision).toLowerCase(), reason: String(json.reason || '') };
        } else if (type === 'toolConfirmation') {
          const word = stdout.trim().split(/\s+/)[0]?.toLowerCase();
          if (['approve', 'approve_always', 'reject', 'reject_with_reply'].includes(word)) out.decision = { result: word, reason: stdout.trim().slice(word.length).trim() };
        }
      } else if (code === 1) {
        out.replaced = (stderr || stdout.trim() || '').slice(0, 20_000) || out.replaced || '';
      } else {
        out.blocked = { code, message: (stderr || stdout.trim() || `hook exited with code ${code}`).slice(0, 4000) };
        return { ...out, additionalContext: addCtx.join('\n\n') };
      }
    }
  }
  out.additionalContext = truncate(addCtx.join('\n\n'), 8000);
  return out;
}
