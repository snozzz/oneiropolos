import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findCodex, startCodexLogin } from './codex.js';
import { loadConfig, saveConfig } from './config.js';
import { currentLang, t } from './i18n.js';
import { listSkills } from './skills.js';
import { ROOT, SERVER_INFO_PATH, ensureDirs } from './paths.js';
import * as svc from './service.js';
import { Snapshotter } from './snapshot.js';
import { deleteTemplate, listTemplates, saveTemplate } from './templates.js';
import { deleteRun, effectiveStatus, isRunnerAlive, isValidRunId, listRuns, livePath, readEvents, readMeta, readState, roundDir, runDir, writeMeta } from './store.js';
import { isPidAlive, readJson, writeJsonAtomic } from './util.js';
import { openUrl } from './workbuddy.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

export function publicState(s) {
  if (!s) return null;
  return { ...s, ...readMeta(s.id), error: s.error ? String(s.error).split('\n')[0] : null, status: effectiveStatus(s), alive: isRunnerAlive(s) };
}

function serveStatic(pathname, res, token) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  let body = fs.readFileSync(file);
  if (rel === 'index.html') {
    const ui = loadConfig().ui || {};
    const theme = ui.theme === 'light' || ui.theme === 'dark' ? ui.theme : 'system';
    const lang = currentLang(); // ui.language, or WBLOOP_LANG when set — the same language as the server's own text
    body = Buffer.from(body.toString('utf8').replace('__WBLOOP_TOKEN__', token).replace('__WBLOOP_THEME__', theme).replace('__WBLOOP_LANG__', lang));
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

function streamEvents(req, res, id, startOffset) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  let offset = startOffset;
  let lastStateStamp = '';
  const lastLive = new Map();
  let closed = false;
  const dir = runDir(id);
  const live = livePath(id);
  const pump = () => {
    if (closed) return;
    for (let i = 0; i < 40; i++) {
      const { events, offset: next } = readEvents(id, offset, 512 * 1024);
      if (!events.length) break;
      for (const ev of events) res.write(`id: ${ev._o}\ndata: ${JSON.stringify(ev)}\n\n`);
      offset = next;
    }
    const st = readState(id);
    const stamp = st ? `${st.updatedAt}|${effectiveStatus(st)}` : '';
    if (st && stamp !== lastStateStamp) {
      lastStateStamp = stamp;
      res.write(`event: state\ndata: ${JSON.stringify(publicState(st))}\n\n`);
    }
    // what WorkBuddy (or each teammate: live.<name>.json) is generating: pushed when the file changed
    let files = [live];
    try {
      files = files.concat(fs.readdirSync(dir).filter((f) => /^live\.[^/]+\.json$/.test(f)).map((f) => path.join(dir, f)));
    } catch {
      // no run dir
    }
    for (const file of files) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtime && mtime !== lastLive.get(file)) {
        lastLive.set(file, mtime);
        const snap = readJson(file, null);
        if (snap) res.write(`event: live\ndata: ${JSON.stringify(snap)}\n\n`);
      }
    }
  };
  pump();
  res.write('event: caught-up\ndata: {}\n\n');
  const timer = setInterval(pump, 350);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    clearInterval(ping);
  });
}

function listDirs(input, showHidden) {
  let dir = String(input || '').trim() || os.homedir();
  dir = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(t('srv.dir.notFound', { dir }));
  const dirs = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!showHidden && ent.name.startsWith('.')) continue;
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, ent.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) dirs.push(ent.name);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  return { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, dirs, home: os.homedir() };
}

let codexLoginJob = null;

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  let m;

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, pid: process.pid });
  if (pathname === '/api/env' && method === 'GET') return sendJson(res, 200, await svc.getEnvironment());
  if (pathname === '/api/workbuddy/models/refresh' && method === 'POST') return sendJson(res, 200, await svc.refreshWbModels());
  if (pathname === '/api/config' && method === 'PUT') return sendJson(res, 200, saveConfig(await readBody(req)));
  if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, loadConfig());
  if (pathname === '/api/quota' && method === 'GET') return sendJson(res, 200, { quota: await svc.getGptQuota({ force: url.searchParams.get('force') === '1' }) });
  if (pathname === '/api/ui-state' && method === 'GET') return sendJson(res, 200, svc.loadUiState());
  if (pathname === '/api/ui-state' && method === 'PUT') return sendJson(res, 200, svc.saveUiState(await readBody(req)));

  if (pathname === '/api/settings-data' && method === 'GET') return sendJson(res, 200, svc.settingsData(url.searchParams.get('dir') || ''));
  if (pathname === '/api/prompts/preview' && method === 'GET') return sendJson(res, 200, svc.systemPromptPreview(url.searchParams.get('role'), url.searchParams.get('dir') || ''));
  if ((m = pathname.match(/^\/api\/hooks\/(\w+)$/)) && method === 'PUT') return sendJson(res, 200, svc.saveHooks(m[1], (await readBody(req)).rules));
  if (pathname === '/api/skills' && method === 'GET') return sendJson(res, 200, listSkills(loadConfig(), url.searchParams.get('dir') || '', { includeDisabled: url.searchParams.get('all') === '1' }));
  if (pathname === '/api/skills' && method === 'POST') return sendJson(res, 200, svc.createSkill(await readBody(req)));
  if (pathname === '/api/skills/read' && method === 'GET') return sendJson(res, 200, svc.readSkill(url.searchParams.get('name'), loadConfig(), url.searchParams.get('dir') || ''));
  if (pathname === '/api/commands' && method === 'GET') return sendJson(res, 200, svc.listCommands(url.searchParams.get('dir') || ''));
  if (pathname === '/api/commands' && method === 'POST') return sendJson(res, 200, svc.saveCommand(await readBody(req)));
  if ((m = pathname.match(/^\/api\/commands\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, svc.removeCommand(decodeURIComponent(m[1])));
  if (pathname === '/api/mcp' && method === 'PUT') return sendJson(res, 200, svc.saveMcp((await readBody(req)).text ?? {}));
  if (pathname === '/api/usage' && method === 'GET') return sendJson(res, 200, svc.usageReport({ period: url.searchParams.get('period') || '30d' }));
  if (pathname === '/api/loops' && method === 'POST') return sendJson(res, 200, svc.addLoop(await readBody(req)));
  if ((m = pathname.match(/^\/api\/loops\/([0-9a-f]{8})$/)) && method === 'PATCH') return sendJson(res, 200, svc.updateLoop(m[1], await readBody(req)));
  if ((m = pathname.match(/^\/api\/loops\/([0-9a-f]{8})$/)) && method === 'DELETE') return sendJson(res, 200, svc.removeLoop(m[1]));
  if (pathname === '/api/notebook' && method === 'GET') return sendJson(res, 200, svc.readNotebook(svc.resolveWorkdir(url.searchParams.get('dir'))));
  if (pathname === '/api/notebook' && method === 'PUT') {
    const body = await readBody(req);
    return sendJson(res, 200, svc.writeNotebook(svc.resolveWorkdir(body.dir), body.text));
  }
  if (pathname === '/api/git' && method === 'GET') return sendJson(res, 200, await svc.gitInfo(url.searchParams.get('dir')));
  if (pathname === '/api/git/line' && method === 'GET') return sendJson(res, 200, await svc.gitLine(url.searchParams.get('dir'), url.searchParams.get('target')));
  if (pathname === '/api/agents/role' && method === 'PUT') {
    const body = await readBody(req);
    return sendJson(res, 200, svc.writeAgentRole(body.id, body.text));
  }
  if (pathname === '/api/review' && method === 'POST') return sendJson(res, 200, await svc.startReview(await readBody(req)));
  if (pathname === '/api/new-prompt' && method === 'POST') return sendJson(res, 200, svc.startNewPrompt(await readBody(req)));
  if ((m = pathname.match(/^\/api\/jobs\/([0-9a-f]{10})$/)) && method === 'GET') return sendJson(res, 200, svc.getJob(m[1]));
  if (pathname === '/api/exec' && method === 'POST') return sendJson(res, 200, await svc.execCommand(await readBody(req)));
  if (pathname === '/api/profiles' && method === 'POST') return sendJson(res, 200, svc.saveProfile(await readBody(req)));
  if ((m = pathname.match(/^\/api\/profiles\/([0-9a-f]{8})\/apply$/)) && method === 'POST') return sendJson(res, 200, svc.applyProfile(m[1]));
  if ((m = pathname.match(/^\/api\/profiles\/([0-9a-f]{8})$/)) && method === 'DELETE') return sendJson(res, 200, svc.deleteProfile(m[1]));
  if (pathname === '/api/settings/export' && method === 'POST') return sendJson(res, 200, svc.exportSettings());
  if (pathname === '/api/settings/import' && method === 'POST') return sendJson(res, 200, svc.importSettings(await readBody(req, 8 * 1024 * 1024)));

  if (pathname === '/api/templates' && method === 'GET') return sendJson(res, 200, listTemplates());
  if (pathname === '/api/templates' && method === 'POST') return sendJson(res, 200, saveTemplate(await readBody(req)));
  if ((m = pathname.match(/^\/api\/templates\/([0-9a-f]{1,32})$/)) && method === 'DELETE') return sendJson(res, 200, deleteTemplate(m[1]));

  if (pathname === '/api/runs' && method === 'GET') return sendJson(res, 200, listRuns());
  if (pathname === '/api/runs/cleanup' && method === 'POST') return sendJson(res, 200, svc.cleanupRuns(await readBody(req)));
  if (pathname === '/api/runs' && method === 'POST') {
    const body = await readBody(req);
    const state = svc.createTask(body);
    if (body.start !== false) svc.spawnRunner(state.id);
    return sendJson(res, 200, publicState(readState(state.id)));
  }

  if ((m = pathname.match(/^\/api\/runs\/([^/]+)(\/.*)?$/))) {
    const id = m[1];
    const sub = m[2] || '';
    if (!isValidRunId(id)) return sendJson(res, 400, { error: 'invalid task id' });
    const st = readState(id);
    if (!st) return sendJson(res, 404, { error: t('srv.runMissing', { id }) });
    if (sub === '' && method === 'GET') return sendJson(res, 200, publicState(st));
    if (sub === '' && method === 'PATCH') return sendJson(res, 200, writeMeta(id, await readBody(req)));
    if (sub === '' && method === 'DELETE') {
      deleteRun(id);
      return sendJson(res, 200, { ok: true });
    }
    if (sub === '/events' && method === 'GET') {
      const last = Number(req.headers['last-event-id'] || url.searchParams.get('offset') || 0);
      return streamEvents(req, res, id, Number.isFinite(last) ? last : 0);
    }
    if (sub === '/control' && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 200, svc.controlRun(id, body.cmd, body));
    }
    if (sub === '/log' && method === 'GET') {
      const file = path.join(runDir(id), 'runner.log');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-60_000) : '';
      return sendJson(res, 200, { text });
    }
    if ((m = sub.match(/^\/rounds\/(\d+)\/diff$/)) && method === 'GET') {
      const diff = readJson(path.join(roundDir(id, Number(m[1])), 'diff.json'), null);
      if (!diff) return sendJson(res, 404, { error: t('srv.snap.noRoundDiff') });
      const snap = new Snapshotter(runDir(id), st.workdir);
      const patch = await snap.fullPatch(diff.from, diff.to).catch(() => diff.patch);
      return sendJson(res, 200, { files: diff.files, patch: patch.length > 3_000_000 ? `${patch.slice(0, 3_000_000)}\n…(truncated)` : patch, command: diff.command });
    }
    if (sub === '/checkpoints' && method === 'GET') return sendJson(res, 200, await svc.listCheckpoints(id));
    if (sub === '/restore-preview' && method === 'GET') return sendJson(res, 200, await svc.restorePreview(id, url.searchParams.get('commit')));
    if (sub === '/restore' && method === 'POST') return sendJson(res, 200, await svc.restoreRun(id, (await readBody(req)).commit));
    if (sub === '/export' && method === 'GET') return sendJson(res, 200, { markdown: svc.exportMarkdown(id) });
    if (sub === '/export' && method === 'POST') return sendJson(res, 200, svc.exportRun(id));
    if (sub === '/asides' && method === 'GET') return sendJson(res, 200, svc.listAsides(id));
    if (sub === '/asides' && method === 'POST') return sendJson(res, 200, svc.askAside(id, (await readBody(req)).question));
    if (sub === '/approvals' && method === 'GET') return sendJson(res, 200, svc.listApprovalsOf(id));
    if ((m = sub.match(/^\/approvals\/([0-9a-f]{10})$/)) && method === 'POST') return sendJson(res, 200, svc.answerApproval(id, m[1], await readBody(req)));
    if (sub === '/board' && method === 'POST') return sendJson(res, 200, svc.postBoard(id, await readBody(req)));
    if (sub === '/board' && method === 'GET') {
      const round = Number(url.searchParams.get('round')) || st.round;
      const file = path.join(runDir(id), 'team', `r${round}`, 'BOARD.md');
      return sendJson(res, 200, { round, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
    }
    if (sub === '/diff' && method === 'GET') {
      const first = st.snapshot?.firstCommit;
      const last = [...(st.rounds || [])].reverse().find((r) => r.endCommit)?.endCommit;
      if (!first || !last) return sendJson(res, 404, { error: t('srv.snap.noneYet') });
      const snap = new Snapshotter(runDir(id), st.workdir);
      const d = await snap.diff(first, last, 3_000_000);
      return sendJson(res, 200, d);
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  if (pathname === '/api/accounts' && method === 'GET') return sendJson(res, 200, await svc.engineStatus({ force: url.searchParams.get('force') === '1' }));
  if ((m = pathname.match(/^\/api\/accounts\/(chatgpt|claude|deepseek|workbuddy)\/(login|logout|code|key)$/))) {
    const [, id, act] = m;
    if (act === 'login' && method === 'POST') return sendJson(res, 200, svc.startSignIn(id));
    if (act === 'login' && method === 'GET') return sendJson(res, 200, svc.getSignIn(id));
    if (act === 'login' && method === 'DELETE') return sendJson(res, 200, svc.cancelSignIn(id));
    if (act === 'logout' && method === 'POST') return sendJson(res, 200, await svc.signOut(id));
    if (act === 'code' && method === 'POST') return sendJson(res, 200, svc.sendSignInCode(id, (await readBody(req)).code));
    if (act === 'key' && method === 'POST') return sendJson(res, 200, svc.setEngineKey(id, (await readBody(req)).key));
  }
  if (pathname === '/api/login/workbuddy' && method === 'POST') return sendJson(res, 200, svc.startWbLogin(await readBody(req)));
  if (pathname === '/api/login/workbuddy' && method === 'GET') return sendJson(res, 200, svc.getWbLogin() || {});
  if (pathname === '/api/login/workbuddy' && method === 'DELETE') return sendJson(res, 200, svc.cancelWbLogin() || {});
  if (pathname === '/api/logout/workbuddy' && method === 'POST') return sendJson(res, 200, await svc.logoutWb());

  if (pathname === '/api/login/codex' && method === 'POST') {
    const found = findCodex(loadConfig().codex.path);
    if (!found) return sendJson(res, 400, { error: t('srv.codex.missing') });
    if (!codexLoginJob || codexLoginJob.done) {
      codexLoginJob = { lines: [], done: false };
      const job = codexLoginJob;
      startCodexLogin(found, (line) => {
        job.lines.push(line);
        const urlMatch = line.match(/https:\/\/\S+/);
        if (urlMatch && !job.url) job.url = urlMatch[0];
      }).then((r) => {
        job.done = true;
        job.code = r.code;
      });
    }
    return sendJson(res, 200, { started: true });
  }
  if (pathname === '/api/login/codex' && method === 'GET') return sendJson(res, 200, codexLoginJob ? { done: codexLoginJob.done, code: codexLoginJob.code, url: codexLoginJob.url, lines: codexLoginJob.lines.slice(-20) } : {});

  if (pathname === '/api/fs/list' && method === 'GET') return sendJson(res, 200, listDirs(url.searchParams.get('path'), url.searchParams.get('hidden') === '1'));
  if (pathname === '/api/fs/files' && method === 'GET') return sendJson(res, 200, await svc.listProjectFiles(url.searchParams.get('dir')));
  if (pathname === '/api/fs/todos' && method === 'GET') return sendJson(res, 200, await svc.listTodos(url.searchParams.get('dir')));
  if (pathname === '/api/reveal' && method === 'POST') {
    const target = String((await readBody(req)).path || '');
    if (!target || !fs.existsSync(target)) return sendJson(res, 400, { error: t('srv.fileMissing') });
    spawn('/usr/bin/open', ['-R', target], { stdio: 'ignore', detached: true }).unref();
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/open' && method === 'POST') {
    const body = await readBody(req);
    const target = String(body.path || '');
    if (/^https:\/\//.test(target)) openUrl(target);
    else if (target && fs.existsSync(target)) openUrl(target);
    else return sendJson(res, 400, { error: t('srv.cannotOpen') });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

export async function findRunningServer() {
  const info = readJson(SERVER_INFO_PATH, null);
  if (!info?.port || !isPidAlive(info.pid)) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { headers: { 'x-wbloop-token': info.token }, signal: AbortSignal.timeout(1500) });
    if (r.ok) return info;
  } catch {
    // stale
  }
  return null;
}

export async function startServer({ port = 0 } = {}) {
  ensureDirs();
  const token = crypto.randomBytes(24).toString('hex');
  let actualPort = port;
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden host');
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(url.pathname, res, token);
      return;
    }
    const isSse = /\/events$/.test(url.pathname);
    const provided = req.headers['x-wbloop-token'] || (isSse ? url.searchParams.get('token') : null);
    if (provided !== token) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    route(req, res, url).catch((err) => {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;
  const info = { pid: process.pid, port: actualPort, token, url: `http://127.0.0.1:${actualPort}/`, startedAt: new Date().toISOString() };
  writeJsonAtomic(SERVER_INFO_PATH, info);
  if (!process.env.WBLOOP_NO_MODEL_REFRESH) setTimeout(() => svc.refreshWbModelsIfStale(), 1500).unref();
  setTimeout(() => svc.startLooperIfNeeded(), 2500).unref();
  const cleanup = () => {
    const cur = readJson(SERVER_INFO_PATH, null);
    if (cur?.pid === process.pid) fs.rmSync(SERVER_INFO_PATH, { force: true });
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
  return { server, ...info };
}
