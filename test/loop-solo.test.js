// No lead: the executor works on the goal directly; a failing check sends it back; a later message is a new round.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [],
  wbCalls: [
    { writeFiles: { 'a.txt': 'A' }, text: '## What was done\nWrote a.txt' },
    { writeFiles: { 'b.txt': 'B' }, text: '## What was done\nWrote b.txt, the check passes' },
    { writeFiles: { 'c.txt': 'C' }, text: '## What was done\nWrote c.txt' },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readState } = await import('../src/store.js');

test('lead off: goal → executor; failing check → executor again; done; a message → one more round', async (t) => {
  t.after(env.cleanup);
  const check = process.platform === 'win32' ? 'if exist b.txt (exit /b 0) else (exit /b 1)' : 'test -f b.txt';
  const run = createTask({ goal: 'write the files', workdir: env.work, settings: { ...env.settings, loop: { ...env.settings.loop, useLead: false, checkCommand: check } } });
  await new Orchestrator(run.id).run();
  let s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  assert.equal(s.round, 2);
  assert.equal(env.codexCalls().length, 0, 'no lead calls at all');
  let wb = env.wbCalls();
  assert.equal(wb.length, 2);
  assert.match(wb[0].prompt, /\[Round 1 · the user's request\]\n\nwrite the files/);
  assert.match(wb[0].system, /You work alone on the user's task/);
  assert.match(wb[1].prompt, /the check command failed/);
  assert.ok(wb[1].resume, 'the fix continues the same session');
  assert.match(s.message, /Wrote b\.txt, the check passes/);

  appendControl(run.id, { cmd: 'message', text: 'also write c.txt' });
  await new Orchestrator(run.id).run();
  s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  wb = env.wbCalls();
  assert.equal(wb.length, 3);
  assert.match(wb[2].prompt, /\[Round 3 · the user's request\]\n\nalso write c\.txt/);
  assert.equal(env.codexCalls().length, 0);
});
