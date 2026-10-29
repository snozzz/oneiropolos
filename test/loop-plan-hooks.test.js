import assert from 'node:assert/strict';
import test from 'node:test';
import { gpt, setupFakeEnv, shellJs } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', { assessment: 'plan v1', next_instruction: 'create a.txt' }),
    gpt('continue', { assessment: 'plan v2 with tests', next_instruction: 'create a.txt and a test' }),
    gpt('done', { assessment: 'all good' }),
  ],
  wbCalls: [{ writeFiles: { 'a.txt': 'A' }, result: 'success', text: '## What was done\nwrote a' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test('Plan Mode: a message revises the plan, approval starts execution; hooks inject context and ask the user', async (t) => {
  t.after(env.cleanup);
  env.writeHook('onSessionStart', [{ description: 'ctx', hooks: [{ type: 'context', content: 'SESSION-CONTEXT-42' }] }]);
  env.writeHook('onUserMessage', [{ description: 'tag', hooks: [{ type: 'command', command: shellJs('console.log(JSON.stringify({additionalContext:"from-hook"}))') }] }]);
  env.writeHook('beforeSubAgentStart', [{ description: 'pre', hooks: [{ type: 'context', content: 'BEFORE-AGENT-CONTEXT' }] }]);
  env.writeHook('onSubAgentComplete', [{ description: 'ask', hooks: [{ type: 'prompt', prompt: 'Anything to add before GPT audits?' }] }]);
  const settings = { ...env.settings, loop: { maxRounds: 5, finalReview: false }, agents: { mode: 'plan' } };
  const run = createTask({ goal: 'plan goal', workdir: env.work, settings });
  const seen = [];
  let asked = false;
  let changed = false;
  const orch = new Orchestrator(run.id, {
    onEvent: (ev) => {
      seen.push(ev.kind);
      if (ev.kind === 'plan.approval' && !changed) {
        changed = true;
        appendControl(run.id, { cmd: 'message', text: 'please add a test' });
      } else if (ev.kind === 'plan.approval') {
        appendControl(run.id, { cmd: 'approve', text: 'go' });
      }
      if (ev.kind === 'ask' && !asked) {
        asked = true;
        appendControl(run.id, { cmd: 'message', text: 'looks fine' });
      }
    },
  });
  await orch.run();
  const s = readState(run.id);

  assert.equal(s.status, 'done', s.message);
  assert.equal(s.planApproved, true);
  assert.equal(s.round, 1, 'the first proposed round was dropped when the plan was revised');
  assert.equal(seen.filter((k) => k === 'plan.approval').length, 2, 'the revised plan needs approval again');
  const codex = env.codexCalls();
  assert.ok(codex[0].prompt.includes('SESSION-CONTEXT-42'), 'onSessionStart context goes to the planner');
  assert.ok(codex[0].instructions.includes('Plan Mode: the user approves your plan'));
  assert.ok(codex[1].prompt.includes('please add a test') && codex[1].prompt.includes('from-hook'), 'onUserMessage adds context to the message');
  const wb = env.wbCalls();
  assert.equal(wb.length, 1);
  assert.ok(wb[0].prompt.startsWith('BEFORE-AGENT-CONTEXT'), 'beforeSubAgentStart prepends context');
  assert.ok(asked, 'the onSubAgentComplete prompt hook asked the user');
  assert.ok(codex[2].prompt.includes('looks fine') && codex[2].prompt.includes('APPROVED'), 'the audit sees the answer and the approval');
  const evs = readEvents(run.id).events;
  assert.ok(evs.some((e) => e.kind === 'plan.approved' && e.note === 'go'));
  assert.ok(evs.filter((e) => e.kind === 'hook').length >= 4);
});
