import fs from 'node:fs';
import { CONFIG_PATH, ensureDirs } from './paths.js';
import { readJson, writeJsonAtomic } from './util.js';

export const DEFAULTS = {
  // Who plays which role. engine: chatgpt | claude | deepseek | workbuddy; model/effort empty = the engine section's
  // own (codex.model, workbuddy.model …), so settings from before roles existed keep working.
  roles: {
    lead: { engine: 'chatgpt', model: '', effort: '' },
    executor: { engine: 'workbuddy', model: '', effort: '' },
  },
  codex: {
    path: '', // empty = find automatically
    home: '', // empty = $CODEX_HOME or ~/.codex; a path here runs codex against its own home (its own hooks/config)
    model: '', // empty = the highest-priority model the account can use
    effort: 'high',
    // 0 = codex's own window (272K for the current catalog); a number here is passed as -c model_context_window=N
    contextWindow: 0,
    // scratch = GPT works in its own writable scratch dir (can run tests that write temp files), the project is
    // read-only for it; read-only = fully read-only
    sandbox: 'scratch',
    turnTimeoutMin: 40,
    webSearch: false, // let GPT search the web while planning/auditing
  },
  workbuddy: {
    appPath: '', // empty = /Applications/WorkBuddy.app or ~/Applications/WorkBuddy.app
    model: 'auto',
    effort: '', // empty = the model's default; 'off' = thinking off; otherwise passed as --effort
    contextWindow: 0, // 0 = the model's default window; otherwise tokens (e.g. 1000000)
    permissionMode: 'bypassPermissions',
    maxTurnsPerCall: 80,
    callTimeoutMin: 120,
    idleTimeoutMin: 30, // long builds can be silent for a while
    maxContinuations: 4, // automatic continuations per round after step limits / interruptions
    tools: '', // empty = built-in whitelist of coding tools; 'all' = no restriction; or a comma-separated list
    addDirs: [], // additional directories WorkBuddy may read and write (--add-dir)
    autocompact: '', // '' = WorkBuddy default; 'auto' or a token count like 400k
  },
  claude: {
    path: '', // empty = find `claude` (Claude Code) automatically
    home: '', // empty = the app's own config dir ~/.wbloop/claude-home (its own sign-in); ~/.claude shares the normal one
    model: '', // empty = the account's default; or an alias (fable, opus, sonnet, haiku) or a full model name
    effort: '',
  },
  deepseek: {
    appPath: '', // empty = /Applications/DeepSeek Harness.app
    home: '', // empty = ~/.wbloop/dsh-home (its own sign-in, separate from the desktop app's ~/.dsh)
    model: 'deepseek-flash',
    effort: 'high', // off | low | high | max
  },
  loop: {
    maxRounds: 30,
    finalReview: true, // after GPT says done, a fresh GPT session reviews independently
    autonomy: 'auto', // auto = GPT decides with its recommended option; ask = may pause to ask the user
    diffMaxKB: 48,
    waitOnLimitHours: 8,
    checkCommand: '', // run by the program after every round (e.g. npm test); the result goes to GPT
    checkTimeoutMin: 15,
    tokenBudgetM: 0, // token budget in millions (GPT + WorkBuddy); 0 = unlimited (snow-cli /goal --budget)
    // A session whose context grew past this many thousand tokens starts fresh at the next round (the executor with a
    // handover note, the lead from a recap): every request re-sends the whole context, so this bounds the cost. 0 = off.
    sessionCapK: 100,
  },
  agents: {
    replyLanguage: 'auto', // auto (= the goal's language) | en | zh | ja
    mode: 'normal', // normal | plan (approve the plan before execution) | vuln (vulnerability hunting)
  },
  team: {
    mode: 'off', // off | auto (GPT may split rounds into parallel teammates) | always (snow-cli Team Mode)
    maxTeammates: 3,
  },
  // Standing rules (appended to every task) and system-prompt overrides
  prompts: {
    gpt: '',
    workbuddy: '',
    system: {
      lead: { mode: 'builtin', text: '' },
      executor: { mode: 'builtin', text: '' },
      teammate: { mode: 'builtin', text: '' },
      reviewer: { mode: 'builtin', text: '' },
      advisor: { mode: 'builtin', text: '' },
    },
    role: { mode: 'rules', file: 'ROLE.md' }, // ROLE.md (snow-cli): off | rules | override
  },
  subagents: {
    enabled: true,
    disabled: [],
    custom: [], // [{ id, name, description, prompt, tools: [], model }]
  },
  safety: {
    policy: 'ask', // ask (approve sensitive commands) | deny | allow (YOLO)
    timeoutMin: 10, // unanswered approvals are denied after this long
    disabled: [], // ids of built-in rules that are switched off
    custom: [], // [{ id, pattern, description, enabled }]
  },
  hooks: { enabled: true },
  skills: { enabled: true, disabled: [], extraDirs: [] }, // extraDirs: more global skill folders, e.g. ~/.claude/skills
  mcp: { enabled: true },
  notebook: { enabled: true },
  system: {
    notify: true,
    caffeinate: true,
  },
  ui: {
    theme: 'system', // system | light | dark
    density: 'full', // full | compact (hide thinking and reads) | hidden (only reports)
    language: 'en', // en | zh | ja
  },
  profiles: {
    active: '',
    list: [], // [{ id, name, settings: { codex, workbuddy, loop, team, agents } }]
  },
};

// Settings copied into each task (everything that changes how a task runs); UI preferences and profiles stay global.
export const TASK_KEYS = ['roles', 'codex', 'claude', 'deepseek', 'workbuddy', 'loop', 'agents', 'team', 'prompts', 'subagents', 'safety', 'hooks', 'skills', 'mcp', 'notebook', 'system'];

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(base)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(base[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  return deepMerge(DEFAULTS, readJson(CONFIG_PATH, {}));
}

export function saveConfig(patch) {
  ensureDirs();
  const current = fs.existsSync(CONFIG_PATH) ? readJson(CONFIG_PATH, {}) : {};
  const next = deepMerge(current, patch);
  writeJsonAtomic(CONFIG_PATH, next);
  return deepMerge(DEFAULTS, next);
}

/** Replaces whole sub-trees (lists such as profiles.list or safety.custom must not be merged item by item). */
export function replaceConfig(path, value) {
  ensureDirs();
  const current = fs.existsSync(CONFIG_PATH) ? readJson(CONFIG_PATH, {}) : {};
  const keys = path.split('.');
  let cur = current;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  writeJsonAtomic(CONFIG_PATH, current);
  return deepMerge(DEFAULTS, current);
}

export function taskSettings(cfg) {
  const out = {};
  for (const k of TASK_KEYS) if (cfg[k] !== undefined) out[k] = cfg[k];
  return out;
}
