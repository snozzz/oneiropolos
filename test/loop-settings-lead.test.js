import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    { ...gpt('continue', { next_instruction: 'write a.txt' }), __sleepMs: 3000 },
    gpt('continue', { next_instruction: 'write a.txt' }),
    gpt('done'),
  ],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, result: 'success' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('changing the active lead model interrupts the call and preserves a queued message', { timeout: 10000 }, async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'lead settings retry test', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 3, finalReview: false } } });
  let changed = false;
  let orch;
  orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      if (ev.kind !== 'gpt.thread' || ev.label !== 'plan' || changed) return;
      changed = true;
      appendControl(run.id, { cmd: 'settings', patch: { codex: { model: 'new-model' } } });
      appendControl(run.id, { cmd: 'message', text: 'also keep this new lead requirement' });
      // Apply the controls while the first Codex call is still in progress.
      setTimeout(() => orch.pollControl().catch(() => {}), 10);
    },
  });
  await orch.run();

  const s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  assert.equal(s.settings.codex.model, 'new-model');
  assert.equal(s.userMessages.length, 0, 'the queued message was handled by the lead');
  const codex = env.codexCalls();
  assert.equal(codex.length, 3, 'aborted plan, resumed plan, then audit');
  assert.equal(codex[0].model, 'good-model');
  assert.equal(codex[1].model, 'new-model');
  assert.equal(codex[1].resume, true, 'the lead keeps its existing session');
  assert.ok(codex[1].prompt.includes('also keep this new lead requirement'));
  assert.ok(readEvents(run.id).events.some((e) => e.kind === 'info' && e.key === 'srv.gpt.settingsChanged'));
});
