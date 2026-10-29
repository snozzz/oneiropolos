// Token accounting per CLI: the CodeBuddy core inside WorkBuddy reports result.usage summed over the whole resumed
// session and counts cached tokens inside input_tokens; Claude Code reports one invocation with input excluding cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeUsage, runStreamJson } from '../src/engines/streamjson.js';

function fakeCli(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbloop-usage-'));
  const file = path.join(dir, 'cli.js');
  fs.writeFileSync(file, `process.stdin.resume();process.stdin.on('end',()=>{for(const l of ${JSON.stringify(lines.map((x) => JSON.stringify(x)))})process.stdout.write(l+'\\n');});`);
  return file;
}

const assistant = (id, usage) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }], usage } });

test('WorkBuddy: per-request usage replaces the cumulative session total, cache not double counted', async () => {
  const cli = fakeCli([
    { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
    assistant('a', { input_tokens: 17310, cache_read_input_tokens: 17152, cache_creation_input_tokens: 158, output_tokens: 55 }),
    assistant('a', { input_tokens: 17310, cache_read_input_tokens: 17152, cache_creation_input_tokens: 158, output_tokens: 55 }),
    assistant('b', { input_tokens: 17403, cache_read_input_tokens: 17152, cache_creation_input_tokens: 251, output_tokens: 1 }),
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 69161, cache_read_input_tokens: 51328, cache_creation_input_tokens: 17833, output_tokens: 127 } },
  ]);
  const r = await runStreamJson({ command: process.execPath, args: [cli], prompt: 'p', usageIncludesCache: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.usage, { input_tokens: 0, cache_read_input_tokens: 34304, cache_creation_input_tokens: 409, output_tokens: 56 });
  assert.equal(r.contextTokens, 17403);
});

test('Claude: result.usage is per invocation and already excludes the cache', async () => {
  const cli = fakeCli([
    assistant('a', { input_tokens: 2, cache_read_input_tokens: 18571, cache_creation_input_tokens: 71, output_tokens: 16 }),
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 4, cache_read_input_tokens: 37213, cache_creation_input_tokens: 176, output_tokens: 78 } },
  ]);
  const r = await runStreamJson({ command: process.execPath, args: [cli], prompt: 'p' });
  assert.deepEqual(r.usage, { input_tokens: 4, cache_read_input_tokens: 37213, cache_creation_input_tokens: 176, output_tokens: 78 });
  assert.equal(r.contextTokens, 18644);
  assert.deepEqual(normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }, true).input_tokens, 10);
});
