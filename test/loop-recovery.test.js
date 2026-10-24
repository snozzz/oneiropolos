import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  badModels: ['bad-model'],
  models: ['bad-model', 'good-model', 'third-model'],
  codexTurns: [
    'Sure, let me look at the directory first… (not JSON)',
    gpt('continue', { next_instruction: 'create main.py' }),
    gpt('done'),
    gpt('continue', { assessment: 'tests are missing', issues: [{ severity: 'major', detail: 'no tests' }], next_instruction: 'add test_main.py' }),
    gpt('done'),
    gpt('done', { assessment: 'review passed' }),
  ],
  wbCalls: [
    { writeFiles: { 'main.py': 'print(1)' }, result: 'crash' },
    { writeFiles: { 'main2.py': 'print(2)' }, result: 'success' },
    { writeFiles: { 'test_main.py': 'pass' }, result: 'success' },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, readState } = await import('../src/store.js');
const { defaultCodexModel } = await import('../src/codex.js');

test('model fallback, JSON retry, continuing after a crash, fixing what the review found', async (t) => {
  t.after(env.cleanup);
  const run = createTask({ goal: 'recovery test', workdir: env.work, settings: { ...env.settings, workbuddy: { ...env.settings.workbuddy, effort: 'off' } } });
  assert.equal(run.settings.codex.model, 'bad-model');
  await new Orchestrator(run.id).run();
  const s = readState(run.id);

  assert.equal(s.status, 'done', s.message);
  assert.equal(s.settings.codex.model, 'good-model', 'switched to a usable model');
  assert.equal(defaultCodexModel(), 'good-model', 'the usable model becomes the default');
  assert.equal(s.round, 2);
  assert.equal(s.reviewCount, 2);
  assert.equal(s.rounds[0].worker.continuations, 1, 'continued after the crash');
  assert.equal(s.rounds[1].source, 'reviewer', "round 2's instruction came from the reviewer");
  assert.ok(s.rounds[1].reviewerNote.includes('no tests'));

  const codex = env.codexCalls();
  const models = codex.map((c) => c.model);
  assert.equal(models[0], 'bad-model');
  assert.ok(models.slice(1).every((m) => m === 'good-model'));
  assert.ok(codex[2].resume && codex[2].prompt.includes('could not be parsed'), 'invalid JSON: asked again in the same session');
  const auditAfterReview = codex.find((c) => c.prompt.includes('the independent Reviewer found the goal NOT finished'));
  assert.ok(auditAfterReview, "the reviewer's findings reach the Lead");

  const wb = env.wbCalls();
  assert.ok(!wb[0].args.includes('--effort'), 'thinking off: no --effort');
  assert.equal(JSON.parse(wb[0].args[wb[0].args.indexOf('--settings') + 1]).alwaysThinkingEnabled, false, 'thinking off');
  assert.ok(wb[1].prompt.includes('continuation'));
  assert.ok(wb[2].prompt.includes('add test_main.py'));

  const events = readEvents(run.id).events;
  assert.ok(events.some((e) => e.kind === 'info' && e.key === 'srv.gpt.modelSwitch' && /good-model/.test(e.text)));
  assert.ok(events.some((e) => e.kind === 'gpt.error' && /format/i.test(e.message)));
  assert.ok(events.some((e) => e.kind === 'wait'), 'a short wait after the crash before continuing');
});
