import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

// Keep the real transient backoff (15 seconds) so a stale signal makes this regression fail quickly.
delete process.env.WBLOOP_TEST_FAST;
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'write a.txt' }),
    gpt('done'),
  ],
  wbCalls: [
    { result: 'error', error: 'network timeout' },
    { writeFiles: { 'a.txt': 'A' }, result: 'success' },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('changing the executor model interrupts a transient retry wait', { timeout: 5000 }, async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'settings wait test', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 3, finalReview: false } } });
  let scheduled = false;
  let orch;
  orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      if (ev.kind !== 'wb.end' || ev.ok || scheduled) return;
      scheduled = true;
      appendControl(run.id, { cmd: 'settings', patch: { workbuddy: { model: 'new-model' } } });
      // Let runExecutor enter waitFor before applying the control command.
      setTimeout(() => orch.pollControl().catch(() => {}), 10);
    },
  });
  await orch.run();

  const s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  assert.equal(env.wbCalls().length, 2);
  const args = env.wbCalls()[1].args;
  assert.equal(args[args.indexOf('--model') + 1], 'new-model');
  assert.ok(readEvents(run.id).events.some((e) => e.kind === 'info' && e.key === 'srv.wb.settingsChanged'));
});
