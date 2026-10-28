import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setupFakeEnv } from './fakes.js';

// Keep this at the adapter boundary: the failure happens before WorkBuddy's
// stream emits its init event, so a loop test that only uses the normal fake
// would miss the stale client-generated session id.
const env = setupFakeEnv({ codexTurns: [], wbCalls: [{ result: 'success' }] });
const cli = path.join(env.app, 'Contents/Resources/app.asar.unpacked/cli/bin/codebuddy');
fs.writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
const sessionId = flag('--session-id') || flag('--resume');
if (sessionId === 'max-turns-client-id') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: sessionId, errors: ['Max turns exceeded'] }) + '\\n');
  process.exit(0);
}
if (sessionId !== 'fresh-client-id') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId || 'late-session', model: 'fake-model' }) + '\\n');
}
const end = Date.now() + 5000;
while (Date.now() < end) {}
`, { mode: 0o755 });

const { lead } = await import('../src/engines/wb.js');
const { findWorkBuddy } = await import('../src/workbuddy.js');
const found = findWorkBuddy(env.app);
test.after(env.cleanup);

const call = async (extra = {}) => {
  const base = path.join(env.base, `lead-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(base, { recursive: true });
  const systemFile = path.join(base, 'system.txt');
  fs.writeFileSync(systemFile, 'test lead');
  const signal = extra.abort === false ? null : new AbortController();
  if (signal) setTimeout(() => signal.abort(), extra.abortMs ?? 25).unref();
  return lead({
    cfg: env.settings,
    found,
    newId: 'fresh-client-id',
    prompt: 'reply',
    cwd: env.work,
    model: 'auto',
    effort: 'high',
    systemFile,
    schema: JSON.stringify({ type: 'object' }),
    signal: signal?.signal,
    timeoutMs: 5000,
    rawFile: path.join(base, 'raw.jsonl'),
    ...extra,
  });
};

test('WorkBuddy lead does not persist a fresh session interrupted before init', async () => {
  const events = [];
  const r = await call({ onEvent: (event) => events.push(event) });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'aborted');
  assert.equal(r.threadId, null);
  assert.equal(events.some((event) => event.kind === 'gpt.thread'), false);
});

test('WorkBuddy lead keeps an existing session id when its resume is interrupted before init', async () => {
  const r = await call({ threadId: 'existing-session' });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'aborted');
  assert.equal(r.threadId, 'existing-session');
});

test('WorkBuddy lead does not persist a fresh session when init precedes a failed call', async () => {
  const r = await call({ newId: 'late-init-client-id' });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'aborted');
  assert.equal(r.threadId, null);
});

test('WorkBuddy lead keeps an initialized session after max turns', async () => {
  const r = await call({ newId: 'max-turns-client-id', abort: false });
  assert.equal(r.ok, false);
  assert.equal(r.threadId, 'max-turns-client-id');
});
