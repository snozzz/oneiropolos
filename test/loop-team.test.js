import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({
  codexTurns: [
    gpt('continue', {
      next_instruction: 'alpha writes a.txt, beta writes b.txt; both touch shared.txt',
      team: [
        { name: 'alpha', role: 'writer A', instruction: 'write a.txt and set shared.txt to A', owns: 'a.txt' },
        { name: 'beta', role: 'writer B', instruction: 'write b.txt and set shared.txt to B', owns: 'b.txt' },
      ],
    }),
    gpt('continue', { next_instruction: 'resolve the conflict markers in shared.txt (keep both lines)' }),
    gpt('done', { assessment: 'merged and resolved' }),
  ],
  wbByMember: {
    alpha: { writeFiles: { 'a.txt': 'A', 'shared.txt': 'A\n' }, result: 'success', text: '## What was done\nalpha done' },
    beta: { writeFiles: { 'b.txt': 'B', 'shared.txt': 'B\n' }, result: 'success', text: '## What was done\nbeta done' },
  },
  wbCalls: [{ writeFiles: { 'shared.txt': 'A\nB\n' }, result: 'success', text: '## What was done\nresolved' }],
});

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, readState } = await import('../src/store.js');

test('Team Mode: teammates work in parallel in private copies, their work is merged back, conflicts go to the next round', async (t) => {
  t.after(env.cleanup);
  fs.writeFileSync(path.join(env.work, 'shared.txt'), 'base\n');
  fs.mkdirSync(path.join(env.work, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(env.work, 'node_modules', 'dep', 'index.js'), 'module.exports = 1');
  const settings = { ...env.settings, loop: { maxRounds: 5, finalReview: false }, team: { mode: 'auto', maxTeammates: 3 } };
  const run = createTask({ goal: 'team goal', workdir: env.work, settings });
  await new Orchestrator(run.id).run();
  const s = readState(run.id);

  assert.equal(s.status, 'done', s.message);
  assert.equal(s.round, 2);
  const r1 = s.rounds[0];
  assert.deepEqual(r1.team.map((m) => m.name), ['alpha', 'beta']);
  assert.deepEqual(r1.merge.conflicts, ['shared.txt'], 'both changed shared.txt');
  assert.deepEqual(r1.merge.merged.sort(), ['alpha', 'beta']);
  assert.ok(r1.teamState.alpha.done && r1.teamState.beta.done);
  assert.deepEqual(r1.teamState.alpha.files.sort(), ['A a.txt', 'M shared.txt']);
  assert.equal(s.stats.teamRounds, 1);

  const calls = env.wbCalls();
  const alpha = calls.find((c) => c.member === 'alpha');
  const beta = calls.find((c) => c.member === 'beta');
  assert.ok(alpha.cwd.includes(path.join('team', 'r1', 'alpha', 'ws')), alpha.cwd);
  assert.ok(beta.cwd.includes(path.join('team', 'r1', 'beta', 'ws')));
  assert.ok(alpha.system.includes('Team Mode — you are teammate "alpha" (writer A)'), 'teammate system prompt');
  assert.ok(alpha.prompt.includes('BOARD.md') && alpha.prompt.includes('- beta (writer B)'), 'board and roster in the prompt');
  const addDirs = alpha.args.filter((a, i) => alpha.args[i - 1] === '--add-dir');
  assert.ok(addDirs.some((d) => d.endsWith(path.join('team', 'r1'))), 'teammates can write the board');

  // the copies had the dependencies, are gone afterwards, and never leaked into the project
  assert.ok(!fs.existsSync(path.join(env.home, 'runs', run.id, 'team', 'r1', 'alpha', 'ws')), 'workspaces removed after the merge');
  assert.deepEqual(fs.readdirSync(env.work).sort(), ['a.txt', 'b.txt', 'node_modules', 'shared.txt']);
  assert.equal(fs.readFileSync(path.join(env.work, 'shared.txt'), 'utf8'), 'A\nB\n', 'round 2 resolved the conflict');

  const codex = env.codexCalls();
  assert.ok(codex[0].instructions.includes('Team Mode (multi-agent collaboration) — available'), 'the Lead knows Team Mode');
  assert.ok(codex[1].prompt.includes('### Team round (2 teammates in parallel)') && codex[1].prompt.includes('alpha done') && codex[1].prompt.includes('beta done'));
  assert.ok(codex[1].prompt.includes('**Merge conflicts**') && codex[1].prompt.includes('- shared.txt'), 'the audit names the conflicts');
  const final = fs.readFileSync(path.join(env.home, 'runs', run.id, 'rounds', '1', 'diff.json'), 'utf8');
  assert.ok(final.includes('<<<<<<<'), 'round 1 diff shows the conflict markers');

  const kinds = readEvents(run.id).events.map((e) => e.kind);
  for (const k of ['team.start', 'team.merging', 'team.merged']) assert.ok(kinds.includes(k), k);
  const memberEvents = readEvents(run.id).events.filter((e) => e.kind === 'wb.end' && e.member);
  assert.deepEqual(memberEvents.map((e) => e.member).sort(), ['alpha', 'beta']);
});
