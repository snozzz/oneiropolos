import fs from 'node:fs';
import { SCHEMA_PATH, ensureDirs } from './paths.js';

// Structured output of every GPT turn (codex exec --output-schema; strict mode needs every field in "required").
export const GPT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['continue', 'done', 'ask_user', 'abort'] },
    assessment: { type: 'string' },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        },
        required: ['title', 'status'],
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          detail: { type: 'string' },
        },
        required: ['severity', 'detail'],
      },
    },
    next_instruction: { type: 'string' },
    // Team Mode: parallel assignments for this round (empty = the single Executor)
    team: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          instruction: { type: 'string' },
          owns: { type: 'string' },
        },
        required: ['name', 'role', 'instruction', 'owns'],
      },
    },
    progress: { type: 'integer' },
    question_for_user: { type: 'string' },
  },
  required: ['verdict', 'assessment', 'plan', 'issues', 'next_instruction', 'team', 'progress', 'question_for_user'],
};

export function ensureSchemaFile() {
  ensureDirs();
  const text = JSON.stringify(GPT_OUTPUT_SCHEMA, null, 2);
  let current = '';
  try {
    current = fs.readFileSync(SCHEMA_PATH, 'utf8');
  } catch {
    // missing
  }
  if (current !== text) fs.writeFileSync(SCHEMA_PATH, text);
  return SCHEMA_PATH;
}

const VERDICTS = new Set(['continue', 'done', 'ask_user', 'abort']);

/** Teammate names become directory names and labels: short, unique slugs. */
export function teamSlug(name, used = new Set()) {
  let base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9一-鿿぀-ヿ_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mate';
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

/** Validates and normalises GPT output: { value } or { error } (the error text goes back to GPT). */
export function normalizeGptOutput(obj) {
  if (!obj || typeof obj !== 'object') return { error: 'no JSON object in the reply' };
  if (!VERDICTS.has(obj.verdict)) return { error: `invalid verdict: ${obj.verdict}` };
  const used = new Set();
  const team = Array.isArray(obj.team)
    ? obj.team.filter((m) => m && String(m.instruction || '').trim()).slice(0, 8).map((m) => ({
      name: teamSlug(m.name, used),
      role: String(m.role || '').trim().slice(0, 120),
      instruction: String(m.instruction).trim(),
      owns: String(m.owns || '').trim().slice(0, 1000),
    }))
    : [];
  const value = {
    verdict: obj.verdict,
    assessment: String(obj.assessment || ''),
    plan: Array.isArray(obj.plan)
      ? obj.plan.filter((p) => p && p.title).map((p) => ({ title: String(p.title), status: ['todo', 'doing', 'done'].includes(p.status) ? p.status : 'todo' }))
      : [],
    issues: Array.isArray(obj.issues)
      ? obj.issues.filter((i) => i && i.detail).map((i) => ({ severity: ['blocker', 'major', 'minor'].includes(i.severity) ? i.severity : 'minor', detail: String(i.detail) }))
      : [],
    next_instruction: String(obj.next_instruction || '').trim(),
    team,
    progress: Math.max(0, Math.min(100, Math.round(Number(obj.progress) || 0))),
    question_for_user: String(obj.question_for_user || '').trim(),
  };
  if (value.verdict === 'continue' && !value.next_instruction && !value.team.length) return { error: 'verdict=continue but next_instruction is empty' };
  if (value.verdict === 'ask_user' && !value.question_for_user) value.question_for_user = value.assessment || '?';
  return { value };
}
