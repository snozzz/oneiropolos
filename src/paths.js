import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = os.homedir();
export const DATA_DIR = process.env.WBLOOP_HOME || path.join(HOME, '.wbloop');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const SERVER_INFO_PATH = path.join(DATA_DIR, 'server.json');
export const SCHEMA_PATH = path.join(DATA_DIR, 'gpt-output.schema.json');
export const TEMPLATES_PATH = path.join(DATA_DIR, 'templates.json');

// A config directory of the WorkBuddy core (CodeBuddy Code CLI) just for this program, separate from the desktop app's ~/.workbuddy.
export const WB_HOME = path.join(DATA_DIR, 'workbuddy-home');
// A product-config overlay with a different authentication.id: the CLI keeps its credentials in a separate file and never
// touches the desktop app's.
export const WB_PRODUCT_PATH = path.join(DATA_DIR, 'workbuddy-product.json');
export const WB_AUTH_ID = 'wbloop-cli';
export const WB_AUTH_DIR = path.join(HOME, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth');
export const WB_AUTH_FILE = process.env.WBLOOP_WB_AUTH_FILE || path.join(WB_AUTH_DIR, `${WB_AUTH_ID}.info`);

export function ensureDirs() {
  for (const dir of [DATA_DIR, RUNS_DIR, LOG_DIR, WB_HOME]) fs.mkdirSync(dir, { recursive: true });
}
