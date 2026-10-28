import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'write a.txt' }),
    gpt('done'),
  ],
  wbCalls: [
    { result: 'error', error: 'insufficient credits' },
    { writeFiles: { 'a.txt': 'A' }, result: 'success' },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('a manual pause received after a problem pause blocks a following model change', { timeout: 10000 }, async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'remain paused after a manual pause', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 3, finalReview: false } } });
  let handled = false;
  let orch;
  orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      if (ev.kind !== 'run.status' || ev.status !== 'paused' || handled) return;
      handled = true;
      // These commands deliberately arrive in this order while the automatic pause is waiting.
      appendControl(run.id, { cmd: 'pause' });
      appendControl(run.id, { cmd: 'settings', patch: { workbuddy: { model: 'new-model' } } });
      setTimeout(() => orch.pollControl().catch(() => {}), 10);
      setTimeout(() => {
        appendControl(run.id, { cmd: 'stop' });
        orch.pollControl().catch(() => {});
      }, 120);
    },
  });
  await orch.run();

  const s = readState(run.id);
  const events = readEvents(run.id).events;
  const pausedAt = events.findIndex((e) => e.kind === 'run.status' && e.status === 'paused' && e.key === 'srv.pause.wbCredits');
  assert.equal(s.status, 'stopped', s.message);
  assert.equal(s.settings.workbuddy.model, 'new-model');
  assert.ok(pausedAt >= 0);
  assert.equal(events.slice(pausedAt + 1).some((e) => e.kind === 'run.status' && e.status === 'running'), false, 'manual pause prevented automatic resume');
  assert.equal(env.wbCalls().length, 1, 'the second call never started while paused');
});
