// The stream-json protocol of Claude Code and of the CodeBuddy core inside WorkBuddy (the core is a fork, so the
// event format is the same): one runner for both engines, as executor (events for the timeline) or as lead (a JSON
// verdict via --json-schema, its steps shown like GPT's).
import path from 'node:path';
import { t } from '../i18n.js';
import { oneLine, runProcess, truncate } from '../util.js';

export function relPath(file, cwd) {
  if (!file || typeof file !== 'string') return '';
  const normalized = file.replaceAll('\\', '/');
  const root = cwd?.replaceAll('\\', '/').replace(/\/$/, '');
  if (root && normalized.startsWith(root + '/')) return normalized.slice(root.length + 1);
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

export function clip(text, max) {
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
export function createLiveTracker(onLive) {
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

export function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}


/**
 * Runs one headless stream-json agent call. classify(text) maps an error text to auth | credits | limit | context |
 * transient | unknown. Returns the executor result shape the loop expects (see runExecutor in src/loop.js).
 */
export async function runStreamJson({ command, args, env, cwd, prompt, sessionId, onEvent, onLive, signal, timeoutMs, idleTimeoutMs, rawFile, classify = () => 'unknown', crashKey = 'srv.wb.crashed', usageIncludesCache = false }) {
  const started = Date.now();
  // usage of every model request (by message id: one response can arrive as several assistant events)
  const requests = new Map();
  let contextTokens = 0;
  const toolCalls = [];
  const toolIndex = new Map();
  const texts = [];
  const live = onLive ? createLiveTracker(onLive) : null;
  let sawInit = false;
  let result = null;
  let modelName = '';
  let initSession = '';

  const res = await runProcess(command, args, {
    cwd,
    env,
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
        initSession = ev.session_id || '';
        onEvent?.({ kind: 'wb.init', sessionId: ev.session_id, model: ev.model });
      } else if (ev.type === 'assistant') {
        if (!parent) live?.settle();
        const u = ev.message?.usage;
        if (u) {
          const n = normalizeUsage(u, usageIncludesCache);
          requests.set(ev.message.id || `r${requests.size}`, n);
          if (!parent) contextTokens = n.input_tokens + n.cache_read_input_tokens + n.cache_creation_input_tokens;
        }
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
    if (!errors.length) errors.push(t(crashKey, { code: res.code, signal: res.signal || '-' }));
  }
  const ok = !!result && result.subtype === 'success' && !result.is_error;
  if (result && !ok && !errors.length && typeof result.result === 'string' && result.result.trim()) errors.push(result.result.trim());
  const errorText = errors.join('\n');
  const maxTurnsHit = /max turns/i.test(errorText) || result?.subtype === 'error_max_turns';
  let errorKind = null;
  if (!ok) {
    if (res.aborted) errorKind = 'aborted';
    else if (maxTurnsHit) errorKind = 'max_turns';
    else if (res.timedOut || res.idleTimedOut) errorKind = 'transient';
    else errorKind = classify(`${errorText}\n${result?.result || ''}`);
  }
  return {
    ok,
    sawInit,
    sessionId: result?.session_id || initSession || sessionId,
    model: modelName,
    resultText: typeof result?.result === 'string' ? result.result : '',
    structured: result?.structured_output ?? null,
    lastTexts: texts.slice(-3),
    subtype: result?.subtype || null,
    errors,
    errorKind,
    maxTurnsHit,
    numTurns: result?.num_turns ?? null,
    // The CodeBuddy core reports result.usage summed over the whole resumed session, with cached tokens inside
    // input_tokens; the per-request usage is exact for both CLIs, so that is used when the stream has it.
    usage: usageIncludesCache && requests.size ? sumUsage(requests.values()) : result?.usage ? normalizeUsage(result.usage, usageIncludesCache) : requests.size ? sumUsage(requests.values()) : null,
    contextTokens,
    permissionDenials: result?.permission_denials || [],
    toolCalls,
    durationMs: Date.now() - started,
  };
}

/** Anthropic-shaped usage: input_tokens excludes the cached parts (the CodeBuddy core counts them inside input_tokens). */
export function normalizeUsage(u, includesCache = false) {
  const read = Number(u?.cache_read_input_tokens) || 0;
  const write = Number(u?.cache_creation_input_tokens) || 0;
  const input = Number(u?.input_tokens) || 0;
  return { input_tokens: includesCache ? Math.max(0, input - read - write) : input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: Number(u?.output_tokens) || 0 };
}

function sumUsage(list) {
  const out = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  for (const u of list) for (const k of Object.keys(out)) out[k] += u[k];
  return out;
}

/** Executor events of a lead call, re-shaped as the GPT steps the timeline already knows how to draw. */
export function leadEventMapper(onEvent) {
  const pending = new Map();
  return (e) => {
    if (e.parent) return;
    if (e.kind === 'wb.thinking') onEvent?.({ kind: 'gpt.item', phase: 'completed', itemType: 'reasoning', text: truncate(e.text || '', 4000) });
    else if (e.kind === 'wb.text') onEvent?.({ kind: 'gpt.item', phase: 'completed', itemType: 'agent_message', text: e.text || '' });
    else if (e.kind === 'wb.tool') {
      pending.set(e.id, e);
      if (/^(bash|shell|exec|run_command|terminal)$/i.test(e.name)) onEvent?.({ kind: 'gpt.item', phase: 'started', itemType: 'command_execution', id: e.id, command: e.summary || '' });
      else if (/^web_?search$/i.test(e.name)) onEvent?.({ kind: 'gpt.item', phase: 'completed', itemType: 'web_search', text: e.summary || '' });
      else if (!/^StructuredOutput$/.test(e.name)) onEvent?.({ kind: 'gpt.item', phase: 'completed', itemType: 'tool', id: e.id, text: `${e.name} ${e.summary || ''}`.trim() });
    } else if (e.kind === 'wb.tool_result') {
      const call = pending.get(e.id);
      pending.delete(e.id);
      if (call && /^(bash|shell|exec|run_command|terminal)$/i.test(call.name)) {
        onEvent?.({ kind: 'gpt.item', phase: 'completed', itemType: 'command_execution', id: e.id, command: call.summary || '', exitCode: e.isError ? 1 : 0, status: 'completed', output: truncate(e.text || '', 3000) });
      }
    }
  };
}

/** Lead usage in the shape the loop records for GPT (input includes cached input). */
export function leadUsage(u) {
  if (!u) return null;
  const cached = u.cache_read_input_tokens || 0;
  return { input_tokens: (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0), cached_input_tokens: cached, output_tokens: u.output_tokens || 0 };
}

/** The verdict text of a lead call: the --json-schema structured output when the CLI returned one, else the last text. */
export function leadText(r) {
  if (r.structured && typeof r.structured === 'object') return JSON.stringify(r.structured);
  return r.resultText || r.lastTexts[r.lastTexts.length - 1] || '';
}

export function leadError(r) {
  if (r.ok) return null;
  const message = oneLine(r.errors.join('\n') || 'failed', 2000);
  const kind = r.errorKind === 'aborted' ? 'aborted' : r.errorKind === 'credits' ? 'limit' : r.errorKind === 'context' || r.errorKind === 'max_turns' ? 'transient' : r.errorKind || 'unknown';
  return { message, kind };
}

