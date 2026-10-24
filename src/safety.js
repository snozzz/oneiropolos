// Sensitive commands (snow-cli docs/usage/06): shell commands that need the user's approval before WorkBuddy may run
// them. The check runs inside WorkBuddy's PreToolUse hook (src/hook-gate.js); an approval request is a small file in
// the run directory that the UI, the CLI or a toolConfirmation hook answers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, runDir } from './store.js';
import { nowIso, readJson, writeJsonAtomic } from './util.js';

export const BUILTIN_RULES = [
  { id: 'rm-recursive', pattern: String.raw`(^|[\s;&|(])rm\s+(-[a-zA-Z]*[rR]|--recursive)` },
  { id: 'git-reset-hard', pattern: String.raw`\bgit\s+reset\b[^\n;&|]*--hard` },
  { id: 'git-clean', pattern: String.raw`\bgit\s+clean\s+-[a-zA-Z]*[fdxX]` },
  { id: 'git-push-force', pattern: String.raw`\bgit\s+push\b[^\n;&|]*(\s-f\b|\s--force)` },
  { id: 'git-push', pattern: String.raw`\bgit\s+push\b` },
  { id: 'git-branch-delete', pattern: String.raw`\bgit\s+branch\s+(-D\b|--delete\s+--force)` },
  { id: 'git-rebase', pattern: String.raw`\bgit\s+rebase\b` },
  { id: 'git-discard', pattern: String.raw`\bgit\s+(checkout\s+(--\s|\.(\s|$)|-f\b)|restore\s+(?!--staged)\S|stash\s+(drop|clear)\b)` },
  { id: 'git-history', pattern: String.raw`\bgit\s+(filter-branch|filter-repo|update-ref\s+-d|reflog\s+(expire|delete))\b` },
  { id: 'sudo', pattern: String.raw`(^|[\s;&|(])sudo\s` },
  { id: 'chmod-recursive', pattern: String.raw`\b(chmod|chown)\s+(-[a-zA-Z]*R|--recursive)` },
  { id: 'sql-drop', pattern: String.raw`\b(drop\s+(database|table|schema)|truncate\s+table)\b` },
  { id: 'publish', pattern: String.raw`\b((npm|pnpm|yarn|bun)\s+publish|cargo\s+publish|twine\s+upload|gem\s+push|poetry\s+publish)\b` },
  { id: 'pipe-to-shell', pattern: String.raw`\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b` },
  { id: 'disk', pattern: String.raw`\b(mkfs(\.\w+)?|diskutil\s+(erase\w*|partition\w*|reformat)|dd\s[^\n]*\bof=/dev/)` },
  { id: 'power', pattern: String.raw`(^|[\s;&|(])(shutdown|reboot|halt)\b` },
  { id: 'kill-by-name', pattern: String.raw`(^|[\s;&|(])(killall|pkill)\s` },
];

/** Every rule with its effective state. Custom rules: { id, pattern, description, enabled }. */
export function safetyRules(settings = {}) {
  const off = new Set(settings.safety?.disabled || []);
  const rules = BUILTIN_RULES.map((r) => ({ ...r, builtin: true, enabled: !off.has(r.id) }));
  for (const c of settings.safety?.custom || []) {
    if (!c?.pattern) continue;
    rules.push({ id: String(c.id || crypto.createHash('sha1').update(c.pattern).digest('hex').slice(0, 8)), pattern: String(c.pattern), description: String(c.description || ''), builtin: false, enabled: c.enabled !== false });
  }
  return rules;
}

function compile(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    // not a valid regex: treat as a literal
    return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

export function matchSensitive(command, settings = {}) {
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  for (const r of safetyRules(settings)) {
    if (r.enabled && compile(r.pattern).test(cmd)) return r;
  }
  return null;
}

// ---------- approval requests (files in <run>/approvals) ----------

export const approvalsDir = (runId) => path.join(runDir(runId), 'approvals');
const reqFile = (runId, id) => path.join(approvalsDir(runId), `${id}.json`);
const decisionFile = (runId, id) => path.join(approvalsDir(runId), `${id}.decision.json`);
const alwaysFile = (runId) => path.join(approvalsDir(runId), 'always.json');
const logFile = (runId) => path.join(approvalsDir(runId), 'log.jsonl');

export function alwaysAllowed(runId) {
  return readJson(alwaysFile(runId), []) || [];
}

export function createApproval(runId, { round, member, tool, command, rule, timeoutMin }) {
  fs.mkdirSync(approvalsDir(runId), { recursive: true });
  const id = crypto.randomBytes(5).toString('hex');
  const rec = {
    id,
    at: nowIso(),
    round: round ?? null,
    member: member || null,
    tool,
    command: String(command || '').slice(0, 4000),
    rule: { id: rule.id, description: rule.description || '', builtin: Boolean(rule.builtin) },
    expiresAt: new Date(Date.now() + Math.max(0.05, Number(timeoutMin) || 10) * 60_000).toISOString(),
    status: 'pending',
  };
  writeJsonAtomic(reqFile(runId, id), rec);
  appendEvent(runId, { kind: 'approval.request', ...rec });
  return rec;
}

export function readApproval(runId, id) {
  return readJson(reqFile(runId, id), null);
}

export function listApprovals(runId) {
  let files = [];
  try {
    files = fs.readdirSync(approvalsDir(runId)).filter((f) => /^[0-9a-f]{10}\.json$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => readJson(path.join(approvalsDir(runId), f), null)).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function pendingApprovals(runId) {
  return listApprovals(runId).filter((r) => r.status === 'pending' && Date.parse(r.expiresAt) > Date.now());
}

/** The UI / CLI answers: decision = allow | deny. */
export function decideApproval(runId, id, { decision, reason = '', always = false, by = 'user' }) {
  if (!/^[0-9a-f]{10}$/.test(String(id))) throw new Error('bad approval id');
  const rec = readApproval(runId, id);
  if (!rec) throw new Error('approval request not found');
  if (rec.status !== 'pending') return rec;
  const d = decision === 'allow' ? 'allow' : 'deny';
  if (d === 'allow' && always) {
    const list = new Set(alwaysAllowed(runId));
    list.add(rec.rule.id);
    writeJsonAtomic(alwaysFile(runId), [...list]);
  }
  writeJsonAtomic(decisionFile(runId, id), { decision: d, reason: String(reason || '').slice(0, 1000), always: Boolean(always), by, at: nowIso() });
  return { ...rec, status: 'answered' };
}

/** Called by the gate when it stops waiting; records the final outcome. */
export function closeApproval(runId, id, { decision, by, reason = '' }) {
  const rec = readApproval(runId, id);
  if (!rec || rec.status !== 'pending') return rec;
  const done = { ...rec, status: decision, by, reason, closedAt: nowIso() };
  writeJsonAtomic(reqFile(runId, id), done);
  appendEvent(runId, { kind: 'approval.result', id, decision, by, reason, round: rec.round, member: rec.member, command: rec.command });
  logGate(runId, { round: rec.round, member: rec.member, command: rec.command, decision, by, reason, rule: rec.rule.id });
  return done;
}

export function readDecision(runId, id) {
  return readJson(decisionFile(runId, id), null);
}

export function logGate(runId, entry) {
  try {
    fs.mkdirSync(approvalsDir(runId), { recursive: true });
    fs.appendFileSync(logFile(runId), `${JSON.stringify({ at: nowIso(), ...entry })}\n`);
  } catch {
    // best effort
  }
}

/** Gate decisions of one round (for the audit prompt): commands that were denied or needed approval. */
export function gateLog(runId, round) {
  let text = '';
  try {
    text = fs.readFileSync(logFile(runId), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter((e) => e && (round == null || e.round === round));
}

/** When a WorkBuddy step ends (stop, interrupt), requests nobody answered are closed as cancelled. */
export function cancelPending(runId, { round = null } = {}) {
  for (const r of listApprovals(runId).filter((x) => x.status === 'pending')) {
    if (round != null && r.round !== round) continue;
    closeApproval(runId, r.id, { decision: 'cancelled', by: 'system' });
  }
}
