import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'create a.txt' }),
    gpt('done'),
    gpt('done'),
    gpt('continue', { next_instruction: 'create c.txt as the user asked' }),
    gpt('done'),
    gpt('done'),
  ],
  wbCalls: [
    { writeFiles: { 'a.txt': 'A' }, sleepMs: 6000, result: 'success' },
    { writeFiles: { 'a2.txt': 'A2' }, result: 'success' },
    { writeFiles: { 'c.txt': 'C' }, result: 'success' },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

async function waitForEvent(id, kind, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (readEvents(id).events.some((e) => e.kind === kind)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${kind}`);
}

test('stop while working → a new process continues from there → a message after finishing adds a requirement', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'stop and resume test', workdir: env.work, settings: env.settings });

  const first = new Orchestrator(run.id).run();
  await waitForEvent(run.id, 'wb.tool');
  appendControl(run.id, { cmd: 'stop' });
  const t0 = Date.now();
  await first;
  assert.ok(Date.now() - t0 < 5000, 'stopping takes effect quickly (kills WorkBuddy)');
  let s = readState(run.id);
  assert.equal(s.status, 'stopped');
  assert.equal(s.phase, 'work');
  assert.equal(s.rounds[0].workerInFlight, true);
  assert.equal(s.wb.sessionStarted, true);

  // the old stop command is still in the control file; the new process must ignore it
  await new Orchestrator(run.id).run();
  s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  const wb = env.wbCalls();
  assert.ok(wb[1].resume, 'resumes the original WorkBuddy session');
  assert.ok(wb[1].prompt.includes('resuming after the program was interrupted'));
  assert.equal(s.rounds[0].diffFiles, 2);

  // a new requirement after finishing
  appendControl(run.id, { cmd: 'message', text: 'also add c.txt' });
  await new Orchestrator(run.id).run();
  s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  assert.equal(s.round, 2);
  assert.ok(fs.existsSync(`${env.work}/c.txt`));
  const followup = env.codexCalls().find((c) => c.prompt.includes('also add c.txt'));
  assert.ok(followup && followup.resume, 'the new requirement goes to the same GPT session');
  assert.ok(readEvents(run.id).events.some((e) => e.kind === 'user.message'));
});
