// Fake codex and fake WorkBuddy for tests: they print the same event formats as the real CLIs, following a script,
// without using any quota.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const scriptPath = process.env.FAKE_CODEX_SCRIPT;
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const stateFile = scriptPath + '.state';
let n = 0;
try { n = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
const model = flag('-m');
const outFile = flag('-o');
const resume = args[1] === 'resume';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const threadId = resume ? args[args.length - 2] : 'thread-' + n;
const instr = (args.find((a) => a.startsWith('model_instructions_file=')) || '').slice('model_instructions_file='.length);
const instructions = instr ? fs.readFileSync(JSON.parse(instr), 'utf8') : '';
fs.appendFileSync(scriptPath + '.calls', JSON.stringify({ n, model, resume, cwd: process.cwd(), args, prompt: stdin, instructions }) + '\\n');
out({ type: 'thread.started', thread_id: threadId });
if ((script.badModels || []).includes(model)) {
  const msg = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The '" + model + "' model is not supported when using Codex with a ChatGPT account." } });
  out({ type: 'error', message: msg });
  out({ type: 'turn.failed', error: { message: msg } });
  process.exit(1);
}
let rule = script.turns[Math.min(n, script.turns.length - 1)];
fs.writeFileSync(stateFile, String(n + 1));
out({ type: 'turn.started' });
out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'x\\n', exit_code: 0, status: 'completed' } });
// a turn may contain __sleepMs to "think" for a while (used to test interrupts)
if (rule && typeof rule === 'object' && rule.__sleepMs) {
  const end = Date.now() + rule.__sleepMs;
  while (Date.now() < end) {}
  rule = { ...rule };
  delete rule.__sleepMs;
}
const text = typeof rule === 'string' ? rule : JSON.stringify(rule);
out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } });
out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } });
if (outFile) fs.writeFileSync(outFile, text);
`;

const FAKE_WB_CLI = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
const scriptPath = process.env.FAKE_WB_SCRIPT;
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
const sessionId = flag('--resume') || flag('--session-id');
// teammates (Team Mode) follow script.byMember[name]; everything else follows script.calls in order
const mm = prompt.match(/assignment for teammate "([^"]+)"/);
const member = mm ? mm[1] : null;
let n = 0;
let step;
if (member && script.byMember && script.byMember[member]) {
  step = script.byMember[member];
} else {
  const stateFile = scriptPath + '.state';
  try { n = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
  fs.writeFileSync(stateFile, String(n + 1));
  step = script.calls[Math.min(n, script.calls.length - 1)];
}
const sysFile = flag('--system-prompt-file');
fs.appendFileSync(scriptPath + '.calls', JSON.stringify({ n, member, args, cwd: process.cwd(), prompt, resume: args.includes('--resume'), system: sysFile ? fs.readFileSync(sysFile, 'utf8') : '', env: { cfg: process.env.CODEBUDDY_CONFIG_DIR, lite: process.env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, product: process.env.ACC_PRODUCT_CONFIG_PATH } }) + '\\n');
if (step.result === 'crash_before_init') process.exit(4);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd() });
if (args.includes('--include-partial-messages')) {
  // like the real core: partial deltas first, then the complete message
  const se = (event) => out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event });
  se({ type: 'message_start', message: { model: 'fake-model' } });
  se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一想' } });
  se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再动手' } });
  if (step.liveSleepMs) { const end = Date.now() + step.liveSleepMs; while (Date.now() < end) {} }
  se({ type: 'message_stop' });
}
out({ type: 'assistant', session_id: sessionId, message: { model: 'fake-model', content: [{ type: 'text', text: '开始干活' }] } });
let i = 0;
for (const [name, content] of Object.entries(step.writeFiles || {})) {
  const id = 'tool-' + n + '-' + (i++);
  out({ type: 'assistant', session_id: sessionId, message: { model: 'fake-model', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: path.join(process.cwd(), name), content } }] } });
  fs.writeFileSync(path.join(process.cwd(), name), content);
  out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }], is_error: false }] } });
}
if (step.sleepMs) { const end = Date.now() + step.sleepMs; while (Date.now() < end) {} }
if (step.result === 'crash') process.exit(3);
if (step.result === 'max_turns') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, num_turns: 5, errors: ['Max turns (80) exceeded'], usage: { input_tokens: 10, output_tokens: 5 } });
} else if (step.result === 'error') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, num_turns: 1, errors: [step.error || 'boom'], usage: {} });
} else {
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: step.text || '## What was done\\nDone', num_turns: 3, usage: { input_tokens: 100, output_tokens: 20 } });
}
`;

export function gpt(verdict, extra = {}) {
  return {
    verdict,
    assessment: extra.assessment || `assessment: ${verdict}`,
    plan: extra.plan || [{ title: 'step one', status: verdict === 'done' ? 'done' : 'doing' }],
    issues: extra.issues || [],
    next_instruction: extra.next_instruction ?? (verdict === 'continue' ? 'write the file' : ''),
    team: extra.team || [],
    progress: extra.progress ?? (verdict === 'done' ? 100 : 50),
    question_for_user: extra.question_for_user || '',
  };
}

/** An isolated fake environment: paths plus helpers to read the recorded calls. Call it before importing src/*. */
export function setupFakeEnv({ codexTurns, wbCalls, wbByMember = null, badModels = [], models = ['good-model', 'second-model'] }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbloop-test-'));
  const home = path.join(base, 'home');
  const codexHome = path.join(base, 'codex-home');
  const work = path.join(base, 'work');
  const app = path.join(base, 'FakeWorkBuddy.app');
  const cliDir = path.join(app, process.platform === 'win32' ? 'resources/app.asar.unpacked/cli' : 'Contents/Resources/app.asar.unpacked/cli');
  for (const d of [home, codexHome, work, path.join(app, 'Contents/MacOS'), path.join(cliDir, 'bin')]) fs.mkdirSync(d, { recursive: true });

  const codexPath = path.join(base, 'codex');
  fs.writeFileSync(codexPath, FAKE_CODEX, { mode: 0o755 });
  fs.writeFileSync(path.join(cliDir, 'bin/codebuddy'), FAKE_WB_CLI, { mode: 0o755 });
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, path.join(app, 'WorkBuddy.exe'));
  else fs.writeFileSync(path.join(app, 'Contents/MacOS/Electron'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(cliDir, 'product.json'), JSON.stringify({ authentication: { id: 'workbuddy-desktop' }, genieVersion: '9.9.9', models: [{ id: 'auto', name: 'Auto' }] }));
  fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({ name: 'fake', publishConfig: { customPackage: { version: '1.0.0' } } }));

  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: models.map((slug, i) => ({ slug, display_name: slug, visibility: 'list', priority: i + 1, supported_reasoning_levels: [{ effort: 'high' }] })),
  }));
  const codexScript = path.join(base, 'codex-script.json');
  fs.writeFileSync(codexScript, JSON.stringify({ turns: codexTurns, badModels }));
  const wbScript = path.join(base, 'wb-script.json');
  fs.writeFileSync(wbScript, JSON.stringify({ calls: wbCalls, byMember: wbByMember }));
  const authFile = path.join(base, 'wb-auth.info');
  fs.writeFileSync(authFile, JSON.stringify({ auth: { refreshExpiresAt: Date.now() + 86400_000 }, account: { uid: 'u1', nickname: 'tester' } }));

  Object.assign(process.env, {
    WBLOOP_HOME: home,
    CODEX_HOME: codexHome,
    WBLOOP_WB_AUTH_FILE: authFile,
    FAKE_CODEX_SCRIPT: codexScript,
    FAKE_WB_SCRIPT: wbScript,
  });
  const readCalls = (file) => {
    try {
      return fs.readFileSync(`${file}.calls`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return {
    base,
    home,
    work,
    app,
    codexPath,
    settings: {
      codex: { path: codexPath, model: badModels[0] || 'good-model', effort: 'high' },
      workbuddy: { appPath: app, model: 'auto' },
      loop: { maxRounds: 5, finalReview: true },
      system: { notify: false, caffeinate: false },
    },
    writeHook: (type, rules) => {
      const dir = path.join(home, 'hooks');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${type}.json`), JSON.stringify({ [type]: rules }));
    },
    codexCalls: () => readCalls(codexScript),
    wbCalls: () => readCalls(wbScript),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

export const shellJs = (code) => `node -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"`;
