// ChatGPT through the Codex CLI (ChatGPT subscription login). Lead: `codex exec` read-only with an output schema.
// Executor: `codex exec` in a workspace-write sandbox — writes stay inside the working folder (plus extra folders),
// network allowed; Codex has no tool hooks, so the sensitive-command gate does not apply to it.
import { classifyError, codexEnv, codexInfo, codexRateLimitsLive, defaultCodexModel, findCodex, listCodexModels, runCodexTurn } from '../codex.js';
import { t } from '../i18n.js';
import { oneLine, runProcess, truncate } from '../util.js';
import { relPath } from './streamjson.js';

export const meta = { id: 'chatgpt', name: 'GPT', vendor: 'ChatGPT', section: 'codex', gate: false, agents: false, schema: true };

const homeOf = (cfg) => cfg?.codex?.home || '';

export function find(cfg) {
  return findCodex(cfg?.codex?.path);
}

export async function status(cfg) {
  const found = find(cfg);
  if (!found) return { installed: false, loggedIn: false };
  const i = await codexInfo(found, homeOf(cfg)).catch((err) => ({ loggedIn: false, error: err.message }));
  return { installed: true, loggedIn: Boolean(i.loggedIn), account: i.chatgpt ? 'ChatGPT' : i.loggedIn ? 'API key' : '', version: i.version || '', chatgpt: Boolean(i.chatgpt) };
}

/** `codex login`: opens the ChatGPT sign-in page and waits for its callback on localhost; auth lands in the codex home. */
export async function login(cfg, { onUpdate, signal } = {}) {
  const found = find(cfg);
  if (!found) throw new Error(t('srv.codex.missing'));
  const env = await codexEnv(found, homeOf(cfg));
  let authUrl = '';
  const seen = (line) => {
    const m = String(line).match(/https:\/\/\S+/);
    if (m && !authUrl) {
      authUrl = m[0];
      onUpdate?.({ state: 'waiting', authUrl });
    }
  };
  onUpdate?.({ state: 'starting' });
  const r = await runProcess(found.path, ['login'], { env, signal, timeoutMs: 10 * 60_000, onLine: seen, onStderr: (c) => String(c).split('\n').forEach(seen) });
  if (r.aborted) return { ok: false, error: t('srv.cancelled') };
  const st = await status(cfg);
  return st.loggedIn ? { ok: true, account: st.account } : { ok: false, error: oneLine(r.stderr, 300) || t('srv.codex.exit', { code: r.code }) };
}

export async function logout(cfg) {
  const found = find(cfg);
  if (!found) throw new Error(t('srv.codex.missing'));
  await runProcess(found.path, ['logout'], { env: await codexEnv(found, homeOf(cfg)), timeoutMs: 30_000 });
  return { ok: true };
}

export function models(cfg) {
  return listCodexModels(homeOf(cfg)).filter((m) => m.visible).map((m) => ({ id: m.id, name: m.name, efforts: m.efforts, defaultEffort: m.defaultEffort, contextWindow: m.contextWindow, description: m.description || '' }));
}

export function defaultModel(cfg) {
  return defaultCodexModel(homeOf(cfg));
}

export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export async function quota(cfg) {
  return codexRateLimitsLive(find(cfg), { home: homeOf(cfg) }).catch(() => null);
}

/** One lead turn: exactly the original GPT turn. */
export function lead(o) {
  const c = o.cfg.codex || {};
  const extraArgs = [...(o.mcpArgs || [])];
  const ctxWindow = Math.round(Number(c.contextWindow) || 0);
  if (ctxWindow > 0) extraArgs.unshift('-c', `model_context_window=${ctxWindow}`);
  return runCodexTurn({
    found: o.found,
    threadId: o.threadId,
    prompt: o.prompt,
    cwd: o.cwd,
    model: o.model,
    effort: o.effort,
    sandbox: o.sandbox,
    schemaPath: o.schemaPath,
    instructionsFile: o.systemFile,
    codexHome: homeOf(o.cfg),
    webSearch: Boolean(o.webSearch),
    extraArgs,
    outFile: o.outFile,
    rawFile: o.rawFile,
    onEvent: o.onEvent,
    signal: o.signal,
    timeoutMs: o.timeoutMs,
  });
}

const ERROR_KIND = { limit: 'limit', auth: 'auth', transient: 'transient', aborted: 'aborted', config: 'unknown', unknown: 'unknown' };

/** One executor call: codex items become the executor events the timeline draws (Bash, Edit, text, thinking). */
export async function exec(o) {
  const toolCalls = [];
  const texts = [];
  const open = new Map();
  let threadId = o.resume ? o.sessionId : null;
  const emit = (e) => o.onEvent?.(e);
  const addTool = (id, name, summary, input) => {
    toolCalls.push({ id, name, summary, ok: null });
    emit({ kind: 'wb.tool', id, name, summary, input });
  };
  const endTool = (id, isError, text = '') => {
    const call = toolCalls.find((x) => x.id === id);
    if (call) call.ok = !isError;
    emit({ kind: 'wb.tool_result', id, isError, text: truncate(text, 8000) });
  };
  const dirs = (o.addDirs || []).filter(Boolean);
  const extraArgs = ['-c', 'sandbox_workspace_write.network_access=true', ...(o.mcpArgs || [])];
  if (dirs.length) extraArgs.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(dirs)}`);
  const r = await runCodexTurn({
    found: o.found,
    threadId,
    prompt: o.prompt,
    cwd: o.cwd,
    model: o.model,
    effort: o.effort,
    sandbox: 'workspace-write',
    instructionsFile: o.systemFile,
    codexHome: homeOf(o.cfg),
    extraArgs,
    rawFile: o.rawFile,
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    onEvent: (e) => {
      if (e.kind === 'gpt.thread') {
        if (!threadId) emit({ kind: 'wb.init', sessionId: e.threadId, model: o.model });
        threadId = e.threadId;
        return;
      }
      if (e.kind !== 'gpt.item') return;
      const id = e.id || `${e.itemType}-${toolCalls.length}`;
      if (e.itemType === 'command_execution') {
        if (e.phase === 'started') {
          open.set(id, true);
          addTool(id, 'Bash', oneLine(e.command, 400), { command: truncate(e.command, 6000) });
        } else {
          if (!open.has(id)) addTool(id, 'Bash', oneLine(e.command, 400), { command: truncate(e.command, 6000) });
          open.delete(id);
          endTool(id, e.exitCode != null && e.exitCode !== 0, e.output || '');
        }
      } else if (e.itemType === 'file_change') {
        (e.changes || []).forEach((c, i) => {
          const [kind, ...rest] = String(c).split(' ');
          const file = relPath(rest.join(' '), o.cwd) || c;
          addTool(`${id}-${i}`, kind === 'add' ? 'Write' : 'Edit', file, { file });
          endTool(`${id}-${i}`, e.status === 'failed');
        });
      } else if (e.itemType === 'reasoning' && e.text) {
        emit({ kind: 'wb.thinking', text: e.text });
      } else if (e.itemType === 'agent_message' && e.text) {
        texts.push(e.text);
        emit({ kind: 'wb.text', text: truncate(e.text, 20_000) });
      } else if (e.itemType === 'web_search') {
        addTool(id, 'WebSearch', e.text || '', { query: e.text || '' });
        endTool(id, false);
      } else if (e.itemType === 'mcp_tool_call') {
        addTool(id, 'MCP', e.text || '', { json: e.text || '' });
        endTool(id, e.status === 'failed');
      }
    },
  });
  const u = r.usage;
  const errorText = r.error?.message || '';
  return {
    ok: r.ok,
    sawInit: Boolean(threadId),
    sessionId: r.threadId || threadId,
    model: o.model || '',
    resultText: r.text || texts[texts.length - 1] || '',
    lastTexts: texts.slice(-3),
    subtype: r.ok ? 'success' : 'error',
    errors: r.ok ? [] : [errorText],
    errorKind: r.ok ? null : ERROR_KIND[r.error?.kind] || classifyError(errorText),
    maxTurnsHit: false,
    numTurns: null,
    usage: u ? { input_tokens: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), cache_read_input_tokens: u.cached_input_tokens || 0, output_tokens: u.output_tokens || 0 } : null,
    contextTokens: r.contextTokens || 0,
    permissionDenials: [],
    toolCalls,
    durationMs: r.durationMs,
  };
}

