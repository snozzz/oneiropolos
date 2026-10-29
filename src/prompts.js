// Per-turn prompts (the "user messages" of each GPT turn and WorkBuddy round). The standing behaviour lives in the
// system prompts (src/sysprompts.js); these carry the facts of the moment. They restate the essentials, so the loop
// keeps working even when the user replaces a system prompt with their own text.
import { formatDuration, oneLine, truncate } from './util.js';

const OUTPUT_REMINDER = 'Reply with ONE JSON object matching the schema (verdict, assessment, plan, issues, next_instruction, team, progress, question_for_user) — nothing else.';

function list(messages) {
  return messages.map((m) => `- ${m.text}${m.context ? `\n  (context added by a hook: ${oneLine(m.context, 600)})` : ''}`).join('\n');
}

function planText(plan) {
  return (plan || []).map((p) => `- [${p.status}] ${p.title}`).join('\n') || '(none)';
}

export function plannerPrompt({ goal, workdir, maxRounds, snapshotNote, checkCommand, userMessages, hookContext, mode, extraDirs, team }) {
  const teamOn = team?.mode && team.mode !== 'off';
  return `## The user's goal
${goal}

## Working directory
${workdir}
${extraDirs?.length ? `\nAdditional directories the Executor may use:\n${extraDirs.map((d) => `- ${d}`).join('\n')}\n` : ''}${snapshotNote ? `\n${snapshotNote}\n` : ''}
## Facts
- The task may use at most ${maxRounds} rounds (one round = the Executor works once, then you audit once).
${checkCommand ? `- After every round the program itself runs the check command \`${oneLine(checkCommand, 300)}\` in the working directory and gives you the exit code and output — more trustworthy than the Executor's report.\n` : ''}${teamOn ? `- Team Mode: ${team.mode === 'always' ? 'ON (mandatory)' : 'available'}, up to ${team.maxTeammates || 3} teammates per round.\n` : ''}${mode === 'plan' ? '- Plan Mode: the user approves your plan before execution starts.\n' : ''}${mode === 'vuln' ? '- Vulnerability Hunting Mode: this is a security analysis task (see your system prompt).\n' : ''}${hookContext ? `\n## Context from the user's hooks\n${truncate(hookContext, 8000)}\n` : ''}${userMessages?.length ? `\n## Additional notes from the user\n${list(userMessages)}\n` : ''}
## Now
1. Investigate the working directory quickly (focus on what matters for the goal).
2. Write a plan of 3–10 steps.
3. Write the Executor's first instruction${teamOn ? ' (or parallel team assignments, if the work splits cleanly)' : ''}.

${OUTPUT_REMINDER}`;
}

export function workerPrompt({ round, instruction, workdir, handoff, hookContext }) {
  return `${handoff ? `${handoff}\n\n` : ''}${hookContext ? `${hookContext}\n\n` : ''}[Round ${round} · instruction from the Lead]

${instruction}

---
Working directory: ${workdir}
When you are done, finish with the report in the required format (what was done / files changed / commands run & results / open issues).`;
}

export function teammatePrompt({ round, member, instruction, workspace, board, roster, workdir, hookContext }) {
  return `${hookContext ? `${hookContext}\n\n` : ''}[Round ${round} · Team Mode · assignment for teammate "${member.name}"${member.role ? ` — ${member.role}` : ''}]

${instruction}

---
Files you own: ${member.owns || '(see above)'}
Your private copy of the project: ${workspace}   (the real project is ${workdir}; don't touch it)
Team board: ${board}
Team roster:
${roster}

Work only in your copy. When you are done, finish with the report in the required format.`;
}

export function continuationPrompt({ round, reason, instruction }) {
  return `[Round ${round} · continuation]
Your previous run stopped because of: ${reason}. This round's instruction is not finished yet.
First check the current state quickly (which files you already changed, test status), then complete the remaining work — don't redo what is already done. Finish with the report in the required format.

(The round's instruction, for reference)
${truncate(instruction, 4000)}`;
}

export function handoffNote({ goal, plan, lastAssessment, reason }) {
  return `[Handover] The previous execution session ended (${reason}); you are taking over. Background:
- Overall goal: ${oneLine(goal, 600)}
- Current plan:
${planText(plan)}
- The Lead's latest assessment: ${oneLine(lastAssessment || '(none)', 800)}`;
}

export function formatToolSummary(toolCalls) {
  if (!toolCalls?.length) return '(no tool calls)';
  const counts = {};
  for (const c of toolCalls) counts[c.name] = (counts[c.name] || 0) + 1;
  const countLine = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n}×${k}`).join('  ');
  const important = toolCalls.filter((c) => !['Read', 'Glob', 'Grep', 'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'TaskOutput', 'ToolSearch', 'NotebookRead'].includes(c.name));
  // the diff already shows what was written; these lines mainly show which commands ran and whether they failed
  const lines = important.slice(-40).map((c) => `${c.ok === false ? '✗' : c.ok === true ? '✓' : '…'} ${c.name}: ${oneLine(c.summary, 160)}`);
  const skipped = important.length > 40 ? `(${important.length - 40} earlier calls omitted)\n` : '';
  return `Counts: ${countLine}\n${skipped}${lines.join('\n') || '(read-only operations only)'}`;
}

const STATUS_NAMES = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

function formatFileList(diff) {
  if (!diff) return '(no snapshot recorded)';
  if (!diff.files.length) return '(no file changes this round)';
  return diff.files.slice(0, 200).map((f) => `- ${STATUS_NAMES[f.status] || f.status} ${f.from ? `${f.from} → ` : ''}${f.path} (+${f.add} -${f.del})`).join('\n')
    + (diff.files.length > 200 ? `\n… ${diff.files.length} files in total` : '');
}

export function formatDiffSection(diff) {
  if (!diff) return '';
  if (!diff.files.length) return formatFileList(diff);
  return `${formatFileList(diff)}

\`\`\`diff
${diff.patch}
\`\`\`
${diff.truncated ? `(the patch is ${Math.round(diff.patchBytes / 1024)} KB and was truncated)` : ''}
Full diff: ${diff.command}`;
}

function formatUserMessages(messages) {
  if (!messages?.length) return '';
  return `\n### Messages from the user (consider them first)\n${list(messages)}\n`;
}

/** The check command's result, obtained by the program itself (not relayed by the Executor). */
export function formatCheck(check) {
  if (!check?.command) return '';
  const status = check.timedOut ? `TIMED OUT (stopped after ${formatDuration(check.durationMs)})` : check.code === 0 ? 'PASSED (exit code 0)' : `FAILED (exit code ${check.code})`;
  return `\n### Check command (run by the program in the working directory — trustworthy)
$ ${check.command}
${status} · took ${formatDuration(check.durationMs)}
\`\`\`
${check.output || '(no output)'}
\`\`\`
`;
}

export function workerOutcomeText(w) {
  if (!w) return '(none)';
  const status = w.ok ? 'finished normally' : w.interrupted ? 'interrupted by the user (they have something to say — see the user messages below)' : `did not finish normally: ${oneLine((w.errors || []).join('; '), 400)}`;
  const report = w.resultText || (w.lastTexts || []).join('\n\n') || '(no report from the Executor)';
  return `Status: ${status} · model ${w.model || '-'} · took ${formatDuration(w.durationMs)} · ${w.toolCalls?.length ?? w.toolCount ?? 0} tool calls${w.continuations ? ` · auto-continued ${w.continuations}×` : ''}

${truncate(report, 9000)}`;
}

function formatTeam(team, merge) {
  if (!team?.length) return '';
  const parts = team.map((m) => `#### Teammate "${m.name}"${m.role ? ` — ${m.role}` : ''}
Owns: ${m.owns || '-'}
Assignment: ${oneLine(m.instruction, 600)}
Files changed in their copy: ${m.files == null ? '?' : m.files.length ? m.files.slice(0, 40).join(', ') : 'none'}

${workerOutcomeText(m.worker)}

Tool calls: ${formatToolSummary(m.toolCalls)}`);
  const conflicts = merge?.conflicts?.length
    ? `\n**Merge conflicts** — these files now contain conflict markers (<<<<<<< ======= >>>>>>>) and must be resolved next round:\n${merge.conflicts.map((f) => `- ${f}`).join('\n')}\n`
    : '\nMerge: all teammates\' changes merged cleanly.\n';
  const failed = merge?.errors?.length ? `\nMerge problems: ${merge.errors.join('; ')}\n` : '';
  return `\n### Team round (${team.length} teammates in parallel)\n${parts.join('\n\n')}\n${conflicts}${failed}`;
}

export function auditPrompt({ round, remaining, instruction, instructionSource, worker, diff, snapshotNote, userMessages, stagnantRounds, reviewerNote, check, team, merge, hookNotes, budget }) {
  const denials = worker?.permissionDenials?.length
    ? `\n### Denied operations\n${worker.permissionDenials.slice(0, 20).map((d) => `- ${oneLine(typeof d === 'string' ? d : JSON.stringify(d), 300)}`).join('\n')}\n`
    : '';
  const blocked = worker?.blocked?.length
    ? `\n### Commands stopped by the safety gate\n${worker.blocked.slice(0, 20).map((b) => `- \`${oneLine(b.command, 200)}\` → ${b.decision}${b.reason ? ` (${oneLine(b.reason, 160)})` : ''}`).join('\n')}\n`
    : '';
  const stagnation = stagnantRounds >= 2
    ? `\n> Note: the last ${stagnantRounds} rounds produced no file changes. Decide whether the direction is wrong, the instruction unclear, or the goal already met — don't repeat the same instruction.\n`
    : '';
  return `## Round ${round} results (${remaining} more rounds allowed after this one${budget ? `; ${budget}` : ''})
${reviewerNote ? `\n${reviewerNote}\n` : ''}
### The instruction for this round${instructionSource === 'reviewer' ? ' (from the independent Reviewer)' : ''}
${truncate(instruction, 3500)}
${team?.length ? formatTeam(team, merge) : `
### The Executor's report
${workerOutcomeText(worker)}

### Tool-call summary
${formatToolSummary(worker?.toolCalls)}
`}
### File changes this round${team?.length ? ' (after merging)' : ''}
${diff ? formatDiffSection(diff) : snapshotNote || '(no snapshot recorded)'}
${formatCheck(check)}${denials}${blocked}${hookNotes ? `\n### Notes from the user's hooks\n${truncate(hookNotes, 4000)}\n` : ''}${stagnation}${formatUserMessages(userMessages)}
## Audit now
1. Compare with the instruction and its acceptance criteria. Inspect the key files and the diff yourself; run read-only checks if needed. Don't just trust the report.
2. List the issues (blocker/major/minor).
3. Decide: continue with the next self-contained instruction (fixes + next work); done only when every requirement of the goal has verifiable evidence (not just "tests pass" or the report); abort if continuing is pointless.
4. Update plan and progress.

${OUTPUT_REMINDER}`;
}

export function followupPrompt({ userMessages, note }) {
  return `${note ? `${note}\n\n` : ''}${userMessages?.length ? `## The user's reply / new requirements\n${list(userMessages)}\n\n` : ''}Update your judgement accordingly and give the next step (usually continue + next_instruction). ${OUTPUT_REMINDER}`;
}

/** The user interrupted a Lead turn with a message: answer again with it taken into account. */
export function interjectionNote(messages) {
  return `## The user just interrupted you with a message (consider it first; adjust your judgement and next step if needed)
${list(messages)}`;
}

export function reviewerPrompt({ goal, workdir, lastAudit, rounds, diff, userMessages, check }) {
  const history = (rounds || []).slice(-30).map((r) => `- Round ${r.round}: ${oneLine(r.instruction, 160)} → ${r.audit?.verdict || '-'} (${r.diffFiles ?? '?'} files changed)`).join('\n') || '(none)';
  return `## The goal
${goal}
${userMessages?.length ? `\n## Later requirements from the user\n${list(userMessages)}\n` : ''}
## Working directory
${workdir}

## Their completion statement
${lastAudit?.assessment || '(none)'}

## Their plan
${planText(lastAudit?.plan)}

## Rounds so far
${history}

## All changes from the start until now
${diff ? formatDiffSection(diff) : '(no snapshot recorded)'}
${formatCheck(check)}
## Decide
- Every requirement verifiably met → verdict "done" with your acceptance conclusion and the evidence.
- Defects or omissions → verdict "continue": list them in issues and write a self-contained fix instruction for the Executor (acceptance criteria + verification commands).
- Proxy signals ("tests pass", "the report says done") are not enough on their own.

${OUTPUT_REMINDER}`;
}

export function reviewerNoteForAuditor(review) {
  if (!review) return '';
  const issues = review.issues?.length ? review.issues.map((i) => `- [${i.severity}] ${i.detail}`).join('\n') : '(none)';
  return `> After you judged "done" last time, the independent Reviewer found the goal NOT finished: ${oneLine(review.assessment, 600)}
> Issues it found:
${issues}
> In this round the Executor carried out the Reviewer's fix instruction.`;
}

/** Reaching the round or token limit: no more work, summarise so the user can decide whether to continue. */
export function wrapUpPrompt({ maxRounds, instruction, reason = 'rounds', budgetText = '' }) {
  const why = reason === 'budget' ? `the token budget (${budgetText})` : `the round limit (${maxRounds} rounds)`;
  return `## This task reached ${why}
The program pauses here until the user decides whether to raise the limit. Nothing will be sent to the Executor this time. Please:
1. In assessment, summarise what is done (with evidence), what is still missing, and any risks or blockers.
2. Bring the plan up to date: finished steps done, remaining steps todo — clear enough for someone to pick it up.
3. If the goal is in fact fully met with evidence: verdict "done".
4. Otherwise verdict "continue", with next_instruction = the instruction to give the Executor once the user raises the limit (you may keep or improve the one below).
5. Don't declare done just because the limit was reached, and don't inflate progress.

(The instruction that was about to be sent)
${truncate(instruction, 3500)}

${OUTPUT_REMINDER}`;
}

/** Plan Mode: the user is about to approve the plan; after approval the Lead runs all phases continuously. */
export function planApprovedNote(extra) {
  return `The user APPROVED your plan.${extra ? ` Their note: ${extra}` : ''} Execute all phases continuously from now on without asking for confirmation between phases; verify every phase.`;
}

/** Side question (/btw): never enters the loop. */
export function asidePrompt({ goal, workdir, plan, lastAudit, lastReport, question }) {
  return `A coding task is running automatically (a Lead plans and audits, an Executor does the work). The user asks you a side question; your answer is shown only to them and does not affect the task.

## Task goal
${truncate(goal, 3000)}

## Working directory (read-only for you)
${workdir}

## Current plan
${planText(plan)}

## The Lead's latest assessment
${truncate(lastAudit?.assessment || '(none yet)', 2000)}

## The Executor's latest report
${truncate(lastReport || '(none yet)', 3000)}

## The user's question
${question}

Answer directly and concisely, in the language of the question. Look at files or run read-only commands if you need to confirm something, but change nothing. Use Markdown.`;
}

/** Code review panel (/review): the Lead reviews a diff without touching anything (snow-cli reviewAgent). */
export function codeReviewPrompt({ title, diff, notes, workdir }) {
  return `You are a senior code reviewer. Review the following changes (${title}) in ${workdir} and give feedback.

**Your task:**
1. Identify potential bugs, security issues or logic errors
2. Suggest performance optimizations
3. Point out code quality issues (readability, maintainability)
4. Check for best-practice violations
5. Highlight breaking changes or compatibility issues

**Important:**
- DO NOT modify the code; you may read files and run read-only commands for context
- Be constructive and specific: file paths, line numbers, concrete fixes
- Prioritize critical issues over style preferences; end with an overall verdict
${notes ? `\n**Reviewer notes from the user:** ${notes}\n` : ''}
**Changes:**

\`\`\`diff
${diff}
\`\`\`

Reply in the language of the user's notes if there are any, otherwise in the user's interface language. Use Markdown with sections by severity.`;
}

/** Prompt generator (/new-prompt), from snow-cli's newPrompt. */
export function newPromptPrompt({ requirement, projectContext, subagents }) {
  return `You are a professional prompt engineer. The user describes a requirement; generate a well-structured, detailed task description they can hand to an autonomous coding loop (a Lead plans and audits, an Executor does the work).

## Current project context
${projectContext || '(no working directory selected)'}

## Guidelines
1. Analyse the requirement thoroughly
2. Write a clear, actionable task in the user's language
3. Use the project context for accurate technical details (stack, paths, conventions)
4. Structure it: background, concrete requirements, constraints, acceptance criteria (how to verify it is done — tests, commands)
5. Keep it focused, no meta-commentary
${subagents?.length ? `6. The Executor supports sub-agents (mention them as #id only when clearly useful):\n${subagents.map((a) => `   - #${a.id}: ${oneLine(a.description, 140)}`).join('\n')}\n` : ''}
## The user's requirement
${requirement}

Output ONLY the generated task text.`;
}

/** After a rollback: the working directory was restored to a snapshot. */
export function restoreNote(label) {
  return `[System notice] The user restored the working directory to the snapshot "${label}"; all later file changes were undone. Re-assess progress from the current files and adjust the plan if needed.`;
}

/** Lead session lost or too long: rebuild the context from the saved state. */
export function recapPrompt({ goal, workdir, maxRounds, plan, lastAudit, rounds, checkCommand, team, mode }) {
  const history = (rounds || []).slice(-20).map((r) => `- Round ${r.round}: ${oneLine(r.instruction, 200)} → ${r.audit ? `${r.audit.verdict}: ${oneLine(r.audit.assessment, 200)}` : 'not audited'}`).join('\n') || '(none)';
  return `${plannerPrompt({ goal, workdir, maxRounds, checkCommand, team, mode })}

## Note: this is a fresh session. Continue from the progress below (no need to plan the first step again)
### Current plan
${planText(plan)}
### Rounds so far
${history}
### Your last assessment
${lastAudit?.assessment || '(none)'}`;
}

export function retryJsonPrompt(error) {
  return `Your previous reply could not be parsed (${error}). Reply again with exactly one JSON object matching the schema and nothing else.`;
}

/** /init: analyse the project and create or update AGENTS.md (snow-cli's init workflow, step 1). */
export const INIT_GOAL = {
  en: `Analyse this project and create or update AGENTS.md in the project root (read it first if it exists and UPDATE rather than replace).

Explore the structure and key files (package.json, README, pyproject.toml, Cargo.toml, go.mod, configs, main modules), then write:
- Project name and a one-line description; a 2–3 paragraph overview
- Technology stack (languages, frameworks, key dependencies, build and quality tools)
- Project structure (directory tree with explanations)
- Key features
- Getting started: prerequisites, installation, usage
- Development: available scripts, workflow, how to run the tests
- Configuration, architecture, contribution conventions observed in the code

Be thorough but concise. Don't change any other file.

Done when: AGENTS.md exists, every section matches the real code (paths and commands verified), and the commands listed for build/test actually run.`,
  zh: `分析这个项目，在项目根目录创建或更新 AGENTS.md（已经存在就先读，在原有基础上更新，不要整篇替换）。

先浏览目录结构和关键文件（package.json、README、pyproject.toml、Cargo.toml、go.mod、配置文件、主要模块），然后写清楚：
- 项目名称和一句话简介；两三段概述
- 技术栈（语言、框架、关键依赖、构建与质量工具）
- 项目结构（带说明的目录树）
- 主要功能
- 快速开始：前置条件、安装、使用
- 开发：可用脚本、开发流程、怎么跑测试
- 配置、架构、从代码里看到的约定

详尽但简洁，不要改动其他文件。

验收标准：AGENTS.md 已存在，每一节都和真实代码一致（路径和命令都核对过），里面写的构建/测试命令确实能运行。`,
  ja: `このプロジェクトを分析し、ルートに AGENTS.md を作成または更新してください（既にある場合はまず読み、全体を置き換えずに更新すること）。

ディレクトリ構成と主要ファイル（package.json、README、pyproject.toml、Cargo.toml、go.mod、設定ファイル、主要モジュール）を確認したうえで、次を書きます：
- プロジェクト名と一行説明、2〜3 段落の概要
- 技術スタック（言語、フレームワーク、主要な依存関係、ビルド・品質ツール）
- プロジェクト構成（説明付きのディレクトリツリー）
- 主な機能
- はじめに：前提条件、インストール、使い方
- 開発：利用できるスクリプト、開発の流れ、テストの実行方法
- 設定、アーキテクチャ、コードから読み取れる規約

網羅的かつ簡潔に。ほかのファイルは変更しないこと。

完了条件：AGENTS.md が存在し、各節が実際のコードと一致していること（パスとコマンドを確認済み）、記載したビルド／テストコマンドが実際に動くこと。`,
};
