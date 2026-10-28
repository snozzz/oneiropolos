import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gpt, setupFakeEnv } from './fakes.js';

process.env.WBLOOP_TEST_FAST = '1';
const env = setupFakeEnv({ codexTurns: [], wbCalls: [] });
const scriptPath = path.join(env.base, 'wb-script.json');
const cli = path.join(env.app, 'Contents/Resources/app.asar.unpacked/cli/bin/codebuddy');

// The first lead call has a real session init followed by a rate-limit result,
// matching the WorkBuddy sequence seen in the isolated CLI run. The next call
// must be a fresh session with the changed model and the complete prompt.
fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const scriptPath = process.env.FAKE_WB_SCRIPT;
const lead = args.includes('--json-schema');
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
const sessionId = flag('--session-id') || flag('--resume');
const stateFile = scriptPath + '.lead.state';
let n = 0;
try { n = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch {}
fs.writeFileSync(stateFile, String(n + 1));
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(scriptPath + '.calls', JSON.stringify({ n, lead, args, sessionId, prompt }) + '\\n');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (!lead) {
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: flag('--model') || 'fake-model' });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'done' });
} else if (n === 0) {
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: flag('--model') || 'auto' });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: ['429 rate limit'] });
} else {
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: flag('--model') || 'auto' });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: JSON.stringify(${JSON.stringify(gpt('done'))}) });
}
`, { mode: 0o755 });

const { createTask } = await import('../src/service.js');
const { Orchestrator } = await import('../src/loop.js');
const { appendControl, readEvents, readState } = await import('../src/store.js');

test.after(env.cleanup);

test('a WorkBuddy lead rate-limit failure switches models with a fresh session and queued message', { timeout: 10000 }, async () => {
  const run = createTask({
    goal: 'lead model switch integration goal',
    workdir: env.work,
    settings: {
      ...env.settings,
      roles: {
        lead: { engine: 'workbuddy', model: 'old-model', effort: 'high' },
        executor: { engine: 'chatgpt', model: 'good-model', effort: 'high' },
      },
      loop: { maxRounds: 3, finalReview: false },
    },
  });
  let switched = false;
  let orch;
  orch = new Orchestrator(run.id, {
    onEvent: (event) => {
      if (event.kind !== 'gpt.error' || event.label !== 'plan' || switched) return;
      switched = true;
      appendControl(run.id, { cmd: 'settings', patch: { roles: { lead: { model: 'new-model' } } } });
      appendControl(run.id, { cmd: 'message', text: 'queued requirement after the limit' });
      setTimeout(() => orch.pollControl().catch(() => {}), 10);
    },
  });
  await orch.run();

  const state = readState(run.id);
  const events = readEvents(run.id).events;
  const calls = env.wbCalls();
  assert.equal(state.status, 'done', state.message);
  assert.equal(state.settings.roles.lead.model, 'new-model');
  assert.equal(calls.length, 2);
  const model = (call) => call.args[call.args.indexOf('--model') + 1];
  assert.equal(model(calls[0]), 'old-model');
  assert.equal(model(calls[1]), 'new-model');
  assert.equal(calls[0].args.includes('--resume'), false);
  assert.equal(calls[1].args.includes('--resume'), false, 'the failed fresh session is not resumed');
  assert.notEqual(calls[0].sessionId, calls[1].sessionId);
  assert.match(calls[1].prompt, /lead model switch integration goal/);
  assert.match(calls[1].prompt, /queued requirement after the limit/);
  assert.ok(events.some((event) => event.kind === 'info' && event.key === 'srv.gpt.settingsChanged'));
});
