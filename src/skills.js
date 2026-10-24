// Skills (snow-cli docs/usage/18, compatible with Claude Code skills): a directory with SKILL.md (front matter: name,
// description, allowed-tools). Global: ~/.wbloop/skills plus any directories listed in settings (skills.extraDirs, e.g.
// ~/.claude/skills); project: <dir>/.wbloop/skills, .snow/skills, .claude/skills, .codebuddy/skills. Project skills win
// on the same name.
// WorkBuddy is told which skills exist (name, description, path to SKILL.md) and loads them when relevant; the composer
// can also inject a skill into a message (/skills).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { t } from './i18n.js';

export const GLOBAL_SKILLS_DIR = path.join(DATA_DIR, 'skills');

function skillRoots(settings, workdir) {
  const roots = [];
  for (const d of settings.skills?.extraDirs || []) {
    const dir = String(d || '').replace(/^~(?=$|\/)/, os.homedir());
    if (path.isAbsolute(dir)) roots.push({ dir, scope: 'global', source: path.basename(path.dirname(dir)) || 'extra' });
  }
  roots.push({ dir: GLOBAL_SKILLS_DIR, scope: 'global', source: 'wbloop' });
  if (workdir) {
    for (const sub of ['.codebuddy', '.claude', '.snow', '.wbloop']) roots.push({ dir: path.join(workdir, sub, 'skills'), scope: 'project', source: sub.slice(1) });
  }
  return roots;
}

function frontMatter(text) {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---/);
  const meta = {};
  if (!m) return meta;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

export function listSkills(settings = {}, workdir = '', { includeDisabled = false } = {}) {
  const map = new Map();
  for (const root of skillRoots(settings, workdir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const file = path.join(root.dir, e.name, 'SKILL.md');
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const meta = frontMatter(text);
      const name = String(meta.name || e.name).trim();
      map.set(name, { name, description: String(meta.description || '').slice(0, 600), allowedTools: meta['allowed-tools'] || '', file, dir: path.dirname(file), scope: root.scope, source: root.source });
    }
  }
  const disabled = new Set(settings.skills?.disabled || []);
  return [...map.values()].map((s) => ({ ...s, enabled: !disabled.has(s.name) })).filter((s) => includeDisabled || s.enabled).sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name, settings = {}, workdir = '') {
  const s = listSkills(settings, workdir, { includeDisabled: true }).find((x) => x.name === name);
  if (!s) throw new Error(t('srv.skills.notFound', { name }));
  return { ...s, content: fs.readFileSync(s.file, 'utf8') };
}

export function createSkill({ name, description }) {
  const id = String(name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(t('srv.skills.badName'));
  const dir = path.join(GLOBAL_SKILLS_DIR, id);
  if (fs.existsSync(dir)) throw new Error(t('srv.skills.exists', { name: id }));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  const desc = String(description || '').trim().replace(/\n+/g, ' ') || id;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${id}
description: ${desc}
---

# ${id}

## When to use
${desc}

## Instructions
1. …

## Examples

## Notes
`);
  return { name: id, dir, file: path.join(dir, 'SKILL.md') };
}
