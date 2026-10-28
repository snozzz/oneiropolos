import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'inspect the project' }),
    '## What was done\ninspected',
    gpt('done'),
  ],
  wbCalls: [],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test.after(() => {
  env.cleanup();
});

test('changing away from an unauthenticated WorkBuddy executor resumes the task', { timeout: 10000 }, async () => {
  // This is the pre-call login check in runWorkRound, rather than a CLI auth error.
  fs.writeFileSync(process.env.WBLOOP_WB_AUTH_FILE, '{}');
  const run = createTask({
    goal: 'recover from WorkBuddy login pause',
    workdir: env.work,
    settings: {
      ...env.settings,
      roles: { executor: { engine: 'workbuddy', model: 'auto', effort: 'high' } },
      loop: { maxRounds: 3, finalReview: false },
    },
  });
  let changed = false;
  let orch;
  orch = new Orchestrator(run.id, {
    onEvent: (event) => {
      if (event.kind !== 'run.status' || event.status !== 'paused' || changed) return;
      assert.equal(event.key, 'srv.pause.wbLogin');
      changed = true;
      appendControl(run.id, { cmd: 'settings', patch: { roles: { executor: { engine: 'chatgpt', model: 'good-model', effort: 'high' } } } });
      setTimeout(() => orch.pollControl().catch(() => {}), 10);
    },
  });
  await orch.run();

  const state = readState(run.id);
  const events = readEvents(run.id).events;
  assert.equal(state.status, 'done', state.message);
  assert.equal(state.settings.roles.executor.engine, 'chatgpt');
  assert.ok(events.some((event) => event.kind === 'run.status' && event.status === 'paused' && event.key === 'srv.pause.wbLogin'));
  assert.ok(events.some((event) => event.kind === 'run.status' && event.status === 'running'));
  assert.equal(env.wbCalls().length, 0);
  assert.ok(env.codexCalls().some((call) => call.resume === false), 'the switched executor starts with the ChatGPT adapter');
});
