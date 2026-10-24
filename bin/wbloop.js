#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { brandName, BRAND } from '../src/brand.js';
import { codexInfo, defaultCodexModel, findCodex, listCodexModels } from '../src/codex.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { clockText, fmtDuration, locale, t } from '../src/i18n.js';
import { loadLoops } from '../src/loops.js';
import { Orchestrator } from '../src/loop.js';
import { DATA_DIR, ROOT, WB_AUTH_FILE } from '../src/paths.js';
import { decideApproval, pendingApprovals } from '../src/safety.js';
import { findRunningServer, startServer } from '../src/server.js';
import * as svc from '../src/service.js';
import { listSubagents } from '../src/subagents.js';
import { appendControl, effectiveStatus, isValidRunId, listRuns, readEvents, readState } from '../src/store.js';
import { PLACEHOLDER_RE, findTemplate, listTemplates } from '../src/templates.js';
import { oneLine, sleep } from '../src/util.js';
import { findWorkBuddy, listWbModels, openUrl, wbAuthState, wbLogin, wbLogout } from '../src/workbuddy.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { gray: paint('90'), red: paint('31'), green: paint('32'), yellow: paint('33'), blue: paint('34'), magenta: paint('35'), cyan: paint('36'), bold: paint('1') };

// switches without a value: what follows them is a positional argument (the goal …), never their value
const BOOLEAN_FLAGS = new Set(['detach', 'force', 'open', 'ask', 'json-ready', 'help', 'reuse', 'follow', 'review', 'always', 'web-search']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (a.startsWith('--no-')) out[a.slice(5)] = false;
      else if (BOOLEAN_FLAGS.has(a.slice(2))) out[a.slice(2)] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      const key = { d: 'dir', m: 'gpt-model', h: 'help' }[a[1]] || a[1];
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && key !== 'help') out[key] = argv[++i];
      else out[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function labelName(label = '') {
  if (label === 'plan') return t('gpt.title.plan');
  if (label.startsWith('audit')) return t('gpt.title.audit', { n: label.slice(6) });
  if (label.startsWith('review')) return t('gpt.title.review', { n: label.split('-')[1] || 1 });
  if (label.startsWith('followup')) return t('gpt.title.followup');
  if (label.startsWith('wrapup')) return t('gpt.title.wrapup');
  return label;
}

const textOf = (ev, field = 'text') => (ev.key ? t(ev.key, ev.params) : ev[field]);
// "Oneiropolos (ὀνειροπόλος)" in English, "守梦人（Oneiropolos）" elsewhere
const subName = () => (brandName() === BRAND.latin ? BRAND.greek : BRAND.latin);

export function printEvent(ev) {
  const time = c.gray((ev.t || '').slice(11, 19));
  const out = (s) => console.log(`${time} ${s}`);
  const who = ev.member ? `WB:${ev.member}` : 'WB';
  switch (ev.kind) {
    case 'run.status':
      out(c.gray(`${t('cli.status')} → ${t(`status.${ev.status}`)}${ev.message ? `: ${textOf(ev, 'message')}` : ''}`));
      break;
    case 'phase':
      out(c.bold(`━━ ${t(`phase.${ev.phase}`)}${ev.round ? ` · ${t('round.n', { n: ev.round })}` : ''}${ev.team?.length ? ` · ${t('cli.team', { names: ev.team.join(', ') })}` : ''} ━━`));
      break;
    case 'gpt.start':
      out(c.blue(`[GPT] ${labelName(ev.label)}${ev.resume ? '' : ` (${t('cli.newSession')})`}…`));
      break;
    case 'gpt.item':
      if (ev.itemType === 'command_execution' && ev.phase === 'completed') out(c.blue(`[GPT] $ ${oneLine(ev.command, 140)} ${c.gray(`(exit ${ev.exitCode})`)}`));
      else if (ev.itemType === 'reasoning' && ev.text) out(c.gray(`[GPT …] ${oneLine(ev.text, 200)}`));
      break;
    case 'gpt.result': {
      const o = ev.output || {};
      const verdictColor = o.verdict === 'done' ? c.green : o.verdict === 'continue' ? c.cyan : c.yellow;
      out(`${c.blue('[GPT]')} ${t('cli.verdict')}: ${verdictColor(t(`verdict.${o.verdict}`))} · ${o.progress}%`);
      if (o.assessment) console.log(c.gray(`        ${oneLine(o.assessment, 600)}`));
      for (const i of o.issues || []) console.log(c.yellow(`        - [${t(`severity.${i.severity}`)}] ${oneLine(i.detail, 300)}`));
      if (o.team?.length) for (const m of o.team) console.log(c.cyan(`        ⇉ ${m.name}${m.role ? ` (${m.role})` : ''}: ${oneLine(m.instruction, 300)}`));
      else if (o.next_instruction) console.log(c.cyan(`        → ${oneLine(o.next_instruction, 500)}`));
      break;
    }
    case 'gpt.error':
      out(c.red(`[GPT] ${oneLine(ev.message, 300)}`));
      break;
    case 'wb.start':
      out(c.green(`[${who}] ${ev.continuation ? t('cli.wbContinue') : t('cli.wbStart')}`));
      break;
    case 'wb.init':
      if (ev.model) out(c.gray(`[${who}] ${ev.model}`));
      break;
    case 'wb.text':
      if (!ev.parent) out(c.green(`[${who}] ${oneLine(ev.text, 300)}`));
      break;
    case 'wb.tool':
      out(c.green(`[${who}] ▸ ${ev.name} ${c.gray(oneLine(ev.summary, 160))}`));
      break;
    case 'wb.tool_result':
      if (ev.isError) out(c.red(`[${who}]   ✗ ${oneLine(ev.text, 200)}`));
      break;
    case 'wb.end':
      out(c.green(`[${who}] ${ev.ok ? t('cli.wbDone') : c.yellow(t('export.notFinished', { err: oneLine((ev.errors || []).join('; '), 160) }))} · ${t('export.tools', { n: ev.toolCount })} · ${fmtDuration(ev.durationMs)}`));
      break;
    case 'team.start':
      out(c.magenta(`[Team] ${ev.members.map((m) => `${m.name}${m.role ? ` (${m.role})` : ''}`).join(' · ')}`));
      break;
    case 'team.merged':
      out(c.magenta(`[Team] ${t('cli.merged', { n: ev.merged.length })}${ev.conflicts.length ? c.yellow(` · ${t('export.conflicts')}: ${ev.conflicts.join(', ')}`) : ''}`));
      break;
    case 'round.diff':
      if (ev.files) out(c.magenta(`[diff] ${ev.files.length ? `${t('export.changed', { n: ev.files.length, add: ev.files.reduce((n, f) => n + (Number(f.add) || 0), 0), del: ev.files.reduce((n, f) => n + (Number(f.del) || 0), 0) })} ${ev.files.slice(0, 8).map((f) => `${f.status} ${f.path}`).join(', ')}${ev.files.length > 8 ? '…' : ''}` : t('export.noChanges')}`));
      else if (ev.disabled) out(c.gray(`[diff] ${ev.disabled}`));
      break;
    case 'wait':
      out(c.yellow(`[${t('status.waiting')}] ${textOf(ev, 'reason')}`));
      break;
    case 'ask':
      out(c.magenta(`[${t('notify.needYou')}] ${ev.question}`));
      console.log(c.magenta(`        ${t('cli.replyHere')}`));
      break;
    case 'plan.approval':
      out(c.magenta(`[${t('notify.planReady')}] ${t('cli.approveHint')}`));
      break;
    case 'approval.request':
      out(c.magenta(`[${t('notify.approval')}] ${ev.member ? `${ev.member}: ` : ''}$ ${oneLine(ev.command, 200)} — ${ev.rule?.description || ''}`));
      console.log(c.magenta(`        ${t('cli.approvalHint', { id: ev.id })}`));
      break;
    case 'approval.result':
      if (ev.decision !== 'allow' || ev.by !== 'policy') out(c.gray(`[gate] $ ${oneLine(ev.command, 120)} → ${t(`approval.${ev.decision}`)} (${ev.by})`));
      break;
    case 'user.message':
      out(c.cyan(`[${t('who.you')}${ev.cut ? ' ✂' : ''}] ${oneLine(ev.text, 300)}`));
      break;
    case 'round.check':
      out((ev.ok ? c.green : c.yellow)(`[check] ${ev.command} → ${ev.ok ? t('check.passed') : ev.timedOut ? t('check.timedOut') : t('check.failed', { code: ev.code })} · ${fmtDuration(ev.durationMs)}`));
      break;
    case 'schedule':
      out(c.magenta(`[${t('cli.scheduled')}] ${clockText(Date.parse(ev.at))}`));
      break;
    case 'restore':
      out(c.magenta(`[rollback] ${ev.labelKey ? t(ev.labelKey, ev.labelParams) : ev.label}`));
      break;
    case 'hook':
      out(c.gray(`[hook] ${ev.type}${ev.blocked ? ` ✗ ${ev.blocked}` : ''}`));
      break;
    case 'info':
      out(c.gray(`[i] ${textOf(ev)}`));
      break;
    case 'error':
      out(c.red(`[!] ${ev.message}`));
      break;
    case 'done':
      out(ev.aborted ? c.yellow(`■ ${t('final.aborted')}: ${oneLine(ev.summary, 400)}`) : c.green(`✔ ${t('final.done')} (${ev.rounds}): ${oneLine(ev.summary, 400)}`));
      break;
    default:
      break;
  }
}

function buildOverrides(args) {
  const o = { codex: {}, workbuddy: {}, loop: {}, team: {}, agents: {} };
  if (args['gpt-model']) o.codex.model = String(args['gpt-model']);
  if (args.effort) o.codex.effort = String(args.effort);
  if (args['web-search']) o.codex.webSearch = true;
  if (args['wb-model']) o.workbuddy.model = String(args['wb-model']);
  if (args['wb-effort']) o.workbuddy.effort = String(args['wb-effort']);
  if (args['wb-context']) o.workbuddy.contextWindow = Number(String(args['wb-context']).replace(/k$/i, '000').replace(/m$/i, '000000')) || 0;
  if (args['add-dir']) o.workbuddy.addDirs = String(args['add-dir']).split(',').map((d) => path.resolve(d.trim())).filter(Boolean);
  if (args['max-rounds']) o.loop.maxRounds = Number(args['max-rounds']);
  if (args.budget) o.loop.tokenBudgetM = Number(args.budget) || 0;
  if (typeof args.check === 'string') o.loop.checkCommand = args.check;
  if (args.review === false) o.loop.finalReview = false;
  if (args.ask) o.loop.autonomy = 'ask';
  if (args.team) o.team.mode = args.team === true ? 'auto' : String(args.team);
  if (args.teammates) o.team.maxTeammates = Number(args.teammates);
  if (args.mode) o.agents.mode = String(args.mode);
  if (args.lang) o.agents.replyLanguage = String(args.lang);
  return o;
}

async function readGoal(args) {
  if (args['goal-file']) return fs.readFileSync(String(args['goal-file']), 'utf8');
  const text = args._.slice(1).join(' ').trim();
  if (text && text !== '-') return text;
  if (!process.stdin.isTTY || text === '-') {
    let s = '';
    for await (const chunk of process.stdin) s += chunk;
    return s;
  }
  return '';
}

async function runForeground(runId) {
  const orch = new Orchestrator(runId, { onEvent: printEvent });
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts === 1) {
      console.log(c.yellow(`\n${t('cli.stopping')}`));
      orch.requestStop();
    } else {
      process.exit(130);
    }
  });
  let rl = null;
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      if (text === '/pause') appendControl(runId, { cmd: 'pause' });
      else if (text === '/resume') appendControl(runId, { cmd: 'resume' });
      else if (text === '/stop') appendControl(runId, { cmd: 'stop' });
      else if (text === '/compact') appendControl(runId, { cmd: 'compact' });
      else if (text === '/approve' || text.startsWith('/approve ')) appendControl(runId, { cmd: 'approve', text: text.slice(8).trim() });
      else if (/^\/(allow|deny)\b/.test(text)) {
        const [, verb, id] = text.match(/^\/(allow|deny)\s*(\S*)/);
        const req = pendingApprovals(runId).find((r) => !id || r.id === id);
        if (req) decideApproval(runId, req.id, { decision: verb === 'allow' ? 'allow' : 'deny' });
        else console.log(c.gray(t('cli.noApproval')));
      } else if (text.startsWith('/cut ')) appendControl(runId, { cmd: 'cut', text: text.slice(5) });
      else appendControl(runId, { cmd: 'message', text });
    });
    console.log(c.gray(`${t('cli.liveHint')}\n`));
  }
  await orch.run();
  rl?.close();
  const s = readState(runId);
  console.log(c.bold(`\n${t('cli.taskLine', { id: runId, status: t(`status.${effectiveStatus(s)}`) })}${s.message ? ` · ${s.messageKey ? t(s.messageKey, s.messageParams) : s.message}` : ''}`));
  return s;
}

async function tailRun(runId, { follow = true } = {}) {
  let offset = 0;
  for (;;) {
    const { events, offset: next } = readEvents(runId, offset);
    for (const ev of events) printEvent(ev);
    offset = next;
    const s = readState(runId);
    const st = effectiveStatus(s);
    if (!follow || ['done', 'failed', 'stopped', 'interrupted'].includes(st)) {
      if (events.length === 0) return st;
    }
    await sleep(700);
  }
}

function pickRun(args) {
  const id = args._[1];
  if (id && isValidRunId(id)) return id;
  if (id === 'last' || !id) {
    const runs = listRuns();
    if (runs.length) return runs[0].id;
  }
  throw new Error(t('cli.needId'));
}

async function cmdDoctor() {
  const cfg = loadConfig();
  const codex = findCodex(cfg.codex.path);
  const info = await codexInfo(codex);
  const wb = findWorkBuddy(cfg.workbuddy.appPath);
  const auth = wbAuthState();
  const ok = (b) => (b ? c.green('✔') : c.red('✘'));
  console.log(c.bold(t('cli.doctor.title', { app: brandName(), latin: subName() })));
  console.log(`${ok(info.installed)} Codex CLI: ${info.installed ? `${info.path} (${info.version})` : t('cli.doctor.noCodex')}`);
  console.log(`${ok(info.loggedIn)} ${t('cli.doctor.gptLogin')}: ${info.statusText || t('cli.notLoggedIn')}${info.loggedIn && !info.chatgpt ? c.yellow(` (${t('cli.doctor.notChatgpt')})`) : ''}`);
  const models = listCodexModels().filter((m) => m.visible).map((m) => (m.unavailable ? c.gray(`${m.id}(✗)`) : m.id));
  console.log(`  ${t('cli.doctor.gptModels')}: ${models.join(', ') || '-'} · ${t('cli.default')} ${cfg.codex.model || defaultCodexModel() || '-'}`);
  const q = info.loggedIn ? await svc.getGptQuota() : null;
  if (q) console.log(`  ${t('cli.doctor.quota')}: ${quotaLine(q)}`);
  console.log(`${ok(!!wb)} WorkBuddy: ${wb ? `${wb.app} (${wb.appVersion}, core ${wb.cliVersion})` : t('srv.wb.missing')}`);
  console.log(`${ok(auth.loggedIn)} ${t('cli.doctor.wbLogin')}: ${auth.loggedIn ? `${t('srv.wb.loggedIn')}${auth.nickname ? ` (${auth.nickname})` : ''} · ${WB_AUTH_FILE}` : t('cli.doctor.wbLoginHint')}`);
  if (wb) {
    const { models: wbm, source } = listWbModels(wb);
    console.log(`  ${t('cli.doctor.wbModels', { source })}: ${wbm.slice(0, 12).map((m) => m.id).join(', ')}…`);
  }
  const agents = listSubagents(cfg, process.cwd());
  console.log(`  ${t('cli.doctor.agents')}: ${agents.map((a) => a.id).join(', ')}`);
  console.log(`  ${t('cli.doctor.data')}: ${DATA_DIR}`);
  console.log(`  Node: ${process.version} (${process.execPath})`);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  console.log(`  ${t('cli.doctor.proxy')}: ${proxy || t('cli.doctor.noProxy')}`);
}

function quotaLine(q) {
  const w = (label, x) => (x ? `${label} ${Math.max(0, Math.round(100 - x.usedPercent))}% (${x.resetsAt ? new Date(x.resetsAt).toLocaleString(locale(), { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'})` : '');
  return [w(t('cli.quota5h'), q.primary), w(t('cli.quotaWeek'), q.secondary), q.planType ? q.planType : '', q.source === 'live' ? '' : t('cli.quotaStale')].filter(Boolean).join(' · ');
}

/** --start-at 23:00 or a full timestamp; a time already past means tomorrow */
function parseStartAt(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= Date.now() + 60_000) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const at = Date.parse(v);
  if (!Number.isFinite(at)) throw new Error(t('cli.badStartAt', { v }));
  return new Date(at).toISOString();
}

async function cmdLogin(target) {
  const cfg = loadConfig();
  if (target === 'codex' || target === 'gpt') {
    const codex = findCodex(cfg.codex.path);
    if (!codex) throw new Error(t('srv.codex.missing'));
    await new Promise((resolve) => {
      spawn(codex.path, ['login'], { stdio: 'inherit' }).on('exit', resolve);
    });
    return;
  }
  const wb = findWorkBuddy(cfg.workbuddy.appPath);
  if (!wb) throw new Error(t('srv.wb.missing'));
  const res = await wbLogin(wb, {
    onUpdate: (u) => {
      if (u.state === 'waiting') console.log(`${t('cli.loginOpened')}\n${u.authUrl}`);
      if (u.state === 'error') console.log(c.red(u.message));
    },
  });
  if (res.ok) console.log(c.green(`${t('srv.wb.loggedIn')}${res.account?.userName ? `: ${res.account.userName}` : ''}`));
  else process.exitCode = 1;
}

async function cmdServe(args) {
  const existing = await findRunningServer();
  if (existing && args.reuse !== false) {
    if (args['json-ready']) console.log(JSON.stringify({ ready: true, url: existing.url, reused: true }));
    else console.log(t('cli.serveRunning', { url: existing.url }));
    if (args.open) openUrl(existing.url);
    return;
  }
  const info = await startServer({ port: Number(args.port || 0) });
  if (args['json-ready']) console.log(JSON.stringify({ ready: true, url: info.url }));
  else console.log(t('cli.serveStarted', { url: info.url }));
  if (args.open) openUrl(info.url);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') {
    console.log(t('cli.help', { app: brandName(), latin: subName() }));
    return;
  }
  switch (cmd) {
    case 'app': {
      const appPath = path.join(ROOT, 'dist', 'Oneiropolos.app');
      if (fs.existsSync(appPath)) spawn('/usr/bin/open', [appPath], { stdio: 'ignore', detached: true }).unref();
      else await cmdServe({ ...args, open: true });
      break;
    }
    case 'serve':
      await cmdServe(args);
      break;
    case 'run': {
      const goal = (await readGoal(args)).trim();
      if (!goal) throw new Error(t('cli.needGoal'));
      const holes = goal.match(PLACEHOLDER_RE) || [];
      if (holes.length && !args.force) throw new Error(t('cli.holes', { n: holes.length, first: holes[0] }));
      const state = svc.createTask({ goal, workdir: args.dir || process.cwd(), settings: buildOverrides(args), startAt: parseStartAt(args['start-at']) });
      const st = state.settings;
      console.log(c.bold(t('cli.newTask', { id: state.id })));
      console.log(c.gray([
        `${t('cli.dir')}: ${state.workdir}`,
        `GPT: ${st.codex.model || t('cli.default')} (${st.codex.effort}) · WorkBuddy: ${st.workbuddy.model}${st.workbuddy.effort ? ` (${st.workbuddy.effort})` : ''} · ${t('cli.maxRounds', { n: st.loop.maxRounds })}`,
        st.team?.mode !== 'off' ? `Team: ${st.team.mode} (≤ ${st.team.maxTeammates})` : '',
        st.agents?.mode !== 'normal' ? `${t('cli.mode')}: ${st.agents.mode}` : '',
        st.loop.checkCommand ? `${t('cli.check')}: ${st.loop.checkCommand}` : '',
        state.scheduledAt ? `${t('cli.scheduled')}: ${clockText(Date.parse(state.scheduledAt))}` : '',
      ].filter(Boolean).join('\n')));
      if (args.detach) {
        svc.spawnRunner(state.id);
        console.log(t('cli.detached', { id: state.id }));
      } else {
        await runForeground(state.id);
      }
      break;
    }
    case 'resume': {
      const id = pickRun(args);
      const s = readState(id);
      if (args.detach || (s.pid && effectiveStatus(s) !== 'interrupted' && ['paused', 'waiting_user'].includes(s.status))) {
        console.log(JSON.stringify(svc.startOrResume(id)));
        console.log(t('cli.followHint', { id }));
      } else {
        await runForeground(id);
      }
      break;
    }
    case 'tail': {
      const id = pickRun(args);
      const st = await tailRun(id, { follow: args.follow !== false });
      console.log(c.bold(`${t('cli.status')}: ${t(`status.${st}`)}`));
      break;
    }
    case 'msg':
    case 'message': {
      const id = pickRun(args);
      console.log(JSON.stringify(svc.controlRun(id, 'message', { text: args._.slice(2).join(' ') })));
      break;
    }
    case 'approve-plan':
      console.log(JSON.stringify(svc.controlRun(pickRun(args), 'approve', { text: args._.slice(2).join(' ') })));
      break;
    case 'compact':
      console.log(JSON.stringify(svc.controlRun(pickRun(args), 'compact')));
      break;
    case 'approve':
    case 'allow':
    case 'deny': {
      const id = pickRun(args);
      const list = pendingApprovals(id);
      const req = list.find((r) => r.id === args._[2]) || (args._[2] ? null : list[0]);
      if (!req) {
        console.log(t('cli.noApproval'));
        break;
      }
      decideApproval(id, req.id, { decision: cmd === 'deny' ? 'deny' : 'allow', reason: args.reason || '', always: Boolean(args.always) });
      console.log(`${t(`approval.${cmd === 'deny' ? 'deny' : 'allow'}`)}: $ ${oneLine(req.command, 160)}`);
      break;
    }
    case 'pause':
    case 'stop':
      console.log(JSON.stringify(svc.controlRun(pickRun(args), cmd)));
      break;
    case 'list':
    case 'ls': {
      const runs = listRuns();
      if (!runs.length) console.log(t('cli.noTasks'));
      for (const r of runs) {
        console.log(`${c.bold(r.id)}  ${t(`status.${r.status}`).padEnd(8)}  ${r.round}/${r.maxRounds ?? '?'}  ${String(r.progress ?? 0).padStart(3)}%${r.team !== 'off' ? '  ⇉' : ''}  ${c.gray(r.workdir)}\n    ${oneLine(r.goal, 100)}`);
      }
      break;
    }
    case 'show': {
      const s = readState(pickRun(args));
      console.log(c.bold(`${s.id} · ${t(`status.${effectiveStatus(s)}`)}${s.message ? ` · ${s.messageKey ? t(s.messageKey, s.messageParams) : s.message}` : ''}`));
      console.log(`${t('export.goal')}: ${s.goal}\n${t('cli.dir')}: ${s.workdir}\n${t('round.n', { n: `${s.round}/${s.settings.loop.maxRounds}` })} · ${s.progress}%`);
      console.log(`GPT: ${s.gpt.threadId || '-'} · WorkBuddy: ${s.wb.sessionId || '-'}`);
      console.log(`GPT ${s.stats.gptTurns}× (${s.stats.gptIn} in / ${s.stats.gptOut} out) · WorkBuddy ${s.stats.wbCalls}× (${s.stats.wbIn} in / ${s.stats.wbOut} out)${s.stats.teamRounds ? ` · team rounds ${s.stats.teamRounds}` : ''}`);
      if (s.plan?.length) console.log(`${t('export.plan')}:\n${s.plan.map((p) => `  ${p.status === 'done' ? '✔' : p.status === 'doing' ? '▶' : '·'} ${p.title}`).join('\n')}`);
      if (s.lastAudit) console.log(`${t('cli.verdict')}: ${t(`verdict.${s.lastAudit.verdict}`)} · ${oneLine(s.lastAudit.assessment, 500)}`);
      break;
    }
    case 'doctor':
      await cmdDoctor();
      break;
    case 'quota': {
      const q = await svc.getGptQuota({ force: true });
      console.log(q ? quotaLine(q) : t('cli.noQuota'));
      break;
    }
    case 'usage': {
      const r = svc.usageReport({ period: args.period || args._[1] || '30d' });
      console.log(c.bold(t('cli.usageTitle', { period: r.period })));
      for (const [agent, v] of Object.entries(r.totals)) console.log(`  ${agent.padEnd(10)} ${String(v.calls).padStart(5)}×  in ${(v.in / 1e6).toFixed(2)}M  cached ${(v.cached / 1e6).toFixed(2)}M  out ${(v.out / 1e6).toFixed(2)}M`);
      for (const m of r.byModel.slice(0, 20)) console.log(c.gray(`    ${m.agent}/${m.model}: ${m.calls}× · ${((m.in + m.out) / 1e6).toFixed(2)}M`));
      break;
    }
    case 'export': {
      const r = svc.exportRun(pickRun(args));
      console.log(t('cli.exported', { path: r.path }));
      break;
    }
    case 'login':
      await cmdLogin(args._[1] || 'workbuddy');
      break;
    case 'logout': {
      const wb = findWorkBuddy(loadConfig().workbuddy.appPath);
      await wbLogout(wb);
      console.log(t('cli.loggedOut'));
      break;
    }
    case 'templates':
    case 'template': {
      const key = args._[1];
      if (key) {
        const tpl = findTemplate(String(key));
        if (!tpl) throw new Error(t('srv.tpl.notFound'));
        console.log(tpl.body);
        break;
      }
      const { builtin, custom } = listTemplates();
      for (const tpl of builtin) console.log(`  ${tpl.id.padEnd(12)} ${tpl.name}  ${c.gray(tpl.hint)}`);
      for (const tpl of custom) console.log(`  ${tpl.id.padEnd(12)} ${tpl.name}  ${c.gray(t('cli.custom'))}`);
      console.log(c.gray(`\n${t('cli.templatesHint')}`));
      break;
    }
    case 'agents': {
      for (const a of listSubagents(loadConfig(), args.dir || process.cwd())) console.log(`  #${a.id.padEnd(18)} ${a.name}  ${c.gray(`${a.source} · ${oneLine(a.description, 90)}`)}`);
      break;
    }
    case 'prompt': {
      const role = args._[1] || 'executor';
      console.log(svc.systemPromptPreview(role, args.dir ? path.resolve(String(args.dir)) : '').text);
      break;
    }
    case 'loop': {
      const sub = args._[1] || 'list';
      if (sub === 'list') {
        const loops = loadLoops();
        if (!loops.length) console.log(t('cli.noLoops'));
        for (const l of loops) console.log(`  ${l.id}  ${l.enabled ? '●' : '○'}  ${l.schedule.type === 'daily' ? `daily ${l.schedule.time}` : `every ${Math.round(l.schedule.ms / 60000)}m`}  ${l.kind === 'message' ? `→ ${l.runId}` : c.gray(l.workdir)}  ${oneLine(l.prompt, 80)}  ${c.gray(`${t('cli.next')}: ${clockText(Date.parse(l.nextRunAt))}`)}`);
      } else if (sub === 'add') {
        const rec = svc.addLoop({ kind: args.run ? 'message' : 'task', spec: args._.slice(2).join(' '), dir: args.dir || process.cwd(), runId: args.run || '', settings: buildOverrides(args) });
        console.log(t('cli.loopAdded', { id: rec.id, next: clockText(Date.parse(rec.nextRunAt)) }));
      } else if (sub === 'cancel' || sub === 'stop' || sub === 'rm') {
        svc.removeLoop(String(args._[2] || ''));
        console.log(t('cli.loopRemoved'));
      } else {
        throw new Error('wbloop loop list | add [--run <id>] <spec> | cancel <id>');
      }
      break;
    }
    case 'config': {
      const pairs = args._.slice(1);
      if (!pairs.length) {
        console.log(JSON.stringify(loadConfig(), null, 2));
        break;
      }
      const patch = {};
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq < 0) throw new Error(t('cli.configPair', { pair }));
        const keys = pair.slice(0, eq).split('.');
        let v = pair.slice(eq + 1);
        if (v === 'true' || v === 'false') v = v === 'true';
        else if (v !== '' && !Number.isNaN(Number(v))) v = Number(v);
        let cur = patch;
        keys.slice(0, -1).forEach((k) => {
          cur[k] = cur[k] || {};
          cur = cur[k];
        });
        cur[keys[keys.length - 1]] = v;
      }
      console.log(JSON.stringify(saveConfig(patch), null, 2));
      break;
    }
    default:
      console.log(t('cli.help', { app: brandName(), latin: subName() }));
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(c.red(`${t('cli.error')}: ${err.message}`));
  process.exit(1);
});
