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
    gpt('done'),
    gpt('done', { assessment: 'review passed' }),
  ],
  wbCalls: [
    { writeFiles: { 'a.txt': 'A' }, result: 'max_turns', liveSleepMs: 500 },
    { writeFiles: { 'a2.txt': 'A2' }, result: 'success', text: '## What was done\nwrote a' },
    { writeFiles: { 'b.txt': 'B' }, result: 'success', text: '## What was done\nwrote b' },
  ],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, readState } = await import('../src/store.js');

test('full loop: plan → work (auto-continue after the step limit) → audit → work → audit → independent review → done', async (t) => {
  t.after(env.cleanup);
  const settings = { ...env.settings, workbuddy: { ...env.settings.workbuddy, effort: 'max', contextWindow: 600000 } };
  const run = createTask({ goal: 'test goal', workdir: env.work, settings });
  // watch live.json while it runs: WorkBuddy's partial output must reach the UI live
  const liveFile = path.join(env.home, 'runs', run.id, 'live.json');
  const seen = [];
  const watcher = setInterval(() => {
    try {
      const snap = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
      if (snap.blocks?.length) seen.push(snap);
    } catch {
      // not yet
    }
  }, 15);
  await new Orchestrator(run.id).run();
  clearInterval(watcher);
  const s = readState(run.id);

  assert.equal(s.status, 'done', s.message);
  assert.equal(s.round, 2);
  assert.equal(s.reviewCount, 1);
  assert.equal(s.progress, 100);
  assert.equal(s.rounds[0].worker.continuations, 1, 'round 1 continues automatically once');
  assert.equal(s.rounds[0].diffFiles, 2, 'round 1 changed a.txt and a2.txt');
  assert.equal(s.rounds[1].diffFiles, 1);
  assert.equal(s.rounds[1].audit.verdict, 'done');

  const wb = env.wbCalls();
  assert.equal(wb.length, 3);
  assert.ok(wb[0].args.includes('--session-id'), 'the first call uses --session-id');
  assert.ok(wb[1].resume && wb[1].prompt.includes('continuation'), 'a continuation resumes the session');
  assert.ok(wb[2].resume, 'later rounds resume the same session');
  assert.equal(wb[0].env.lite, '1');
  const disallowed = wb[0].args[wb[0].args.indexOf('--disallowedTools') + 1];
  assert.ok(disallowed.includes('TeamCreate') && disallowed.includes('AskUserQuestion'), disallowed);
  const tools = wb[0].args[wb[0].args.indexOf('--tools') + 1].split(',');
  assert.ok(tools.includes('Bash') && tools.includes('Agent') && !tools.includes('TeamCreate') && !tools.includes('AskUserQuestion'), tools.join(','));
  assert.ok(wb[0].env.product.startsWith(env.home), 'the product overlay lives in the data directory');
  assert.equal(wb[0].args[wb[0].args.indexOf('--effort') + 1], 'max', 'the effort goes through --effort');
  const wbSettings = JSON.parse(wb[0].args[wb[0].args.indexOf('--settings') + 1]);
  assert.equal(wbSettings.contextWindow, 600000, 'the context window goes through --settings');
  assert.ok(wbSettings.hooks.PreToolUse[0].hooks[0].command.includes('hook-gate.js'), 'the safety gate is installed as a PreToolUse hook');
  assert.equal(wbSettings.hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
  assert.ok(wb[0].system.startsWith('# Oneiropolos · Executor') && !wb[0].replaced, 'the brief is appended to WorkBuddy\'s own prompt');
  assert.ok(wb[0].system.includes('agent_explore') && wb[0].system.includes('Project notebook'), 'sub-agents and the notebook are described');
  const agents = JSON.parse(wb[0].args[wb[0].args.indexOf('--agents') + 1]);
  assert.deepEqual(Object.keys(agents).sort(), ['agent_analyze', 'agent_debug', 'agent_explore', 'agent_general', 'agent_plan', 'agent_qa']);
  assert.ok(agents.agent_explore.tools.includes('Read') && !agents.agent_explore.tools.includes('Write'), 'the explorer is read-only');
  assert.ok(wb[0].args.includes('--include-partial-messages'), 'partial output is on');
  assert.ok(seen.some((snap) => snap.round === 1 && snap.blocks[0].type === 'thinking' && snap.blocks[0].text === '先想一想再动手'), `the UI sees the thinking live: ${JSON.stringify(seen.slice(0, 2))}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(liveFile, 'utf8')).blocks, [], 'the live content is cleared afterwards');
  const raw = fs.readFileSync(path.join(env.home, 'runs', run.id, 'rounds', '1', 'workbuddy.jsonl'), 'utf8');
  assert.ok(raw.includes('"type":"result"') && !raw.includes('stream_event'), 'the raw log keeps no deltas');
  const toolEv = readEvents(run.id).events.find((e) => e.kind === 'wb.tool');
  assert.equal(toolEv.input.file, 'a.txt', 'tool events carry detailed arguments for the UI');
  assert.equal(toolEv.input.content, 'A');
  assert.ok(wb[2].args.includes('--effort'), 'resumed sessions get the effort too');
  assert.ok(wb[0].prompt.includes('create a.txt'));
  const product = JSON.parse(fs.readFileSync(wb[0].env.product, 'utf8'));
  assert.equal(product.authentication.id, 'wbloop-cli', 'credentials are separate from the desktop app');

  const codex = env.codexCalls();
  assert.equal(codex.length, 4);
  assert.equal(codex[0].resume, false);
  assert.ok(codex[1].resume && codex[2].resume, 'audits resume the same GPT session');
  assert.equal(codex[3].resume, false, 'the independent review is a fresh session');
  assert.ok(codex[3].instructions.startsWith('# Oneiropolos · Reviewer') && codex[3].prompt.includes('Their completion statement'));
  assert.ok(codex[0].instructions.startsWith('# Oneiropolos · Lead'), 'the lead brief');
  assert.ok(codex[0].args.some((a) => a.startsWith('developer_instructions=')) && !codex[0].replaced, "Codex keeps its own base instructions");
  assert.ok(codex[1].prompt.includes('a.txt') && codex[1].prompt.includes('a2.txt'), 'the audit prompt has the round diff');
  assert.ok(codex[0].args.includes('--ignore-user-config'));
  assert.ok(codex[0].args.includes('--output-schema'));
  // the working directory is in the temp dir → GPT gets the fully read-only sandbox
  assert.equal(codex[0].args[codex[0].args.indexOf('-s') + 1], 'read-only');

  const kinds = new Set(readEvents(run.id).events.map((e) => e.kind));
  for (const k of ['phase', 'gpt.start', 'gpt.item', 'gpt.result', 'wb.start', 'wb.init', 'wb.tool', 'wb.tool_result', 'wb.end', 'round.diff', 'audit.start', 'done']) {
    assert.ok(kinds.has(k), `missing event ${k}`);
  }
  // no program files may appear in the project directory
  assert.deepEqual(fs.readdirSync(env.work).sort(), ['a.txt', 'a2.txt', 'b.txt']);
  assert.ok(fs.existsSync(path.join(env.home, 'runs', run.id, 'shadow.git', 'HEAD')));
});
