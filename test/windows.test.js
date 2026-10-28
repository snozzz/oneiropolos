import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { baseChildEnv, execText, findExecutable, isPidAlive, runProcess, SHELL, shellArgs } from '../src/util.js';

test('Windows: shell preserves quoted arguments, Unicode, stderr and failing exit codes', { skip: process.platform !== 'win32' }, async () => {
  const res = await execText(SHELL, shellArgs('node -e "console.log(process.argv[1]);console.error(\'stderr\');process.exit(7)" "中文 path with spaces"', true), { env: await baseChildEnv() });
  assert.equal(res.code, 7);
  assert.match(res.stdout, /中文 path with spaces/);
  assert.match(res.stdout, /stderr/);
  assert.ok(findExecutable('git')?.endsWith('.exe'));
});

test('Windows: npm shims launch without interpreting argument metacharacters', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneiropolos shim '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'node_modules', 'fake'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/fake/cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(dir, 'fake.cmd'), '@echo off\r\n"node" "%dp0%\\node_modules\\fake\\cli.js" %*\r\n');
  const args = ['a b', '中文', 'x & echo injected', '$(test)', '"quoted"'];
  const res = await execText(path.join(dir, 'fake.cmd'), args);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), args);
});

test('Windows: abort terminates a CLI and its descendant process', { skip: process.platform !== 'win32' }, async () => {
  const abort = new AbortController();
  let descendant;
  const res = await runProcess(process.execPath, ['-e', `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)`], {
    signal: abort.signal, timeoutMs: 10000,
    onLine(line) { descendant = Number(line); abort.abort(); },
  });
  assert.equal(res.aborted, true);
  assert.ok(descendant);
  assert.equal(isPidAlive(descendant), false);
});
