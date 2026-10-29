// The interactive terminal client (`onei`, English for now). It works on the same task files as the app: a goal
// creates a task whose runner starts detached, the transcript follows events.jsonl, and messages and commands go
// through the control channel. Leaving the CLI never stops a task; `onei` again (or the app) picks it back up.
//
// Three voices share one transcript, told apart by a glyph and a colour:
//   ›  you            ◇  the lead (plans, audits)            ◆  the executor (does the work)
// Below the transcript sit a one-line status (spinner, who is working, time, tokens) and the input line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, saveConfig } from './config.js';
import { ENGINE_IDS, engine, engineName, roleNames, roleSpec } from './engines/index.js';
import { setRoleNames, t } from './i18n.js';
import { decideApproval, pendingApprovals } from './safety.js';
import * as svc from './service.js';
import { effectiveStatus, isRunnerAlive, listRuns, readEvents, readState } from './store.js';
import { usageReport } from './usage.js';
import { openUrl } from './workbuddy.js';

const out = process.stdout;
const COLOR = out.isTTY && !process.env.NO_COLOR;
const sgr = (open, close = 0) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const S = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  you: sgr('38;5;223', 39),
  lead: sgr('38;5;179', 39),
  exec: sgr('38;5;110', 39),
  ok: sgr('38;5;108', 39),
  warn: sgr('38;5;179', 39),
  bad: sgr('38;5;167', 39),
  ask: sgr('38;5;140', 39),
  gray: sgr('38;5;245', 39),
};
const EN = (key, params) => t(key, params, 'en');
const ACTIVE = new Set(['running', 'waiting', 'paused', 'waiting_user', 'queued']);
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PLACEHOLDER = { idle: 'Write your goal, then take a nap.', task: 'Message the lead…', solo: 'Message the executor…', done: 'Anything else?', reply: 'Your answer…' };
const ALIASES = { gpt: 'chatgpt', chatgpt: 'chatgpt', codex: 'chatgpt', claude: 'claude', deepseek: 'deepseek', ds: 'deepseek', workbuddy: 'workbuddy', wb: 'workbuddy' };

// ---------- text measuring: CJK and other wide characters take two columns ----------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const isWide = (cp) => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);

export function width(s) {
  let w = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

/** Cuts plain text to a column width, with an ellipsis. */
export function fit(s, cols) {
  const text = String(s);
  if (width(text) <= cols) return text;
  let w = 0;
  let res = '';
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > cols - 1) break;
    res += ch;
    w += cw;
  }
  return `${res}…`;
}

/** Word wrap for plain text (no colour codes inside); long words and CJK runs break anywhere. */
export function wrap(text, cols) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    let w = 0;
    for (const token of para.split(/(\s+)/)) {
      if (!token) continue;
      const tw = width(token);
      if (w + tw <= cols) {
        line += token;
        w += tw;
        continue;
      }
      if (/^\s+$/.test(token)) {
        lines.push(line.trimEnd());
        line = '';
        w = 0;
        continue;
      }
      // a CJK run has no spaces to break at: it fills the line character by character
      const wide = [...token].some((ch) => isWide(ch.codePointAt(0)));
      if (!wide && tw <= cols && line.trim()) {
        lines.push(line.trimEnd());
        line = token;
        w = tw;
        continue;
      }
      for (const ch of token) {
        const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
        if (w + cw > cols) {
          lines.push(line.trimEnd());
          line = '';
          w = 0;
        }
        line += ch;
        w += cw;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** A path cut from the left, so the folder name stays visible. */
function tailFit(s, n) {
  const chars = [...String(s)];
  if (width(s) <= n) return String(s);
  let tail = chars.slice(-Math.max(1, n - 1)).join('');
  const cut = tail.indexOf('/');
  if (cut > 0 && cut < tail.length - 1) tail = tail.slice(cut);
  return `…${tail}`;
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cols = () => Math.max(40, out.columns || 100);
const shortDir = (d) => (d.startsWith(os.homedir()) ? `~${d.slice(os.homedir().length)}` : d);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Markdown, lightly: headings become bold lines, emphasis markers go, everything is indented and wrapped. */
function body(text, { indent = '  ', max = 40, paint = (x) => x } = {}) {
  const w = cols() - width(indent) - 1;
  const lines = [];
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const head = raw.match(/^#{1,6}\s+(.*)$/);
    const clean = (head ? head[1] : raw).replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
    for (const l of wrap(clean, w)) lines.push(head ? S.bold(l) : paint(l));
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const cut = lines.length > max ? [...lines.slice(0, max), S.dim(`… ${lines.length - max} more lines`)] : lines;
  return cut.map((l) => (l ? indent + l : '')).join('\n');
}

// ---------- names of engines and models ----------

function modelLabel(id, model) {
  if (!model || model === 'auto') return id === 'chatgpt' ? '' : model === 'auto' ? 'auto' : 'default';
  try {
    const m = engine(id).models(loadConfig()).find((x) => x.id === model);
    return m?.name || model;
  } catch {
    return model;
  }
}

function roleText(cfg, role) {
  const sp = roleSpec(cfg, role);
  let model = sp.model;
  if (!model && sp.engine === 'chatgpt') {
    try {
      model = engine('chatgpt').defaultModel(cfg);
    } catch {
      model = '';
    }
  }
  const m = modelLabel(sp.engine, model);
  return [sp.name, m && m.toLowerCase() !== sp.name.toLowerCase() ? m : '', sp.effort].filter(Boolean).join(' · ');
}

const LEAD_ACT = { plan: 'planning', audit: 'auditing', review: 'reviewing', followup: 'reading your message', wrapup: 'wrapping up' };

function leadLabel(label = '') {
  if (label === 'plan') return 'plan';
  if (label.startsWith('audit-')) return `audit ${label.slice(6)}`;
  if (label.startsWith('review-')) return 'independent review';
  if (label.startsWith('followup')) return 'follow-up';
  if (label.startsWith('wrapup')) return 'wrap-up';
  return label;
}

// ---------- the screen: transcript above, status and input at the bottom ----------

class Screen {
  constructor() {
    this.status = '';
    this.statusShown = false;
    this.placeholder = '';
    this.placeholderShown = false;
    this.rl = null;
  }

  attach(rl) {
    this.rl = rl;
  }

  /** Moves the cursor to the first row of the status/prompt area and clears it. extraRows: rows already submitted. */
  clearBottom(extraRows = 0) {
    const pos = this.rl.getCursorPos();
    readline.moveCursor(out, 0, -(pos.rows + extraRows + (this.statusShown ? 1 : 0)));
    readline.cursorTo(out, 0);
    readline.clearScreenDown(out);
  }

  drawBottom() {
    if (this.status) {
      out.write(`${this.status}\n`);
      this.statusShown = true;
    } else {
      this.statusShown = false;
    }
    this.rl.prompt(true);
    this.drawPlaceholder();
  }

  drawPlaceholder() {
    this.placeholderShown = false;
    if (this.rl.line || !this.placeholder || !out.isTTY) return;
    const pos = this.rl.getCursorPos();
    out.write(S.dim(fit(this.placeholder, cols() - pos.cols - 1)));
    readline.cursorTo(out, pos.cols);
    this.placeholderShown = true;
  }

  /** Prints transcript text above the status line. */
  print(text = '', extraRows = 0) {
    if (!this.rl) {
      out.write(`${text}\n`);
      return;
    }
    this.clearBottom(extraRows);
    if (text != null) out.write(`${text}\n`);
    this.drawBottom();
  }

  /** Repaints only the status line, leaving the input untouched. */
  setStatus(text) {
    const next = text ? fit(text, cols() - 1) : '';
    if (!this.rl || next === this.status) return;
    if (Boolean(next) !== this.statusShown) {
      this.status = next;
      this.print(null);
      return;
    }
    this.status = next;
    const pos = this.rl.getCursorPos();
    readline.moveCursor(out, 0, -(pos.rows + 1));
    readline.cursorTo(out, 0);
    out.write(`${next}\x1b[K`);
    readline.moveCursor(out, 0, pos.rows + 1);
    readline.cursorTo(out, pos.cols);
  }

  setPlaceholder(text) {
    if (text === this.placeholder) return;
    this.placeholder = text;
    if (this.rl && !this.rl.line) this.print(null);
  }
}

// ---------- the session ----------

export class Session {
  constructor({ dir = process.cwd(), goal = '' } = {}) {
    this.dir = path.resolve(dir);
    this.screen = new Screen();
    this.runId = null;
    this.offset = 0;
    this.state = null;
    this.options = { mode: 'normal', team: 'off', check: null, useLead: null };
    this.lastPlan = '';
    this.pendingText = null;
    this.busy = null;
    this.spin = 0;
    this.ctrlC = 0;
    this.verbose = false;
    this.initialGoal = goal;
  }

  get cfg() {
    return loadConfig();
  }

  /** What a new task would run with: the saved defaults plus this session's options. */
  newSettings() {
    const o = this.options;
    const loop = {};
    if (o.check != null) loop.checkCommand = o.check;
    if (o.useLead != null) loop.useLead = o.useLead;
    return { loop, agents: { mode: o.mode }, team: { mode: o.team } };
  }

  taskSettings() {
    return this.state?.settings || { ...this.cfg, loop: { ...this.cfg.loop, ...this.newSettings().loop } };
  }

  print(text) {
    this.screen.print(text);
  }

  note(text) {
    this.print(S.dim(`  ${text}`));
  }

  start() {
    const rl = readline.createInterface({ input: process.stdin, output: out, prompt: `${S.you('›')} `, completer: (line) => this.complete(line), historySize: 200 });
    this.rl = rl;
    this.screen.attach(rl);
    process.stdin.on('keypress', (ch, key) => this.onKey(ch, key));
    rl.on('line', (line) => this.onLine(line));
    rl.on('SIGINT', () => this.onCtrlC());
    rl.on('close', () => this.quit());
    out.on('resize', () => this.print(null));
    this.header();
    // a task already running in this folder: follow it
    const runsHere = listRuns().filter((r) => r.workdir === this.dir);
    const here = runsHere.find((r) => ACTIVE.has(r.status));
    if (here) this.open(here.id);
    else {
      if (runsHere[0]) this.note(`last task here: ${fit(oneLine(runsHere[0].goal), cols() - 40)} · ${runsHere[0].status} · /open to see it`);
      this.screen.setPlaceholder(PLACEHOLDER.idle);
    }
    this.screen.drawBottom();
    if (this.initialGoal) this.newTask(this.initialGoal);
    this.timer = setInterval(() => this.tick(), 120);
  }

  header() {
    const cfg = this.cfg;
    const solo = (this.options.useLead ?? cfg.loop?.useLead) === false;
    const lines = [
      '',
      `  ${S.lead('☾')}  ${S.bold('Oneiropolos')}   ${S.dim(tailFit(shortDir(this.dir), cols() - 22))}`,
      `     ${S.dim('lead')}  ${solo ? S.dim('off') : S.lead(roleText(cfg, 'lead'))}`,
      `     ${S.dim('exec')}  ${S.exec(roleText(cfg, 'executor'))}`,
      `     ${S.dim('/help for commands · esc interrupts · ctrl+c leaves (tasks keep running)')}`,
      '',
    ];
    out.write(`${lines.join('\n')}\n`);
  }

  // ---------- input ----------

  onKey(ch, key) {
    if (!key) return;
    if (key.name === 'escape') {
      this.interrupt();
      return;
    }
    if (!(key.ctrl && key.name === 'c')) this.ctrlC = 0;
    // the placeholder disappears with the first character and comes back on an empty line
    setImmediate(() => {
      if (this.screen.placeholderShown && this.rl.line) {
        out.write('\x1b[K');
        this.screen.placeholderShown = false;
      } else if (!this.rl.line && !this.screen.placeholderShown) {
        this.screen.drawPlaceholder();
      }
    });
  }

  onCtrlC() {
    if (this.rl.line) {
      this.rl.write(null, { ctrl: true, name: 'u' });
      this.rl.write(null, { ctrl: true, name: 'k' });
      return;
    }
    this.ctrlC += 1;
    if (this.ctrlC >= 2) {
      this.quit();
      return;
    }
    this.note(this.runId && ACTIVE.has(this.status()) ? 'Press ctrl+c again to leave. The task keeps running; `onei` brings you back.' : 'Press ctrl+c again to leave.');
  }

  /** The submitted line is still on screen as typed: replace it by the transcript's own rendering. */
  onLine(line) {
    const text = line.trim();
    const promptCols = 2;
    const rows = Math.floor((promptCols + width(line)) / cols()) + 1;
    this.screen.clearBottom(rows);
    this.screen.drawBottom();
    if (!text) return;
    if (text.startsWith('/')) {
      this.command(text).catch((err) => this.print(S.bad(`  ✗ ${err.message}`)));
      return;
    }
    if (!this.runId) {
      this.newTask(text);
      return;
    }
    try {
      svc.controlRun(this.runId, 'message', { text });
      // the runner echoes it as a user.message event; until then show it as pending
      this.pendingText = text;
      this.print(`${S.you('›')} ${S.bold(text)}`);
    } catch (err) {
      this.print(S.bad(`  ✗ ${err.message}`));
    }
  }

  /** Esc: end the current step now; whatever is typed goes along as the message. */
  interrupt() {
    if (!this.runId || !isRunnerAlive(readState(this.runId))) return;
    const text = this.rl.line.trim();
    if (!text) {
      this.note('Type what you want to say, then press esc to interrupt with it (enter sends it for the next step).');
      return;
    }
    this.rl.write(null, { ctrl: true, name: 'u' });
    this.rl.write(null, { ctrl: true, name: 'k' });
    svc.controlRun(this.runId, 'cut', { text });
    this.pendingText = text;
    this.print(`${S.you('›')} ${S.bold(text)} ${S.dim('(interrupting)')}`);
  }

  complete(line) {
    const cmds = ['/new', '/open', '/tasks', '/lead', '/exec', '/mode', '/team', '/check', '/pause', '/resume', '/stop', '/approve', '/allow', '/deny', '/login', '/status', '/usage', '/verbose', '/help', '/quit'];
    if (!line.startsWith('/')) return [[], line];
    const parts = line.split(' ');
    if (parts.length === 1) return [cmds.filter((c) => c.startsWith(line)), line];
    if (['/lead', '/exec', '/login'].includes(parts[0]) && parts.length === 2) {
      const names = ['gpt', 'claude', 'deepseek', 'workbuddy', ...(parts[0] === '/lead' ? ['off', 'on'] : [])];
      return [names.filter((n) => n.startsWith(parts[1])).map((n) => `${parts[0]} ${n}`), line];
    }
    return [[], line];
  }

  // ---------- tasks ----------

  status() {
    const s = this.runId ? readState(this.runId) : null;
    return s ? effectiveStatus(s) : '';
  }

  newTask(goal) {
    let run;
    try {
      run = svc.createTask({ goal, workdir: this.dir, settings: this.newSettings() });
    } catch (err) {
      this.print(S.bad(`  ✗ ${err.message}`));
      return;
    }
    this.print(`${S.you('›')} ${S.bold(goal)}`);
    svc.spawnRunner(run.id);
    this.follow(run.id, { replay: false });
  }

  open(id) {
    const s = readState(id);
    if (!s) throw new Error(`No task ${id}`);
    this.print(S.dim(`  ── ${oneLine(s.goal).slice(0, 60)} · ${effectiveStatus(s)} ──`));
    this.print(`${S.you('›')} ${S.bold(s.goal)}`);
    this.follow(id, { replay: true });
  }

  follow(id, { replay }) {
    this.runId = id;
    this.offset = 0;
    this.lastPlan = '';
    this.busy = null;
    this.state = readState(id);
    setRoleNames(roleNames(this.state.settings));
    this.replaying = replay;
    this.poll();
    this.replaying = false;
  }

  poll() {
    if (!this.runId) return;
    const { events, offset } = readEvents(this.runId, this.offset);
    this.offset = offset;
    this.state = readState(this.runId) || this.state;
    for (const ev of events) {
      try {
        this.render(ev);
      } catch (err) {
        this.note(`(could not show a ${ev.kind} event: ${err.message})`);
      }
    }
    const st = this.status();
    const solo = this.state?.settings?.loop?.useLead === false;
    this.screen.setPlaceholder(st === 'waiting_user' ? PLACEHOLDER.reply : ACTIVE.has(st) ? (solo ? PLACEHOLDER.solo : PLACEHOLDER.task) : PLACEHOLDER.done);
  }

  tick() {
    this.poll();
    const s = this.state;
    if (!s || !this.runId) {
      this.screen.setStatus('');
      return;
    }
    const st = effectiveStatus(s);
    if (!ACTIVE.has(st)) {
      this.screen.setStatus('');
      return;
    }
    this.spin = (this.spin + 1) % SPIN.length;
    const elapsed = clock(Date.now() - Date.parse(s.startedAt || s.createdAt));
    const stats = s.stats || {};
    const tok = (stats.gptIn || 0) + (stats.gptOut || 0) + (stats.wbIn || 0) + (stats.wbOut || 0);
    const inTok = (stats.gptIn || 0) + (stats.wbIn || 0);
    const hit = inTok ? ` · cache ${Math.round((100 * ((stats.gptCachedIn || 0) + (stats.wbCachedIn || 0))) / inTok)}%` : '';
    let what;
    if (st === 'paused') what = S.warn(`paused${s.messageKey ? ` · ${EN(s.messageKey, s.messageParams)}` : ''} · /resume`);
    else if (st === 'waiting_user') what = S.ask('waiting for you');
    else if (st === 'waiting') what = S.warn(s.messageKey ? EN(s.messageKey, s.messageParams) : 'waiting');
    else if (this.busy) what = `${this.busy.role === 'lead' ? S.lead(this.busy.name) : S.exec(this.busy.name)} ${this.busy.act}${this.busy.last ? S.dim(` · ${this.busy.last}`) : ''}`;
    else what = 'working';
    const spin = st === 'running' ? S.gray(SPIN[this.spin]) : S.dim('·');
    this.screen.setStatus(`${spin} ${what} ${S.dim(`· ${s.round ? `round ${s.round} · ` : ''}${elapsed}${tok ? ` · ${fmtTok(tok)} tok${hit}` : ''}`)}`);
  }

  // ---------- events → transcript ----------

  render(ev) {
    const set = this.state?.settings || {};
    const names = roleNames(set);
    switch (ev.kind) {
      case 'user.message':
        if (this.pendingText && oneLine(this.pendingText) === oneLine(ev.text)) this.pendingText = null;
        else this.print(`${S.you('›')} ${S.bold(ev.text)}${ev.cut ? S.dim(' (interrupting)') : ''}`);
        break;
      case 'gpt.start': {
        const name = engineName(ev.engine) || names.lead;
        const rev = String(ev.label || '').startsWith('review-');
        this.busy = { role: 'lead', name, act: LEAD_ACT[String(ev.label || '').split('-')[0]] || 'thinking' };
        this.print(`\n${S.lead('◇')} ${S.lead(S.bold(rev ? 'Reviewer' : name))} ${S.dim(`· ${leadLabel(ev.label)}`)}`);
        break;
      }
      case 'gpt.item':
        if (this.busy?.role === 'lead' && ev.itemType === 'command_execution') this.busy.last = `$ ${oneLine(ev.command).slice(0, 60)}`;
        break;
      case 'gpt.result':
        this.busy = null;
        this.leadResult(ev.output || {}, names);
        break;
      case 'gpt.error':
        this.print(S.bad(`  ✗ ${fit(oneLine(ev.message), cols() - 6)}`));
        break;
      case 'wb.start': {
        const name = ev.member || engineName(ev.engine) || names.exec;
        this.busy = { role: 'exec', name, act: 'working' };
        this.lastText = null;
        if (ev.continuation) this.print(S.dim(`  ↻ continues (${ev.resume ? 'same session' : 'new session'})`));
        else this.print(`\n${S.exec('◆')} ${S.exec(S.bold(name))} ${S.dim(`· round ${ev.round}`)}`);
        break;
      }
      case 'wb.text':
        if (ev.parent) break;
        this.flushText();
        this.lastText = ev.text;
        break;
      case 'wb.thinking':
        if (this.verbose && !ev.parent) this.print(S.dim(S.italic(`  ${fit(oneLine(ev.text), cols() - 4)}`)));
        break;
      case 'wb.tool': {
        this.flushText();
        if (this.busy) this.busy.last = `${ev.name} ${oneLine(ev.summary).slice(0, 50)}`;
        const indent = ev.parent ? '      ' : '  ';
        const name = String(ev.name || '').padEnd(6);
        this.print(S.dim(`${indent}⎿ ${name} ${fit(oneLine(ev.summary), cols() - width(indent) - 11)}`));
        break;
      }
      case 'wb.tool_result':
        if (ev.isError) this.print(S.bad(`      ✗ ${fit(oneLine(ev.text), cols() - 9)}`));
        break;
      case 'wb.end': {
        this.busy = null;
        const report = ev.resultText || this.lastText || '';
        this.lastText = null;
        if (report.trim()) this.print(`\n${body(report, { max: this.verbose ? 200 : 24 })}`);
        const u = ev.usage;
        const facts = [`${ev.toolCount ?? 0} tool${ev.toolCount === 1 ? '' : 's'}`, ev.durationMs ? clock(ev.durationMs) : '', u ? `${fmtTok(u.input)} in${u.input ? ` · cache ${Math.round((100 * (u.cached || 0)) / u.input)}%` : ''}` : ''].filter(Boolean).join(' · ');
        this.print(S.dim(`  ${facts}`));
        if (!ev.ok && ev.errorKind !== 'cut') this.print(S.warn(`  ! ${fit(oneLine((ev.errors || []).join('; ')), cols() - 6)}`));
        break;
      }
      case 'team.start':
        this.print(`  ${S.exec('⇉')} ${S.dim('team:')} ${ev.members.map((m) => m.name).join(', ')}`);
        break;
      case 'team.merged':
        this.print(S.dim(`  merged ${ev.merged.length}${ev.conflicts.length ? S.warn(` · conflicts: ${ev.conflicts.join(', ')}`) : ''}`));
        break;
      case 'round.diff':
        if (ev.files) {
          const add = ev.files.reduce((n, f) => n + (Number(f.add) || 0), 0);
          const del = ev.files.reduce((n, f) => n + (Number(f.del) || 0), 0);
          this.print(S.dim(`  ${ev.files.length ? `${ev.files.length} file${ev.files.length === 1 ? '' : 's'} changed ${S.ok(`+${add}`)} ${S.bad(`−${del}`)}` : 'no file changes'}`));
        }
        break;
      case 'round.check':
        this.print(`  ${ev.ok ? S.ok('✓ check passed') : S.bad(`✗ check ${ev.timedOut ? 'timed out' : `failed (exit ${ev.code})`}`)} ${S.dim(`$ ${fit(ev.command, cols() - 30)}`)}`);
        break;
      case 'wait':
        this.note(ev.key ? EN(ev.key, ev.params) : ev.reason);
        break;
      case 'ask':
        this.print(`\n${S.ask('?')} ${S.ask(S.bold(`${names.lead} asks`))}\n${body(ev.question, { paint: S.ask })}`);
        break;
      case 'plan.approval':
        this.print(`\n${S.ask('?')} ${S.ask('The plan is ready.')} ${S.dim('/approve to start, or type what to change.')}`);
        break;
      case 'plan.approved':
        this.note('plan approved');
        break;
      case 'approval.request':
        this.print(`\n${S.ask('!')} ${S.ask(`${ev.member || names.exec} wants to run`)} ${S.bold(`$ ${fit(oneLine(ev.command), cols() - 30)}`)}\n  ${S.dim(`${ev.rule?.description ? `${ev.rule.description} · ` : ''}/allow or /deny`)}`);
        break;
      case 'approval.result':
        if (ev.by !== 'policy') this.note(`${ev.decision === 'allow' ? 'allowed' : 'denied'}: $ ${fit(oneLine(ev.command), cols() - 20)}`);
        break;
      case 'info':
        this.note(ev.key ? EN(ev.key, ev.params) : ev.text);
        break;
      case 'error':
        this.print(S.bad(`  ✗ ${ev.message}`));
        break;
      case 'run.status':
        if (['paused', 'stopped', 'failed'].includes(ev.status) && !this.replaying) {
          const why = ev.key ? EN(ev.key, ev.params) : ev.message;
          this.print(`${ev.status === 'paused' ? S.warn('‖ paused') : S.warn(`■ ${ev.status}`)}${why ? S.dim(` · ${why}`) : ''}`);
        }
        break;
      case 'done': {
        this.busy = null;
        const s = this.state || {};
        const took = s.finishedAt ? ` · ${clock(Date.parse(s.finishedAt) - Date.parse(s.createdAt))}` : '';
        // the summary is usually the assessment just printed above it
        const solo = s.settings?.loop?.useLead === false;
        const summary = ev.summary && !solo && oneLine(ev.summary) !== this.lastAssessment ? `\n${body(ev.summary, { max: 12 })}` : '';
        this.print(`\n${ev.aborted ? S.warn('■ Stopped') : S.lead('✦ Done')} ${S.dim(`· ${ev.rounds} round${ev.rounds === 1 ? '' : 's'}${took}`)}${summary}\n`);
        break;
      }
      default:
        break;
    }
  }

  flushText() {
    if (this.lastText) this.print(S.dim(`  ${fit(oneLine(this.lastText), cols() - 4)}`));
    this.lastText = null;
  }

  leadResult(o, names) {
    const tone = o.verdict === 'done' ? S.ok : o.verdict === 'continue' ? S.lead : o.verdict === 'ask_user' ? S.ask : S.warn;
    const verdict = { continue: 'continue', done: 'done', ask_user: 'asks you', abort: 'stops' }[o.verdict] || o.verdict;
    this.print(`  ${tone(verdict)} ${S.dim(`· ${o.progress ?? 0}%`)}`);
    if (o.assessment) this.print(body(o.assessment, { max: 10 }));
    this.lastAssessment = oneLine(o.assessment);
    for (const i of o.issues || []) this.print(`  ${i.severity === 'blocker' ? S.bad('!') : S.warn('!')} ${S.dim(`[${i.severity}]`)} ${fit(oneLine(i.detail), cols() - 18)}`);
    const plan = (o.plan || []).map((p) => `${p.status === 'done' ? S.ok('✓') : p.status === 'doing' ? S.lead('◆') : S.dim('○')} ${p.status === 'done' ? S.dim(p.title) : p.title}`);
    const planKey = JSON.stringify(o.plan || []);
    if (plan.length && planKey !== this.lastPlan) {
      this.lastPlan = planKey;
      this.print(plan.map((l) => `  ${fit(l, cols() + 20)}`).join('\n'));
    }
    if (o.verdict === 'continue') {
      const team = (o.team || []).filter((m) => m?.name);
      if (team.length > 1) for (const m of team) this.print(`  ${S.exec('→')} ${S.exec(m.name)} ${S.dim(fit(oneLine(m.instruction), cols() - 10 - width(m.name)))}`);
      else if (o.next_instruction) this.print(`  ${S.exec('→')} ${S.exec(names.exec)}\n${body(o.next_instruction, { indent: `  ${S.dim('│')} `, max: 8, paint: S.dim })}`);
    }
  }

  // ---------- slash commands ----------

  async command(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    const need = () => {
      if (!this.runId) throw new Error('No task yet: type a goal first.');
      return this.runId;
    };
    switch (cmd) {
      case '/help':
        this.help();
        break;
      case '/new':
        this.runId = null;
        this.state = null;
        this.busy = null;
        this.screen.setStatus('');
        if (arg) this.newTask(arg);
        else {
          this.print(S.dim('  ── new task ──'));
          this.screen.setPlaceholder(PLACEHOLDER.idle);
        }
        break;
      case '/tasks':
      case '/open': {
        const runs = listRuns().slice(0, 12);
        if (cmd === '/open' && !arg) {
          const last = listRuns().find((r) => r.workdir === this.dir);
          if (last) {
            this.open(last.id);
            break;
          }
        }
        if (cmd === '/open' && arg) {
          const pick = /^\d+$/.test(arg) ? runs[Number(arg) - 1] : runs.find((r) => r.id === arg || r.id.endsWith(arg));
          if (!pick) throw new Error(`No task ${arg}`);
          this.open(pick.id);
          break;
        }
        if (!runs.length) {
          this.note('No tasks yet.');
          break;
        }
        this.print(runs.map((r, i) => `  ${S.dim(String(i + 1).padStart(2))}  ${(ACTIVE.has(r.status) ? S.exec : S.dim)(r.status.padEnd(12))} ${fit(oneLine(r.goal), cols() - 40)}  ${S.dim(shortDir(r.workdir).split('/').pop())}`).join('\n'));
        this.note('/open <number> to follow one');
        break;
      }
      case '/lead':
      case '/exec':
        this.setRole(cmd === '/lead' ? 'lead' : 'executor', rest);
        break;
      case '/mode': {
        const m = { normal: 'normal', plan: 'plan', vuln: 'vuln' }[arg];
        if (!m) throw new Error('Use /mode normal | plan | vuln');
        this.options.mode = m;
        this.note(`mode: ${m} (for the next task)`);
        break;
      }
      case '/team': {
        if (!['off', 'auto', 'always'].includes(arg)) throw new Error('Use /team off | auto | always');
        this.options.team = arg;
        this.note(`team: ${arg} (for the next task)`);
        break;
      }
      case '/check':
        this.options.check = arg && arg !== 'off' ? arg : '';
        if (this.runId && ACTIVE.has(this.status())) svc.controlRun(this.runId, 'settings', { patch: { loop: { checkCommand: this.options.check } } });
        this.note(this.options.check ? `check: $ ${this.options.check}` : 'check: off');
        break;
      case '/pause':
      case '/stop':
        svc.controlRun(need(), cmd.slice(1));
        this.note(cmd === '/pause' ? 'pausing after this step' : 'stopping');
        break;
      case '/resume':
        svc.controlRun(need(), 'resume');
        this.note('continuing');
        break;
      case '/approve':
        svc.controlRun(need(), 'approve', { text: arg });
        break;
      case '/allow':
      case '/deny': {
        const id = need();
        const req = pendingApprovals(id).find((r) => !arg || r.id === arg);
        if (!req) throw new Error('Nothing is waiting for approval.');
        decideApproval(id, req.id, { decision: cmd === '/allow' ? 'allow' : 'deny' });
        break;
      }
      case '/login':
        await this.login(arg);
        break;
      case '/code':
        if (!this.loginEngine?.sendCode?.(arg)) throw new Error('No sign-in is waiting for a code.');
        break;
      case '/status':
        await this.accounts();
        break;
      case '/usage': {
        const r = usageReport({ period: arg || '7d' });
        const line = (k, v) => `  ${k.padEnd(8)} ${fmtTok(v.in + v.out).padStart(6)}  ${S.dim(`${v.calls} calls · cache ${v.in ? Math.round((100 * v.cached) / v.in) : 0}%`)}`;
        this.print(`${S.dim(`  last ${r.period}`)}\n${line('lead', r.totals.gpt)}\n${line('exec', r.totals.workbuddy)}`);
        break;
      }
      case '/verbose':
        this.verbose = !this.verbose;
        this.note(`verbose ${this.verbose ? 'on: thinking and full reports' : 'off'}`);
        break;
      case '/quit':
      case '/exit':
        this.quit();
        break;
      default:
        throw new Error(`Unknown command ${cmd} · /help`);
    }
  }

  setRole(role, args) {
    const [first = '', model, effort] = args;
    if (role === 'lead' && (first === 'off' || first === 'on')) {
      this.options.useLead = first === 'on';
      if (this.runId && ACTIVE.has(this.status())) svc.controlRun(this.runId, 'settings', { patch: { loop: { useLead: this.options.useLead } } });
      this.note(first === 'on' ? 'lead on' : 'lead off: the executor works on the goal alone');
      return;
    }
    const id = ALIASES[first.toLowerCase()];
    if (!id) {
      const cfg = this.taskSettings();
      this.note(`${role === 'lead' ? 'lead' : 'exec'}: ${roleText(cfg, role)} · change with /${role === 'lead' ? 'lead' : 'exec'} <gpt|claude|deepseek|workbuddy> [model] [effort]`);
      return;
    }
    const spec = { engine: id, model: model || '', effort: effort || '' };
    saveConfig({ roles: { [role]: spec } });
    if (this.runId && ACTIVE.has(this.status())) svc.controlRun(this.runId, 'settings', { patch: { roles: { [role]: spec } } });
    this.note(`${role === 'lead' ? 'lead' : 'exec'} → ${roleText(this.cfg, role)}${this.runId && ACTIVE.has(this.status()) ? ' (this task too)' : ''}`);
  }

  async accounts() {
    const cfg = this.cfg;
    const rows = await Promise.all(ENGINE_IDS.map(async (id) => {
      try {
        return { id, ...(await engine(id).status(cfg)) };
      } catch (err) {
        return { id, installed: false, error: err.message };
      }
    }));
    const lead = roleSpec(cfg, 'lead').engine;
    const exec = roleSpec(cfg, 'executor').engine;
    this.print(rows.map((r) => {
      const mark = !r.installed ? S.dim('–') : r.loggedIn ? S.ok('●') : S.bad('●');
      const state = !r.installed ? 'not installed' : r.loggedIn ? [r.account, r.plan].filter(Boolean).join(' · ') || 'signed in' : 'not signed in · /login';
      const roles = [r.id === lead ? 'lead' : '', r.id === exec ? 'exec' : ''].filter(Boolean).join(', ');
      return `  ${mark} ${engineName(r.id).padEnd(10)} ${S.dim(state)}${roles ? `  ${S.lead(roles)}` : ''}`;
    }).join('\n'));
  }

  async login(name) {
    const id = ALIASES[String(name || '').toLowerCase()];
    if (!id) throw new Error('Use /login gpt | claude | deepseek | workbuddy');
    const eng = engine(id);
    this.loginEngine = eng;
    this.note(`signing in to ${eng.meta.vendor}…`);
    let opened = false;
    const res = await eng.login(this.cfg, {
      onUpdate: (u) => {
        if (u.state === 'waiting' && u.authUrl && !opened) {
          opened = true;
          this.print(`  ${S.dim('Open in your browser if it did not open:')}\n  ${u.authUrl}`);
          if (id !== 'claude' && id !== 'chatgpt' && !process.env.WBLOOP_NO_OPEN) openUrl(u.authUrl);
          if (u.canPaste) this.note('If the page shows a code, paste it here with /code <code>.');
        }
      },
    });
    this.loginEngine = null;
    this.print(res.ok ? S.ok(`  ✓ signed in to ${eng.meta.vendor}${res.account ? ` as ${res.account}` : ''}`) : S.bad(`  ✗ ${res.error || 'sign-in failed'}`));
  }

  help() {
    const rows = [
      ['type a goal', 'start a task in this folder'],
      ['enter', 'send a message (the next step reads it)'],
      ['esc', 'interrupt the current step with what you typed'],
      ['/lead <engine> [model] [effort]', 'who plans and audits · /lead off: executor alone'],
      ['/exec <engine> [model] [effort]', 'who does the work (gpt, claude, deepseek, workbuddy)'],
      ['/mode plan|vuln|normal  /team auto', 'options for the next task'],
      ['/check <command>', 'run after every round, e.g. /check npm test'],
      ['/pause /resume /stop', 'control the task'],
      ['/approve  /allow  /deny', 'answer a plan or a command waiting for you'],
      ['/tasks  /open [n]  /new', 'switch tasks (/open: the last one here)'],
      ['/status  /login <engine>  /usage', 'accounts and tokens'],
      ['/verbose', 'show thinking and full reports'],
      ['ctrl+c twice  /quit', 'leave; tasks keep running'],
    ];
    const w = Math.max(...rows.map(([k]) => k.length));
    this.print(rows.map(([k, v]) => `  ${S.lead(k.padEnd(w))}  ${S.dim(v)}`).join('\n'));
  }

  quit() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.rl) {
      this.screen.status = '';
      this.screen.clearBottom();
    }
    if (this.runId && ACTIVE.has(this.status())) out.write(S.dim(`  The task keeps running. Run \`onei\` here to come back.\n`));
    process.exit(0);
  }
}

/** `onei [goal]` in a folder. Without a terminal there is nothing to talk to: run `wbloop run` instead. */
export function startTui({ dir, goal } = {}) {
  if (!process.stdin.isTTY || !out.isTTY) {
    console.error('onei needs a terminal. For scripts use: wbloop run "goal"');
    process.exit(2);
  }
  if (dir && !fs.existsSync(dir)) {
    console.error(`No such folder: ${dir}`);
    process.exit(2);
  }
  new Session({ dir, goal }).start();
}
