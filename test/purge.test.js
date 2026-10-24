import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbloop-purge-'));
process.env.WBLOOP_HOME = path.join(base, 'home');

const { PURGE_MAX_BYTES, applyPurge, purgeSettings, purgeStatus } = await import('../src/purge.js');
const { buildSystemPrompt } = await import('../src/sysprompts.js');

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const ruleFile = (name, text) => {
  const file = path.join(base, name);
  fs.writeFileSync(file, text);
  return file;
};

const ctx = (settings) => ({
  settings,
  workdir: '/tmp/lab',
  sandbox: { mode: 'read-only', cwd: '/tmp/lab' },
  subagents: [],
  skills: [],
  notebookPath: null,
  extraDirs: [],
  mode: 'normal',
  team: {},
  teammate: {
    member: { name: 'lab', role: 'tester', owns: 'src/**' },
    workspace: '/tmp/lab/.team/lab',
    board: '/tmp/lab/.team/BOARD.md',
    roster: '- lab (tester) — owns: src/**',
  },
});

test('purge: off by default, and the default path lives in the data dir', () => {
  const st = purgeStatus({});
  assert.equal(st.enabled, false);
  assert.equal(st.active, false);
  assert.equal(st.reason, 'off');
  assert.equal(st.file, path.join(base, 'home', 'purge.md'));
  assert.equal(purgeSettings({}).label, 'PURGE');
});

test('purge: a missing or empty file never changes the prompt', () => {
  const missing = purgeStatus({ purge: { enabled: true, file: path.join(base, 'nope.md') } });
  assert.equal(missing.active, false);
  assert.equal(missing.reason, 'missing');

  const empty = path.join(base, 'empty.md');
  fs.writeFileSync(empty, '   \n\n');
  const st = purgeStatus({ purge: { enabled: true, file: empty } });
  assert.equal(st.exists, true);
  assert.equal(st.active, false);
  assert.equal(st.reason, 'empty');

  const basePrompt = 'BUILT-IN';
  for (const file of [path.join(base, 'nope.md'), empty]) {
    const r = applyPurge(basePrompt, { settings: { purge: { enabled: true, file } }, role: 'lead', workdir: '/tmp/lab' });
    assert.equal(r.text, basePrompt);
    assert.equal(r.purge.active, false);
  }
});

test('purge: overlay keeps the built-in prompt and appends the ruleset last', () => {
  const file = ruleFile('rules.md', '# Lab\n- targets: 127.0.0.1 only\n');
  const settings = { purge: { enabled: true, file } };
  const basePrompt = 'BUILT-IN BODY\n\nSystem Environment:\nWorking Directory: /tmp/lab';
  const r = applyPurge(basePrompt, { settings, role: 'lead', workdir: '/tmp/lab' });
  assert.equal(r.purge.active, true);
  assert.ok(r.text.startsWith(basePrompt), 'the built-in prompt stays first');
  assert.ok(r.text.indexOf('Ruleset overlay') > r.text.indexOf('BUILT-IN BODY'));
  assert.ok(r.text.includes('- targets: 127.0.0.1 only'));
  assert.ok(r.text.trimEnd().endsWith('--- purge end ---'));
});

test('purge: replace drops the built-in prompt but keeps the environment block', () => {
  const file = ruleFile('replace.md', 'ONLY THESE RULES');
  const r = applyPurge('BUILT-IN BODY', { settings: { purge: { enabled: true, file, mode: 'replace' } }, role: 'reviewer', workdir: '/tmp/lab' });
  assert.equal(r.purge.active, true);
  assert.ok(!r.text.includes('BUILT-IN BODY'));
  assert.ok(r.text.includes('ONLY THESE RULES'));
  assert.ok(r.text.includes('Working Directory: /tmp/lab'));
});

test('purge: only the configured roles are touched', () => {
  const file = ruleFile('roles.md', 'RULES');
  const settings = { purge: { enabled: true, file } };
  for (const role of ['lead', 'reviewer']) {
    assert.equal(buildSystemPrompt(role, ctx(settings)).purge.active, true, role);
  }
  for (const role of ['executor', 'teammate', 'advisor']) {
    const r = buildSystemPrompt(role, ctx(settings));
    assert.equal(r.purge.active, false, role);
    assert.equal(r.purge.reason, 'role');
    assert.ok(!r.text.includes('RULES'), role);
  }
  const lead = buildSystemPrompt('lead', ctx(settings));
  assert.equal(lead.source, 'builtin+purge');
  assert.ok(lead.text.includes('Ruleset overlay'));
});

test('purge: an oversized ruleset is truncated and flagged', () => {
  const file = ruleFile('big.md', 'x'.repeat(PURGE_MAX_BYTES + 4096));
  const st = purgeStatus({ purge: { enabled: true, file } });
  assert.equal(st.truncated, true);
  assert.equal(st.active, true);
  const r = applyPurge('BODY', { settings: { purge: { enabled: true, file } }, role: 'lead', workdir: '/tmp/lab' });
  assert.ok(r.text.length < PURGE_MAX_BYTES + 4096);
  assert.ok(r.text.includes('truncated'));
});

test('purge: custom roles and label are honoured', () => {
  const file = ruleFile('custom.md', 'RULES');
  const st = purgeStatus({ purge: { enabled: true, file, label: 'LAB', roles: ['advisor'] } });
  assert.equal(st.label, 'LAB');
  assert.deepEqual(st.roles, ['advisor']);
  assert.equal(buildSystemPrompt('advisor', ctx({ purge: { enabled: true, file, roles: ['advisor'] } })).purge.active, true);
  assert.equal(buildSystemPrompt('lead', ctx({ purge: { enabled: true, file, roles: ['advisor'] } })).purge.active, false);
});
