// Custom slash commands (snow-cli /custom, docs/usage/09.5). One JSON file per command:
//   { "type": "prompt" | "execute", "command": "...", "description": "..." }
// Global: ~/.wbloop/commands/; project: <dir>/.wbloop/commands/ and <dir>/.snow/commands/ (snow-cli files work as is).
// Sub-directories become namespaces: deploy/stage.json → /deploy:stage. "$ARGUMENTS" is replaced by what follows the
// command; without it the arguments are appended.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { t } from './i18n.js';

export const GLOBAL_COMMANDS_DIR = path.join(DATA_DIR, 'commands');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}(:[a-z0-9][a-z0-9_-]{0,40})?$/i;

function scan(dir, scope) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const rel of files.slice(0, 300)) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
      if (!data || !['prompt', 'execute'].includes(data.type) || !String(data.command || '').trim()) continue;
      const name = rel.replace(/\.json$/, '').split(path.sep).join(':');
      if (!NAME_RE.test(name)) continue;
      out.push({ name, type: data.type, command: String(data.command), description: String(data.description || ''), scope, file: path.join(dir, rel) });
    } catch {
      // broken file: skip
    }
  }
  return out;
}

export function listCommands(workdir = '') {
  const map = new Map();
  for (const c of scan(GLOBAL_COMMANDS_DIR, 'global')) map.set(c.name, c);
  if (workdir) for (const sub of ['.snow', '.wbloop']) for (const c of scan(path.join(workdir, sub, 'commands'), 'project')) map.set(c.name, c);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(template, args) {
  const a = String(args || '').trim();
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(a);
  return a ? `${template} ${a}` : template;
}

export function saveCommand({ name, type, command, description }) {
  const n = String(name || '').trim().replace(/^\//, '');
  if (!NAME_RE.test(n)) throw new Error(t('srv.cmd.badName'));
  if (!['prompt', 'execute'].includes(type)) throw new Error(t('srv.cmd.badType'));
  if (!String(command || '').trim()) throw new Error(t('srv.cmd.empty'));
  const file = path.join(GLOBAL_COMMANDS_DIR, ...n.split(':')) + '.json';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type, command: String(command), description: String(description || '') }, null, 2)}\n`);
  return listCommands();
}

export function deleteCommand(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) throw new Error(t('srv.cmd.badName'));
  const file = path.join(GLOBAL_COMMANDS_DIR, ...n.split(':')) + '.json';
  if (!fs.existsSync(file)) throw new Error(t('srv.cmd.notFound', { name: n }));
  fs.rmSync(file);
  return listCommands();
}
