import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbloop-gate-'));
process.env.WBLOOP_HOME = path.join(base, 'home');
const work = path.join(base, 'work');
fs.mkdirSync(work, { recursive: true });

const { createRun, readEvents } = await import('../src/store.js');
const { decideApproval, pendingApprovals, gateLog } = await import('../src/safety.js');
const { writeHookType } = await import('../src/hooks.js');
const GATE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'hook-gate.js');

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

/** Runs the gate like WorkBuddy's PreToolUse hook would. */
function gate(runId, input, phase = 'pre', extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE, phase, '--run', runId, '--round', '1', ...extra], { env: { ...process.env, WBLOOP_LANG: 'en' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('exit', (code) => resolve({ code, stderr: stderr.trim() }));
    child.stdin.end(JSON.stringify({ hook_event_name: phase === 'pre' ? 'PreToolUse' : 'PostToolUse', ...input }));
  });
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

async function waitPending(runId) {
  for (let i = 0; i < 100; i++) {
    const list = pendingApprovals(runId);
    if (list.length) return list[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no approval request appeared');
}

test('safety gate: policies, approval by the user, "always", denial with a reason, timeout', async () => {
  const run = createRun({ goal: 'g', workdir: work, settings: { safety: { policy: 'ask', timeoutMin: 0.05 }, system: { notify: false } } });
  assert.equal((await gate(run.id, bash('npm test'))).code, 0, 'ordinary commands pass straight through');

  // the user allows it, once and "always for this task"
  let pending = gate(run.id, bash('rm -rf build'), 'pre', ['--member', 'alpha']);
  let req = await waitPending(run.id);
  assert.equal(req.rule.id, 'rm-recursive');
  assert.equal(req.member, 'alpha');
  decideApproval(run.id, req.id, { decision: 'allow', always: true });
  assert.equal((await pending).code, 0);
  assert.equal((await gate(run.id, bash('rm -r dist'))).code, 0, 'the same rule is now allowed without asking');

  // the user denies another rule with a reason
  pending = gate(run.id, bash('git push origin main'));
  req = await waitPending(run.id);
  decideApproval(run.id, req.id, { decision: 'deny', reason: 'push it yourself later' });
  const denied = await pending;
  assert.equal(denied.code, 2, 'exit 2 blocks the tool');
  assert.match(denied.stderr, /The user denied this command: push it yourself later/);

  // nobody answers: denied after the timeout (3 s here)
  const t0 = Date.now();
  const timedOut = await gate(run.id, bash('git reset --hard'));
  assert.equal(timedOut.code, 2);
  assert.match(timedOut.stderr, /Nobody approved this command/);
  assert.ok(Date.now() - t0 < 10_000);

  const events = readEvents(run.id).events;
  assert.equal(events.filter((e) => e.kind === 'approval.request').length, 3);
  assert.deepEqual(events.filter((e) => e.kind === 'approval.result').map((e) => `${e.decision}/${e.by}`), ['allow/user', 'allow/always', 'deny/user', 'deny/timeout']);
  assert.deepEqual(gateLog(run.id, 1).map((e) => e.decision), ['allow', 'allow', 'deny', 'deny']);
});

test('safety gate: deny and allow (YOLO) policies, the user\'s tool hooks, toolConfirmation hooks', async () => {
  const deny = createRun({ goal: 'g', workdir: work, settings: { safety: { policy: 'deny' } } });
  const r = await gate(deny.id, bash('sudo rm x'));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /safety policy/);
  const yolo = createRun({ goal: 'g', workdir: work, settings: { safety: { policy: 'allow' } } });
  assert.equal((await gate(yolo.id, bash('rm -rf /tmp/x'))).code, 0);

  writeHookType('beforeToolCall', [{ description: 'no writes to secrets', matcher: 'filesystem-create,filesystem-edit', hooks: [{ type: 'command', command: 'grep -q secret && { echo "secrets are off limits" >&2; exit 1; }; exit 0' }] }]);
  const blocked = await gate(yolo.id, { tool_name: 'Write', tool_input: { file_path: '/w/secret.txt' } });
  assert.equal(blocked.code, 2);
  assert.equal(blocked.stderr, 'secrets are off limits');
  assert.equal((await gate(yolo.id, { tool_name: 'Write', tool_input: { file_path: '/w/ok.txt' } })).code, 0);
  writeHookType('beforeToolCall', []);

  const ask = createRun({ goal: 'g', workdir: work, settings: { safety: { policy: 'ask' } } });
  writeHookType('toolConfirmation', [{ description: 'auto', matcher: 'terminal-execute', hooks: [{ type: 'command', command: 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{const c=JSON.parse(s);console.log(JSON.stringify(JSON.parse(c.args).command.includes(\'build\')?{result:\'approve\'}:{result:\'reject_with_reply\',reason:\'not this one\'}))})"' }] }]);
  assert.equal((await gate(ask.id, bash('rm -rf build'))).code, 0, 'approved by the hook');
  const rej = await gate(ask.id, bash('rm -rf src'));
  assert.equal(rej.code, 2);
  assert.match(rej.stderr, /not this one/);
  writeHookType('toolConfirmation', []);

  writeHookType('afterToolCall', [{ description: 'lint', matcher: 'Edit', hooks: [{ type: 'command', command: 'echo "lint: 2 problems" >&2; exit 1' }] }]);
  const post = await gate(yolo.id, { tool_name: 'Edit', tool_input: { file_path: '/w/a.js' }, tool_response: 'ok' }, 'post');
  assert.equal(post.code, 2);
  assert.equal(post.stderr, 'lint: 2 problems', 'afterToolCall output replaces what the model sees');
  writeHookType('afterToolCall', []);
});
