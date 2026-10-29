#!/usr/bin/env node
// onei: the interactive terminal for Oneiropolos. `onei` in a project folder, then type a goal.
import path from 'node:path';
import { startTui } from '../src/tui.js';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`onei — a lead plans and audits, an executor does the work, while you take a nap.

Usage:
  onei                 open the terminal in this folder (follows a task already running here)
  onei "goal"          start a task right away
  onei -d <dir> …      work in another folder

Inside: type a goal, /help for commands. Leaving never stops a task.
Scripting and everything else: wbloop --help`);
  process.exit(0);
}
let dir = process.cwd();
const words = [];
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '-d' || argv[i] === '--dir') && argv[i + 1]) dir = path.resolve(argv[++i]);
  else words.push(argv[i]);
}
startTui({ dir, goal: words.join(' ').trim() });
