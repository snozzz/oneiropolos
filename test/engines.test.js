// Every engine can play either role: Claude as lead with DeepSeek executing, WorkBuddy as lead with ChatGPT executing.
// The CLIs are fakes that speak the real formats (Claude Code stream-json, DSH headless --json, codex exec --json).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
const lead = args.includes('--json-schema');
const stateFile = scriptPath + (lead ? '.lead' : '.exec');
let n = 0;
try { n = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
fs.writeFileSync(stateFile, String(n + 1));
const sessionId = flag('--resume') || flag('--session-id');
fs.appendFileSync(scriptPath + '.calls', JSON.stringify({ lead, n, args, cwd: process.cwd(), prompt, configDir: process.env.CLAUDE_CONFIG_DIR || '' }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake' });
if (lead) {
  const rule = script.leadTurns[Math.min(n, script.leadTurns.length - 1)];
  out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'thinking', thinking: 'check the files' }, { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } });
  out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'a.txt', is_error: false }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: '', structured_output: rule, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } });
} else {
  const step = script.execCalls[Math.min(n, script.execCalls.length - 1)];
  for (const [name, content] of Object.entries(step.writeFiles || {})) {
    out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'w' + name, name: 'Write', input: { file_path: path.join(process.cwd(), name), content } }] } });
    fs.writeFileSync(path.join(process.cwd(), name), content);
    out({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'w' + name, content: 'ok' }] } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: '## What was done\\nDone', usage: { input_tokens: 20, output_tokens: 8 } });
}
`;

const FAKE_DSH = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const scriptPath = process.env.FAKE_DSH_SCRIPT;
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
const patch = JSON.parse(fs.readFileSync(flag('--patch'), 'utf8'));
const policy = patch.find((r) => r.id === 'sandbox-policy');
const lead = policy && policy.config.mode === 'read-only';
const stateFile = scriptPath + (lead ? '.lead' : '.exec');
let n = 0;
try { n = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
fs.writeFileSync(stateFile, String(n + 1));
const sessionId = flag('--session-id') || 'session-' + n;
fs.appendFileSync(scriptPath + '.calls', JSON.stringify({ lead, n, args, patch, cwd: process.cwd(), prompt, home: process.env.DSH_HOME, mode: process.env.DSH_PERMISSION_MODE, asNode: process.env.ELECTRON_RUN_AS_NODE }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'session', sessionId, cwd: process.cwd() });
out({ type: 'status', phase: 'turn_start', turn: 1 });
const step = script.execCalls[Math.min(n, script.execCalls.length - 1)];
for (const [name, content] of Object.entries(step.writeFiles || {})) {
  out({ type: 'tool_call', callId: 'c' + name, tool: 'write', input: { path: path.join(process.cwd(), name), content } });
  fs.writeFileSync(path.join(process.cwd(), name), content);
  out({ type: 'tool_result', callId: 'c' + name, status: 'completed', result: 'written' });
}
out({ type: 'thinking', text: 'done thinking' });
out({ type: 'text', text: 'Report: done' });
out({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 40, cacheReadTokens: 10, outputTokens: 6 } });
out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
out({ type: 'final', text: '## What was done\\nDone by DeepSeek' });
`;

const env = setupFakeEnv({
  codexTurns: [],
  wbCalls: [{ result: 'success' }],
  // WorkBuddy as lead (second test) answers through StructuredOutput: the fake prints the plan as its result text
});
const claudePath = path.join(env.base, 'claude');
fs.writeFileSync(claudePath, FAKE_CLAUDE, { mode: 0o755 });
const claudeScript = path.join(env.base, 'claude-script.json');
fs.writeFileSync(claudeScript, JSON.stringify({
  leadTurns: [gpt('continue', { next_instruction: 'create d.txt' }), gpt('done')],
  execCalls: [{ writeFiles: { 'x.txt': 'X' } }],
}));
const dshApp = path.join(env.base, 'DeepSeek Harness.app');
fs.mkdirSync(path.join(dshApp, 'Contents/MacOS'), { recursive: true });
fs.mkdirSync(path.join(dshApp, 'Contents/Resources'), { recursive: true });
fs.writeFileSync(path.join(dshApp, 'Contents/Resources/app.asar'), '');
const dshScriptFile = path.join(env.base, 'fake-dsh.js');
fs.writeFileSync(dshScriptFile, FAKE_DSH, { mode: 0o755 });
fs.writeFileSync(path.join(dshApp, 'Contents/MacOS/DeepSeek Harness'), `#!/bin/sh\nexec "${process.execPath}" "${dshScriptFile}" "$@"\n`, { mode: 0o755 });
const dshScript = path.join(env.base, 'dsh-script.json');
fs.writeFileSync(dshScript, JSON.stringify({ execCalls: [{ writeFiles: { 'd.txt': 'D' } }] }));
Object.assign(process.env, { FAKE_CLAUDE_SCRIPT: claudeScript, FAKE_DSH_SCRIPT: dshScript });

const calls = (file) => {
  try {
    return fs.readFileSync(`${file}.calls`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { readEvents, readState } = await import('../src/store.js');

test.after(env.cleanup);

test('Claude leads, DeepSeek executes: verdicts via --json-schema, work via DSH headless', async () => {
  const settings = {
    ...env.settings,
    roles: { lead: { engine: 'claude', model: 'opus', effort: 'high' }, executor: { engine: 'deepseek', model: 'deepseek-v4-pro', effort: 'max' } },
    claude: { path: claudePath },
    deepseek: { appPath: dshApp },
    loop: { maxRounds: 5, finalReview: false },
  };
  const run = createTask({ goal: 'engines test', workdir: env.work, settings });
  await new Orchestrator(run.id).run();
  const s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  assert.equal(fs.readFileSync(path.join(env.work, 'd.txt'), 'utf8'), 'D', 'DeepSeek wrote the file');

  const lc = calls(claudeScript).filter((c) => c.lead);
  assert.equal(lc.length, 2);
  assert.ok(lc[0].args.includes('--json-schema'));
  assert.equal(lc[0].args[lc[0].args.indexOf('--model') + 1], 'opus');
  assert.ok(lc[0].args.join(' ').includes('"sandbox":{"enabled":true'), 'Bash runs sandboxed');
  assert.ok(lc[0].args[lc[0].args.indexOf('--disallowedTools') + 1].includes('Write'), 'no file-writing tools for the lead');
  assert.ok(lc[0].cwd.endsWith('gpt-scratch'), 'the lead works from a scratch directory');
  assert.ok(lc[0].configDir.endsWith('claude-home'), 'own config directory');
  assert.ok(lc[1].args.includes('--resume'), 'the second lead turn resumes the session');

  const dc = calls(dshScript);
  assert.equal(dc.length, 1);
  assert.equal(dc[0].lead, false);
  assert.equal(dc[0].mode, 'workspace-write');
  assert.equal(dc[0].asNode, '1');
  assert.ok(dc[0].home.endsWith('dsh-home'));
  assert.ok(dc[0].args[0].endsWith('app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), 'the signed entry inside app.asar');
  assert.deepEqual(dc[0].patch.find((r) => r.id === 'approval').config, { policy: 'never' });
  assert.equal(dc[0].patch.find((r) => r.id === 'permission').config.defaultPreset, 'unattended-write');
  assert.equal(dc[0].patch.find((r) => r.id === 'agent-default-model').config.model, 'deepseek-v4-pro');
  assert.ok(dc[0].patch.find((r) => r.id === 'system-prompt').config.personaSuffix.includes('You are DeepSeek, working as the Executor'));
  assert.ok(dc[0].prompt.includes('create d.txt'));

  const events = readEvents(run.id).events;
  assert.ok(events.some((e) => e.kind === 'gpt.item' && e.itemType === 'command_execution' && e.command === 'ls'), 'lead steps drawn like GPT steps');
  assert.ok(events.some((e) => e.kind === 'wb.tool' && e.name === 'Write' && e.summary === 'd.txt'), 'DSH tools mapped to the timeline');
  assert.equal(s.rounds[0].worker.resultText, '## What was done\nDone by DeepSeek');
  assert.ok(s.stats.gptIn >= 100 && s.stats.wbIn >= 40, 'usage recorded for both roles');
});

test('WorkBuddy leads, ChatGPT executes: read-only gate for the lead, workspace-write sandbox for codex', async () => {
  const work2 = path.join(env.base, 'work2');
  fs.mkdirSync(work2);
  // the fake WorkBuddy core returns its result text; as lead that text is the JSON verdict
  fs.writeFileSync(path.join(env.base, 'wb-script.json'), JSON.stringify({ calls: [
    { result: 'success', text: JSON.stringify(gpt('continue', { next_instruction: 'create e.txt' })) },
    { result: 'success', text: JSON.stringify(gpt('done')) },
  ] }));
  fs.rmSync(path.join(env.base, 'wb-script.json.state'), { force: true });
  fs.rmSync(path.join(env.base, 'wb-script.json.calls'), { force: true });
  fs.writeFileSync(path.join(env.base, 'codex-script.json'), JSON.stringify({ turns: ['## What was done\ncreated e.txt'] }));
  const settings = {
    ...env.settings,
    roles: { lead: { engine: 'workbuddy', model: 'auto' }, executor: { engine: 'chatgpt', model: 'good-model' } },
    loop: { maxRounds: 5, finalReview: false },
  };
  const run = createTask({ goal: 'engines test 2', workdir: work2, settings });
  await new Orchestrator(run.id).run();
  const s = readState(run.id);
  assert.equal(s.status, 'done', s.message);
  const wb = env.wbCalls();
  assert.equal(wb.length, 2);
  assert.ok(wb[0].args.includes('--json-schema'));
  assert.equal(wb[0].args[wb[0].args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash,WebFetch,WebSearch,ToolSearch,StructuredOutput');
  assert.ok(wb[0].args.join(' ').includes('hook-gate.js') && wb[0].args.join(' ').includes(' readonly '), 'read-only gate on Bash');
  const cx = env.codexCalls();
  assert.equal(cx.length, 1);
  assert.ok(cx[0].args.includes('workspace-write'), 'codex executes in workspace-write');
  assert.ok(cx[0].args.some((a) => a === 'sandbox_workspace_write.network_access=true'));
  assert.ok(cx[0].instructions.includes('You are GPT, working as the Executor'));
  assert.equal(s.rounds[0].worker.resultText, '## What was done\ncreated e.txt');
});
