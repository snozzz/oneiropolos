// MCP servers (snow-cli docs/usage/14). One file, ~/.wbloop/mcp.json, in the common { "mcpServers": { … } } format with
// two extra fields per server: "enabled" and "targets" (["workbuddy", "gpt"]). WorkBuddy gets them through
// --mcp-config, GPT (Codex) through -c mcp_servers.<name>.* overrides.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './paths.js';
import { t } from './i18n.js';
import { readJson, writeJsonAtomic } from './util.js';

export const MCP_FILE = path.join(DATA_DIR, 'mcp.json');

export function loadMcp() {
  const data = readJson(MCP_FILE, null);
  const servers = data && typeof data.mcpServers === 'object' && data.mcpServers ? data.mcpServers : {};
  return { mcpServers: servers };
}

function validName(n) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(n);
}

/** Validates and saves the whole file. Accepts an object or JSON text. */
export function saveMcp(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (err) {
      throw new Error(t('srv.mcp.badJson', { err: err.message }));
    }
  }
  const servers = data?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(t('srv.mcp.noServers'));
  const clean = {};
  for (const [name, s] of Object.entries(servers)) {
    if (!validName(name)) throw new Error(t('srv.mcp.badName', { name }));
    if (!s || typeof s !== 'object') throw new Error(t('srv.mcp.badServer', { name }));
    if (!s.command && !s.url) throw new Error(t('srv.mcp.needCommand', { name }));
    if (s.args != null && !Array.isArray(s.args)) throw new Error(t('srv.mcp.badArgs', { name }));
    const targets = Array.isArray(s.targets) ? s.targets.filter((x) => x === 'workbuddy' || x === 'gpt') : ['workbuddy'];
    clean[name] = { ...s, enabled: s.enabled !== false, targets: targets.length ? targets : ['workbuddy'] };
  }
  ensureDirs();
  writeJsonAtomic(MCP_FILE, { mcpServers: clean });
  return { mcpServers: clean };
}

function serversFor(target, settings = {}) {
  if (settings.mcp?.enabled === false) return [];
  return Object.entries(loadMcp().mcpServers).filter(([, s]) => s.enabled !== false && (s.targets || ['workbuddy']).includes(target));
}

const strip = (s) => {
  const { enabled, targets, ...rest } = s;
  return rest;
};

/** JSON for WorkBuddy's --mcp-config, or '' when there is nothing to load. */
export function wbMcpConfig(settings) {
  const list = serversFor('workbuddy', settings);
  if (!list.length) return '';
  return JSON.stringify({ mcpServers: Object.fromEntries(list.map(([n, s]) => [n, strip(s)])) });
}

const toml = (v) => JSON.stringify(v);
const tomlTable = (obj) => `{ ${Object.entries(obj || {}).map(([k, v]) => `${toml(k)} = ${toml(String(v))}`).join(', ')} }`;

/** -c overrides for codex exec. */
export function codexMcpArgs(settings) {
  const out = [];
  for (const [name, s] of serversFor('gpt', settings)) {
    const key = `mcp_servers.${name}`;
    if (s.url) {
      out.push('-c', `${key}.url=${toml(s.url)}`);
      if (s.headers && typeof s.headers === 'object') out.push('-c', `${key}.http_headers=${tomlTable(s.headers)}`);
    } else {
      out.push('-c', `${key}.command=${toml(s.command)}`);
      if (s.args?.length) out.push('-c', `${key}.args=${toml(s.args.map(String))}`);
      if (s.env && typeof s.env === 'object' && Object.keys(s.env).length) out.push('-c', `${key}.env=${tomlTable(s.env)}`);
    }
  }
  return out;
}

export function mcpSummary(settings) {
  return Object.entries(loadMcp().mcpServers).map(([name, s]) => ({
    name,
    enabled: s.enabled !== false && settings?.mcp?.enabled !== false,
    targets: s.targets || ['workbuddy'],
    kind: s.url ? 'http' : 'stdio',
    detail: s.url || [s.command, ...(s.args || [])].join(' '),
  }));
}

export function mcpFileExists() {
  return fs.existsSync(MCP_FILE);
}
