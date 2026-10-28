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

test('changing the executor model automatically resumes a quota pause', { timeout: 10000 }, async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'recover after an executor pause', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 3, finalReview: false } } });
  let changed = false;
  let orch;
  orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      if (ev.kind !== 'run.status' || ev.status !== 'paused' || changed) return;
      changed = true;
      appendControl(run.id, { cmd: 'settings', patch: { workbuddy: { model: 'new-model' } } });
      setTimeout(() => orch.pollControl().catch(() => {}), 10);
    },
  });
  await orch.run();

  const s = readState(run.id);
  const events = readEvents(run.id).events;
  assert.equal(s.status, 'done', s.message);
  assert.equal(s.settings.workbuddy.model, 'new-model');
  assert.ok(events.some((e) => e.kind === 'run.status' && e.status === 'paused' && e.key === 'srv.pause.wbCredits'));
  assert.ok(events.some((e) => e.kind === 'run.status' && e.status === 'running'), 'the settings change resumed the problem pause');
  const wb = env.wbCalls();
  assert.equal(wb.length, 2);
  assert.equal(wb[1].args[wb[1].args.indexOf('--model') + 1], 'new-model');
});
