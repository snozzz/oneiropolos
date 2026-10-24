// Ruleset overlay for the GPT role (the "purge" slot).
//
// The user may attach a local markdown file that is composed into the system prompt of the roles they pick
// (lead and reviewer by default). The app ships NO ruleset content of its own: an empty or missing file is a
// no-op and the badge stays dim. Everything that is actually injected is mirrored next to the run
// (prompts/<role>.md), so a transcript can always be traced back to the exact text that produced it.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { truncate } from './util.js';

export const PURGE_MAX_BYTES = 96 * 1024;

export function purgeSettings(settings = {}) {
  const p = settings?.purge || {};
  const roles = Array.isArray(p.roles) ? p.roles.filter((r) => typeof r === 'string' && r.trim()) : [];
  return {
    enabled: p.enabled === true,
    label: String(p.label || '').trim() || 'PURGE',
    file: String(p.file || '').trim() || path.join(DATA_DIR, 'purge.md'),
    mode: p.mode === 'replace' ? 'replace' : 'overlay',
    roles: roles.length ? roles : ['lead', 'reviewer'],
  };
}

function readRuleset(cfg) {
  try {
    const st = fs.statSync(cfg.file);
    if (!st.isFile()) return { exists: false, bytes: 0, text: '', truncated: false, mtime: null };
    const raw = fs.readFileSync(cfg.file, 'utf8').replace(/\r\n/g, '\n').trim();
    const bytes = Buffer.byteLength(raw, 'utf8');
    const truncated = bytes > PURGE_MAX_BYTES;
    return {
      exists: true,
      bytes,
      text: truncated ? truncate(raw, PURGE_MAX_BYTES) : raw,
      truncated,
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return { exists: false, bytes: 0, text: '', truncated: false, mtime: null };
  }
}

/** What the UI and the audit trail show. `reason` explains why the badge is dim. */
export function purgeStatus(settings = {}) {
  const cfg = purgeSettings(settings);
  const r = readRuleset(cfg);
  const reason = !cfg.enabled ? 'off' : !r.exists ? 'missing' : !r.text ? 'empty' : 'ok';
  return {
    enabled: cfg.enabled,
    active: reason === 'ok',
    label: cfg.label,
    file: cfg.file,
    mode: cfg.mode,
    roles: cfg.roles,
    exists: r.exists,
    bytes: r.bytes,
    truncated: Boolean(r.truncated),
    reason,
  };
}

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * Composes the ruleset into a role's system prompt.
 * overlay: the built-in prompt stays, the ruleset is appended as the last, highest-priority block.
 * replace: the built-in prompt is dropped entirely; only the environment block survives.
 * Returns the untouched text (and the status) when the role is not configured or the file is not usable.
 */
export function applyPurge(text, { settings = {}, role, workdir = '' } = {}) {
  const cfg = purgeSettings(settings);
  const status = purgeStatus(settings);
  if (!cfg.roles.includes(role)) return { text, purge: { ...status, active: false, reason: status.reason === 'ok' ? 'role' : status.reason } };
  if (!status.active) return { text, purge: status };

  const r = readRuleset(cfg);
  const note = r.truncated ? `\n(The file is larger than ${kb(PURGE_MAX_BYTES)} and was truncated.)` : '';
  const head = cfg.mode === 'replace'
    ? `## Ruleset — ${cfg.label}

The user replaced the default operating instructions for this role with the local ruleset below
(${cfg.file}, ${kb(r.bytes)}).${note} The environment block, the reply contract and the tool/sandbox rules
you were given still apply; everything else in the ruleset takes precedence.`
    : `## Ruleset overlay — ${cfg.label}

The user attached a local ruleset to this session (${cfg.file}, ${kb(r.bytes)}).${note} It is part of your
system prompt and sits above the sections before it: where the two disagree, follow the ruleset and record the
conflict in \`assessment\` instead of silently choosing one side. It does not change the JSON contract of your
reply, the sandbox you run in, or the tools you have.`;
  const block = `${head}

--- ${cfg.label.toLowerCase()} begin ---
${r.text}
--- ${cfg.label.toLowerCase()} end ---`;

  const out = cfg.mode === 'replace'
    ? `${block}\n\n${envTail(workdir)}`
    : `${text.trimEnd()}\n\n${block}`;
  return { text: out, purge: status };
}

function envTail(workdir) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : process.platform === 'win32' ? 'Windows' : process.platform;
  return `System Environment:
Platform: ${platform}
Shell: ${path.basename(process.env.SHELL || '/bin/zsh')}
Working Directory: ${workdir}

Current Date: ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
