import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

export function abortError(message = 'aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function truncate(text, max, note = '…(truncated)') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n${note} ${s.length} characters in total`;
}

export function truncateMiddle(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n…(${s.length - max} characters omitted)…\n${s.slice(-tail)}`;
}

export function oneLine(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// With --output-schema GPT should print only JSON; tolerate the occasional code fence or surrounding text.
export function extractJsonObject(text) {
  if (!text) return null;
  const s = String(text).trim();
  const attempts = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1]);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(s.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function compareVersionDirsDesc(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

// When launched from Finder/Dock the PATH is short; add nvm, Homebrew and friends ourselves.
export function candidateBinDirs() {
  const home = os.homedir();
  const dirs = [];
  const nvmBase = path.join(home, '.nvm/versions/node');
  try {
    for (const v of fs.readdirSync(nvmBase).sort(compareVersionDirsDesc)) dirs.push(path.join(nvmBase, v, 'bin'));
  } catch {
    // no nvm
  }
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.bun/bin'),
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.volta/bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  );
  return dirs;
}

export function findExecutable(name, preferredDirs = []) {
  const dirs = [...preferredDirs, ...(process.env.PATH || '').split(':').filter(Boolean), ...candidateBinDirs()];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

export function mergePath(...dirLists) {
  const seen = new Set();
  const out = [];
  for (const list of dirLists) {
    for (const dir of list) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    }
  }
  return out.join(':');
}

/**
 * Runs a child process and calls back for each stdout line. The child gets its own process group, so stopping it
 * ends the whole group (no orphans). Supports a total timeout, an idle timeout (no output for a while) and an
 * AbortSignal. Lines for which rawFilter(line) returns false are not written to rawFile.
 */
export function runProcess(cmd, args, opts = {}) {
  const { cwd, env, input, onLine, onStderr, signal, timeoutMs, idleTimeoutMs, rawFile, rawFilter } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      resolve({ code: null, signal: null, error, stderr: '', timedOut: false, idleTimedOut: false, aborted: false });
      return;
    }
    let buf = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let idleTimedOut = false;
    let aborted = false;
    let lastActivity = Date.now();
    const raw = rawFile ? fs.createWriteStream(rawFile, { flags: 'a' }) : null;

    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    const terminate = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    };

    const emitLine = (line) => {
      if (!line.trim()) return;
      if (raw && (!rawFilter || rawFilter(line))) raw.write(`${line}\n`);
      try {
        onLine?.(line);
      } catch {
        // a faulty handler must not break the pipe
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lastActivity = Date.now();
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        emitLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      lastActivity = Date.now();
      stderr += chunk;
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
      try {
        onStderr?.(chunk);
      } catch {
        // ignore
      }
    });
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();

    const timers = [];
    if (timeoutMs) {
      timers.push(setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs));
    }
    if (idleTimeoutMs) {
      timers.push(setInterval(() => {
        if (Date.now() - lastActivity > idleTimeoutMs) {
          idleTimedOut = true;
          terminate();
        }
      }, Math.max(1000, Math.min(30_000, Math.floor(idleTimeoutMs / 4)))));
    }
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code, sig, error) => {
      if (settled) return;
      settled = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      signal?.removeEventListener('abort', onAbort);
      emitLine(buf);
      buf = '';
      raw?.end();
      // after the main process exits, clean up background children it left in the same group
      killGroup('SIGTERM');
      resolve({ code, signal: sig, error, stderr, timedOut, idleTimedOut, aborted });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('exit', (code, sig) => {
      // background children may keep stdout open so 'close' may never come; give it 3 seconds
      setTimeout(() => finish(code, sig, null), 3000).unref();
    });
    child.on('close', (code, sig) => finish(code, sig, null));
  });
}

export async function execText(cmd, args, opts = {}) {
  let stdout = '';
  const res = await runProcess(cmd, args, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 20_000,
    onLine: (line) => {
      if (stdout.length < (opts.maxBytes ?? 8_000_000)) stdout += `${line}\n`;
    },
  });
  return { ...res, stdout };
}

let proxyCache = null;

// GUI-launched processes don't get the shell's *_proxy variables; fill them in from the macOS system proxy
// settings (the same thing the WorkBuddy desktop app does).
export async function systemProxyEnv() {
  if (proxyCache && Date.now() - proxyCache.at < 60_000) return proxyCache.env;
  const env = {};
  try {
    const { stdout } = await execText('/usr/sbin/scutil', ['--proxy'], { timeoutMs: 5000 });
    const kv = {};
    const exceptions = [];
    let inExceptions = false;
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('ExceptionsList')) {
        inExceptions = true;
        continue;
      }
      if (inExceptions) {
        if (line.startsWith('}')) {
          inExceptions = false;
          continue;
        }
        const m = line.match(/^\d+\s*:\s*(.+)$/);
        if (m) exceptions.push(m[1].trim());
        continue;
      }
      const m = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (m) kv[m[1]] = m[2].trim();
    }
    if (kv.HTTPSEnable === '1' && kv.HTTPSProxy) env.HTTPS_PROXY = `http://${kv.HTTPSProxy}:${kv.HTTPSPort || 443}`;
    if (kv.HTTPEnable === '1' && kv.HTTPProxy) env.HTTP_PROXY = `http://${kv.HTTPProxy}:${kv.HTTPPort || 80}`;
    if (env.HTTPS_PROXY && !env.HTTP_PROXY) env.HTTP_PROXY = env.HTTPS_PROXY;
    if (env.HTTP_PROXY && !env.HTTPS_PROXY) env.HTTPS_PROXY = env.HTTP_PROXY;
    if (env.HTTPS_PROXY) {
      env.NO_PROXY = [...new Set(['localhost', '127.0.0.1', '::1', ...exceptions])].join(',');
      env.https_proxy = env.HTTPS_PROXY;
      env.http_proxy = env.HTTP_PROXY;
      env.no_proxy = env.NO_PROXY;
    }
  } catch {
    // no proxy info
  }
  proxyCache = { at: Date.now(), env };
  return env;
}

export async function baseChildEnv(extraPathDirs = []) {
  const env = { ...process.env };
  const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  if (!proxyKeys.some((k) => env[k])) Object.assign(env, await systemProxyEnv());
  env.PATH = mergePath(extraPathDirs, (env.PATH || '').split(':'), ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}

// /tmp and $TMPDIR are writable in Codex's workspace-write sandbox anyway, so scratch mode cannot isolate projects there.
export function isTempPath(p) {
  const roots = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  try {
    roots.push(fs.realpathSync(os.tmpdir()));
  } catch {
    // ignore
  }
  let real = p;
  try {
    real = fs.realpathSync(p);
  } catch {
    // keep as is
  }
  return roots.some((r) => real === r || real.startsWith(`${r}/`));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}
