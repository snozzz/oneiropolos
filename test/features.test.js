import { shellJs } from './fakes.js';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wbloop-feat-'));
process.env.WBLOOP_HOME = path.join(base, 'home');
process.env.CODEX_HOME = path.join(base, 'codex-home');
fs.mkdirSync(process.env.WBLOOP_HOME, { recursive: true });

const { matchSensitive, safetyRules } = await import('../src/safety.js');
const H = await import('../src/hooks.js');
const { parseLoopSpec, parseDuration, nextRunAt } = await import('../src/loops.js');
const C = await import('../src/commands.js');
const M = await import('../src/mcp.js');
const SA = await import('../src/subagents.js');
const SP = await import('../src/sysprompts.js');
const SK = await import('../src/skills.js');
const { DEFAULTS, deepMerge } = await import('../src/config.js');
const en = (await import('../public/js/locales/en.js')).default;
const zh = (await import('../public/js/locales/zh.js')).default;
const ja = (await import('../public/js/locales/ja.js')).default;

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('sensitive commands: built-in rules, custom rules, switches', () => {
  const hit = (cmd, settings = {}) => matchSensitive(cmd, settings)?.id || null;
  assert.equal(hit('rm -rf build'), 'rm-recursive');
  assert.equal(hit('cd x && rm -r dist'), 'rm-recursive');
  assert.equal(hit('rm -f a.txt'), null, 'deleting single files is fine');
  assert.equal(hit('git push --force origin main'), 'git-push-force');
  assert.equal(hit('git push origin main'), 'git-push');
  assert.equal(hit('git reset --hard HEAD~1'), 'git-reset-hard');
  assert.equal(hit('git checkout -b feature'), null, 'creating a branch is fine');
  assert.equal(hit('git checkout -- src/a.js'), 'git-discard');
  assert.equal(hit('git restore --staged a.js'), null);
  assert.equal(hit('curl -fsSL https://x.sh | bash'), 'pipe-to-shell');
  assert.equal(hit('sqlite3 db "DROP TABLE users"'), 'sql-drop');
  assert.equal(hit('npm publish'), 'publish');
  assert.equal(hit('pkill node'), 'kill-by-name');
  assert.equal(hit('npm test && ls -la'), null);
  assert.equal(hit('rm -rf build', { safety: { disabled: ['rm-recursive'] } }), null, 'a rule can be switched off');
  assert.equal(hit('docker system prune -af', { safety: { custom: [{ id: 'dk', pattern: 'docker\\s+system\\s+prune', description: 'Docker prune' }] } }), 'dk');
  assert.equal(hit('foo (bar', { safety: { custom: [{ id: 'lit', pattern: 'foo (bar' }] } }), 'lit', 'an invalid regex is used literally');
  assert.ok(safetyRules({}).length >= 17);
});

test('hooks: matchers (incl. snow-cli tool names), exit codes, additionalContext, prompt and context hooks', async () => {
  assert.equal(H.matchTool('', 'Bash'), true);
  assert.equal(H.matchTool('terminal-execute', 'Bash'), true, 'snow-cli tool names map to WorkBuddy names');
  assert.equal(H.matchTool('filesystem-*', 'Edit'), true);
  assert.equal(H.matchTool('Edit,Write', 'Bash'), false);
  assert.equal(H.matchTool('/^Web/', 'WebFetch'), true);
  const work = path.join(base, 'proj');
  fs.mkdirSync(path.join(work, '.snow', 'hooks'), { recursive: true });
  const rule = (hooks, extra = {}) => ({ description: 'r', ...extra, hooks });
  // context hook + command hook returning additionalContext (project file in snow-cli's place)
  fs.writeFileSync(path.join(work, '.snow', 'hooks', 'onUserMessage.json'), JSON.stringify({ onUserMessage: [rule([{ type: 'context', content: 'STATIC CONTEXT', enabled: true }, { type: 'command', command: 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{const c=JSON.parse(s);process.stdout.write(JSON.stringify({additionalContext:\'seen:\'+c.message}))})"', timeout: 5000 }])] }));
  let r = await H.runHooks('onUserMessage', { message: 'hello' }, { workdir: work });
  assert.equal(r.ran, 2);
  assert.match(r.additionalContext, /STATIC CONTEXT/);
  assert.match(r.additionalContext, /seen:hello/);
  // exit 1 replaces, exit 2 blocks
  H.writeHookType('afterToolCall', [rule([{ type: 'command', command: shellJs("process.stderr.write('replaced');process.exit(1)") }], { matcher: 'Bash' })]);
  r = await H.runHooks('afterToolCall', { toolName: 'Bash' }, { workdir: work, toolName: 'Bash' });
  assert.equal(r.replaced, 'replaced');
  r = await H.runHooks('afterToolCall', { toolName: 'Edit' }, { workdir: work, toolName: 'Edit' });
  assert.equal(r.ran, 0, 'the matcher filters other tools');
  H.writeHookType('beforeToolCall', [rule([{ type: 'command', command: shellJs("process.stderr.write('nope');process.exit(2)") }])]);
  r = await H.runHooks('beforeToolCall', {}, { workdir: work, toolName: 'Write' });
  assert.deepEqual(r.blocked, { code: 2, message: 'nope' });
  // toolConfirmation keywords
  H.writeHookType('toolConfirmation', [rule([{ type: 'command', command: 'echo reject_with_reply too dangerous' }])]);
  r = await H.runHooks('toolConfirmation', {}, { workdir: work, toolName: 'Bash' });
  assert.deepEqual(r.decision, { result: 'reject_with_reply', reason: 'too dangerous' });
  // prompt hooks only where allowed; a broken/slow command fails open
  H.writeHookType('onStop', [rule([{ type: 'prompt', prompt: 'Anything else? $STOPSESSION$' }])]);
  r = await H.runHooks('onStop', { status: 'done' }, { workdir: work });
  assert.match(r.prompt, /^Anything else\? \{"status":"done"\}/);
  H.writeHookType('onSessionStart', [rule([{ type: 'command', command: shellJs('setTimeout(()=>{},5000)'), timeout: 600 }])]);
  r = await H.runHooks('onSessionStart', {}, { workdir: work });
  assert.equal(r.blocked, null, 'a timeout fails open');
  assert.equal(H.readHookDir().onStop.length, 1);
  H.writeHookType('onStop', []);
  assert.equal(H.readHookDir().onStop.length, 0, 'an empty list removes the file');
});

test('loops: snow-cli schedule syntax plus Chinese/Japanese variants', () => {
  assert.equal(parseDuration('8h30m'), 8.5 * 3600_000);
  assert.equal(parseDuration('hello'), null);
  assert.deepEqual(parseLoopSpec('5m check logs'), { schedule: { type: 'interval', ms: 300_000 }, prompt: 'check logs' });
  assert.deepEqual(parseLoopSpec('check status every 2 hours'), { schedule: { type: 'interval', ms: 7_200_000 }, prompt: 'check status' });
  assert.deepEqual(parseLoopSpec('daily 9:30 daily report'), { schedule: { type: 'daily', time: '09:30' }, prompt: 'daily report' });
  assert.deepEqual(parseLoopSpec('summarize every day at 18:00'), { schedule: { type: 'daily', time: '18:00' }, prompt: 'summarize' });
  assert.deepEqual(parseLoopSpec('每天 08:00 检查依赖更新'), { schedule: { type: 'daily', time: '08:00' }, prompt: '检查依赖更新' });
  assert.deepEqual(parseLoopSpec('每 2 小时 跑一遍测试'), { schedule: { type: 'interval', ms: 7_200_000 }, prompt: '跑一遍测试' });
  assert.deepEqual(parseLoopSpec('毎日 07:15 ログを確認'), { schedule: { type: 'daily', time: '07:15' }, prompt: 'ログを確認' });
  assert.deepEqual(parseLoopSpec('just do it'), { schedule: { type: 'interval', ms: 600_000 }, prompt: 'just do it' }, 'default every 10 minutes');
  assert.throws(() => parseLoopSpec('30s too fast'), /1 minute/);
  assert.throws(() => parseLoopSpec('daily 25:00 x'), /HH:MM/);
  const at = nextRunAt({ type: 'daily', time: '00:00' }, new Date('2026-10-24T10:00:00').getTime());
  assert.equal(new Date(at).getDate(), 25, 'a time already past runs tomorrow');
});

test('custom commands: namespaces, $ARGUMENTS, snow-cli project files', () => {
  C.saveCommand({ name: 'fix-issue', type: 'prompt', command: 'Fix issue $ARGUMENTS carefully', description: 'fix' });
  C.saveCommand({ name: 'deploy:stage', type: 'execute', command: 'echo deploy' });
  const work = path.join(base, 'cmdproj');
  fs.mkdirSync(path.join(work, '.snow', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(work, '.snow', 'commands', 'fix-issue.json'), JSON.stringify({ type: 'prompt', command: 'Project version $ARGUMENTS' }));
  const global = C.listCommands();
  assert.deepEqual(global.map((c) => c.name), ['deploy:stage', 'fix-issue']);
  const proj = C.listCommands(work);
  assert.equal(proj.find((c) => c.name === 'fix-issue').command, 'Project version $ARGUMENTS', 'project commands win');
  assert.equal(C.expandCommand('Fix issue $ARGUMENTS carefully', '123'), 'Fix issue 123 carefully');
  assert.equal(C.expandCommand('Summarize', 'extra'), 'Summarize extra');
  assert.equal(C.expandCommand('a $ARGUMENTS b', ''), 'a  b');
  assert.throws(() => C.saveCommand({ name: 'bad name', type: 'prompt', command: 'x' }), /names/i);
  C.deleteCommand('deploy:stage');
  assert.deepEqual(C.listCommands().map((c) => c.name), ['fix-issue']);
});

test('MCP: validation, WorkBuddy --mcp-config and Codex -c overrides', () => {
  assert.throws(() => M.saveMcp('{'), /JSON/);
  assert.throws(() => M.saveMcp({ mcpServers: { 'bad name': { command: 'x' } } }), /name/i);
  assert.throws(() => M.saveMcp({ mcpServers: { a: {} } }), /command/);
  M.saveMcp({ mcpServers: {
    fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { A: '1' }, targets: ['workbuddy', 'gpt'] },
    web: { url: 'https://example.com/mcp', targets: ['gpt'] },
    off: { command: 'x', enabled: false },
  } });
  const wb = JSON.parse(M.wbMcpConfig({}));
  assert.deepEqual(Object.keys(wb.mcpServers), ['fs']);
  assert.equal(wb.mcpServers.fs.targets, undefined, 'our own fields are stripped');
  const args = M.codexMcpArgs({});
  assert.ok(args.includes('mcp_servers.fs.command="npx"'));
  assert.ok(args.includes('mcp_servers.fs.args=["-y","@modelcontextprotocol/server-filesystem","/tmp"]'));
  assert.ok(args.includes('mcp_servers.fs.env={ "A" = "1" }'));
  assert.ok(args.includes('mcp_servers.web.url="https://example.com/mcp"'));
  assert.equal(M.wbMcpConfig({ mcp: { enabled: false } }), '', 'MCP can be switched off globally');
});

test('sub-agents: built-ins, custom ones, snow-cli Markdown agents, mentions', () => {
  const work = path.join(base, 'agproj');
  fs.mkdirSync(path.join(work, '.snow', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(work, '.snow', 'agents', 'trellis.md'), '---\nid: trellis-implement\ndescription: Implement features from Trellis\ntools:\n  - filesystem-read\n  - filesystem-edit\n  - terminal-execute\n---\n\nYou implement the active Trellis task.\n');
  const settings = { subagents: { disabled: ['agent_debug'], custom: [{ id: 'docs', name: 'Docs Writer', description: 'writes docs', prompt: 'You write docs', tools: ['Read', 'Write'] }] } };
  const list = SA.listSubagents(settings, work);
  const ids = list.map((a) => a.id);
  assert.ok(ids.includes('agent_explore') && !ids.includes('agent_debug'), 'disabled agents are dropped');
  const tr = list.find((a) => a.id === 'trellis-implement');
  assert.deepEqual(tr.tools, ['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'Bash'], 'snow-cli tool names are mapped');
  assert.equal(tr.prompt, 'You implement the active Trellis task.');
  const json = JSON.parse(SA.agentsArg(list));
  assert.deepEqual(json.docs, { description: 'writes docs', prompt: 'You write docs', tools: ['Read', 'Write'] });
  assert.deepEqual(SA.mentionedAgents('first #agent_explore then #docs and #nothing', list), ['agent_explore', 'docs']);
});

test('sub-agent rules: ROLE-<id>.md in the project wins over ~/.wbloop and reaches WorkBuddy; empty text removes it', () => {
  const work = path.join(base, 'agroleproj');
  fs.mkdirSync(work, { recursive: true });
  SA.writeAgentRole('agent_explore', 'GLOBAL RULE');
  let a = SA.listSubagents({}, work).find((x) => x.id === 'agent_explore');
  assert.equal(a.role.scope, 'global');
  assert.ok(a.prompt.startsWith('# Code Exploration Specialist') && a.prompt.endsWith('GLOBAL RULE'), 'added after the built-in instructions');
  fs.writeFileSync(path.join(work, 'ROLE-agent_explore.md'), 'PROJECT RULE\n');
  a = SA.listSubagents({}, work).find((x) => x.id === 'agent_explore');
  assert.equal(a.role.scope, 'project');
  assert.ok(a.prompt.endsWith('PROJECT RULE') && !a.prompt.includes('GLOBAL RULE'));
  assert.ok(JSON.parse(SA.agentsArg([a])).agent_explore.prompt.includes('PROJECT RULE'));
  assert.equal(SA.listSubagents({}, '').find((x) => x.id === 'agent_plan').role, undefined);
  assert.equal(SA.writeAgentRole('agent_explore', '  ').removed, true);
  assert.ok(!fs.existsSync(SA.agentRoleFile('agent_explore')));
  assert.throws(() => SA.writeAgentRole('', 'x'), /id/);
});

test('project notebook: readable names in any script; a notebook under the old ASCII-only name is moved over', async () => {
  const NB = await import('../src/notebook.js');
  const dir = '/Users/x/Documents/软件所实习';
  const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 10);
  fs.mkdirSync(NB.NOTEBOOK_DIR, { recursive: true });
  fs.writeFileSync(path.join(NB.NOTEBOOK_DIR, `--${hash}.md`), 'keep me');
  const file = NB.notebookPath(dir);
  assert.equal(path.basename(file), `软件所实习-${hash}.md`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
  assert.ok(!fs.existsSync(path.join(NB.NOTEBOOK_DIR, `--${hash}.md`)));
  assert.match(path.basename(NB.notebookPath('/tmp/my proj')), /^my-proj-[0-9a-f]{10}\.md$/);
});

test('gitline: a commit and the staged changes as snow-cli GitLine blocks', async () => {
  const svc = await import('../src/service.js');
  const repo = path.join(base, 'glrepo');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.md'), 'hello\n```js\nx\n```\n');
  g('add', '.');
  g('commit', '-qm', 'add a.md');
  const sha = g('rev-parse', 'HEAD').trim();
  let r = await svc.gitLine(repo, sha);
  assert.ok(r.text.startsWith(`# GitLine: ${sha.slice(0, 12)}\nCommit: ${sha}\nAuthor: T\nDate: `));
  assert.match(r.text, /Subject: add a\.md\n\n````git\n/, 'a longer fence, because the diff contains ```');
  assert.ok(r.text.endsWith('\n````\n# GitLine End'));
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  g('add', 'b.txt');
  r = await svc.gitLine(repo, 'staged');
  assert.ok(r.text.startsWith('# GitLine: staged\nType: staged\nFiles: 1\n\n```git\n'));
  await assert.rejects(svc.gitLine(repo, 'unstaged'), /no changes/i);
  await assert.rejects(svc.gitLine(repo, 'HEAD; ls'), /Choose a commit/);
});

test('system prompts: full override, variables, ROLE.md as rules or as an override, standing rules', () => {
  const work = path.join(base, 'roleproj');
  fs.mkdirSync(work, { recursive: true });
  const settings = deepMerge(DEFAULTS, { prompts: { workbuddy: 'Comments in English.', gpt: 'Always run the tests yourself.' } });
  let r = SP.buildSystemPrompt('executor', { settings, workdir: work });
  assert.equal(r.source, 'builtin');
  assert.ok(r.text.startsWith('You are WorkBuddy, working as the Executor'));
  assert.ok(r.text.includes('Comments in English.') && !r.text.includes('Always run the tests yourself.'));
  assert.ok(r.text.includes(`Working Directory: ${work}`), 'environment block');
  fs.writeFileSync(path.join(work, 'ROLE.md'), 'Be terse.');
  r = SP.buildSystemPrompt('executor', { settings, workdir: work });
  assert.equal(r.source, 'builtin+role');
  assert.ok(r.text.startsWith('These are the rules emphasized by the user, which must be adhered to 100%:\nBe terse.'), 'snow-cli: ROLE.md replaces the identity line');
  r = SP.buildSystemPrompt('executor', { settings: deepMerge(settings, { prompts: { role: { mode: 'override' } } }), workdir: work });
  assert.equal(r.source, 'role');
  assert.ok(r.text.startsWith('Be terse.') && !r.text.includes('You are WorkBuddy'), 'override ROLE.md replaces the whole prompt');
  assert.ok(r.text.includes('Comments in English.'), 'standing rules are still appended');
  r = SP.buildSystemPrompt('lead', { settings: deepMerge(settings, { prompts: { system: { lead: { mode: 'custom', text: 'You are my planner in {{workdir}} on {{platform}}.' } } } }), workdir: work });
  assert.equal(r.source, 'custom');
  assert.ok(r.text.startsWith(`You are my planner in ${work} on `), 'variables are filled in');
  assert.ok(!r.text.includes('You are Oneiropolos') && r.text.includes('Always run the tests yourself.'));
  const tm = SP.buildSystemPrompt('teammate', { settings, workdir: work, teammate: { member: { name: 'api', role: 'API dev', owns: 'src/api' }, workspace: '/ws', board: '/b.md', roster: '- api' } });
  assert.ok(tm.text.includes('Team Mode — you are teammate "api" (API dev)') && tm.text.includes('/b.md'));
  assert.match(SP.languageRule('ja'), /Japanese/);
  assert.match(SP.languageRule('auto'), /SAME language as the user's goal/);
  assert.equal(SP.reportFormat('zh').split('\n')[0], '## 完成情况');
});

test('skills: discovery with project priority, creation, disabling', () => {
  const work = path.join(base, 'skproj');
  fs.mkdirSync(path.join(work, '.claude', 'skills', 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(work, '.claude', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF');
  const made = SK.createSkill({ name: 'release-notes', description: 'Write release notes' });
  assert.ok(fs.existsSync(made.file));
  assert.throws(() => SK.createSkill({ name: 'Bad Name' }), /lowercase/);
  const list = SK.listSkills({}, work);
  assert.deepEqual(list.map((s) => s.name), ['pdf', 'release-notes']);
  assert.equal(list[0].scope, 'project');
  assert.deepEqual(SK.listSkills({ skills: { disabled: ['pdf'] } }, work).map((s) => s.name), ['release-notes']);
  assert.match(SK.readSkill('pdf', {}, work).content, /# PDF/);
});

test('i18n: the three dictionaries have the same keys and every key used in the code exists', () => {
  const keys = (d) => Object.keys(d).sort();
  assert.deepEqual(keys(zh), keys(en), 'zh = en');
  assert.deepEqual(keys(ja), keys(en), 'ja = en');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    ...fs.readdirSync(path.join(root, 'src')).map((f) => path.join(root, 'src', f)),
    ...fs.readdirSync(path.join(root, 'public', 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'public', 'js', f)),
    path.join(root, 'bin', 'wbloop.js'),
  ].filter((f) => f.endsWith('.js'));
  const missing = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\b(?:t|info|PauseSignal|msg)\(\s*'([a-z][\w.#-]*\.[\w.#-]+)'/g)) if (!(m[1] in en)) missing.add(`${path.basename(f)}: ${m[1]}`);
    for (const m of text.matchAll(/\{\s*key:\s*'([a-z][\w.-]*\.[\w.-]+)'/g)) if (!(m[1] in en)) missing.add(`${path.basename(f)}: ${m[1]}`);
    for (const m of text.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) if (!(m[1] in en)) missing.add(`${path.basename(f)}: ${m[1]}`);
  }
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)) if (!(m[1] in en)) missing.add(`index.html: ${m[1]}`);
  for (const id of ['allow', 'deny', 'cancelled']) assert.ok(`approval.${id}` in en);
  // keys built at run time from a known set of ids
  const dynamic = [
    ...['general', 'defaults', 'prompts', 'agents', 'safety', 'hooks', 'skills', 'mcp', 'long', 'system'].map((x) => `settings.${x}`),
    ...['lead', 'executor', 'teammate', 'reviewer', 'advisor'].flatMap((x) => [`role.${x}`, `role.${x}.desc`]),
    ...H.HOOK_TYPES.map((x) => `hooks.type.${x}`),
    ...['builtin', 'custom', 'global', 'project'].map((x) => `agents.source.${x}`),
    ...['user', 'system', 'timeout', 'policy', 'always', 'hook'].map((x) => `approvalBy.${x}`),
    ...['full', 'compact', 'hidden'].flatMap((x) => [`density.${x}`, `density.toast.${x}`]),
    ...['team', 'agents', 'prompts', 'safety', 'hooks', 'skills', 'mcp', 'loops', 'notebook', 'modes'].flatMap((x) => [`help.f.${x}`, `help.f.${x}.desc`]),
    ...['M', 'D', 'A'].flatMap((x) => [`restore.${x}`, `restore.count.${x}`]),
    ...['queued', 'running', 'paused', 'waiting_user', 'waiting', 'done', 'failed', 'stopped', 'interrupted'].map((x) => `status.${x}`),
    ...['plan', 'approve', 'work', 'audit', 'followup', 'review', 'ask', 'finish'].map((x) => `phase.${x}`),
  ];
  for (const k of dynamic) if (!(k in en)) missing.add(`dynamic: ${k}`);
  // help shortcut and command rows are listed as plain strings
  const panels = fs.readFileSync(path.join(root, 'public', 'js', 'panels.js'), 'utf8');
  for (const m of panels.matchAll(/'(help\.[kc]\.\w+)'/g)) if (!(m[1] in en)) missing.add(`panels.js: ${m[1]}`);
  assert.deepEqual([...missing], []);
  // placeholders match across languages ({lead} and {exec} are always filled, so a language may leave them out)
  for (const k of Object.keys(en)) {
    const ph = (s) => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((x) => x !== 'lead' && x !== 'exec'))].sort().join(',');
    assert.equal(ph(zh[k]), ph(en[k]), `zh placeholders of ${k}`);
    assert.equal(ph(ja[k]), ph(en[k]), `ja placeholders of ${k}`);
  }
});
