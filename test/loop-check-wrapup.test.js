import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'create a.txt' }),
    gpt('continue', { next_instruction: 'create b.txt' }),
    gpt('continue', { assessment: 'wrap-up: a is done, b is missing', next_instruction: 'rewritten: create b.txt and add a test', progress: 60 }),
  ],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, result: 'success', text: '## What was done\nwrote a' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, readState } = await import('../src/store.js');

test('the check command runs every round and goes to GPT; at the round limit GPT wraps up before pausing', async (t) => {
  t.after(env.cleanup);
  const settings = { ...env.settings, loop: { maxRounds: 1, finalReview: false, checkCommand: process.platform === 'win32' ? 'echo CHECK-OK & type a.txt & exit /b 3' : 'echo CHECK-OK; cat a.txt; exit 3' } };
  const run = createTask({ goal: 'test goal', workdir: env.work, settings });
  const orch = new Orchestrator(run.id);
  const watcher = setInterval(() => {
    if (readState(run.id).status === 'paused') orch.requestStop();
  }, 20);
  await orch.run();
  clearInterval(watcher);
  const s = readState(run.id);

  assert.equal(s.status, 'stopped');
  assert.equal(s.rounds[0].check.code, 3, 'the exit code is recorded as is');
  assert.equal(s.rounds[0].check.ok, false);
  const codex = env.codexCalls();
  assert.equal(codex.length, 3, 'plan, audit of round 1, wrap-up');
  assert.ok(codex[0].prompt.includes('echo CHECK-OK'), 'GPT learns about the check command while planning');
  assert.ok(codex[1].prompt.includes('Check command') && codex[1].prompt.includes('CHECK-OK') && codex[1].prompt.includes('exit code 3'), 'the audit prompt carries the check output');
  assert.ok(codex[0].instructions.includes('Evidence required before "done"') && codex[1].prompt.includes('not just "tests pass"'), '"done" needs evidence');
  assert.ok(codex[2].prompt.includes('reached the round limit'), 'round 2 exceeds the limit: wrap-up');
  assert.equal(env.wbCalls().length, 1, 'the round beyond the limit never reached WorkBuddy');
  assert.equal(s.rounds[1].wrapUp.verdict, 'continue');
  assert.equal(s.rounds[1].instruction, 'rewritten: create b.txt and add a test', 'continuing uses the instruction GPT rewrote in the wrap-up');
  assert.equal(s.progress, 60);
  const evs = readEvents(run.id).events;
  const check = evs.find((e) => e.kind === 'round.check');
  assert.ok(check && check.output.includes('CHECK-OK') && check.output.includes('A'), JSON.stringify(check));
  assert.ok(evs.some((e) => e.kind === 'gpt.result' && e.label === 'wrapup-2'));
  assert.ok(evs.some((e) => e.kind === 'run.status' && e.status === 'paused' && e.key === 'srv.pause.maxRounds'));
});
