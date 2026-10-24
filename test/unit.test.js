import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbloop-unit-'));
process.env.WBLOOP_HOME = path.join(base, 'home');
process.env.WBLOOP_WB_AUTH_FILE = path.join(base, 'no-auth.info');
process.env.CODEX_HOME = path.join(base, 'codex-home');

const { extractJsonObject, isTempPath, truncateMiddle } = await import('../src/util.js');
const { normalizeGptOutput } = await import('../src/schema.js');
const { classifyError, MODEL_UNSUPPORTED_RE, normalizeRateLimits, codexRateLimitsFromRollouts } = await import('../src/codex.js');
const { classifyWbError, summarizeToolInput, wbModelEfforts, wbModelContext, wbModelBadges, isPromotionActive, listWbModels, ensureWbProduct, toolInputDetail, nextDiscountStart } = await import('../src/workbuddy.js');
const T = await import('../src/templates.js');
const { Snapshotter } = await import('../src/snapshot.js');
const { createRun, appendEvent, readEvents, appendControl, readControl, isValidRunId } = await import('../src/store.js');
const { resolveWorkdir } = await import('../src/service.js');
const P = await import('../src/prompts.js');
const SP = await import('../src/sysprompts.js');

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('extractJsonObject tolerates code fences and extra text', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here it is:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJsonObject('prefix {"a":3} suffix'), { a: 3 });
  assert.equal(extractJsonObject('no JSON'), null);
});

test('normalizeGptOutput validates and normalises (including team assignments)', () => {
  const ok = normalizeGptOutput({ verdict: 'continue', assessment: 'x', plan: [{ title: 'p', status: 'weird' }], issues: [{ severity: 'huge', detail: 'd' }], next_instruction: ' do it ', progress: 140, question_for_user: '' });
  assert.equal(ok.value.progress, 100);
  assert.equal(ok.value.plan[0].status, 'todo');
  assert.equal(ok.value.issues[0].severity, 'minor');
  assert.equal(ok.value.next_instruction, 'do it');
  assert.ok(normalizeGptOutput({ verdict: 'continue', next_instruction: '' }).error, 'continue needs an instruction');
  assert.ok(normalizeGptOutput({ verdict: 'maybe' }).error);
  assert.equal(normalizeGptOutput({ verdict: 'ask_user', assessment: 'pick one' }).value.question_for_user, 'pick one');
  const team = normalizeGptOutput({ verdict: 'continue', next_instruction: '', team: [{ name: 'Back End!', role: 'api', instruction: 'do x', owns: 'src/' }, { name: 'back end', instruction: 'do y' }, { name: 'z', instruction: '' }] });
  assert.equal(team.error, undefined, 'team assignments are enough for continue');
  assert.deepEqual(team.value.team.map((m) => m.name), ['back-end', 'back-end-2'], 'names become unique slugs; empty assignments are dropped');
});

test('error classification', () => {
  assert.equal(classifyError("You've hit your usage limit. Try again in 2 hours"), 'limit');
  assert.equal(classifyError('stream disconnected before completion'), 'transient');
  assert.equal(classifyError('401 Unauthorized'), 'auth');
  assert.ok(MODEL_UNSUPPORTED_RE.test("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."));
  assert.equal(classifyWbError('Authentication required. Please use /login command to sign in to your account'), 'auth');
  assert.equal(classifyWbError('积分不足，请升级专业版'), 'credits');
  assert.equal(classifyWbError('429 Too Many Requests'), 'limit');
  assert.equal(classifyWbError('prompt is too long: 250000 tokens > 200000 maximum'), 'context');
  assert.equal(classifyWbError('socket hang up'), 'transient');
});

test('tool summaries use relative paths', () => {
  assert.equal(summarizeToolInput('Write', { file_path: '/w/src/a.py' }, '/w'), 'src/a.py');
  assert.equal(summarizeToolInput('Bash', { command: 'npm   test' }, '/w'), 'npm test');
  const s = P.formatToolSummary([{ name: 'Read', summary: 'a', ok: true }, { name: 'Edit', summary: 'b.py', ok: true }, { name: 'Bash', summary: 'pytest', ok: false }]);
  assert.match(s, /✓ Edit: b\.py/);
  assert.match(s, /✗ Bash: pytest/);
  assert.doesNotMatch(s, /Read: a/);
});

test('isTempPath', () => {
  assert.equal(isTempPath(os.tmpdir()), true);
  assert.equal(isTempPath('/tmp/x'), true);
  assert.equal(isTempPath(path.join(os.homedir(), 'projects')), false);
  assert.equal(truncateMiddle('abcdefghij', 6).includes('omitted'), true);
});

test('resolveWorkdir rejects the root and the whole home folder', () => {
  assert.throws(() => resolveWorkdir('/'));
  assert.throws(() => resolveWorkdir('~'));
  assert.throws(() => resolveWorkdir(path.join(base, 'nope')));
  const d = path.join(base, 'proj');
  fs.mkdirSync(d);
  assert.equal(resolveWorkdir(d), fs.realpathSync(d));
});

test("shadow snapshots leave the project's own git repository alone", async () => {
  const work = path.join(base, 'repo');
  const runDirPath = path.join(base, 'run1');
  fs.mkdirSync(work);
  fs.mkdirSync(runDirPath);
  execFileSync('git', ['init', '-q'], { cwd: work });
  fs.writeFileSync(path.join(work, 'keep.txt'), 'v1\n');
  fs.mkdirSync(path.join(work, 'node_modules'));
  fs.writeFileSync(path.join(work, 'node_modules', 'x.js'), 'ignored');
  const snap = new Snapshotter(runDirPath, work);
  assert.equal(await snap.init(), true);
  const a = await snap.commit('a');
  fs.writeFileSync(path.join(work, 'keep.txt'), 'v2\n');
  fs.writeFileSync(path.join(work, 'new.txt'), 'n\n');
  const b = await snap.commit('b');
  const d = await snap.diff(a, b);
  const byPath = Object.fromEntries(d.files.map((f) => [f.path, f.status]));
  assert.deepEqual(byPath, { 'keep.txt': 'M', 'new.txt': 'A' });
  assert.match(d.patch, /\+v2/);
  // nothing was committed or staged in the user's repository
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' });
  assert.match(status, /\?\? keep\.txt/);
  assert.throws(() => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, stdio: 'pipe' }), 'the user repository still has no commit');
  assert.equal(d.files.some((f) => f.path.startsWith('node_modules')), false);
});

test('events are read from byte offsets; control commands are consumed by offset', () => {
  const s = createRun({ goal: 'g', workdir: base, settings: {} });
  assert.ok(isValidRunId(s.id));
  appendEvent(s.id, { kind: 'a', text: '中文 and 日本語' });
  appendEvent(s.id, { kind: 'b' });
  const first = readEvents(s.id, 0);
  assert.deepEqual(first.events.map((e) => e.kind), ['a', 'b']);
  appendEvent(s.id, { kind: 'c' });
  const second = readEvents(s.id, first.events[1]._o);
  assert.deepEqual(second.events.map((e) => e.kind), ['c']);
  appendControl(s.id, { cmd: 'pause' });
  const c1 = readControl(s.id, 0);
  appendControl(s.id, { cmd: 'message', text: 'hi' });
  const c2 = readControl(s.id, c1.offset);
  assert.deepEqual(c2.commands.map((c) => c.cmd), ['message']);
  assert.throws(() => readEvents('../../etc', 0));
});

test('the sandbox note follows the mode; autonomy is in the Lead system prompt', () => {
  assert.match(SP.sandboxNote({ mode: 'workspace-write', cwd: '/x/scratch' }), /scratch directory/);
  assert.match(SP.sandboxNote({ mode: 'read-only' }), /read-only sandbox/);
  const lead = SP.leadSystemPrompt({ settings: { loop: { autonomy: 'auto' } }, workdir: '/w', sandbox: { mode: 'workspace-write', cwd: '/s' } });
  assert.match(lead, /authorized you to make decisions/);
  assert.match(lead, /\/s is a writable scratch/);
  assert.match(SP.leadSystemPrompt({ settings: { loop: { autonomy: 'ask' } }, workdir: '/w' }), /you may pause with `ask_user`/);
  const prompt = P.plannerPrompt({ goal: 'G', workdir: '/w', maxRounds: 3 });
  assert.match(prompt, /at most 3 rounds/);
});

test('WorkBuddy models: efforts, context windows and the bundled offline config', () => {
  assert.deepEqual(wbModelEfforts({ supportsReasoning: true, reasoning: { defaultEffort: 'high', canDisableThinking: true, supportedEfforts: ['max', 'low', 'high', 'bogus'] } }),
    { reasoning: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true });
  assert.deepEqual(wbModelEfforts({ supportsReasoning: true, reasoning: { effort: 'medium' } }).efforts,
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'without declared levels, all of them (like the desktop app)');
  assert.deepEqual(wbModelEfforts({ supportsReasoning: false }), { reasoning: false, efforts: [], defaultEffort: '', canDisableThinking: false });
  assert.deepEqual(wbModelContext({ maxInputTokens: 960000, contextWindow: { defaultLength: 300000, supportedLengths: [960000, 300000, 600000, 1000000] } }),
    { options: [300000, 600000, 960000], default: 300000 }, 'sizes above maxInputTokens are dropped');
  assert.equal(wbModelContext({ contextWindow: { supportedLengths: [300000] } }), null, 'one size only: not selectable');

  const dir = fs.mkdtempSync(path.join(base, 'wbapp-'));
  const product = path.join(dir, 'product.json');
  fs.writeFileSync(product, JSON.stringify({ authentication: { id: 'workbuddy-desktop', type: 'x' }, models: [
    { id: 'hy3', name: 'Hy3', credits: 'x0.00 credits', supportsReasoning: true, reasoning: { effort: 'high' } },
    { id: 'hy3-x', name: 'Hy3', credits: 'x0.05 credits', supportsReasoning: true, reasoning: { effort: 'high' } },
    { id: 'old', name: 'Old' },
    { id: 'img', name: 'Img', credits: 'x1', tags: ['image'] },
  ] }));
  const { models, source } = listWbModels({ product });
  assert.equal(source, 'bundled', 'without a server config cache the bundled one is used');
  assert.deepEqual(models.map((m) => m.id), ['auto', 'hy3', 'hy3-x'], 'only chat models on sale');
  assert.equal(models[1].name, 'Hy3 (hy3)', 'same-named models get their id');
  assert.equal(models[2].credits, 0.05);

  // the overlay for the core only holds the login; it must not hide the server's model list
  ensureWbProduct({ product });
  const overlay = JSON.parse(fs.readFileSync(path.join(process.env.WBLOOP_HOME, 'workbuddy-product.json'), 'utf8'));
  assert.deepEqual(overlay, { authentication: { id: 'wbloop-cli', type: 'x' } });
});

test('WorkBuddy models: the live server config wins (prices, promotions, order)', () => {
  const ls = path.join(process.env.WBLOOP_HOME, 'workbuddy-home', 'local_storage');
  fs.mkdirSync(ls, { recursive: true });
  const data = {
    agents: [{ name: 'cli', models: ['auto', 'glm-5.2', 'ds', 'gone'] }],
    models: [
      { id: 'auto', name: 'Auto', supportsReasoning: true, reasoning: { effort: 'high' }, descriptionZh: '自动' },
      { id: 'ds', name: 'DS', credits: 'x0.11', supportsReasoning: true, maxInputTokens: 1000000,
        contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1000000] }, reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'high', 'max'] } },
      { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79', supportsReasoning: true, reasoning: { effort: 'medium' } },
      { id: 'hidden', name: 'Hidden', credits: 'x1' },
    ],
    modelPromotions: [
      { id: 'night', kind: 'discount', enabled: true, priority: 100, modelIds: ['glm-5.2'], badge: { label: '夜间折扣' }, hover: { textZh: '每晚 5 折' },
        discount: { factor: 0.5 }, schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' } },
    ],
    modelTiers: [{ enabled: true, modelIds: ['ds'], badge: { label: '订阅优先' }, hover: { textZh: '会员优先调度' } }],
  };
  fs.writeFileSync(path.join(ls, 'entry_test.info'), JSON.stringify([{ userId: 'u-test', ts: 1792700000000, data }]));
  const { models, source, updatedAt } = listWbModels({ product: '/nonexistent' });
  assert.equal(source, 'cloud');
  assert.equal(updatedAt, 1792700000000);
  assert.deepEqual(models.map((m) => m.id), ['auto', 'glm-5.2', 'ds'], 'in the order of the cli agent, missing ones skipped');
  const ds = models.find((m) => m.id === 'ds');
  assert.deepEqual(ds.context, { options: [300000, 1000000], default: 300000 });
  assert.equal(ds.badges[0].label, '订阅优先');

  // promotions run on Beijing time: 23:30 has the night discount, noon does not
  const night = new Date('2026-10-23T15:30:00Z');
  const noon = new Date('2026-10-23T04:00:00Z');
  const promo = data.modelPromotions[0];
  assert.equal(isPromotionActive(promo, night), true);
  assert.equal(isPromotionActive(promo, noon), false);
  assert.equal(isPromotionActive({ ...promo, schedule: { validUntil: '2026-10-01T00:00:00+08:00' } }, noon), false, 'expired promotions are inactive');
  assert.deepEqual(wbModelBadges('glm-5.2', data, night).map((b) => [b.label, b.factor]), [['夜间折扣', 0.5]]);
  assert.deepEqual(wbModelBadges('glm-5.2', data, noon), []);
});

test('tool details: edits give old and new text, long output is truncated', () => {
  const d = toolInputDetail('Edit', { file_path: '/w/a.py', old_string: 'x = 1', new_string: 'x = 2', replace_all: false }, '/w');
  assert.deepEqual(d, { file: 'a.py', old: 'x = 1', new: 'x = 2', all: false });
  const w = toolInputDetail('Write', { file_path: '/w/b.txt', content: 'y'.repeat(20000) }, '/w');
  assert.equal(w.file, 'b.txt');
  assert.ok(w.content.length < 13000 && w.content.includes('(+'), 'long content is truncated with a note');
  assert.equal(toolInputDetail('Bash', { command: 'ls -la', description: 'look' }, '/w').command, 'ls -la');
  assert.match(toolInputDetail('Mystery', { a: 1 }, '/w').json, /"a": 1/);
});

test('templates exist in three languages with placeholders; custom templates can be added, overwritten, deleted', () => {
  const langs = { en: /\[\[[^\]\n]+\]\]/, zh: /【[^】\n]+】/, ja: /【[^】\n]+】/ };
  const ids = T.builtinTemplates('en').map((x) => x.id);
  assert.ok(ids.length >= 9);
  for (const [lang, re] of Object.entries(langs)) {
    const list = T.builtinTemplates(lang);
    assert.deepEqual(list.map((x) => x.id), ids, `${lang} has the same templates`);
    for (const tpl of list) {
      assert.ok(tpl.name && tpl.hint && tpl.body, `${lang}/${tpl.id}`);
      if (tpl.id !== 'init') assert.match(tpl.body, re, `${lang}/${tpl.id} has placeholders`);
      assert.equal((tpl.body.match(T.PLACEHOLDER_RE) || []).length > 0, tpl.id !== 'init', `${lang}/${tpl.id}: PLACEHOLDER_RE finds them`);
    }
  }
  assert.deepEqual(T.builtinTemplates('en').find((x) => x.id === 'security').settings, { agents: { mode: 'vuln' } });
  assert.deepEqual(T.builtinTemplates('ja').find((x) => x.id === 'deepresearch').settings, { codex: { webSearch: true } }, 'deep research lets GPT search the web');
  assert.throws(() => T.saveTemplate({ name: '', body: 'x' }), /name/);
  let r = T.saveTemplate({ name: 'mine', body: 'do [[what]]' });
  assert.equal(r.custom.length, 1);
  r = T.saveTemplate({ name: 'mine', body: 'changed' });
  assert.equal(r.custom.length, 1, 'same name overwrites');
  assert.equal(T.findTemplate('mine').body, 'changed');
  assert.equal(T.findTemplate('bugfix').name, 'Fix a bug');
  assert.equal(T.findTemplate('修 Bug', 'zh').id, 'bugfix', 'found by a name in any language');
  r = T.deleteTemplate(r.custom[0].id);
  assert.equal(r.custom.length, 0);
  assert.throws(() => T.deleteTemplate('nope'), /not found/);
});

test('GPT quota: live and session-log formats; windows past their reset count as 0%', () => {
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const live = normalizeRateLimits({ primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: soon }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: soon + 86400 }, planType: 'plus' }, { source: 'live', resetCredits: 2 });
  assert.equal(live.primary.usedPercent, 40);
  assert.equal(live.primary.windowMins, 300);
  assert.equal(live.primary.resetsAt, soon * 1000, 'seconds become milliseconds');
  assert.equal(live.planType, 'plus');
  assert.equal(live.resetCredits, 2);
  const stale = normalizeRateLimits({ primary: { used_percent: 90, window_minutes: 300, resets_at: 1000 } }, { source: 'rollout' });
  assert.equal(stale.primary.usedPercent, 0);
  assert.equal(stale.primary.stale, true);
  assert.equal(normalizeRateLimits({}), null);

  const now = new Date();
  const dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const line = (pct) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: soon }, secondary: { used_percent: 5, window_minutes: 10080, resets_at: soon }, plan_type: 'plus' } } });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), `${line(10)}\n{"type":"other"}\n${line(33)}\n`);
  const r = codexRateLimitsFromRollouts();
  assert.equal(r.source, 'rollout');
  assert.equal(r.primary.usedPercent, 33, 'the last value in the file');
  assert.equal(r.secondary.usedPercent, 5);
});

test('WorkBuddy discounts: the next discount window, or null during one', () => {
  const data = { modelPromotions: [
    { modelIds: ['m1'], enabled: true, badge: { label: '夜间折扣' }, discount: { factor: 0.5 }, schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '08:00' }] } },
    { modelIds: ['m2'], enabled: true, badge: { label: '只是标签' }, schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '09:00', end: '12:00' }] } },
  ] };
  // 10:00 Beijing time (02:00 UTC) → 23:00 the same day (15:00 UTC)
  const next = nextDiscountStart('m1', data, new Date('2026-10-24T02:00:00Z'));
  assert.equal(next.at, '2026-10-24T15:00:00.000Z');
  assert.equal(next.label, '夜间折扣');
  assert.equal(nextDiscountStart('m1', data, new Date('2026-10-24T16:00:00Z')), null, 'inside the discount window after midnight');
  assert.equal(nextDiscountStart('m2', data, new Date('2026-10-24T02:00:00Z')), null, 'promotions without a discount factor do not count');
  assert.equal(nextDiscountStart('other', data), null);
});
