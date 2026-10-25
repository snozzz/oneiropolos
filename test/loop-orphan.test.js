import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [gpt('continue', { next_instruction: 'create a.txt' }), gpt('done')],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, sleepMs: 8000, result: 'success' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, runDir } = await import('../src/store.js');

test('a runner whose task folder is deleted stops quickly and does not bring the folder back', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'orphan test', workdir: env.work, settings: env.settings });
  const orch = new Orchestrator(run.id);
  const done = orch.run();
  const end = Date.now() + 20_000;
  while (!readEvents(run.id).events.some((e) => e.kind === 'wb.tool')) {
    if (Date.now() > end) throw new Error('WorkBuddy never started');
    await new Promise((r) => setTimeout(r, 100));
  }
  fs.rmSync(runDir(run.id), { recursive: true, force: true });
  const t0 = Date.now();
  await done;
  assert.ok(Date.now() - t0 < 5000, 'the runner ends within a few seconds');
  assert.equal(orch.orphaned, true);
  assert.equal(fs.existsSync(runDir(run.id)), false, 'the deleted folder stays deleted');
});
