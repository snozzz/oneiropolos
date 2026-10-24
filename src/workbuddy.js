import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WB_AUTH_FILE, WB_AUTH_ID, WB_HOME, WB_PRODUCT_PATH, ensureDirs } from './paths.js';
import { t } from './i18n.js';
import { baseChildEnv, oneLine, readJson, runProcess, sleep, truncate, writeJsonAtomic } from './util.js';

const CLI_REL = 'Contents/Resources/app.asar.unpacked/cli';

// Built-in tools WorkBuddy may use (--tools). Under bypassPermissions --disallowedTools alone does not remove tools;
// only the whitelist does. Left out are tools that hang or fail headless: asking the user, plan mode (needs a human to
// exit), its own team/channel collaboration (no team context; SendMessage fails — Team Mode is run by this program
// instead), remote A2A agents, and credit-hungry image/video generation.
export const WB_DEFAULT_TOOLS = [
  'Agent', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Glob', 'Grep',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'TaskOutput',
  'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'DeferExecuteTool', 'StructuredOutput',
  'ListMcpResources', 'ReadMcpResource',
].join(',');
export const WB_DISALLOWED_TOOLS = [
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TeamCreate', 'TeamDelete', 'SendMessage',
  'A2AGetAgentCard', 'A2ASendMessage', 'A2AGetTask', 'A2ACancelTask',
];

export function findWorkBuddy(appPath = '') {
  const candidates = [appPath, '/Applications/WorkBuddy.app', path.join(os.homedir(), 'Applications/WorkBuddy.app')].filter(Boolean);
  for (const app of candidates) {
    const electron = path.join(app, 'Contents/MacOS/Electron');
    const cliDir = path.join(app, CLI_REL);
    const cli = path.join(cliDir, 'bin/codebuddy');
    const product = path.join(cliDir, 'product.json');
    if (fs.existsSync(electron) && fs.existsSync(cli) && fs.existsSync(product)) {
      const prod = readJson(product, {});
      const pkg = readJson(path.join(cliDir, 'package.json'), {});
      return {
        app,
        electron,
        cli,
        product,
        appVersion: prod.genieVersion || '',
        cliVersion: pkg?.publishConfig?.customPackage?.version || '',
      };
    }
  }
  return null;
}

const PRODUCT_OVERLAY_FORMAT = 2;

/**
 * An overlay on WorkBuddy's product config (ACC_PRODUCT_CONFIG_PATH) that only changes authentication.id to wbloop-cli.
 * The CLI names its credential file after this id, so this program's login lives in wbloop-cli.info and the desktop
 * app's workbuddy-desktop.info (encrypted at rest) is never touched. Only the login goes in: the overlay outranks the
 * server-side config, and a full model list here would freeze models, prices and context windows at the bundled version.
 */
export function ensureWbProduct(found) {
  ensureDirs();
  const srcStat = fs.statSync(found.product);
  const metaPath = `${WB_PRODUCT_PATH}.meta.json`;
  const meta = readJson(metaPath, {});
  if (fs.existsSync(WB_PRODUCT_PATH) && meta.format === PRODUCT_OVERLAY_FORMAT && meta.source === found.product
    && meta.mtimeMs === srcStat.mtimeMs && meta.size === srcStat.size) {
    return WB_PRODUCT_PATH;
  }
  const product = JSON.parse(fs.readFileSync(found.product, 'utf8'));
  writeJsonAtomic(WB_PRODUCT_PATH, { authentication: { ...(product.authentication || {}), id: WB_AUTH_ID } });
  writeJsonAtomic(metaPath, { format: PRODUCT_OVERLAY_FORMAT, source: found.product, mtimeMs: srcStat.mtimeMs, size: srcStat.size, at: new Date().toISOString() });
  return WB_PRODUCT_PATH;
}

export async function wbEnv(found, extra = {}) {
  const env = await baseChildEnv();
  // don't inherit variables that could point at another account or product
  for (const key of Object.keys(env)) {
    if (/^(ACC_PRODUCT_CONFIG|CODEBUDDY_SIDECAR_|CODEBUDDY_GATEWAY_)/.test(key)) delete env[key];
  }
  for (const key of ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN', 'WORKBUDDY_AT_REST_ENCRYPTION', 'CODEBUDDY_CREDENTIALS_IN_MEMORY', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    ACC_PRODUCT_CONFIG_PATH: ensureWbProduct(found),
    CODEBUDDY_CONFIG_DIR: WB_HOME,
    DISABLE_AUTOUPDATER: '1',
    CODEBUDDY_PROMPT_SUGGESTION_DISABLED: '1',
    ...extra,
  });
  return env;
}

export function wbAuthState() {
  const data = readJson(WB_AUTH_FILE, null);
  if (!data?.auth) return { loggedIn: false };
  const now = Date.now();
  const refreshExpiresAt = data.auth.refreshExpiresAt || 0;
  const nickname = typeof data.account?.nickname === 'string' ? data.account.nickname : '';
  return {
    loggedIn: Boolean(data.account?.uid) && (!refreshExpiresAt || refreshExpiresAt > now),
    nickname,
    expiresAt: data.auth.expiresAt || null,
    refreshExpiresAt: refreshExpiresAt || null,
  };
}

export const WB_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Reasoning efforts a model offers, matching the WorkBuddy desktop app's menu: declared supportedEfforts when present,
 * otherwise all levels for reasoning models (the core clamps unsupported ones); canDisableThinking adds "off".
 */
export function wbModelEfforts(m) {
  if (!m?.supportsReasoning) return { reasoning: false, efforts: [], defaultEffort: '', canDisableThinking: false };
  const listed = Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts.filter((e) => WB_EFFORTS.includes(e)) : [];
  const def = m.reasoning?.defaultEffort || m.reasoning?.effort || '';
  return {
    reasoning: true,
    efforts: listed.length ? WB_EFFORTS.filter((e) => listed.includes(e)) : [...WB_EFFORTS],
    defaultEffort: WB_EFFORTS.includes(def) ? def : '',
    canDisableThinking: Boolean(m.reasoning?.canDisableThinking ?? m.canDisableThinking),
  };
}

/** Selectable context-window sizes (only when there are at least two, like the desktop app). */
export function wbModelContext(m) {
  const max = m?.maxInputTokens;
  const lengths = [...new Set((m?.contextWindow?.supportedLengths || []).filter((n) => Number.isSafeInteger(n) && n > 0 && (!max || n <= max)))].sort((a, b) => a - b);
  if (lengths.length < 2) return null;
  const def = lengths.includes(m.contextWindow?.defaultLength) ? m.contextWindow.defaultLength : lengths[0];
  return { options: lengths, default: def };
}

function parseCredits(c) {
  const m = String(c ?? '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Minutes since midnight (0–1439) in a time zone; promotions are scheduled in Asia/Shanghai. */
function minutesIn(timeZone, now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return get('hour') * 60 + get('minute');
}

function hm(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isPromotionActive(p, now = new Date()) {
  if (!p || p.enabled === false) return false;
  const s = p.schedule || {};
  if (s.validFrom && now < new Date(s.validFrom)) return false;
  if (s.validUntil && now >= new Date(s.validUntil)) return false;
  if (!Array.isArray(s.daily) || !s.daily.length) return true;
  const cur = minutesIn(s.timezone || 'Asia/Shanghai', now);
  return s.daily.some((w) => {
    const a = hm(w.start);
    const b = hm(w.end);
    if (a == null || b == null) return false;
    return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
  });
}

/**
 * When this model's next discount window starts (only promotions with a real discount factor and daily windows, such
 * as night discounts). null when a discount is active now or there is none. Used by "scheduled start: at the discount".
 */
export function nextDiscountStart(id, data, now = new Date()) {
  let best = null;
  for (const p of data?.modelPromotions || []) {
    if (!p?.modelIds?.includes(id) || p.enabled === false) continue;
    const factor = p.discount?.factor;
    if (typeof factor !== 'number' || factor >= 1) continue;
    if (isPromotionActive(p, now)) return null;
    const s = p.schedule || {};
    if (!Array.isArray(s.daily) || !s.daily.length) continue;
    const cur = minutesIn(s.timezone || 'Asia/Shanghai', now);
    for (const w of s.daily) {
      const start = hm(w.start);
      if (start == null) continue;
      const wait = (start - cur + 1440) % 1440 || 1440;
      const at = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + wait * 60_000);
      if (s.validUntil && at >= new Date(s.validUntil)) continue;
      const candidate = s.validFrom && at < new Date(s.validFrom) ? null : at;
      if (candidate && (!best || candidate < best.at)) best = { at: candidate, label: p.badge?.label || '', factor, text: p.hover?.textZh || p.hover?.text || '' };
    }
  }
  return best ? { ...best, at: best.at.toISOString() } : null;
}

/** Active promotion badges (night discount, free for a limited time …) and tier badges of a model. */
export function wbModelBadges(id, data, now = new Date()) {
  const badges = [];
  const promos = (data?.modelPromotions || []).filter((p) => p.modelIds?.includes(id) && isPromotionActive(p, now)).sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const top = promos[0];
  if (top?.badge?.label) {
    badges.push({ kind: 'promo', label: top.badge.label, text: top.hover?.textZh || '', factor: typeof top.discount?.factor === 'number' ? top.discount.factor : null });
  }
  for (const t of data?.modelTiers || []) {
    if (t.enabled !== false && t.modelIds?.includes(id) && t.badge?.label) badges.push({ kind: 'tier', label: t.badge.label, text: t.hover?.textZh || '', factor: null });
  }
  return badges;
}

function describeWbModel(m, data, now) {
  const credits = parseCredits(m.credits);
  const badges = data ? wbModelBadges(m.id, data, now) : [];
  const factor = badges.find((b) => b.factor != null)?.factor;
  return {
    id: m.id,
    name: m.name || m.id,
    credits,
    // the effective multiplier during a promotion (e.g. 50% off at night, free)
    creditsNow: credits != null && factor != null ? Math.round(credits * factor * 1000) / 1000 : credits,
    description: m.descriptionZh || '',
    maxInput: m.maxInputTokens || null,
    context: wbModelContext(m),
    badges,
    nextDiscount: data ? nextDiscountStart(m.id, data, now) : null,
    ...wbModelEfforts(m),
  };
}

function dedupeNames(list) {
  const count = new Map();
  for (const m of list) count.set(m.name, (count.get(m.name) || 0) + 1);
  // models with the same name (e.g. hy3 / hy3-x) get their id appended
  return list.map((m) => (count.get(m.name) > 1 ? { ...m, name: `${m.name} (${m.id})` } : m));
}

// ---------- live product config from the server ----------
// The WorkBuddy core fetches /v3/config (models, prices, promotions, context windows) at startup and caches it in its
// local_storage. The desktop app shows the same data.

let cloudCache = null;

export function wbCloudConfig() {
  const dir = path.join(WB_HOME, 'local_storage');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.info'));
  } catch {
    return null;
  }
  const stamp = files.map((f) => {
    try {
      return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`;
    } catch {
      return f;
    }
  }).join('|');
  if (cloudCache?.stamp === stamp) return cloudCache.value;
  const uid = readJson(WB_AUTH_FILE, null)?.account?.uid || null;
  let best = null;
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(j)) continue;
    for (const e of j) {
      if (!e?.data || !Array.isArray(e.data.models)) continue;
      if (uid && e.userId && e.userId !== uid) continue;
      if (!best || (e.ts || 0) > best.ts) best = { ts: e.ts || 0, data: e.data };
    }
  }
  cloudCache = { stamp, value: best };
  return best;
}

/**
 * Models WorkBuddy can use: the live server config when cached (order, prices and promotions as in the desktop app),
 * otherwise the product config bundled with the app.
 */
export function listWbModels(found) {
  const now = new Date();
  const cloud = wbCloudConfig();
  if (cloud) {
    const d = cloud.data;
    const byId = new Map(d.models.filter((m) => m?.id).map((m) => [m.id, m]));
    const agent = (d.agents || []).find((a) => a.name === 'cli');
    const ids = agent?.models?.length ? agent.models : d.models.filter((m) => m.credits).map((m) => m.id);
    const models = dedupeNames(ids.map((id) => byId.get(id)).filter(Boolean).map((m) => describeWbModel(m, d, now)));
    if (!models.some((m) => m.id === 'auto')) models.unshift(describeWbModel({ id: 'auto', name: 'Auto', supportsReasoning: true }, d, now));
    return { models, source: 'cloud', updatedAt: cloud.ts || null };
  }
  const product = readJson(found?.product, {});
  const listed = (product.models || []).filter((m) => m?.id && m.id !== 'auto' && !(m.tags && m.tags.length) && (m.credits || m.id === 'default'));
  const auto = (product.models || []).find((m) => m.id === 'auto') || { id: 'auto', name: 'Auto', supportsReasoning: true };
  return { models: dedupeNames([auto, ...listed].map((m) => describeWbModel(m, null, now))), source: 'bundled', updatedAt: null };
}

let refreshing = null;

/**
 * Refreshes the server-side model config: starts only the core's local service (no model call, no credits), which
 * fetches /v3/config on startup, and stops it once the cache changed. One at a time.
 */
export function refreshWbCloudConfig(found, { timeoutMs = 25_000 } = {}) {
  if (!found) return Promise.resolve(null);
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const before = wbCloudConfig()?.ts || 0;
    const port = await freePort();
    const env = await wbEnv(found, { CODEBUDDY_GATEWAY_PASSWORD: crypto.randomBytes(16).toString('hex') });
    const child = spawn(found.electron, [found.cli, '--serve', '--port', String(port), '--host', '127.0.0.1'], {
      env,
      cwd: WB_HOME,
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && child.exitCode == null) {
        await sleep(500);
        const cur = wbCloudConfig();
        if ((cur?.ts || 0) > before) return cur;
      }
      return wbCloudConfig();
    } finally {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // gone
      }
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function classifyWbError(text) {
  const s = String(text || '');
  if (/Authentication required|\/login|not logged in|未登录|登录已过期|\b401\b|unauthori[sz]ed/i.test(s)) return 'auth';
  if (/credit|积分|余额|额度不足|insufficient|\b14018\b|\b6005\b|升级专业版|upgrade to pro/i.test(s)) return 'credits';
  if (/rate.?limit|\b429\b|too many requests|频率|限流|请求过于频繁|服务繁忙|overloaded|busy/i.test(s)) return 'limit';
  if (/context.{0,30}(length|window|limit|too long)|prompt is too long|maximum context|token limit|上下文.{0,10}(超|过长)/i.test(s)) return 'context';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out|\b50[0234]\b|internal server error|unavailable|stream (error|closed)/i.test(s)) return 'transient';
  return 'unknown';
}

function relPath(file, cwd) {
  if (!file || typeof file !== 'string') return '';
  if (cwd && file.startsWith(cwd + path.sep)) return file.slice(cwd.length + 1);
  return file;
}

export function summarizeToolInput(name, input, cwd) {
  const i = input || {};
  switch (name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Read':
    case 'NotebookEdit':
    case 'NotebookRead':
      return relPath(i.file_path || i.notebook_path || i.path, cwd);
    case 'Bash':
    case 'PowerShell':
      return oneLine(i.command, 400);
    case 'Glob':
      return `${i.pattern || ''}${i.path ? ` @ ${relPath(i.path, cwd)}` : ''}`;
    case 'Grep':
      return `${i.pattern || ''}${i.path ? ` @ ${relPath(i.path, cwd)}` : ''}`;
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    case 'Agent':
    case 'Task':
      return oneLine(i.description || i.prompt, 200);
    case 'TaskCreate':
      return oneLine(i.subject || i.description || i.title || JSON.stringify(i), 160);
    case 'TaskUpdate':
      return `#${i.taskId ?? '?'}${i.status ? ` → ${i.status}` : ''}${i.subject ? ` ${oneLine(i.subject, 120)}` : ''}`;
    case 'TaskGet':
    case 'TaskOutput':
    case 'TaskStop':
      return `#${i.taskId ?? i.task_id ?? i.id ?? '?'}`;
    case 'Skill':
      return i.skill || i.name || '';
    default:
      return oneLine(JSON.stringify(i), 200);
  }
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…(+${s.length - max} chars)` : s;
}

/** Tool arguments for the UI (the important fields per tool, long content truncated). GPT still gets the summary. */
export function toolInputDetail(name, input, cwd) {
  const i = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { command: clip(i.command, 6000), description: clip(i.description || '', 300), background: Boolean(i.run_in_background) };
    case 'Edit':
      return { file: relPath(i.file_path, cwd), old: clip(i.old_string, 8000), new: clip(i.new_string, 8000), all: Boolean(i.replace_all) };
    case 'MultiEdit':
      return { file: relPath(i.file_path, cwd), edits: (i.edits || []).slice(0, 30).map((e) => ({ old: clip(e?.old_string, 3000), new: clip(e?.new_string, 3000) })) };
    case 'Write':
      return { file: relPath(i.file_path, cwd), content: clip(i.content, 12_000), lines: String(i.content ?? '').split('\n').length };
    case 'Read':
    case 'NotebookRead':
      return { file: relPath(i.file_path || i.notebook_path, cwd), offset: i.offset ?? null, limit: i.limit ?? null };
    case 'NotebookEdit':
      return { file: relPath(i.notebook_path, cwd), cell: i.cell_id ?? null, mode: i.edit_mode || '', source: clip(i.new_source, 6000) };
    case 'Grep':
      return { pattern: i.pattern || '', path: relPath(i.path, cwd), glob: i.glob || '', mode: i.output_mode || '' };
    case 'Glob':
      return { pattern: i.pattern || '', path: relPath(i.path, cwd) };
    case 'WebFetch':
      return { url: i.url || '', prompt: clip(i.prompt || '', 1000) };
    case 'WebSearch':
      return { query: i.query || '' };
    case 'Agent':
    case 'Task':
      return { description: i.description || '', type: i.subagent_type || '', prompt: clip(i.prompt, 6000) };
    default:
      return { json: clip(JSON.stringify(i, null, 2), 3000) };
  }
}

/** Assembles stream-json deltas into a snapshot of what is being generated, for the live UI (main agent only). */
function createLiveTracker(onLive) {
  let blocks = new Map();
  const snapshot = () => ({
    blocks: [...blocks.values()].map((b) => ({ type: b.type, name: b.name || '', text: b.text.length > 20_000 ? `…${b.text.slice(-20_000)}` : b.text })),
  });
  const emit = () => onLive?.(snapshot());
  return {
    handle(ev) {
      if (ev.parent_tool_use_id) return;
      const e = ev.event || {};
      if (e.type === 'message_start') {
        blocks = new Map();
      } else if (e.type === 'content_block_start') {
        const cb = e.content_block || {};
        const type = cb.type === 'tool_use' ? 'tool' : cb.type === 'thinking' ? 'thinking' : cb.type === 'text' ? 'text' : null;
        if (type) blocks.set(e.index, { type, name: cb.name || '', text: '' });
      } else if (e.type === 'content_block_delta') {
        const b = blocks.get(e.index);
        const d = e.delta || {};
        const piece = d.thinking ?? d.text ?? d.partial_json ?? '';
        if (!b || !piece) return;
        b.text += piece;
        emit();
      }
    },
    // once the complete message arrives, the regular events take over from the deltas
    settle() {
      if (!blocks.size) return;
      blocks = new Map();
      emit();
    },
  };
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Runs WorkBuddy once, headless (-p, stream-json).
 * The first call names the session with --session-id, later calls --resume it, so WorkBuddy keeps its context.
 * effort 'off' disables thinking; contextWindow (tokens) is the desktop app's "context window".
 * With onLive, partial output is enabled and thinking/text/tool arguments stream to the UI as they are generated.
 * systemPromptFile replaces WorkBuddy's system prompt completely; agents (JSON) defines its sub-agents; hooks,
 * mcpConfig and addDirs come from the program's settings.
 */
export async function runWorkBuddyTurn(opts) {
  const {
    found, sessionId, resume, prompt, cwd, model, effort, contextWindow, permissionMode = 'bypassPermissions', maxTurns = 80,
    appendSystemPrompt, systemPromptFile, agents, hooks, mcpConfig, addDirs = [], autocompact, env: extraEnv,
    onEvent, onLive, signal, timeoutMs, idleTimeoutMs, rawFile, tools = WB_DEFAULT_TOOLS,
  } = opts;
  if (!found) throw new Error(t('srv.wb.missing'));
  const args = [
    found.cli, '-p',
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', permissionMode,
    '--max-turns', String(maxTurns),
    '--disallowedTools', WB_DISALLOWED_TOOLS.join(','),
  ];
  if (onLive) args.push('--include-partial-messages');
  // tools === 'all': no restriction, WorkBuddy's defaults
  if (tools && tools !== 'all') args.push('--tools', tools);
  if (model && model !== 'auto') args.push('--model', model);
  const settings = {};
  if (effort === 'off') settings.alwaysThinkingEnabled = false;
  else if (effort && WB_EFFORTS.includes(effort)) args.push('--effort', effort);
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) settings.contextWindow = contextWindow;
  if (hooks && Object.keys(hooks).length) settings.hooks = hooks;
  if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));
  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);
  if (systemPromptFile) args.push('--system-prompt-file', systemPromptFile);
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  if (agents) args.push('--agents', agents);
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
  for (const d of addDirs) if (d) args.push('--add-dir', d);
  if (autocompact) args.push('--autocompact', String(autocompact));

  const started = Date.now();
  const toolCalls = [];
  const toolIndex = new Map();
  const texts = [];
  const live = onLive ? createLiveTracker(onLive) : null;
  let sawInit = false;
  let result = null;
  let modelName = '';

  const res = await runProcess(found.electron, args, {
    cwd,
    env: await wbEnv(found, extraEnv || {}),
    input: prompt,
    signal,
    timeoutMs,
    idleTimeoutMs,
    rawFile,
    // deltas are only for the live view; keep them out of the raw log
    rawFilter: (line) => !line.startsWith('{"type":"stream_event"'),
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      // sub-agent messages carry parent_tool_use_id; the UI nests them under the matching Agent call
      const parent = ev.parent_tool_use_id || null;
      if (ev.type === 'stream_event') {
        live?.handle(ev);
      } else if (ev.type === 'system' && ev.subtype === 'init') {
        sawInit = true;
        modelName = ev.model || '';
        onEvent?.({ kind: 'wb.init', sessionId: ev.session_id, model: ev.model });
      } else if (ev.type === 'assistant') {
        if (!parent) live?.settle();
        if (ev.message?.model && !parent) modelName = ev.message.model;
        for (const block of ev.message?.content || []) {
          if (block.type === 'text' && block.text?.trim()) {
            if (!parent) texts.push(block.text);
            onEvent?.({ kind: 'wb.text', text: truncate(block.text, 20_000), parent });
          } else if (block.type === 'thinking' && (block.thinking || block.text)) {
            onEvent?.({ kind: 'wb.thinking', text: truncate(block.thinking || block.text, 8000), parent });
          } else if (block.type === 'tool_use') {
            const call = { id: block.id, name: block.name, summary: summarizeToolInput(block.name, block.input, cwd), ok: null };
            toolIndex.set(block.id, toolCalls.length);
            toolCalls.push(call);
            onEvent?.({ kind: 'wb.tool', id: block.id, name: block.name, summary: call.summary, input: toolInputDetail(block.name, block.input, cwd), parent });
          }
        }
      } else if (ev.type === 'user') {
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const idx = toolIndex.get(block.tool_use_id);
          const isError = !!block.is_error;
          if (idx != null) toolCalls[idx].ok = !isError;
          onEvent?.({ kind: 'wb.tool_result', id: block.tool_use_id, isError, text: clip(toolResultText(block.content), 8000), parent });
        }
      } else if (ev.type === 'result') {
        result = ev;
      }
    },
  });
  live?.settle();

  const errors = [...(result?.errors || [])];
  if (!result) {
    if (res.aborted) errors.push(t('srv.stopped'));
    else if (res.timedOut) errors.push(t('srv.wb.timeout', { min: Math.round(timeoutMs / 60000) }));
    else if (res.idleTimedOut) errors.push(t('srv.wb.idle', { min: Math.round(idleTimeoutMs / 60000) }));
    else if (res.error) errors.push(res.error.message);
    const tail = String(res.stderr || '').split('\n').filter((l) => l.trim() && !/^\s+at |fetch config failed/.test(l)).slice(-8).join('\n');
    if (tail) errors.push(tail);
    if (!errors.length) errors.push(t('srv.wb.crashed', { code: res.code, signal: res.signal || '-' }));
  }
  const ok = !!result && result.subtype === 'success' && !result.is_error;
  const errorText = errors.join('\n');
  const maxTurnsHit = /max turns/i.test(errorText);
  let errorKind = null;
  if (!ok) {
    if (res.aborted) errorKind = 'aborted';
    else if (maxTurnsHit) errorKind = 'max_turns';
    else if (res.timedOut || res.idleTimedOut) errorKind = 'transient';
    else errorKind = classifyWbError(`${errorText}\n${result?.result || ''}`);
  }
  return {
    ok,
    sawInit,
    sessionId: result?.session_id || sessionId,
    model: modelName,
    resultText: typeof result?.result === 'string' ? result.result : '',
    lastTexts: texts.slice(-3),
    subtype: result?.subtype || null,
    errors,
    errorKind,
    maxTurnsHit,
    numTurns: result?.num_turns ?? null,
    usage: result?.usage || null,
    permissionDenials: result?.permission_denials || [],
    toolCalls,
    durationMs: Date.now() - started,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a password-protected `codebuddy --serve` for a moment and uses its official account API to log in/out.
 * The WorkBuddy core writes the credentials to wbloop-cli.info itself.
 */
async function withServe(found, fn, { signal } = {}) {
  const port = await freePort();
  const password = crypto.randomBytes(16).toString('hex');
  const env = await wbEnv(found, { CODEBUDDY_GATEWAY_PASSWORD: password });
  const child = spawn(found.electron, [found.cli, '--serve', '--port', String(port), '--host', '127.0.0.1'], {
    env,
    cwd: WB_HOME,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-20_000);
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // gone
    }
  };
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-codebuddy-request': '1', 'content-type': 'application/json' };
  try {
    const deadline = Date.now() + 40_000;
    for (;;) {
      if (signal?.aborted) throw new Error(t('srv.cancelled'));
      if (child.exitCode != null) throw new Error(t('srv.wb.serveFailed', { err: oneLine(stderr, 300) }));
      try {
        const r = await fetch(`${base}/api/v1/auth/status`, { headers });
        if (r.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(t('srv.wb.serveTimeout'));
      await sleep(400);
    }
    const loginRes = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
    const loginJson = await loginRes.json().catch(() => ({}));
    const token = loginJson?.data?.token || loginJson?.token;
    if (!token) throw new Error(t('srv.wb.serveNoToken'));
    const api = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { ...headers, authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      return j.data ?? j;
    };
    return await fn(api);
  } finally {
    stop();
  }
}

export function openUrl(url) {
  spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true }).unref();
}

/**
 * Login flow. onUpdate receives { state: 'starting'|'waiting'|'done'|'error', authUrl?, message? }.
 */
export async function wbLogin(found, { method = 'internal', onUpdate, signal, timeoutMs = 10 * 60_000, open = true } = {}) {
  onUpdate?.({ state: 'starting' });
  return withServe(found, async (api) => {
    const status = await api('GET', '/api/v1/auth/account/status');
    if (status?.authenticated) {
      onUpdate?.({ state: 'done', account: status.account, message: t('srv.wb.loggedIn') });
      return { ok: true, account: status.account, already: true };
    }
    const started = await api('POST', '/api/v1/auth/account/login', { method });
    const authUrl = started?.authUrl;
    if (!authUrl) throw new Error(started?.loginError || t('srv.wb.noLoginUrl'));
    if (open) openUrl(authUrl);
    onUpdate?.({ state: 'waiting', authUrl });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000, signal);
      const s = await api('GET', '/api/v1/auth/account/status').catch(() => null);
      if (s?.authenticated) {
        onUpdate?.({ state: 'done', account: s.account });
        return { ok: true, account: s.account };
      }
      if (s?.loginError) throw new Error(t('srv.wb.loginFailed', { err: s.loginError }));
    }
    throw new Error(t('srv.wb.loginTimeout'));
  }, { signal }).catch((err) => {
    onUpdate?.({ state: 'error', message: err.message });
    return { ok: false, error: err.message };
  });
}

export async function wbLogout(found) {
  return withServe(found, (api) => api('POST', '/api/v1/auth/account/logout'));
}

export async function wbCheckOnline(found) {
  return withServe(found, (api) => api('GET', '/api/v1/auth/account/status'));
}
