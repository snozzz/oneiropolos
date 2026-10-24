#!/usr/bin/env node
// The loop daemon (see src/loops.js). One instance at a time (pid file); exits when no loop is enabled any more.
import fs from 'node:fs';
import { LOOPER_PID, loadLoops, looperAlive, nextRunAt, saveLoops } from './loops.js';
import { controlRun, createTask, spawnRunner } from './service.js';
import { ACTIVE_STATUSES, appendEvent, effectiveStatus, readState } from './store.js';
import { sleep, writeJsonAtomic } from './util.js';

const other = looperAlive();
if (other && other !== process.pid) {
  console.log(`[${new Date().toISOString()}] looper already running (pid ${other})`);
  process.exit(0);
}
writeJsonAtomic(LOOPER_PID, { pid: process.pid, at: new Date().toISOString() });
const cleanup = () => {
  try {
    const cur = JSON.parse(fs.readFileSync(LOOPER_PID, 'utf8'));
    if (cur.pid === process.pid) fs.rmSync(LOOPER_PID, { force: true });
  } catch {
    // gone
  }
};
process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
log(`looper ${process.pid} start`);

function busy(runId) {
  if (!runId) return false;
  const s = readState(runId);
  if (!s) return false;
  const st = effectiveStatus(s);
  return ACTIVE_STATUSES.has(st) && st !== 'waiting_user';
}

function fire(l) {
  if (l.kind === 'message') {
    if (busy(l.runId)) return { skipped: true };
    const r = controlRun(l.runId, 'message', { text: l.prompt });
    appendEvent(l.runId, { kind: 'loop.fire', loopId: l.id, text: l.prompt });
    return { runId: l.runId, ...r };
  }
  if (busy(l.lastRunId)) return { skipped: true };
  const state = createTask({ goal: l.prompt, workdir: l.workdir, settings: l.settings || {} });
  spawnRunner(state.id);
  appendEvent(state.id, { kind: 'loop.fire', loopId: l.id, text: l.prompt });
  return { runId: state.id };
}

for (;;) {
  const loops = loadLoops();
  const enabled = loops.filter((l) => l.enabled);
  if (!enabled.length) {
    log('no enabled loops, exiting');
    break;
  }
  let changed = false;
  for (const l of enabled) {
    if (Date.parse(l.nextRunAt) > Date.now()) continue;
    try {
      const r = fire(l);
      if (r.skipped) {
        l.skipped = (l.skipped || 0) + 1;
        log(`loop ${l.id}: previous run still active, skipped`);
      } else {
        l.runs = (l.runs || 0) + 1;
        l.lastRunAt = new Date().toISOString();
        l.lastRunId = r.runId;
        l.lastError = null;
        log(`loop ${l.id}: fired → ${r.runId}`);
      }
    } catch (err) {
      l.lastError = String(err?.message || err).slice(0, 300);
      log(`loop ${l.id}: ${l.lastError}`);
    }
    l.nextRunAt = nextRunAt(l.schedule);
    changed = true;
  }
  if (changed) {
    // merge with the file as it is now (the UI may have edited it meanwhile)
    const fresh = loadLoops();
    for (const l of enabled) {
      const i = fresh.findIndex((x) => x.id === l.id);
      if (i >= 0) fresh[i] = { ...fresh[i], ...pick(l) };
    }
    saveLoops(fresh);
  }
  await sleep(15_000);
}

function pick(l) {
  return { runs: l.runs, skipped: l.skipped, lastRunAt: l.lastRunAt, lastRunId: l.lastRunId, lastError: l.lastError, nextRunAt: l.nextRunAt };
}
process.exit(0);
