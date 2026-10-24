import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    { ...gpt('continue', { next_instruction: 'slowly write a.txt' }), __sleepMs: 8000 },
    gpt('continue', { next_instruction: 'slowly write a.txt' }),
    gpt('done', { assessment: 'as you asked, the README alone is enough' }),
  ],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, sleepMs: 8000, result: 'success' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('interrupt: both a thinking GPT and a working WorkBuddy can be interrupted; the message is handled at once and the task goes on', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'test goal', workdir: env.work, settings: { ...env.settings, loop: { maxRounds: 5, finalReview: false } } });
  const started = Date.now();
  const trace = [];
  let planCut = false;
  let wbCut = false;
  const orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      trace.push(`${((Date.now() - started) / 1000).toFixed(1)} ${ev.kind}${ev.label ? `:${ev.label}` : ''}`);
      // interrupt only once the fake codex / WorkBuddy actually runs (printed its first line)
      if (ev.kind === 'gpt.thread' && ev.label === 'plan' && !planCut) {
        planCut = true;
        appendControl(run.id, { cmd: 'cut', text: 'do not forget the README in the plan' });
      }
      if (ev.kind === 'wb.init' && !wbCut) {
        wbCut = true;
        appendControl(run.id, { cmd: 'cut', text: 'stop that, only write the README instead' });
      }
    },
  });
  await orch.run();
  const s = readState(run.id);

  const why = `\n${trace.join('\n')}`;
  assert.equal(s.status, 'done', s.message);
  assert.ok(Date.now() - started < 12_000, `neither interrupt waited for the 8-second step to finish${why}`);
  const codex = env.codexCalls();
  assert.equal(codex.length, 3, why);
  assert.ok(codex[1].prompt.includes('The user just interrupted you') && codex[1].prompt.includes('do not forget the README in the plan'), `the interrupted plan is answered again with the message${why}`);
  assert.ok(codex[1].prompt.includes("## The user's goal"), 'the whole planning prompt is sent again');
  assert.equal(env.wbCalls().length, 1, 'an interrupted WorkBuddy is not continued automatically');
  assert.equal(s.rounds[0].worker.interrupted, true);
  assert.ok(codex[2].prompt.includes('interrupted by the user') && codex[2].prompt.includes('stop that, only write the README instead'), 'the audit shows the interrupt and the message');
  assert.equal(s.userMessages.length, 0, 'all messages reached GPT');
  const evs = readEvents(run.id).events;
  assert.ok(evs.some((e) => e.kind === 'user.message' && e.cut));
  assert.ok(evs.some((e) => e.kind === 'wb.end' && e.errorKind === 'cut'));
});
