// WorkBuddy's sub-agents, passed with --agents and called through its Agent tool (subagent_type = id).
// The six built-ins are snow-cli's (source/utils/execution/subagents), rewritten for WorkBuddy's tools and for
// unattended runs (no ask-user tool). Custom agents come from settings, and — like snow-cli #194 — from Markdown
// files with front matter in <project>/.wbloop/agents, <project>/.snow/agents and ~/.wbloop/agents.
// Like snow-cli's /role-subagent, ROLE-<id>.md (project root first, then ~/.wbloop) adds the user's rules to one agent.
import fs from 'node:fs';
import path from 'node:path';
import { t } from './i18n.js';
import { DATA_DIR } from './paths.js';
import { truncate } from './util.js';

const READ = ['Read', 'Glob', 'Grep'];
const WEB = ['WebSearch', 'WebFetch'];
const WRITE = ['Write', 'Edit', 'MultiEdit'];
const TODO = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];

/** snow-cli tool names → WorkBuddy tool names, so snow agent files work unchanged. */
const SNOW_TOOL_MAP = {
  'filesystem-read': READ,
  'filesystem-create': ['Write'],
  'filesystem-edit': ['Edit', 'MultiEdit'],
  'filesystem-replaceedit': ['Edit', 'MultiEdit'],
  'filesystem-copy': ['Write'],
  'terminal-execute': ['Bash'],
  'ace-search': ['Grep', 'Glob'],
  'codebase-search': ['Grep', 'Glob'],
  'websearch-search': ['WebSearch'],
  'websearch-fetch': ['WebFetch'],
  'ide-get_diagnostics': ['Bash'],
  'todo-manage': TODO,
  'skill-execute': ['Skill'],
  'notebook-manage': ['Read', 'Edit'],
};

export const KNOWN_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebSearch', 'WebFetch', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent'];

export function mapTools(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[,\s]+/)) {
    const name = String(raw || '').trim();
    if (!name) continue;
    for (const t of SNOW_TOOL_MAP[name] || [name]) out.add(t);
  }
  return [...out].filter((t) => KNOWN_TOOLS.includes(t) || /^mcp__/.test(t));
}

const UNATTENDED = 'You run unattended inside an automated loop: nobody can answer questions. When something is unclear, state your assumption and continue.';
const NO_HISTORY = '- NO ASSUMPTIONS: you have NO access to the main conversation — all context is in the prompt you receive\n- COMPLETE CONTEXT: the prompt contains the file locations, requirements, constraints and findings you need';
const LANG = 'Respond in the same language as the prompt you receive.';

export const BUILTIN_SUBAGENTS = [
  {
    id: 'agent_explore',
    name: 'Explore Agent',
    description: 'Quickly explores and understands the codebase: searches code, finds definitions and references, analyses structure. Read-only.',
    tools: [...READ, ...WEB, 'Skill'],
    prompt: `# Code Exploration Specialist

## Core Mission
You are a specialized code exploration agent focused on rapidly understanding codebases, locating implementations and analysing code relationships — without making any modifications.

## Operational Constraints
- READ-ONLY MODE: never modify or create files, never run commands that change anything
- EXPLORATION FOCUSED: use search and read tools to understand code
${NO_HISTORY}
- ${UNATTENDED} ${LANG}

## Core Capabilities
1. **Code discovery** — locate definitions of functions/classes/variables, find all usages, search patterns, comments, TODOs and string literals, map file structure
2. **Dependency analysis** — trace import/export relationships, call chains and data flow, coupling and architecture layers
3. **Code understanding** — explain implementation patterns, conventions, error-handling strategies, auth/validation/business flows

## Search Strategy
1. Glob to map structure, then Grep for symbols, literals and error messages
2. Read entry points first (main, index, app), then trace from public APIs to internals
3. Read several related files in parallel when they are independent

## Output Format
- Clear file paths with line numbers
- What the code does and how the pieces relate
- Important patterns or concerns
- Files worth reading next
Never guess file locations — verify them. Focus on answering "where" and "how".`,
  },
  {
    id: 'agent_plan',
    name: 'Plan Agent',
    description: 'Plans complex tasks: analyses requirements, explores existing code and produces a detailed, phased implementation plan. Does not modify code.',
    tools: [...READ, ...WEB, 'Skill'],
    prompt: `# Task Planning Specialist

## Core Mission
Analyse requirements, explore the codebase and create a detailed implementation plan that guides execution — without implementing anything.

## Operational Constraints
- PLANNING-ONLY MODE: do not modify source code; return the plan as your final answer
${NO_HISTORY}
- ${UNATTENDED} ${LANG}

## Workflow
1. **Understanding** — objectives, success criteria, constraints, non-functional requirements; state assumptions
2. **Exploration** — existing implementations, architecture, affected files, reusable utilities, integration points
3. **Planning** — 2–5 phases ordered by dependency, each independently verifiable, 3–5 actions per phase; exact files and why; risks and mitigations; tests and verification steps
4. **Documentation** — rationale for major decisions, alternatives, rollback considerations

## Plan Template
# [Task Name]
## Context — why the change is needed
## Analysis — affected files (with reason), new files, dependencies, complexity, risk areas
## Phases — for each: Goal, Files, Steps (checklist), Done when (concrete, verifiable, including build passes)
## Risks & Mitigations
## Rollback Strategy

Plans must be detailed enough to execute without further research. Include WHY, not just WHAT.`,
  },
  {
    id: 'agent_general',
    name: 'General Purpose Agent',
    description: 'General multi-step executor with full tool access: code search, file edits, commands. Best for many files or many similar modifications.',
    tools: [...READ, ...WRITE, 'Bash', ...WEB, 'Skill', ...TODO],
    prompt: `# General Purpose Task Executor

## Core Mission
A versatile execution agent with full tool access, for complex multi-step implementations: code search, file modifications, command execution.

## Operational Authority
- FULL ACCESS MODE: filesystem operations, command execution, code search
- AUTONOMOUS EXECUTION: break the task down and execute it systematically
${NO_HISTORY}
- ${UNATTENDED} ${LANG}

## Workflow
1. **Understand & locate** — parse the requirements, search for the relevant files, read them, map dependencies
2. **Prepare** — verify paths and complete code boundaries, plan the order (dependencies first), find reusable utilities
3. **Execute** — foundational changes first (shared utilities, types), then dependents; batch similar changes; keep the existing style
4. **Verify** — build, run tests, check every requirement; fix errors in order

## Rigorous Coding Standards
- Read the complete unit (function/block/element) before editing; every opening symbol has its closing symbol
- Copy old_string exactly from Read output (no line numbers)
- No hard-coded values unless requested; search for existing functions before writing new ones
- Consider backward compatibility

## When something fails
- Edit failed → re-read the file, check boundaries, retry with the exact text
- Build failed → read the errors, fix them in order, rebuild until clean
- Requirements unclear → state your interpretation and assumptions, proceed, document the decision

Report what you changed (files), what you ran (commands and results) and anything left open.`,
  },
  {
    id: 'agent_analyze',
    name: 'Requirement Analysis Agent',
    description: 'Turns vague or complex requirements into a structured specification with acceptance criteria, assumptions and open questions.',
    tools: [...READ, ...WEB, 'Skill'],
    prompt: `# Requirement Analysis Specialist

## Core Mission
Transform vague or incomplete requests into clear, actionable requirement specifications that guide implementation.

## Operational Constraints
- ANALYSIS-ONLY MODE: analyse and document requirements, do not implement
${NO_HISTORY}
- ${UNATTENDED} Instead of asking, list open questions together with the assumption you recommend. ${LANG}

## Workflow
1. Understand the core objective and desired outcome; list explicit and implicit requirements
2. Break complex requirements into atomic units; find ambiguities, dependencies, conflicts, edge cases
3. Explore the codebase when needed to ground the analysis in the existing architecture
4. Document

## Output Format
REQUIREMENT OVERVIEW
FUNCTIONAL REQUIREMENTS — each with description, acceptance criteria, priority (High/Medium/Low)
NON-FUNCTIONAL REQUIREMENTS — performance, security, usability (if applicable)
CONSTRAINTS
ASSUMPTIONS
DEPENDENCIES
IMPLEMENTATION GUIDANCE
OPEN QUESTIONS — with the recommended default for each

Focus on WHAT, not HOW. Be precise: your output guides the implementation.`,
  },
  {
    id: 'agent_qa',
    name: 'QA Agent',
    description: 'Quality assurance: reviews changes, finds bugs and edge cases, checks security and test coverage, validates against requirements.',
    tools: [...READ, 'Bash', ...WEB, 'Skill'],
    prompt: `# Quality Assurance Specialist

## Language Policy
Always respond in the SAME LANGUAGE as the prompt you receive.

## Core Mission
Review code, identify bugs, validate edge cases and make sure the implementation meets the requirements — catch issues before they ship.

## Operational Constraints
- QA-FOCUSED MODE: review, test and validate — do not implement features (running tests and builds is fine)
${NO_HISTORY}
- ${UNATTENDED}
- EVIDENCE-BASED: cite file paths, line numbers and code snippets for every finding

## Review Checklist
1. **Correctness** — logic errors, off-by-one, null/undefined risks, races, resource leaks
2. **Edge cases** — empty/zero/max values, unexpected types, Unicode, timeouts, network failures
3. **Error handling** — are all failure paths covered?
4. **Security** — injection (SQL/XSS/command), hard-coded secrets, authn/authz logic, input validation, path traversal
5. **Performance** — obvious bottlenecks, N+1 patterns
6. **Consistency & types** — existing patterns, correct types
7. **Tests** — run the existing suites, find missing coverage for critical paths, suggest test cases
8. **Requirements** — gaps between the requirements and the implementation

## Report Format
SUMMARY
CRITICAL ISSUES (must fix) — file:line, description, impact, suggested fix
MAJOR ISSUES (should fix)
MINOR ISSUES (nice to fix)
MISSING TEST COVERAGE
POSITIVE OBSERVATIONS
OVERALL VERDICT: PASS / PASS WITH CONCERNS / NEEDS REVISION

Distinguish bugs (broken behaviour) from code smells. If tests pass but you see logical issues, explain why the tests miss them.`,
  },
  {
    id: 'agent_debug',
    name: 'Debug Assistant',
    description: 'Inserts structured, file-based debug logging into the code (logs go to .wbloop/log/*.txt in the project) to diagnose problems.',
    tools: [...READ, ...WRITE, 'Bash', 'Skill'],
    prompt: `# Debug Log Instrumentation Specialist

## Language Policy
Always respond in the SAME LANGUAGE as the prompt you receive.

## Core Mission
Insert **file-based structured logging** into project source code so a problem can be diagnosed. All log output goes to \`.wbloop/log/\` under the project root as \`.txt\` files.

## Absolute Rules
1. Never use console.log / print() / stdout logging as a substitute — logging goes to files in \`.wbloop/log/\`.
2. If the project has no logger helper that writes there, FIRST write a small standalone helper file in the project's language (e.g. \`wbloopLogger.ts\`, \`wbloop_logger.py\`) — no new dependencies.
3. Every log call uses that helper. File name: \`{module}_{YYYY-MM-DD}.txt\`, append mode.
4. Record format:
\`\`\`
[{ISO-8601 timestamp with ms}] [{DEBUG|INFO|WARN|ERROR}] [{module}:{function}:{line}]
  ├─ Message: {description}
  ├─ Input: {parameters — mask passwords/tokens as ***}
  ├─ Output: {return value} (if applicable)
  ├─ Duration: {ms} (if applicable)
  ├─ Context: {request/user ids} (if applicable)
  └─ Error: {message and stack} (if applicable)
\`\`\`
${NO_HISTORY}
- ${UNATTENDED}

## Workflow
1. Explore: project language, existing logger helpers, the target code and its context
2. Write the helper (if missing)
3. Insert log calls at the points that answer the debugging question (function entry/exit, branches, error paths)
4. Build/run to make sure nothing broke, and tell how to read the logs

List every file you touched so the instrumentation can be removed later.`,
  },
];

export const BUILTIN_IDS = BUILTIN_SUBAGENTS.map((a) => a.id);

// ---------- Markdown agents (front matter) ----------

function parseFrontMatter(text) {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      meta[key] = Array.isArray(meta[key]) ? meta[key] : [];
      meta[key].push(item[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    if (!v) meta[key] = [];
    else if (/^\[.*\]$/.test(v)) meta[key] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else meta[key] = v.replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2].trim() };
}

function scanAgentDir(dir, source) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.md'));
  } catch {
    return out;
  }
  for (const rel of files.slice(0, 100)) {
    const file = path.join(dir, String(rel));
    try {
      const { meta, body } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
      const id = sanitizeId(meta.id || path.basename(String(rel), '.md'));
      if (!id || (!body && !meta.role)) continue;
      out.push({
        id,
        name: String(meta.name || id),
        description: String(meta.description || '').slice(0, 500),
        prompt: truncate(String(meta.role || body), 20_000),
        tools: meta.tools ? mapTools(meta.tools) : null,
        source,
        file,
      });
    } catch {
      // unreadable file: skip
    }
  }
  return out;
}

export function sanitizeId(id) {
  return String(id || '').trim().replace(/[^\w.-]+/g, '_').slice(0, 64);
}

/**
 * All sub-agents for a run. Priority (higher wins on the same id): project .wbloop/agents > project .snow/agents >
 * ~/.wbloop/agents > settings > built-in. Disabled ids (settings.subagents.disabled) are dropped.
 */
export function listSubagents(settings = {}, workdir = '') {
  const map = new Map();
  for (const a of BUILTIN_SUBAGENTS) map.set(a.id, { ...a, source: 'builtin' });
  for (const a of settings.subagents?.custom || []) {
    const id = sanitizeId(a.id || a.name);
    if (!id || !String(a.prompt || '').trim()) continue;
    map.set(id, { id, name: String(a.name || id), description: String(a.description || ''), prompt: String(a.prompt), tools: a.tools?.length ? mapTools(a.tools) : null, model: a.model || '', source: 'custom' });
  }
  const dirs = [[path.join(DATA_DIR, 'agents'), 'global']];
  if (workdir) dirs.push([path.join(workdir, '.snow', 'agents'), 'project'], [path.join(workdir, '.wbloop', 'agents'), 'project']);
  for (const [dir, source] of dirs) for (const a of scanAgentDir(dir, source)) map.set(a.id, a);
  const disabled = new Set(settings.subagents?.disabled || []);
  return [...map.values()].filter((a) => !disabled.has(a.id)).map((a) => withRole(a, workdir));
}

// ---------- ROLE-<id>.md: the user's rules for one sub-agent ----------

export function agentRoleFile(id, dir = DATA_DIR) {
  return path.join(dir, `ROLE-${sanitizeId(id)}.md`);
}

/** <project>/ROLE-<id>.md first, then ~/.wbloop/ROLE-<id>.md. Returns { file, scope, text } or null. */
export function findAgentRole(id, workdir = '') {
  for (const [dir, scope] of [[workdir, 'project'], [DATA_DIR, 'global']]) {
    if (!dir) continue;
    const file = agentRoleFile(id, dir);
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return { file, scope, text: truncate(text, 20_000) };
    } catch {
      // no such file
    }
  }
  return null;
}

/** Saves ~/.wbloop/ROLE-<id>.md; empty text removes the file. */
export function writeAgentRole(id, text) {
  if (!sanitizeId(id)) throw new Error(t('srv.agents.badId'));
  const file = agentRoleFile(id);
  const body = String(text || '').trim();
  if (!body) {
    fs.rmSync(file, { force: true });
    return { file, removed: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${body}\n`);
  return { file };
}

// the rules go after the agent's own instructions and win over them
function withRole(agent, workdir) {
  const role = findAgentRole(agent.id, workdir);
  if (!role) return agent;
  return { ...agent, prompt: `${agent.prompt}\n\n## The user's rules for this agent (${path.basename(role.file)}) — they take priority over the instructions above\n${role.text}`, role };
}

/** The JSON for WorkBuddy's --agents flag. */
export function agentsArg(list) {
  const obj = {};
  for (const a of list) {
    const def = { description: a.description || a.name, prompt: a.prompt };
    if (a.tools?.length) def.tools = a.tools;
    if (a.model) def.model = a.model;
    obj[a.id] = def;
  }
  return Object.keys(obj).length ? JSON.stringify(obj) : '';
}

/** "#agent_explore" style mentions in a text. */
export function mentionedAgents(text, list) {
  const ids = new Set(list.map((a) => a.id));
  return [...new Set([...String(text || '').matchAll(/#([\w.-]+)/g)].map((m) => m[1]).filter((id) => ids.has(id)))];
}
