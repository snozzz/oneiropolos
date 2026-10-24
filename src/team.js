// Team Mode (snow-cli's Agent Team, docs/usage/22) adapted to this loop. snow-cli gives every teammate a git
// worktree of the user's repository; here the project need not be a git repository at all:
// - each teammate works in an APFS clone of the working directory (cp -c: instant, shares disk blocks, includes
//   node_modules and ignored files so builds and tests work), minus the project's own .git;
// - when everyone is done, each copy is snapshotted into the run's shadow repository as a commit on top of the round's
//   base snapshot, the commits are merged one after another with `git merge-tree` (3-way, conflicts leave markers),
//   and the merged tree is checked out into the real working directory.
import fs from 'node:fs';
import path from 'node:path';
import { LARGE_FILE_BYTES } from './snapshot.js';
import { runDir } from './store.js';
import { nowIso, runProcess } from './util.js';

export const teamRoundDir = (runId, round) => path.join(runDir(runId), 'team', `r${round}`);
export const workspaceDir = (runId, round, slug) => path.join(teamRoundDir(runId, round), slug, 'ws');
export const boardFile = (runId, round) => path.join(teamRoundDir(runId, round), 'BOARD.md');

/** Clone the working directory for one teammate (reused when it already exists, e.g. after a restart). */
export async function prepareWorkspace({ runId, round, slug, workdir, signal }) {
  const ws = workspaceDir(runId, round, slug);
  if (fs.existsSync(path.join(ws, '.wbloop-ready'))) return { dir: ws, reused: true };
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  const entries = fs.readdirSync(workdir).filter((e) => e !== '.git' && e !== '.DS_Store');
  const errors = [];
  // clone in batches so the argument list stays short
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200).map((e) => path.join(workdir, e));
    const res = await runProcess('/bin/cp', ['-cRp', ...batch, `${ws}/`], { timeoutMs: 15 * 60_000, signal });
    if (res.aborted) throw new Error('aborted');
    if (res.code !== 0) errors.push(String(res.stderr || '').trim().split('\n').slice(-3).join(' '));
  }
  fs.writeFileSync(path.join(ws, '.wbloop-ready'), nowIso());
  return { dir: ws, reused: false, warning: errors.filter(Boolean).join(' | ') || null };
}

export function removeWorkspace(runId, round, slug) {
  fs.rmSync(path.join(teamRoundDir(runId, round), slug), { recursive: true, force: true });
}

export function initBoard({ runId, round, summary, members }) {
  const file = boardFile(runId, round);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const roster = members.map((m) => `- **${m.name}**${m.role ? ` — ${m.role}` : ''} · owns: ${m.owns || '-'}`).join('\n');
  fs.writeFileSync(file, `# Team board — round ${round}

${summary ? `Lead's summary: ${summary}\n\n` : ''}## Teammates
${roster}

## Notes
<!-- Append short notes below: "- **name** (HH:MM): message". Read this file again before you finish. -->
`);
  return file;
}

export function postToBoard({ runId, round, from, to, text }) {
  const file = boardFile(runId, round);
  if (!fs.existsSync(file)) throw new Error('no team board for this round');
  const hm = new Date().toTimeString().slice(0, 5);
  fs.appendFileSync(file, `- **${from}${to ? ` → ${to}` : ''}** (${hm}): ${String(text).replace(/\n+/g, ' ').trim()}\n`);
}

export function readBoard(runId, round) {
  try {
    return fs.readFileSync(boardFile(runId, round), 'utf8');
  } catch {
    return '';
  }
}

export function rosterText(members) {
  return members.map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ''} — owns: ${m.owns || '-'}`).join('\n');
}

/**
 * Snapshot a teammate's copy as a commit whose parent is the round's base snapshot.
 * Returns { commit, files: [{status, path}] } (commit === base when nothing changed).
 */
export async function snapshotWorkspace(snap, { ws, base, label, indexFile }) {
  fs.rmSync(indexFile, { force: true });
  const r0 = await snap.runIn(ws, indexFile, ['read-tree', base]);
  if (r0.code !== 0) throw new Error(`read-tree failed: ${r0.stderr.trim().slice(0, 200)}`);
  // new files over the size limit stay out of the snapshot, like in the main working directory
  const others = await snap.runIn(ws, indexFile, ['ls-files', '--others', '--exclude-standard', '-z'], { maxBytes: 20_000_000 });
  const big = others.stdout.split('\0').filter(Boolean).filter((rel) => {
    try {
      return fs.statSync(path.join(ws, rel)).size > LARGE_FILE_BYTES;
    } catch {
      return false;
    }
  });
  const exclude = `${indexFile}.exclude`;
  fs.writeFileSync(exclude, `${['.wbloop-ready', ...big.map((p) => `/${p.replace(/([*?[\]!#\\ ])/g, '\\$1')}`)].join('\n')}\n`);
  const cfg = ['-c', `core.excludesFile=${exclude}`];
  const add = await snap.runIn(ws, indexFile, ['add', '-A', '--ignore-errors'], { config: cfg });
  if (add.code !== 0 && /fatal/i.test(add.stderr)) throw new Error(`git add failed: ${add.stderr.trim().slice(0, 200)}`);
  const w = await snap.runIn(ws, indexFile, ['write-tree']);
  const tree = w.stdout.trim();
  if (w.code !== 0 || !tree) throw new Error(`write-tree failed: ${w.stderr.trim().slice(0, 200)}`);
  const baseTree = (await snap.run(['rev-parse', `${base}^{tree}`])).stdout.trim();
  if (tree === baseTree) return { commit: base, files: [] };
  const c = await snap.runIn(ws, indexFile, ['commit-tree', tree, '-p', base, '-m', label]);
  const commit = c.stdout.trim();
  if (c.code !== 0 || !commit) throw new Error(`commit-tree failed: ${c.stderr.trim().slice(0, 200)}`);
  const d = await snap.run(['diff', '--name-status', '--no-renames', base, commit]);
  const files = d.stdout.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status[0], path: rest.join('\t') };
  });
  return { commit, files };
}

/**
 * Merge teammates' commits (all children of base) one after another; ours starts at `start` (base, or a snapshot of
 * the main directory if it changed meanwhile). Returns { commit, tree, conflicts, merged, errors }.
 */
export async function mergeCommits(snap, { start, members }) {
  let ours = start;
  const conflicts = new Set();
  const merged = [];
  const errors = [];
  for (const m of members) {
    if (!m.commit || m.commit === ours) continue;
    const r = await snap.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, m.commit], { maxBytes: 20_000_000 });
    const lines = r.stdout.split('\n').filter(Boolean);
    const tree = lines[0]?.trim();
    if (!(r.code === 0 || r.code === 1) || !/^[0-9a-f]{40,64}$/.test(tree || '')) {
      errors.push(`${m.name}: ${(r.stderr || r.stdout).trim().slice(0, 300) || `merge-tree exit ${r.code}`}`);
      continue;
    }
    if (r.code === 1) for (const f of lines.slice(1)) conflicts.add(f.trim());
    const c = await snap.run(['commit-tree', tree, '-p', ours, '-p', m.commit, '-m', `team merge: ${m.name}`]);
    if (c.code !== 0 || !c.stdout.trim()) {
      errors.push(`${m.name}: commit-tree failed`);
      continue;
    }
    ours = c.stdout.trim();
    merged.push(m.name);
  }
  const tree = (await snap.run(['rev-parse', `${ours}^{tree}`])).stdout.trim();
  return { commit: ours, tree, conflicts: [...conflicts], merged, errors };
}

/** Check the merged tree out into the real working directory (like a rollback; untracked/excluded files stay). */
export async function applyTree(snap, tree) {
  const r = await snap.run(['read-tree', '-u', '--reset', tree], { timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`could not apply the merged result: ${r.stderr.trim().slice(0, 300)}`);
}
