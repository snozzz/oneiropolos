import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    { ...gpt('continue', { next_instruction: 'write a.txt' }), __sleepMs: 100 },
    gpt('done'),
  ],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, result: 'success' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('changing the model does not resume a manual pause', { timeout: 10000 }, async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'keep manually paused', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 3, finalReview: false } } });
  let pauseSent = false;
  let settingsSent = false;
  let orch;
  orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      if (ev.kind === 'gpt.thread' && ev.label === 'plan' && !pauseSent) {
        pauseSent = true;
        appendControl(run.id, { cmd: 'pause' });
        setTimeout(() => orch.pollControl().catch(() => {}), 10);
      }
      if (ev.kind === 'run.status' && ev.status === 'paused' && !settingsSent) {
        settingsSent = true;
        appendControl(run.id, { cmd: 'settings', patch: { codex: { model: 'new-model' } } });
        setTimeout(() => orch.pollControl().catch(() => {}), 10);
        setTimeout(() => {
          appendControl(run.id, { cmd: 'stop' });
          orch.pollControl().catch(() => {});
        }, 100);
      }
    },
  });
  await orch.run();

  const s = readState(run.id);
  const events = readEvents(run.id).events;
  assert.equal(s.status, 'stopped', s.message);
  assert.equal(s.settings.codex.model, 'new-model');
  assert.ok(events.some((e) => e.kind === 'run.status' && e.status === 'paused' && e.key === 'srv.paused'));
  assert.equal(events.filter((e) => e.kind === 'wb.start').length, 0, 'the manually paused task never resumed into work');
  assert.equal(env.codexCalls().length, 1);
});
