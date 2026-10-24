// Token usage statistics (snow-cli /usage, docs/usage/09.4): every model call appends one line to
// ~/.wbloop/usage/YYYY-MM-DD.jsonl; the report aggregates a rolling window by agent, model and day.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, RUNS_DIR } from './paths.js';
import { readEvents } from './store.js';
import { readJson } from './util.js';

export const USAGE_DIR = path.join(DATA_DIR, 'usage');
const PERIODS = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, '12m': 365 * 86400_000 };

function dayOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function recordUsage({ agent, model, input = 0, cached = 0, output = 0, runId = null, kind = '', at = Date.now() }) {
  if (!input && !output) return;
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFileSync(path.join(USAGE_DIR, `${dayOf(at)}.jsonl`), `${JSON.stringify({ t: new Date(at).toISOString(), agent, model: model || '', in: input, cached, out: output, runId, kind })}\n`);
  } catch {
    // statistics are best effort
  }
}

/** One-time import of tasks that ran before usage logging existed. */
function backfill() {
  const marker = path.join(USAGE_DIR, '.backfilled');
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(USAGE_DIR, { recursive: true });
  let ids = [];
  try {
    ids = fs.readdirSync(RUNS_DIR);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)) continue;
    const state = readJson(path.join(RUNS_DIR, id, 'state.json'), null);
    if (!state) continue;
    let hasWb = false;
    let hasGpt = false;
    try {
      const { events } = readEvents(id, 0, 64 * 1024 * 1024);
      for (const ev of events) {
        if (ev.kind === 'gpt.result' && ev.usage) {
          hasGpt = true;
          recordUsage({ agent: 'gpt', model: ev.model, input: ev.usage.input_tokens || 0, cached: ev.usage.cached_input_tokens || 0, output: ev.usage.output_tokens || 0, runId: id, kind: 'turn', at: Date.parse(ev.t) || Date.now() });
        }
        if (ev.kind === 'wb.end' && ev.usage) {
          hasWb = true;
          recordUsage({ agent: 'workbuddy', model: ev.model, input: ev.usage.input || 0, cached: ev.usage.cached || 0, output: ev.usage.output || 0, runId: id, kind: 'round', at: Date.parse(ev.t) || Date.now() });
        }
      }
    } catch {
      // unreadable events: skip
    }
    // older tasks only kept totals
    const at = Date.parse(state.updatedAt) || Date.now();
    if (!hasGpt && state.stats?.gptIn) recordUsage({ agent: 'gpt', model: state.settings?.codex?.model || '', input: state.stats.gptIn, cached: state.stats.gptCachedIn || 0, output: state.stats.gptOut || 0, runId: id, kind: 'task', at });
    if (!hasWb && state.stats?.wbIn) recordUsage({ agent: 'workbuddy', model: state.settings?.workbuddy?.model || 'auto', input: state.stats.wbIn, output: state.stats.wbOut || 0, runId: id, kind: 'task', at });
  }
  fs.writeFileSync(marker, new Date().toISOString());
}

const pad = (n) => String(n).padStart(2, '0');

/** The chart's bucket for a moment: local hour (24h), month (12m) or day. */
function bucketOf(period, ms) {
  if (period === '24h') return `${dayOf(ms)} ${pad(new Date(ms).getHours())}h`;
  if (period === '12m') return dayOf(ms).slice(0, 7);
  return dayOf(ms);
}

/** Every bucket of the window, oldest first, so quiet days show as empty columns. */
function bucketKeys(period, since, now) {
  const keys = [];
  const d = new Date(since);
  if (period === '24h') d.setMinutes(0, 0, 0);
  else if (period === '12m') d.setDate(1);
  if (period !== '24h') d.setHours(0, 0, 0, 0);
  while (d.getTime() <= now && keys.length < 400) {
    const k = bucketOf(period, d.getTime());
    if (keys[keys.length - 1] !== k) keys.push(k);
    if (period === '24h') d.setHours(d.getHours() + 1);
    else if (period === '12m') d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + 1);
  }
  return keys;
}

export function usageReport({ period = '30d' } = {}) {
  if (!PERIODS[period]) period = '30d';
  backfill();
  const span = PERIODS[period] || PERIODS['30d'];
  const since = Date.now() - span;
  const byModel = new Map();
  const byDay = new Map();
  const totals = { gpt: { in: 0, cached: 0, out: 0, calls: 0 }, workbuddy: { in: 0, cached: 0, out: 0, calls: 0 } };
  let files = [];
  try {
    files = fs.readdirSync(USAGE_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    files = [];
  }
  const firstDay = dayOf(since);
  for (const f of files) {
    if (f.slice(0, 10) < firstDay) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(USAGE_DIR, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(r.t);
      if (!(at >= since)) continue;
      const agent = r.agent === 'workbuddy' ? 'workbuddy' : 'gpt';
      const tot = totals[agent];
      tot.in += r.in || 0;
      tot.cached += r.cached || 0;
      tot.out += r.out || 0;
      tot.calls += 1;
      const mk = `${agent}|${r.model || '-'}`;
      const m = byModel.get(mk) || { agent, model: r.model || '-', in: 0, cached: 0, out: 0, calls: 0 };
      m.in += r.in || 0;
      m.cached += r.cached || 0;
      m.out += r.out || 0;
      m.calls += 1;
      byModel.set(mk, m);
      const bucket = bucketOf(period, at);
      const d = byDay.get(bucket) || { key: bucket, gpt: 0, workbuddy: 0 };
      d[agent] += (r.in || 0) + (r.out || 0);
      byDay.set(bucket, d);
    }
  }
  return {
    period,
    since: new Date(since).toISOString(),
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.in + b.out - (a.in + a.out)),
    byDay: bucketKeys(period, since, Date.now()).map((k) => byDay.get(k) || { key: k, gpt: 0, workbuddy: 0 }),
  };
}
