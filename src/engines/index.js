// The engines that can play a role. Two roles: the lead (plans, audits, reviews, answers side questions — read-only)
// and the executor (does the work). Any engine can take either role; each keeps its own sign-in.
import * as chatgpt from './chatgpt.js';
import * as claude from './claude.js';
import * as deepseek from './deepseek.js';
import * as workbuddy from './wb.js';

export const ENGINES = { chatgpt, claude, deepseek, workbuddy };
export const ENGINE_IDS = Object.keys(ENGINES);
export const ROLE_DEFAULTS = { lead: 'chatgpt', executor: 'workbuddy' };

export function engine(id) {
  return ENGINES[id] || null;
}

export function engineName(id) {
  return ENGINES[id]?.meta.name || id;
}

export function engineOf(cfg, role) {
  const id = cfg?.roles?.[role]?.engine;
  return ENGINE_IDS.includes(id) ? id : ROLE_DEFAULTS[role];
}

/**
 * Engine, model and effort of a role. The role's own choice wins; otherwise the engine's section (codex.model for
 * ChatGPT, workbuddy.model …), which is where tasks made before roles existed keep theirs.
 */
export function roleSpec(cfg, role) {
  const id = engineOf(cfg, role);
  const r = cfg?.roles?.[role] || {};
  const sameEngine = !r.engine || r.engine === id;
  const sec = cfg?.[ENGINES[id].meta.section] || {};
  const model = (sameEngine && r.model) || sec.model || '';
  const effort = (sameEngine && r.effort) || sec.effort || '';
  return { engine: id, name: engineName(id), model: model === 'auto' && id !== 'workbuddy' ? '' : model, effort };
}

/** The names the UI and the prompts use for the two roles of a task. */
export function roleNames(cfg) {
  return { lead: engineName(engineOf(cfg, 'lead')), exec: engineName(engineOf(cfg, 'executor')) };
}

export async function allStatus(cfg) {
  const out = {};
  await Promise.all(ENGINE_IDS.map(async (id) => {
    try {
      out[id] = { id, name: engineName(id), vendor: ENGINES[id].meta.vendor, ...(await ENGINES[id].status(cfg)) };
    } catch (err) {
      out[id] = { id, name: engineName(id), vendor: ENGINES[id].meta.vendor, installed: false, loggedIn: false, error: err.message };
    }
  }));
  return out;
}
