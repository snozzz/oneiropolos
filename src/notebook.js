// Project notebook (snow-cli's "code memory"): one Markdown file per working directory, kept outside the project in
// ~/.wbloop/notebooks. WorkBuddy reads it at the start of a round and appends non-obvious knowledge (fragile couplings,
// contracts, decisions); GPT reads it while planning. Survives across tasks in the same project.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const NOTEBOOK_DIR = path.join(DATA_DIR, 'notebooks');

export function notebookPath(workdir) {
  const hash = crypto.createHash('sha1').update(String(workdir)).digest('hex').slice(0, 10);
  const name = path.basename(String(workdir));
  // letters of any script are kept (软件所实习 stays readable); earlier versions kept ASCII only — move such a file over
  const base = name.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  const file = path.join(NOTEBOOK_DIR, `${base}-${hash}.md`);
  const legacy = path.join(NOTEBOOK_DIR, `${name.replace(/[^\w.-]+/g, '-').slice(0, 40) || 'project'}-${hash}.md`);
  if (legacy !== file && !fs.existsSync(file) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, file);
    } catch {
      return legacy;
    }
  }
  return file;
}

export function ensureNotebook(workdir) {
  const file = notebookPath(workdir);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(NOTEBOOK_DIR, { recursive: true });
    fs.writeFileSync(file, `# Project notebook\n\nProject: ${workdir}\n\nKnowledge that is easy to lose between tasks. One bullet per note: \`path\` — what to remember.\n\n## Notes\n`);
  }
  return file;
}

export function readNotebook(workdir) {
  const file = notebookPath(workdir);
  try {
    return { file, text: fs.readFileSync(file, 'utf8'), exists: true };
  } catch {
    return { file, text: '', exists: false };
  }
}

export function writeNotebook(workdir, text) {
  const file = notebookPath(workdir);
  fs.mkdirSync(NOTEBOOK_DIR, { recursive: true });
  fs.writeFileSync(file, String(text ?? ''));
  return { file };
}
