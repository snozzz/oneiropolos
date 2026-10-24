import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'create a.txt' }),
    gpt('continue', { next_instruction: 'create b.txt' }),
    gpt('done', { assessment: 'both files are written' }),
    'Side answer: progress is fine.',
  ],
  wbCalls: [
    { writeFiles: { 'a.txt': 'A' }, result: 'success', text: '## What was done\nwrote a' },
    { writeFiles: { 'b.txt': 'B' }, result: 'success', text: '## What was done\nwrote b' },
  ],
});

const svc = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, readState } = await import('../src/store.js');

test('rollback to a round, undo it, export the conversation, side question, project files', async (t) => {
  t.after(env.cleanup);
  const run = svc.createTask({ goal: 'test goal\nsecond line with details', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 5, finalReview: false } } });
  await new Orchestrator(run.id).run();
  assert.equal(readState(run.id).status, 'done');
  fs.writeFileSync(path.join(env.work, 'mine.txt'), 'added by the user later');

  const cps = await svc.listCheckpoints(run.id);
  assert.equal(cps.enabled, true);
  assert.deepEqual(cps.points.map((p) => p.label), ['End of round 2', 'End of round 1', 'Before round 1'], 'identical neighbours are merged');
  assert.equal(cps.points[1].alias, 'Before round 2');
  const start = cps.points[2];

  const preview = await svc.restorePreview(run.id, start.commit);
  assert.deepEqual(preview.files.map((f) => `${f.status} ${f.path}`).sort(), ['D a.txt', 'D b.txt', 'D mine.txt']);
  await assert.rejects(svc.restoreRun(run.id, 'deadbeef'), /Snapshot not found/);

  const r = await svc.restoreRun(run.id, start.commit);
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readdirSync(env.work), [], 'restored to before round 1: the directory is empty');
  const s = readState(run.id);
  assert.equal(s.restores.length, 1);
  assert.ok(s.userMessages.at(-1).text.includes('restored the working directory to the snapshot "Before round 1"'), 'GPT is told next time');
  assert.ok(readEvents(run.id).events.some((e) => e.kind === 'restore'));

  const again = await svc.listCheckpoints(run.id);
  const safety = again.points.find((p) => p.kind === 'safety');
  assert.ok(safety, 'the state before the rollback is a point to return to');
  await svc.restoreRun(run.id, safety.commit);
  assert.deepEqual(fs.readdirSync(env.work).sort(), ['a.txt', 'b.txt', 'mine.txt'], "undo: even the user's own file is back");

  const md = svc.exportMarkdown(run.id);
  assert.ok(md.startsWith('# test goal\n'), md.slice(0, 80));
  assert.ok(md.includes('### WorkBuddy · Round 1') && md.includes('wrote b') && md.includes('both files are written'));
  assert.ok(md.includes('working directory rolled back to "Before round 1"'));
  const ex = svc.exportRun(run.id);
  assert.ok(fs.existsSync(ex.path) && ex.path.endsWith(`${run.id}.md`));
  fs.rmSync(ex.path, { force: true });

  const threadBefore = readState(run.id).gpt.threadId;
  const aside = svc.askAside(run.id, 'How is it going?');
  assert.equal(aside.status, 'running');
  assert.throws(() => svc.askAside(run.id, 'one more'), /still being answered/);
  let list;
  for (let i = 0; i < 100; i++) {
    list = svc.listAsides(run.id);
    if (list[0].status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(list[0].status, 'done', JSON.stringify(list[0]));
  assert.ok(list[0].answer.includes('Side answer'));
  const call = env.codexCalls().at(-1);
  assert.equal(call.args[call.args.indexOf('-s') + 1], 'read-only', 'side questions are read-only');
  assert.ok(!call.args.includes('--output-schema') && call.prompt.includes('How is it going?'));
  assert.ok(call.instructions.includes("Oneiropolos' advisor"), 'the advisor system prompt is used');
  assert.equal(readState(run.id).gpt.threadId, threadBefore, "the task's GPT session is untouched");

  const files = await svc.listProjectFiles(env.work);
  assert.deepEqual(files.files.sort(), ['a.txt', 'b.txt', 'mine.txt']);
  assert.deepEqual(svc.cleanupRuns({ days: 1 }), { deleted: 0 }, 'a task that just finished is kept');
  assert.ok(fs.existsSync(path.join(env.home, 'runs', run.id)));
});
