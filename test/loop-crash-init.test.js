import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const LONG = `Create main.py. ${'Detailed requirement. '.repeat(600)}Last requirement: write comments.`;
const env = setupFakeEnv({
  codexTurns: [gpt('continue', { next_instruction: LONG }), gpt('done'), gpt('done')],
  wbCalls: [{ result: 'crash_before_init' }, { writeFiles: { 'main.py': 'x' }, result: 'success' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readState } = await import('../src/store.js');

test('WorkBuddy crashes on launch: a new session id and the full instruction again', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'crash test', workdir: env.work, settings: env.settings });
  await new Orchestrator(run.id).run();
  assert.equal(readState(run.id).status, 'done');
  const [first, second] = env.wbCalls();
  const sid = (c) => c.args[c.args.indexOf('--session-id') + 1];
  assert.ok(first.args.includes('--session-id') && second.args.includes('--session-id'), 'both create a session');
  assert.notEqual(sid(first), sid(second), 'the second one uses a new session id');
  assert.ok(second.prompt.includes('Last requirement: write comments.'), 'the full instruction is sent again, not truncated');
  assert.ok(!second.prompt.includes('continuation'));
  assert.ok(!first.args.includes('--effort'), 'no effort chosen: the model default, no --effort');
});
