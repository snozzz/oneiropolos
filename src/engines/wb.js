// WorkBuddy through its bundled CodeBuddy core (src/workbuddy.js). Executor: the original WorkBuddy round.
// Lead: the same core with read-only tools, the verdict through --json-schema, and a PreToolUse gate that turns
// away shell commands that would write (the core has no local sandbox of its own).
import path from 'node:path';
import { t } from '../i18n.js';
import { ROOT } from '../paths.js';
import { WB_EFFORTS, findWorkBuddy, listWbModels, runWorkBuddyTurn, wbAuthState, wbLogin, wbLogout } from '../workbuddy.js';
import { leadError, leadEventMapper, leadText, leadUsage } from './streamjson.js';

export const meta = { id: 'workbuddy', name: 'WorkBuddy', vendor: 'WorkBuddy', section: 'workbuddy', gate: true, agents: true, schema: true };

const LEAD_TOOLS = 'Read,Glob,Grep,Bash,WebFetch,WebSearch,ToolSearch,StructuredOutput';
const sh = (s) => process.platform === 'win32' ? `"${String(s).replaceAll('\\', '/').replaceAll('"', '')}"` : `'${String(s).replace(/'/g, "'\\''")}'`;

export function find(cfg) {
  return findWorkBuddy(cfg?.workbuddy?.appPath);
}

export async function status(cfg) {
  const found = find(cfg);
  const a = wbAuthState();
  return { installed: Boolean(found), loggedIn: Boolean(found) && a.loggedIn, account: a.nickname || '', version: found?.appVersion || '' };
}

export async function login(cfg, { onUpdate, signal, method = 'internal' } = {}) {
  const found = find(cfg);
  if (!found) throw new Error(t('srv.wb.missing'));
  const r = await wbLogin(found, { method, onUpdate, signal });
  return r.ok ? { ok: true, account: r.account?.userName || r.account?.nickname || '' } : { ok: false, error: r.error };
}

export async function logout(cfg) {
  const found = find(cfg);
  if (!found) throw new Error(t('srv.wb.missing'));
  await wbLogout(found);
  return { ok: true };
}

export function models(cfg) {
  const found = find(cfg);
  return (found ? listWbModels(found).models : []).map((m) => ({ ...m, efforts: m.efforts || [] }));
}

export function defaultModel() {
  return 'auto';
}

export const EFFORTS = [...WB_EFFORTS, 'off'];

export function exec(o) {
  return runWorkBuddyTurn({ ...o, found: o.found, systemPromptFile: o.systemFile });
}

export async function lead(o) {
  const gate = `${sh(process.execPath)} ${sh(path.join(ROOT, 'src', 'hook-gate.js'))} readonly --run ${o.runId || '-'}`;
  const sessionId = o.threadId || o.newId;
  const r = await runWorkBuddyTurn({
    found: o.found,
    sessionId,
    resume: Boolean(o.threadId),
    prompt: o.prompt,
    cwd: o.cwd,
    model: o.model,
    effort: o.effort,
    contextWindow: Number(o.cfg?.workbuddy?.contextWindow) || 0,
    maxTurns: 120,
    tools: process.platform === 'win32' ? LEAD_TOOLS.replace(',Bash', '') : LEAD_TOOLS,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: gate, timeout: 30 }] }] },
    systemPromptFile: o.systemFile,
    mcpConfig: o.mcpConfig,
    jsonSchema: o.schema,
    onEvent: leadEventMapper(o.onEvent),
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    rawFile: o.rawFile,
  });
  // A fresh WorkBuddy call is given a client generated id. The core can emit
  // init before a quota/auth failure, even though no server conversation was
  // created. Keep an established session for success, an explicit interrupt,
  // or max-turns; an existing thread remains valid while its resume is being
  // interrupted and can be rebuilt if the service reports it lost.
  const established = r.sawInit && (r.ok || r.errorKind === 'aborted' || r.maxTurnsHit);
  const threadId = o.threadId || (established ? r.sessionId : null);
  if (threadId) o.onEvent?.({ kind: 'gpt.thread', threadId });
  const text = leadText(r);
  return { ok: r.ok && Boolean(text), threadId, text, usage: leadUsage(r.usage), contextTokens: r.contextTokens || 0, error: leadError(r.ok && !text ? { ...r, ok: false, errors: [t('srv.engine.noReply')] } : r), durationMs: r.durationMs };
}
