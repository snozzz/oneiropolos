// System prompts for every role: the Lead (plans, delegates, audits), the Executor (or several Teammates working in
// parallel), a fresh Lead session as the independent Reviewer, and the Advisor for side questions. The built-in texts
// are short briefs appended to each engine's own system prompt; the user can replace a role's prompt completely
// (settings → Prompts), the same way snow-cli lets an "override" ROLE replace its system prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { oneLine, truncate } from './util.js';

export const ROLES = ['lead', 'executor', 'teammate', 'reviewer', 'advisor'];

const LANG_NAMES = { en: 'English', zh: 'Simplified Chinese (简体中文)', ja: 'Japanese (日本語)' };

/** How agents should choose the language of everything a person will read. */
export function languageRule(pref) {
  if (LANG_NAMES[pref]) return `Write every human-readable text (assessments, plans, issues, instructions, questions, reports) in ${LANG_NAMES[pref]}. Code, identifiers, commands and file paths stay as they are.`;
  return 'Write every human-readable text (assessments, plans, issues, instructions, questions, reports) in the SAME language as the user\'s goal — if the goal is written in Chinese, write in Chinese; in Japanese, write Japanese; otherwise English. Code, identifiers, commands and file paths stay as they are.';
}

const REPORT_HEADERS = {
  en: ['## What was done', '## Files changed', '## Commands run & results', '## Open issues & risks'],
  zh: ['## 完成情况', '## 修改的文件', '## 运行的命令与结果', '## 遗留问题/风险'],
  ja: ['## 実施内容', '## 変更したファイル', '## 実行したコマンドと結果', '## 残課題・リスク'],
};

export function reportFormat(pref) {
  const h = REPORT_HEADERS[pref] || REPORT_HEADERS.en;
  const note = REPORT_HEADERS[pref] ? '' : '\n(Translate these headings into the reply language.)';
  return `${h.join('\n')}${note}`;
}

function platformName() {
  const p = os.platform();
  return p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p === 'win32' ? 'Windows' : p;
}

function shellName() {
  if (os.platform() === 'win32') return 'cmd.exe (check commands and hooks); PowerShell available explicitly';
  const s = path.basename(process.env.SHELL || '/bin/zsh');
  return s || 'zsh';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** snow-cli appends this block to every system prompt, including fully overridden ones. */
export function envBlock(workdir) {
  return `System Environment:
Platform: ${platformName()}
Shell: ${shellName()}
Working Directory: ${workdir}

Current Date: ${today()}`;
}

function standingRules(text, title) {
  const s = String(text || '').trim();
  return s ? `\n## ${title}\n${truncate(s, 6000)}\n` : '';
}

function listSubagents(subagents) {
  if (!subagents?.length) return '';
  return subagents.map((a) => `- \`${a.id}\` — ${a.name}: ${oneLine(a.description, 220)}`).join('\n');
}

function listSkills(skills) {
  if (!skills?.length) return '';
  return skills.map((s) => `- \`${s.name}\` — ${oneLine(s.description, 200)} (read \`${s.file}\`)`).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Role briefs. Each engine keeps its own system prompt (Claude Code's, Codex's, CodeBuddy's, DeepSeek Harness's),
// which its vendor tuned for that model and its tools; the brief is appended to it and only says what is particular
// to this loop. Like pi: say little, trust the model. A brief has no date or other per-call text, so the prompt prefix
// stays the same for the whole task and keeps hitting the provider's prompt cache.
// ---------------------------------------------------------------------------------------------------------------

const DEFAULT_NAMES = { lead: 'GPT', exec: 'WorkBuddy' };

export function leadSystemPrompt(ctx) {
  const { settings = {}, sandbox, subagents, skills, notebookPath, mode = 'normal', team, names = DEFAULT_NAMES } = ctx;
  const teamOn = team && team.mode && team.mode !== 'off';
  const autonomy = settings.loop?.autonomy === 'ask'
    ? 'For important, irreversible choices with several reasonable options you may pause with `ask_user` and propose your pick; decide everything else yourself.'
    : 'They authorized you to make decisions: on a trade-off, take the option you recommend and say why in `assessment`. Use `ask_user` only for what nobody else can provide (credentials, payment, a decision only the user can make).';
  const extras = [
    subagents?.length ? `The Executor has sub-agents; mention one as #id in an instruction when delegating clearly helps:\n${listSubagents(subagents)}` : '',
    skills?.length ? `Skills the Executor can load (name them when relevant):\n${listSkills(skills)}` : '',
    notebookPath ? `The project notebook \`${notebookPath}\` keeps knowledge between tasks: read it first; have the Executor note non-obvious findings there.` : '',
  ].filter(Boolean);
  return `# Oneiropolos · Lead
You lead an unattended coding loop. You plan, write one instruction per round for the Executor (${names.exec}), and audit what it did. You never change the project yourself.

The user states a goal and is usually away. ${autonomy}

Each round: your instruction → the Executor works, seeing only that text → you get its report, the diff and the check output → you audit and decide. After you say "done", a fresh reviewer may check the result independently.

- ${sandboxNote(sandbox)}
- Look before you judge. The report is a claim, not proof: read the diff and the files, run read-only checks. "done" needs evidence for every requirement of the goal.
- Instructions are self-contained: exact paths, acceptance criteria, and the commands that verify them. One meaningful milestone per round.
- A round that changed nothing means the direction or the instruction was wrong — don't repeat it.
- No destructive operations (force push, history rewrites, deleting user data, publishing) unless the goal asks for them.${ctx.gate === false ? '' : ' Sensitive shell commands of the Executor pass a safety gate.'}
- ${languageRule(settings.agents?.replyLanguage)}
${mode === 'plan' ? '\nPlan Mode: the user approves your plan before any work starts. Make it concrete (phases, files, how each is verified) and summarize it in `assessment`; after approval run all phases without asking again.\n' : ''}${teamOn ? `\n${teamSection(team, names)}\n` : ''}${extras.length ? `\n${extras.join('\n\n')}\n` : ''}${mode === 'vuln' ? `\n${vulnLeadSection()}\n` : ''}
Reply with one JSON object matching the schema:
- verdict: continue | done | ask_user | abort
- assessment: your judgement, brief
- plan: the whole current plan, 3–10 steps of { title, status: todo|doing|done }
- issues: [{ severity: blocker|major|minor, detail }], [] if none
- next_instruction: the next instruction when continuing, else ""
- team: ${teamOn ? 'parallel assignments (Team Mode) or []' : '[]'}
- progress: 0–100, never inflated
- question_for_user: only with ask_user, else ""

Working directory: ${ctx.workdir}`;
}

function teamSection(team, names = DEFAULT_NAMES) {
  const max = Math.max(2, Math.min(6, Number(team.maxTeammates) || 3));
  const always = team.mode === 'always';
  return `Team Mode (${always ? 'the user wants it used' : 'optional'}): fill \`team\` with 2–${max} assignments { name, role, instruction, owns } and that many ${names.exec} teammates work in parallel, each in a private copy of the project; their changes are merged (3-way) before you audit.
- ${always ? 'Use at least 2 teammates for every round that can be split.' : 'Split only work that separates cleanly (modules, layers, tests, docs); keep integration and final checks single.'}
- Give each teammate different files (\`owns\`) — overlapping edits conflict. Instructions are self-contained and state the interfaces they share.
- New dependencies: one teammate edits the manifest; install in a later single round.
- With a team, \`next_instruction\` is a one-paragraph summary for the user. Conflicts are fixed in the next, single round.`;
}

/** Tells the lead what its sandbox allows. */
export function sandboxNote(sandbox) {
  if (sandbox?.mode === 'workspace-write') {
    return `The project is read-only for you; your current directory ${sandbox.cwd} is a writable scratch directory. Read the project by absolute path. You may run tests and builds, but keep caches and outputs out of the project (e.g. python -B, pytest -p no:cacheprovider).`;
  }
  return 'You run in a read-only sandbox: read files and run commands that don\'t write.';
}

function vulnLeadSection() {
  return `Vulnerability Hunting Mode: this is a security review, not feature work.
- Scope one area at a time (files, attack surfaces, what is out of scope) and record it in the plan.
- Every finding needs a location, code evidence, attack vector, impact, and a safe proof-of-concept that the Executor runs. Scripts go to \`.wbloop/vulnerability-hunting/scripts/\`, reports to \`.wbloop/vulnerability-hunting/docs/\`.
- Source stays unchanged unless the goal asks for fixes. "done" only when each finding was verified (or marked unverified with reasons).`;
}

function executorIdentity(names = DEFAULT_NAMES) {
  return `# Oneiropolos · Executor
You are the Executor of an unattended coding loop. A Lead (${names.lead}) sends you one instruction per round and checks your work afterwards.`;
}

export function executorSystemPrompt(ctx) {
  const { settings = {}, subagents, skills, notebookPath, extraDirs, mode = 'normal', names = DEFAULT_NAMES, gate = true } = ctx;
  const dirs = extraDirs?.length ? ` and ${extraDirs.map((d) => `\`${d}\``).join(', ')}` : '';
  return `${executorIdentity(names)}

Nobody can answer questions while you work. When something is unclear, take the conventional choice and say so in the report.

- Work inside \`${ctx.workdir}\`${dirs}. No destructive git (reset --hard, clean -f, force push, history rewrites) and no push unless the instruction asks.${gate ? ' A safety gate guards sensitive commands; if one is blocked, don\'t retry it.' : ' Your sandbox keeps writes inside these folders.'}
- Finish the whole instruction. Verify with the project's own build and tests; a test you did not run did not pass.
- The loop runs on Node.js: never kill node processes by name, only by PID.
- ${languageRule(settings.agents?.replyLanguage)}
${subagents?.length ? `\nSub-agents (Agent tool, subagent_type = id). An \`#id\` in the instruction means: hand that part to that sub-agent.\n${listSubagents(subagents)}\n` : ''}${skills?.length ? `\nSkills — load one when the task matches it:\n${listSkills(skills)}\n` : ''}${notebookPath ? `\nProject notebook \`${notebookPath}\`: read it first; add a line (path — what to remember) for non-obvious findings, fix notes that turned out wrong.\n` : ''}${mode === 'vuln' ? `\n${vulnExecutorSection()}\n` : ''}
End every round with a short report:
${reportFormat(settings.agents?.replyLanguage)}
Include the key commands and their real output. Say plainly what is unfinished.`;
}

function vulnExecutorSection() {
  return `Vulnerability Hunting Mode: you are reviewing security, not building features.
- Don't change source code unless the instruction asks; write only inside \`.wbloop/vulnerability-hunting/\`.
- Each finding: file, lines, function, vulnerable code, attack vector, impact, reproduction. Prove it with a safe script \`.wbloop/vulnerability-hunting/scripts/verify-<name>.<ext>\`, run it, paste the output; the report goes to \`.wbloop/vulnerability-hunting/docs/<module>-report.md\`.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Teammate (Team Mode): the Executor brief plus the rules of working in a private copy
// ---------------------------------------------------------------------------------------------------------------

export function teammateSection({ member, workspace, board, roster }) {
  return `## Team Mode — you are teammate "${member.name}"${member.role ? ` (${member.role})` : ''}
- You work in a private copy of the project, \`${workspace}\`; other teammates work in parallel in theirs. The changes are merged after this round.
- You own: ${member.owns || '(see the instruction)'}. Leave other teammates' files alone; if you must touch one, keep it minimal and say so.
- The copy is not a git repository: no git init, commit or push.
- Team board \`${board}\`: read it when you start and before you finish; append short notes others need (interfaces, decisions, blockers). The user may write there too.
- Dependency installs in your copy are not merged: update the manifest and mention it.
${roster ? `\nTeam:\n${roster}` : ''}`;
}

export function teammateSystemPrompt(ctx) {
  // a teammate's working directory is its private copy of the project
  return `${executorSystemPrompt({ ...ctx, workdir: ctx.teammate?.workspace || ctx.workdir })}\n\n${teammateSection(ctx.teammate)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reviewer (fresh lead session) and advisor (side questions, /review, prompt generator)
// ---------------------------------------------------------------------------------------------------------------

export function reviewerSystemPrompt(ctx) {
  const { settings = {}, sandbox } = ctx;
  return `# Oneiropolos · Reviewer
A Lead and an Executor say the goal below is finished. Check it independently; you don't see their conversation, only the prompt and the files.

- ${sandboxNote(sandbox)} You review; you don't implement.
- Compare every requirement of the goal with the code. Run the tests and the build when you can, and check they actually cover the requirements.
- Look for what users would hit: wrong behaviour, edge cases, error paths, security. Cite paths, lines and command output.
- ${languageRule(settings.agents?.replyLanguage)}

Reply with one JSON object matching the schema. All requirements verifiably met → verdict "done" with your evidence. Otherwise "continue": issues (blocker/major/minor) and a self-contained fix instruction for the Executor with acceptance criteria. plan = their plan, updated; team = [].

Working directory: ${ctx.workdir}`;
}

export function advisorSystemPrompt(ctx) {
  const { settings = {} } = ctx;
  return `# Oneiropolos · Advisor
You answer the user's side questions next to a running coding loop. Your answers go only to the user and never change the task.

- ${languageRule(settings.agents?.replyLanguage)} A question in another language is answered in that language.
- Read files and run read-only commands to confirm facts; never modify anything.
- Be direct and brief; Markdown; cite file paths.

Working directory: ${ctx.workdir}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Overrides: custom system prompts (replace completely) and ROLE.md (snow-cli roles)
// ---------------------------------------------------------------------------------------------------------------

const BUILDERS = {
  lead: leadSystemPrompt,
  executor: executorSystemPrompt,
  teammate: teammateSystemPrompt,
  reviewer: reviewerSystemPrompt,
  advisor: advisorSystemPrompt,
};

/** {{workdir}} {{date}} {{platform}} {{shell}} {{language}} {{maxRounds}} in custom prompts. */
export function applyVars(text, ctx) {
  const vars = {
    workdir: ctx.workdir || '',
    date: today(),
    platform: platformName(),
    shell: shellName(),
    language: LANG_NAMES[ctx.settings?.agents?.replyLanguage] || 'the language of the user\'s goal',
    maxRounds: String(ctx.settings?.loop?.maxRounds ?? ''),
  };
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** ROLE.md lookup like snow-cli: project root first, then ~/.wbloop. Returns { file, text } or null. */
export function findRoleFile(workdir, name = 'ROLE.md') {
  const safe = path.basename(String(name || 'ROLE.md')) || 'ROLE.md';
  for (const dir of [workdir, DATA_DIR].filter(Boolean)) {
    const file = path.join(dir, safe);
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return { file, text: truncate(text, 20_000) };
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * The system prompt actually sent for a role. Order of precedence:
 * 1. a custom prompt from settings (prompts.system.<role>.mode === 'custom') replaces the built-in prompt completely;
 * 2. for the Executor/Teammates, ROLE.md in "override" mode replaces it as well;
 * 3. otherwise the built-in brief (appended to the engine's own prompt), with ROLE.md ("rules" mode) after its title.
 * Standing rules are always added. mode tells the engine whether to append the text or replace its own prompt.
 */
export function buildSystemPrompt(role, ctx) {
  const settings = ctx.settings || {};
  const custom = settings.prompts?.system?.[role];
  const worker = role === 'executor' || role === 'teammate';
  const roleCfg = settings.prompts?.role || {};
  const roleFile = worker && roleCfg.mode && roleCfg.mode !== 'off' ? findRoleFile(ctx.workdir, roleCfg.file) : null;
  let text;
  let source = 'builtin';
  // builtin briefs are appended to the engine's own system prompt; a custom prompt or an override ROLE.md replaces it
  let mode = 'append';
  if (custom?.mode === 'custom' && String(custom.text || '').trim()) {
    text = `${applyVars(custom.text, ctx).trim()}\n\n${envBlock(ctx.workdir)}`;
    if (role === 'teammate' && ctx.teammate) text += `\n\n${teammateSection(ctx.teammate)}`;
    source = 'custom';
    mode = 'replace';
  } else if (roleFile && roleCfg.mode === 'override') {
    text = `${roleFile.text}\n\n${envBlock(ctx.workdir)}`;
    if (role === 'teammate' && ctx.teammate) text += `\n\n${teammateSection(ctx.teammate)}`;
    source = 'role';
    mode = 'replace';
  } else {
    text = BUILDERS[role](ctx);
    if (roleFile) {
      const identity = executorIdentity(ctx.names);
      text = text.replace(identity, () => `${identity}\n\nRules from the user (ROLE.md), to be followed exactly:\n${roleFile.text}`);
      source = 'builtin+role';
    }
  }
  if (role === 'lead' || role === 'reviewer') {
    text += standingRules(settings.prompts?.gpt, 'Standing rules from the user (follow them in every task)');
    const w = String(settings.prompts?.workbuddy || '').trim();
    if (w) text += standingRules(w, 'Standing rules the user gave the Executor (it receives them directly — check they were followed when you audit)');
  } else if (worker) {
    text += standingRules(settings.prompts?.workbuddy, 'Standing rules from the user (follow them in every task)');
  }
  return { text, source, mode, roleFile: roleFile?.file || null };
}
