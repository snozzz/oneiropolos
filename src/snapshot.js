import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.js';
import { execText, findExecutable, runProcess } from './util.js';

// Snapshots of the working directory live in a "shadow" git repository inside the run directory:
// GIT_DIR points to ~/.wbloop/runs/<id>/shadow.git, so the project's own .git (if any) is never touched.

const DEFAULT_EXCLUDES = [
  '.DS_Store',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.gradle/',
  '.idea/',
  '.workbuddy/',
  '.codebuddy/',
  'target/',
  '*.o',
  '*.so',
  '*.dylib',
  '*.a',
  '*.class',
];
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const GIT_BASE = ['-c', 'core.quotepath=false', '-c', 'user.name=wbloop', '-c', 'user.email=wbloop@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
const MAX_FILES = 30_000;

export class Snapshotter {
  constructor(runDir, workdir) {
    this.gitDir = path.join(runDir, 'shadow.git');
    this.workdir = workdir;
    this.git = findExecutable('git', ['/usr/bin']) || 'git';
    this.disabledReason = null;
  }

  env() {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workdir,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    };
  }

  run(args, opts = {}) {
    return execText(this.git, [...GIT_BASE, ...args], { cwd: this.workdir, env: this.env(), timeoutMs: opts.timeoutMs ?? 120_000, maxBytes: opts.maxBytes });
  }

  /** The same repository with another work tree and index (teammate workspaces in Team Mode). */
  runIn(workTree, indexFile, args, opts = {}) {
    const env = { ...this.env(), GIT_WORK_TREE: workTree, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) };
    return execText(this.git, [...GIT_BASE, ...(opts.config || []), ...args], { cwd: workTree, env, timeoutMs: opts.timeoutMs ?? 300_000, maxBytes: opts.maxBytes });
  }

  async init() {
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
      const r = await this.run(['init', '--quiet']);
      if (r.code !== 0) {
        this.disabledReason = t('srv.snap.initFailed', { err: r.stderr.trim() });
        return false;
      }
      fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), `${DEFAULT_EXCLUDES.join('\n')}\n`);
    }
    const count = await this.countCandidateFiles();
    if (count > MAX_FILES) {
      this.disabledReason = t('srv.snap.tooMany', { n: MAX_FILES });
      return false;
    }
    return true;
  }

  async countCandidateFiles() {
    let n = 0;
    await runProcess(this.git, ['ls-files', '--others', '--cached', '--exclude-standard'], {
      cwd: this.workdir,
      env: this.env(),
      timeoutMs: 120_000,
      onLine: () => {
        n += 1;
      },
    });
    return n;
  }

  async excludeLargeFiles() {
    const r = await this.run(['ls-files', '--others', '--exclude-standard'], { maxBytes: 20_000_000 });
    const big = [];
    for (const rel of r.stdout.split('\n')) {
      if (!rel) continue;
      try {
        if (fs.statSync(path.join(this.workdir, rel)).size > LARGE_FILE_BYTES) big.push(rel);
      } catch {
        // vanished
      }
    }
    if (big.length) {
      const escaped = big.map((p) => `/${p.replace(/([*?[\]!#\\ ])/g, '\\$1')}`);
      fs.appendFileSync(path.join(this.gitDir, 'info', 'exclude'), `${escaped.join('\n')}\n`);
    }
    return big;
  }

  /** Takes a snapshot and returns the commit hash (an empty commit when nothing changed, so every round has an anchor). */
  async commit(message) {
    if (this.disabledReason) return null;
    await this.excludeLargeFiles();
    const add = await this.run(['add', '-A', '--ignore-errors'], { timeoutMs: 300_000 });
    if (add.code !== 0 && /fatal/i.test(add.stderr)) {
      this.disabledReason = t('srv.snap.addFailed', { err: add.stderr.trim().slice(0, 300) });
      return null;
    }
    const c = await this.run(['commit', '--allow-empty', '--no-verify', '-q', '-m', message]);
    if (c.code !== 0) {
      this.disabledReason = t('srv.snap.commitFailed', { err: c.stderr.trim().slice(0, 300) });
      return null;
    }
    const head = await this.run(['rev-parse', 'HEAD']);
    return head.stdout.trim() || null;
  }

  /** Differences between two snapshots: file list, stats and a truncated patch. */
  async diff(from, to, maxBytes = 48 * 1024) {
    if (!from || !to) return null;
    const [nameStatus, numstat, patch] = await Promise.all([
      this.run(['diff', '--name-status', '-M', from, to]),
      this.run(['diff', '--numstat', '-M', from, to]),
      this.run(['diff', '-M', '--no-color', '--unified=3', from, to], { maxBytes: maxBytes * 4 }),
    ]);
    const stats = new Map();
    for (const line of numstat.stdout.split('\n')) {
      const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);
      if (m) stats.set(m[3].replace(/^.*=> /, '').replace(/[{}]/g, ''), { add: m[1], del: m[2] });
    }
    const files = [];
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0][0];
      const file = parts[parts.length - 1];
      const st = stats.get(file) || {};
      files.push({ status, path: file, from: parts.length > 2 ? parts[1] : undefined, add: st.add ?? '-', del: st.del ?? '-' });
    }
    const full = patch.stdout;
    return {
      from,
      to,
      files,
      patch: full.length > maxBytes ? `${full.slice(0, maxBytes)}\n…(patch truncated; use the command below for the full diff)` : full,
      truncated: full.length > maxBytes,
      patchBytes: full.length,
      command: `git --git-dir="${this.gitDir}" --work-tree="${this.workdir}" diff ${from.slice(0, 12)} ${to.slice(0, 12)}`,
    };
  }

  async fullPatch(from, to) {
    const r = await this.run(['diff', '-M', '--no-color', from, to], { maxBytes: 30_000_000 });
    return r.stdout;
  }

  // ---------- rollback: restore the working directory to a snapshot ----------

  /** The tree of the current working directory (computed with a temporary index, no commit). */
  async worktreeTree() {
    if (this.disabledReason) return null;
    await this.excludeLargeFiles();
    const index = path.join(this.gitDir, 'index');
    const tmp = path.join(this.gitDir, `index.preview-${process.pid}`);
    try {
      if (fs.existsSync(index)) fs.copyFileSync(index, tmp);
      const env = { ...this.env(), GIT_INDEX_FILE: tmp };
      const base = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
      await execText(this.git, [...base, 'add', '-A', '--ignore-errors'], { cwd: this.workdir, env, timeoutMs: 300_000 });
      const w = await execText(this.git, [...base, 'write-tree'], { cwd: this.workdir, env, timeoutMs: 60_000 });
      return w.code === 0 ? w.stdout.trim() : null;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async isCommit(ref) {
    if (!/^[0-9a-f]{7,64}$/.test(String(ref || ''))) return false;
    const r = await this.run(['cat-file', '-t', ref]);
    return r.stdout.trim() === 'commit';
  }

  /** What restoring target would change: M overwritten, D deleted (not in target), A brought back (in target, missing now). */
  async restorePreview(target) {
    const tree = await this.worktreeTree();
    if (!tree) return null;
    const r = await this.run(['diff', '--name-status', '--no-renames', tree, target]);
    const files = r.stdout.split('\n').filter(Boolean).map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
    return { files };
  }

  /**
   * First snapshots the current state ("before restore", so it can be undone), then replaces index and working tree
   * with target: files missing from target are deleted; excluded directories (node_modules …) and very large files are
   * left alone. The shadow repository's HEAD does not move.
   */
  async restore(target, label = 'before restore') {
    if (this.disabledReason) throw new Error(this.disabledReason);
    if (!(await this.isCommit(target))) throw new Error(t('srv.snap.notFound'));
    const safety = await this.commit(`before restore: ${label}`);
    if (!safety) throw new Error(this.disabledReason || t('srv.snap.saveFailed'));
    const r = await this.run(['read-tree', '-u', '--reset', target], { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(t('srv.snap.restoreFailed', { err: r.stderr.trim().slice(0, 300) }));
    return { safety };
  }
}
