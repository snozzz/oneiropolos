import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'create a.txt' }),
    gpt('continue', { assessment: 'budget wrap-up', next_instruction: 'create a.txt later' }),
  ],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, result: 'success' }],
});

const { createTask, controlRun } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, readState } = await import('../src/store.js');

test('token budget: the round does not start; GPT wraps up and the task pauses', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'budget goal', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 5, finalReview: false, tokenBudgetM: 0.000001 } } });
  const orch = new Orchestrator(run.id);
  const watcher = setInterval(() => {
    if (readState(run.id).status === 'paused') orch.requestStop();
  }, 20);
  await orch.run();
  clearInterval(watcher);
  const s = readState(run.id);
  assert.equal(s.status, 'stopped');
  const evs = readEvents(run.id).events;
  assert.ok(evs.some((e) => e.kind === 'run.status' && e.status === 'paused' && e.key === 'srv.pause.budget'), JSON.stringify(evs.filter((e) => e.kind === 'run.status')));
  assert.ok(env.codexCalls().some((c) => c.prompt.includes('token budget')), 'the wrap-up names the budget');
  assert.throws(() => controlRun(run.id, 'approve'), /not waiting for plan approval/);
});
