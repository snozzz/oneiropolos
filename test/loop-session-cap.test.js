// A big executor session is restarted with a handover note at the next round; a big lead thread continues from a recap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'create a.txt' }),
    gpt('continue', { next_instruction: 'create b.txt' }),
    gpt('continue', { next_instruction: 'create c.txt' }),
    gpt('done'),
  ],
  wbCalls: [
    { writeFiles: { 'a.txt': 'A' }, contextTokens: 150_000 },
    { writeFiles: { 'b.txt': 'B' }, contextTokens: 20_000 },
    { writeFiles: { 'c.txt': 'C' }, contextTokens: 30_000 },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readState } = await import('../src/store.js');

test('session cap: the executor starts fresh after a round whose context passed the cap', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'cap goal', workdir: env.work, settings: { ...env.settings, loop: { ...env.settings.loop, finalReview: false, sessionCapK: 100 } } });
  await new Orchestrator(run.id).run();
  const s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  const wb = env.wbCalls();
  assert.equal(wb.length, 3);
  assert.ok(wb[1].args.includes('--session-id'), 'round 2 starts a new session');
  assert.match(wb[1].prompt, /\[Handover\]/);
  assert.ok(wb[2].resume, 'round 3 resumes the small new session');
  assert.equal(s.stats.wbIn, 200_000);
  assert.equal(s.stats.wbCachedIn, 180_000);
});
