// The engines on the client side: names, the role → engine/model/effort resolution (same rules as
// src/engines/index.js), and model lists for the pickers.
import { app } from './core.js';
import { setRoleNames, t } from './i18n.js';

export const ENGINE_IDS = ['chatgpt', 'claude', 'deepseek', 'workbuddy'];
export const ENGINE_NAMES = { chatgpt: 'GPT', claude: 'Claude', deepseek: 'DeepSeek', workbuddy: 'WorkBuddy' };
export const ENGINE_VENDORS = { chatgpt: 'ChatGPT', claude: 'Claude', deepseek: 'DeepSeek', workbuddy: 'WorkBuddy' };
export const ENGINE_SECTION = { chatgpt: 'codex', claude: 'claude', deepseek: 'deepseek', workbuddy: 'workbuddy' };
export const ROLE_DEFAULTS = { lead: 'chatgpt', executor: 'workbuddy' };

export function engineOf(st, role) {
  const id = st?.roles?.[role]?.engine;
  return ENGINE_IDS.includes(id) ? id : ROLE_DEFAULTS[role];
}

export function roleSpec(st, role) {
  const id = engineOf(st, role);
  const r = st?.roles?.[role] || {};
  const same = !r.engine || r.engine === id;
  const sec = st?.[ENGINE_SECTION[id]] || {};
  let model = (same && r.model) || sec.model || '';
  if (model === 'auto' && id !== 'workbuddy') model = '';
  if (!model && id === 'chatgpt') model = app.env?.engineModels?.chatgpt?.defaultModel || '';
  if (!model && id === 'workbuddy') model = 'auto';
  if (!model && id === 'deepseek') model = 'deepseek-flash';
  return { engine: id, name: ENGINE_NAMES[id], model, effort: (same && r.effort) || sec.effort || '' };
}

export function roleNamesOf(st) {
  return { lead: ENGINE_NAMES[engineOf(st, 'lead')], exec: ENGINE_NAMES[engineOf(st, 'executor')] };
}

/** Texts say "{lead}" and "{exec}": point them at the engines of the task on screen (or of the defaults). */
export function useRoleNames(st) {
  setRoleNames(roleNamesOf(st));
}

export function engineModels(id) {
  return app.env?.engineModels?.[id]?.models || [];
}

export function engineEfforts(id) {
  return app.env?.engineModels?.[id]?.efforts || [];
}

export function modelName(id, model) {
  if (!model) return id === 'claude' ? t('form.default') : ENGINE_NAMES[id];
  const m = engineModels(id).find((x) => x.id === model);
  return m?.name || model;
}

/** "Claude Opus", "GPT-5.6-Sol", "DeepSeek Flash", "Kimi-K2": short enough for the composer's model button. */
export function roleLabel(st, role) {
  const s = roleSpec(st, role);
  if (!s.model || s.model === 'auto') return s.name;
  const name = modelName(s.engine, s.model);
  // Claude's aliases (Opus, Sonnet …) need the brand; other catalogs name their models fully
  return s.engine === 'claude' && !/claude/i.test(name) ? `Claude ${name}` : name;
}

export function engineStatus(id) {
  return app.env?.engines?.[id] || { installed: false, loggedIn: false };
}
