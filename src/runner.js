#!/usr/bin/env node
// Runs one task in the background: node src/runner.js <runId>
// Started detached by the UI or `wbloop run --detach`; closing the UI doesn't stop the task.
import { Orchestrator } from './loop.js';

const runId = process.argv[2];
if (!runId) {
  console.error('usage: runner.js <runId>');
  process.exit(2);
}

const orch = new Orchestrator(runId, {
  onEvent: (ev) => {
    if (['run.status', 'phase', 'error', 'done', 'wait'].includes(ev.kind)) {
      console.log(`[${ev.t}] ${ev.kind} ${JSON.stringify({ ...ev, t: undefined, kind: undefined })}`);
    }
  },
});

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    console.log(`[${new Date().toISOString()}] received ${sig}, stopping`);
    orch.requestStop();
  });
}
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});

console.log(`[${new Date().toISOString()}] runner ${process.pid} start ${runId}`);
try {
  await orch.run();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
console.log(`[${new Date().toISOString()}] runner exit, status=${orch.state.status}`);
process.exit();
