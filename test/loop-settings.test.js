import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'write a.txt' }),
    gpt('done'),
    gpt('done'),
  ],
  wbCalls: [
    { sleepMs: 3000, result: 'success' },
    { sleepMs: 3000, result: 'success' },
    { writeFiles: { 'a.txt': 'A' }, result: 'success' },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('changing the active executor model interrupts the current call and keeps the queued message', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'settings retry test', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 5, finalReview: true } } });
  let changes = 0;
  const orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      if (ev.kind === 'wb.init' && changes < 2) {
        changes += 1;
        appendControl(run.id, { cmd: 'settings', patch: { workbuddy: { model: changes === 1 ? 'new-model' : 'third-model' } } });
        if (changes === 1) appendControl(run.id, { cmd: 'message', text: 'also keep the new requirement' });
      }
    },
  });
  await orch.run();

  const s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  assert.equal(s.settings.workbuddy.model, 'third-model');
  const wb = env.wbCalls();
  assert.equal(wb.length, 3, 'both active calls were replaced before the final call');
  assert.equal(wb[1].args[wb[1].args.indexOf('--model') + 1], 'new-model');
  assert.equal(wb[2].args[wb[2].args.indexOf('--model') + 1], 'third-model');
  assert.ok(env.codexCalls().some((c) => c.prompt.includes('also keep the new requirement')), 'the queued message reaches the lead');
  assert.ok(readEvents(run.id).events.some((e) => e.kind === 'info' && e.key === 'srv.wb.settingsChanged'));
});
