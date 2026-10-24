import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { next_instruction: 'create a.txt' }),
    gpt('done'),
    gpt('done', { assessment: 'review passed' }),
    gpt('done', { assessment: 'added the README note' }),
    gpt('done', { assessment: 'second review passed' }),
  ],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, result: 'success' }],
});

const { createTask, resolveStartAt } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('scheduled start waits until the time, "continue" starts early; a message sent during the review is not dropped', async (t) => {
  t.after(env.cleanup);
  assert.equal(resolveStartAt(new Date(Date.now() + 5000).toISOString()), null, 'within half a minute means now');
  assert.throws(() => resolveStartAt(new Date(Date.now() + 8 * 86400_000).toISOString()), /7 days/);
  const startAt = new Date(Date.now() + 3600_000).toISOString();
  const run = createTask({ goal: 'test goal', workdir: env.work, settings: env.settings, startAt });
  assert.equal(readState(run.id).scheduledAt, startAt);

  let waitingSeen = false;
  let reviewMessageSent = false;
  const orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      if (ev.kind === 'schedule') {
        const s = readState(run.id);
        waitingSeen = s.status === 'waiting' && s.messageKey === 'srv.schedule.waiting' && /Scheduled start/.test(s.message);
        setTimeout(() => appendControl(run.id, { cmd: 'resume' }), 200);
      }
      if (ev.kind === 'gpt.start' && ev.label === 'review-1' && !reviewMessageSent) {
        reviewMessageSent = true;
        appendControl(run.id, { cmd: 'message', text: 'add one line to the README' });
      }
    },
  });
  const started = Date.now();
  await orch.run();
  const s = readState(run.id);

  assert.ok(waitingSeen, 'while waiting the status says "Scheduled start"');
  assert.ok(Date.now() - started < 15_000, 'started early, did not wait an hour');
  assert.equal(s.status, 'done', s.message);
  assert.equal(s.scheduledAt, null);
  const codex = env.codexCalls();
  const review1 = codex.find((c) => c.prompt.includes('Their completion statement'));
  assert.ok(review1);
  const followup = codex.find((c) => c.prompt.includes('add one line to the README') && c.prompt.includes("The user's reply / new requirements"));
  assert.ok(followup, 'a message received during the review goes to the Lead before finishing');
  assert.equal(s.userMessages.length, 0);
  assert.ok(readEvents(run.id).events.some((e) => e.kind === 'schedule'));
});
