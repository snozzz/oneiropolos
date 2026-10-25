#!/usr/bin/env node
// WorkBuddy's PreToolUse / PostToolUse hook for one run (installed through --settings by src/loop.js):
//   node src/hook-gate.js pre|post|readonly --run <id> [--round N] [--member name]
// pre:  the user's beforeToolCall hooks, then the sensitive-command gate (approval by the user, a toolConfirmation
//       hook, or the safety policy). Exit 2 blocks the tool; stderr is what the model sees.
// post: the user's afterToolCall hooks (exit 1 → their output replaces what the model sees).
// readonly: for a lead running on an engine without a local sandbox (WorkBuddy): file-writing tools and shell
//       commands that obviously write are turned away.
import fs from 'node:fs';
import { t } from './i18n.js';
import { runHooks } from './hooks.js';
import { alwaysAllowed, closeApproval, createApproval, logGate, matchSensitive, readDecision } from './safety.js';
import { appendEvent, isValidRunId, readState } from './store.js';
import { notify } from './system.js';
import { oneLine, sleep } from './util.js';

const argv = process.argv.slice(2);
const phase = argv[0];
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : '';
};
const runId = opt('run');
const round = Number(opt('round')) || null;
const member = opt('member') || null;

const WRITE_CMD = /(^|[;&|(`]\s*|\bsudo\s+|\bxargs\s+)(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd|install|patch|unzip)\b|\btar\s+-?[a-z]*x|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bgit\s+(add|commit|push|reset|checkout|switch|merge|rebase|stash|clean|restore|apply|am|cherry-pick|revert|tag|pull|fetch|init|clone|mv|rm|worktree)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall|update|upgrade|publish|link)\b|\bpip3?\s+(install|uninstall)\b|\bbrew\s+(install|uninstall|upgrade)\b|(^|[^0-9&<>])>{1,2}\s*(?!\/dev\/null|&)[^\s]/;

/** A shell command that obviously writes to disk (redirects, file utilities, git/npm mutations). */
function writesFiles(command) {
  return WRITE_CMD.test(String(command || ''));
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}
if (phase === 'readonly') {
  const name = String(input.tool_name || input.toolName || '');
  const command = String((input.tool_input || input.toolInput || {}).command || '');
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) || (['Bash', 'PowerShell'].includes(name) && writesFiles(command))) {
    block('You are the read-only lead: this would change files, so it was not run. Read and check only; the executor makes all changes.');
  }
  process.exit(0);
}
if (!isValidRunId(runId)) process.exit(0);
const state = readState(runId);
if (!state) process.exit(0);
const settings = state.settings || {};
const workdir = state.workdir;
const toolName = String(input.tool_name || input.toolName || '');
const toolInput = input.tool_input || input.toolInput || {};
const hookEnv = { WBLOOP_RUN_ID: runId, WBLOOP_ROUND: String(round || ''), WBLOOP_MEMBER: member || '' };
const hooksOn = settings.hooks?.enabled !== false;
// once a command matched a sensitive rule, any failure below blocks it (fail closed); everything else fails open
let sensitive = false;

function hookEvent(type, r) {
  if (!r.ran) return;
  appendEvent(runId, { kind: 'hook', type, round, member, tool: toolName, ran: r.ran, blocked: r.blocked ? oneLine(r.blocked.message, 300) : null, replaced: r.replaced != null });
}

async function pre() {
  if (hooksOn) {
    const r = await runHooks('beforeToolCall', { toolName, args: toolInput, round, member }, { workdir, toolName, env: hookEnv });
    hookEvent('beforeToolCall', r);
    if (r.blocked) block(r.blocked.message);
    if (r.replaced != null) block(r.replaced || 'Blocked by a beforeToolCall hook.');
  }
  if (!['Bash', 'PowerShell'].includes(toolName)) return;
  const command = String(toolInput.command || '');
  const rule = matchSensitive(command, settings);
  if (!rule) return;
  sensitive = true;
  const desc = rule.builtin ? t(`safety.rule.${rule.id}`) : rule.description || rule.pattern;
  const policy = settings.safety?.policy || 'ask';
  const record = (decision, by, reason = '') => {
    logGate(runId, { round, member, command, decision, by, reason, rule: rule.id });
    appendEvent(runId, { kind: 'approval.result', id: null, decision, by, reason, round, member, command, rule: { id: rule.id, description: desc } });
  };
  if (policy === 'allow' || alwaysAllowed(runId).includes(rule.id)) {
    record('allow', policy === 'allow' ? 'policy' : 'always');
    return;
  }
  if (policy === 'deny') {
    record('deny', 'policy');
    block(`Blocked by the Oneiropolos safety policy (${desc}). This command is not allowed in this task. Do not retry it; use a safer alternative or explain in your report why it is needed.`);
  }
  if (hooksOn) {
    const r = await runHooks('toolConfirmation', { toolName, args: JSON.stringify(toolInput), isSensitive: true, matchedPattern: rule.pattern, matchedReason: desc, round, member }, { workdir, toolName, env: hookEnv });
    hookEvent('toolConfirmation', r);
    const d = r.decision?.result;
    if (d === 'approve' || d === 'approve_always') {
      record('allow', 'hook');
      return;
    }
    if (d === 'reject' || d === 'reject_with_reply') {
      record('deny', 'hook', r.decision.reason);
      block(`Blocked by a confirmation hook${r.decision.reason ? `: ${r.decision.reason}` : ''}. Do not retry it; find another way or explain in your report.`);
    }
  }
  const timeoutMin = Math.max(0.05, Number(settings.safety?.timeoutMin) || 10);
  const req = createApproval(runId, { round, member, tool: toolName, command, rule: { ...rule, description: desc }, timeoutMin });
  if (settings.system?.notify !== false) notify(t('notify.title', { what: t('notify.approval') }), `${desc}: ${oneLine(command, 140)}`);
  const deadline = Date.parse(req.expiresAt);
  while (Date.now() < deadline) {
    const d = readDecision(runId, req.id);
    if (d) {
      closeApproval(runId, req.id, { decision: d.decision, by: d.by || 'user', reason: d.reason });
      if (d.decision === 'allow') return;
      block(`The user denied this command${d.reason ? `: ${d.reason}` : ''}. Do not retry it; follow the user's reason, use a safer alternative, or explain in your report.`);
    }
    const s = readState(runId);
    if (!s || ['stopped', 'failed', 'done'].includes(s.status)) {
      closeApproval(runId, req.id, { decision: 'cancelled', by: 'system' });
      block('The task was stopped before the user answered.');
    }
    await sleep(700);
  }
  closeApproval(runId, req.id, { decision: 'deny', by: 'timeout' });
  block(`Nobody approved this command within ${timeoutMin} minutes (${desc}), so it was not run. Do not retry it; use a safer alternative, or explain in your report why it is needed so the user can run it.`);
}

async function post() {
  if (!hooksOn) return;
  const r = await runHooks('afterToolCall', { toolName, args: toolInput, result: input.tool_response ?? input.toolResponse ?? null, error: input.error ?? null, round, member }, { workdir, toolName, env: hookEnv });
  hookEvent('afterToolCall', r);
  if (r.blocked) block(r.blocked.message);
  if (r.replaced != null) block(r.replaced);
}

try {
  if (phase === 'pre') await pre();
  else if (phase === 'post') await post();
} catch (err) {
  if (sensitive) block(`The safety gate failed (${err?.message || err}); the command was not run.`);
  // otherwise fail open: a broken hook must never wedge WorkBuddy
  process.stderr.write(`hook gate error: ${err?.message || err}\n`);
}
process.exit(0);
