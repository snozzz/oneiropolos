# Oneiropolos · 守梦人 · 夢守

**English** · [中文](README_zh.md)

> You take a nap; it keeps watch over the dream.

A local two-agent loop for macOS (desktop app, browser UI and command line):

- **GPT — lead and auditor.** Runs through the official Codex CLI on your **ChatGPT subscription**. It researches, writes the plan, gives WorkBuddy one instruction per round, and after every round reads the diff, opens files, runs the tests and decides what happens next.
- **WorkBuddy — executor.** Runs the core that ships inside WorkBuddy.app (the CodeBuddy Code CLI) headless, on your **WorkBuddy account**. It reads and writes the files and runs the commands — alone, or as a **team** of parallel teammates.

The loop goes on until GPT decides the goal is met. Then, by default, a fresh GPT session that knows nothing of the history checks the result independently. WorkBuddy's short runs (step limits, stops halfway) are handled by automatic continuation and by GPT's round-by-round instructions.

```
your goal ─▶ GPT plans ─▶ ┌─────────────────────────────────────────────────────────────┐
  (Plan-first mode:       │ round N: WorkBuddy carries out the instruction               │
   you approve the plan)  │          (or 2–3 teammates in parallel, merged with git)     │
                          │      ↓ shadow-git snapshot · your check command runs         │
                          │ GPT audits: diff, files, tests → next instruction            │
                          └──────────────────────── continue ◀───────────────────────────┘
                                                   │ done
                                                   ▼
                                  a fresh GPT session reviews ─▶ finished (or keeps fixing)
```

### The name

*Oneiropolos* is Homer's ὀνειροπόλος, "one who deals with dreams" — the dream-reader. In the *Odyssey* dreams come through two gates: those through the gate of ivory deceive, those through the gate of horn come true. A WorkBuddy report is a dream of sorts; GPT's audit, your check command and the independent review are there to tell which gate it came through. In Chinese the app is 守梦人 ("keeper of the dream"), in Japanese 夢守. The icon is Hypnos, god of sleep: a wing at his temple, eyes closed, resting on a crescent moon (generated with Codex; the original is `app/icon-source.png`).

The lines of poetry on the home page are about sleep and dozing — Meng Haoran, Su Shi, Homer, Ovid, Keats, Bashō, Ono no Komachi and others, chosen per language. They are decoration only; buttons, settings and every functional label are plain. The command line and the data folder keep the old name, `wbloop`.

## Requirements

| Needed | Notes |
|---|---|
| macOS + Node.js ≥ 20 | e.g. `brew install node` or nvm |
| Codex CLI | `npm i -g @openai/codex`, then `codex login` and choose ChatGPT |
| WorkBuddy.app | installed in /Applications; sign-in is described below |

Check everything (also shows the GPT quota):

```bash
node bin/wbloop.js doctor
```

## Starting

**App (recommended)**

```bash
bash app/build-app.sh                       # builds dist/Oneiropolos.app
open dist/Oneiropolos.app                   # shown as 守梦人 / 夢守 on Chinese / Japanese systems
cp -R dist/Oneiropolos.app ~/Applications/  # to open it from Launchpad or Spotlight
```

The app prefers the code in the project folder, so after editing the source a reload (⌘R) is enough for the interface; rebuild for changes to the Swift shell.

**Browser:** `node bin/wbloop.js serve --open`

**Command line** (`npm link` once in this folder gives you a `wbloop` command):

```bash
node bin/wbloop.js run -d ~/projects/myproj --check "npm test" "Implement …, constraints …, done when …"
```

## Language

The interface is in **English** by default. **Settings → General → Language** switches between English, 中文 and 日本語 (also in ⌘K: "Language"). The page reloads in the new language, and the app's menus follow. Messages from running tasks are re-rendered in the current language.

- Command line: `wbloop config ui.language=zh` (or `ja`, `en`); `WBLOOP_LANG=ja` overrides it for one command.
- The language the **agents** write in is separate: by default they answer in the language of your goal; **Parameters → Collaboration → Reply language** (or `--lang en|zh|ja`) fixes it.
- The Dock and Finder name follows the macOS system language (Oneiropolos / 守梦人 / 夢守), not the in-app setting.

## Signing in

- **GPT** uses the Codex CLI login (`codex login`). When the GPT entry at the bottom left shows the remaining quota (e.g. "5h 94% · week 87%"), you are signed in.
- **WorkBuddy**: click WorkBuddy at the bottom left, or run `node bin/wbloop.js login`. The official sign-in page (www.workbuddy.cn) opens in the browser; pick your account.
  - This is the program's **own sign-in**, stored in `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/wbloop-cli.info`. It **does not touch the WorkBuddy desktop app's** sign-in (whose credentials are encrypted in another file). Credits come from the same account.
  - It lasts about 30 days and renews itself; when it expires, the task pauses and asks you to sign in again, then you click Continue.

## Using it

Tasks are on the left (running ones first), the conversation on the right. **Your messages and GPT's are on the right, WorkBuddy's on the left**: you state a goal → GPT plans and hands WorkBuddy an instruction → WorkBuddy works and reports → GPT audits and gives the next step… Each role has an emblem: Athena's owl is GPT, Hephaestus's hammer is WorkBuddy, the crescent is you, Themis's scales are the independent reviewer.

### A new task

1. Write the **goal, constraints and acceptance criteria** in the box on the home page. `@` mentions a file in the working directory, `#` asks for a sub-agent. The chips below it:
   - **Working directory** — a dedicated project folder (ideally a git repository).
   - **Models & parameters** — GPT and WorkBuddy models and reasoning effort, WorkBuddy's context window, GPT web search, extra folders for WorkBuddy, Team Mode and its size, task mode, reply language, maximum rounds, token budget, **check command**, autonomy, independent review and the sensitive-command policy.
   - **Team** — Solo, Auto (GPT may split a round among teammates) or Always.
   - **Mode** — Normal, **Plan first** (nothing changes until you approve GPT's plan) or **Vulnerability hunting** (a security review of code you own: each finding verified with a minimal proof and reported with a fix).
   - **Start** — now, tonight at 23:00, late night, morning, any time; when the chosen WorkBuddy model has a night discount there is also "when the discount starts". Until then the task just waits (the Mac doesn't idle-sleep), and "Start now" is always available.
2. Click the gold arrow (or ⌘↩).
3. **Templates** below the box: New feature, Fix a bug, New project, Refactor, Performance, Add tests, Review & fix, Write AGENTS.md (`/init`), **Deep research**, Security audit, Parallel work. Click one, replace the `[[…]]` parts and press Tab to jump to the next one; Start reminds you if any are left. Your own goals can be saved as templates.

Notes on the parameters:

- **Check command** (e.g. `npm test`, `python3 -m unittest -q`): after each round the program runs it in the working directory and hands the exit code and output straight to GPT's audit, and runs it again before the independent review. This doesn't pass through WorkBuddy, so it is more trustworthy than its own report.
- **WorkBuddy model data** matches the desktop app: credit multipliers, "night discount" and other tags, context-window steps and reasoning levels all come from WorkBuddy's live server config (refreshed at launch when older than 2 hours, or with "Refresh" in the parameters — no model call, no credits).
- **Maximum rounds** and **token budget** (millions of tokens, GPT + WorkBuddy): when either is reached, GPT first writes a **wrap-up** (what is done, what is left, what the next instruction would be), then the task pauses; raise the limit and click Continue.
- **Autonomy** defaults to "GPT decides on its own", for unattended runs; with "Ask me about important decisions" GPT may pause and notify you.
- **Independent review** is on by default: once GPT says done, a fresh session that doesn't know the history checks again, and anything it finds gets fixed.

### While a task runs

- **Leave a message** for GPT at the bottom (↩ sends; it is used at the next audit), e.g. "use pytest", "ignore performance for now".
- **Interrupt and send** (⌥↩, or `/cut message`): ends the current step at once — a thinking GPT answers again with your message, a working WorkBuddy stops and GPT handles your message. The task itself goes on.
- **Side question** (the speech bubble in the title bar, or `/btw question`): ask GPT anything, e.g. "how far along is it?". The answer appears in a drawer, only for you, and nothing stops (uses a little GPT quota).
- **Sensitive commands** (`rm -rf`, `git push --force`, `git reset --hard`, piping a download into a shell, … 17 built-in rules plus your own): with the default policy WorkBuddy waits and a card asks you — **Allow**, **Always allow** (for this task) or **Deny** with a reason that goes back to WorkBuddy. No answer in 10 minutes means deny. `/yolo` toggles "allow without asking".
- **Plan first**: GPT's plan appears with **Approve** (or `/approve`); a message instead revises the plan.
- **Team Mode**: each teammate gets its own lane with its live process; they share a message board (`/board`, or `>>name message` to post to one). Their work is merged with git at the end of the round; conflicts go back to GPT.
- **Pause / Continue / Stop**; "Adjust" in the title bar changes models, rounds, budget or the check command mid-task.
- **Watch WorkBuddy work**: each round's "process" shows its thinking, text and every tool call; open a step for details — the command and its output, the diff of an edit, a written file, what a sub-agent did. Risky commands are marked. After the round the process folds away, leaving the report, the round's changes (file list / diff) and the check result. `/tool-display` switches between full, compact and reports only.

### After a task

- Write a new requirement at the bottom and the task picks up again.
- **Roll back** (next to a round's changes, in the "⋯" menu, `/rollback`, or Esc Esc): restore the working directory to the start or end of a round. The current state is saved as a snapshot first, so a rollback can be undone; excluded folders like node_modules and files over 5 MB are left alone. GPT is told about it next time.
- **Export** (`/export`): the conversation as Markdown in Downloads; `/copy` copies the last reply.

## What came from snow-cli

The working style, many commands and the system prompts follow [snow-cli](https://github.com/MayDay-wpf/snow-cli), adapted to a GPT lead with a WorkBuddy executor:

| snow-cli | Here |
|---|---|
| System prompts, `ROLE.md`, override roles | Built-in prompts for every role (lead, executor, teammate, reviewer, advisor); **Settings → Prompts** replaces any of them completely (with `{{workdir}}`, `{{date}}` … variables). `ROLE.md` in the project root (or `~/.wbloop`) is added as "rules emphasized by the user" or replaces WorkBuddy's prompt. GPT gets its prompt through Codex's `model_instructions_file`, WorkBuddy through `--system-prompt-file`. |
| Sub-agents, `/agent`, `#` picker, `.snow/agents/*.md` | Six built-ins (explore, plan, general, analyze, QA, debug) passed to WorkBuddy with `--agents`; your own in Settings → Sub-agents or as Markdown files in `<project>/.wbloop/agents`, `<project>/.snow/agents`, `~/.wbloop/agents`. `#agent_explore` in a goal or message asks for one. |
| `/role-subagent` (`ROLE-<name>.md`) | **Rules** next to each sub-agent writes `~/.wbloop/ROLE-<id>.md`; a `ROLE-<id>.md` in a project root wins for that project. |
| Team mode (`/team`) | GPT assigns parts of a round to teammates (name, role, files owned). Each works in an APFS clone of the folder; results are merged with a three-way git merge; a shared `BOARD.md` carries messages. |
| Plan mode, `/goal` | Plan-first mode with approval; the whole app is goal-driven, with evidence-based audits. |
| Vulnerability hunting | Task mode "Vulnerability hunting" and the Security audit template. |
| Hooks (9 types, `.snow/hooks`) | Same types and exit-code meaning (0 ok / JSON `additionalContext`, 1 replace, 2 block), command, prompt and context hooks; global in `~/.wbloop/hooks`, per project in `.snow/hooks` or `.wbloop/hooks`. Tool hooks reach WorkBuddy through its PreToolUse/PostToolUse. |
| Sensitive commands, YOLO, `/permissions` | Policy ask / deny / allow, 17 rules on/off, custom regex rules, "always allow" per task, `/yolo`. |
| Skills, `/skills` | `SKILL.md` folders from `~/.wbloop/skills` and the project's `.claude`, `.codebuddy`, `.snow`, `.wbloop` skill folders; `/skills` puts one into the message. |
| Custom commands (`$ARGUMENTS`, namespaces) | Settings → Skills & commands, or JSON files in `~/.wbloop/commands`, `.snow/commands`; type prompt or execute. |
| MCP | `~/.wbloop/mcp.json` (Settings → MCP), per server for WorkBuddy, GPT or both. |
| `/loop` | `/loop 30m check the logs`, `/loop daily 09:30 …` (also 每天 / 毎日): new tasks or messages on a schedule. |
| Code memory | A per-project notebook WorkBuddy reads and updates (`/notebook`). |
| `` !`cmd` ``, `` !!`cmd` `` | Command injection in goals and messages: output goes into the text, or is only shown to you. |
| `/review`, `/new-prompt`, `/usage`, `/todo`, `/gitline`, `/deepresearch`, `/compact`, `/init`, `/btw`, `/cut`, `/pause`, `/export`, `/copy`, `/tool-display`, `/profiles`, `/config` export/import, Esc Esc rollback | All available (profiles in Settings → Defaults, export/import in System & data). |

Not ported, on purpose: terminal-only features (buddy pets, games, pixel editor, status line, tool icons and names, speedometer, thinking display, simple theme); settings of snow's own model runtime that Codex and WorkBuddy handle themselves (providers and OAuth, custom headers, tool search, tool-call correction, compression modes, sub-agent depth); IDE/LSP integration and codebase indexing; service mode, connected instances and telemetry. Instead of `/branch` start a new task, instead of `/worktree` use git; `/auto-format` is an `afterToolCall` hook; `/backend` and `/taskmanager` are the task list (every task is its own process); `/todolist` and `/ultra-todo` are GPT's plan with step status and the audit after every round.

## Shortcuts and commands

| Key | Does |
|---|---|
| ⌘K | Command palette: tasks, commands, settings, language, theme |
| ⌘N / ⌘, / ⌘/ | New task / Settings / Help |
| ⌘↩ | Start the task (home page) |
| ↩ / ⇧↩ / ⌥↩ | Send / new line / interrupt and send |
| ↑ ↓ | Earlier inputs when the box is empty |
| Esc Esc | Roll back to a round |
| `/` | Slash commands (the Chinese IME's "、" works too), Tab completes; pinyin initials work, e.g. `/hg` is rollback |
| `@` / `#` / `>>` | File in the working directory / sub-agent / message to a teammate |

In a task: `/cut` `/btw` `/approve` `/pause` `/resume` `/stop` `/plan` `/diff` `/rollback` `/review` `/export` `/copy` `/compact` `/team` `/yolo` `/rounds 40` `/budget 20` `/check npm test` `/skills` `/agents` `/todo` `/gitline` `/new-prompt` `/loop` `/notebook` `/board` `/usage` `/tool-display` `/settings` `/help`, plus your own commands.

On the home page: `/dir` `/params` `/team` `/mode` `/init` `/deepresearch <question>` `/gitline` `/new-prompt` `/review` `/skills` `/agents` `/todo` `/loop` `/notebook` `/usage` `/mcp` `/hooks` `/settings` `/help`.

## Settings

Ten pages: **General** (language, theme, process detail), **Defaults** (parameters for new tasks, saved profiles), **Prompts** (each role built-in or custom, standing rules for GPT and for WorkBuddy, ROLE.md), **Sub-agents**, **Safety** (policy, timeout, rules), **Hooks**, **Skills & commands**, **MCP**, **Long runs** (steps per call, continuations, idle timeout, waiting on limits, check timeout, auto-compact) and **System & data** (notifications, sleep prevention, notebook, cleanup, usage, loops, export/import of settings).

## Command line

```bash
node bin/wbloop.js templates                  # list templates
node bin/wbloop.js templates bugfix > goal.md # edit the [[…]] parts
node bin/wbloop.js run -d ~/projects/myproj --goal-file goal.md --team auto --check "npm test" --start-at 23:00
node bin/wbloop.js run -d . --mode plan "…"   # then: wbloop approve-plan last
node bin/wbloop.js allow last --always        # answer a sensitive-command request (or: deny last --reason "…")
node bin/wbloop.js loop add "daily 09:30 check the logs and fix new errors"
node bin/wbloop.js quota | usage 7d | agents | prompt executor
```

Also: `wbloop list / show / tail / msg / pause / stop / resume / compact / export <ID|last>`, `wbloop config key=value`. In a foreground run, type to leave a message; `/cut …`, `/approve`, `/allow`, `/deny`, `/compact`, `/pause`, `/resume`, `/stop` work there too.

## Ruleset overlay (purge)

GPT's "armour" does not live in codex — it lives in this program's own system prompt. To swap in a ruleset of your own you don't need to touch the code: point `settings.purge` at a Markdown file and it is composed into the lead/reviewer prompt, with a **PURGE** badge in the task header (dim = switched on but not in effect, solid = actually injected for this turn).

```bash
wbloop config purge.enabled=true                      # default slot: ~/.wbloop/purge.md
wbloop config purge.enabled=true purge.file=/path/to/ruleset.md
wbloop config purge.mode=replace                      # drop the built-in prompt, keep the environment block
wbloop config purge.roles='["lead","reviewer"]'       # who receives it (those two by default)
```

- The program **ships no ruleset content**: a missing or empty file is a no-op, the badge stays dim, the prompt is untouched. `examples/purge.md` is a shape reference only.
- Composition replaces codex's base instructions wholesale (`-c model_instructions_file`), so codex's own scaffolding is not stacked on top; `--ignore-user-config` still applies, `~/.codex/config.toml` plays no part.
- Every round's final prompt is kept at `~/.wbloop/runs/<ID>/prompts/<role>.md`, so you can check verbatim what was sent; the prompt preview in Settings includes it too.
- It only touches GPT's prompt layer: the JSON reply contract, the read-only sandbox and the tool list are unchanged, and WorkBuddy plus its command approvals (`safety`) are unaffected. dsh-purge's lab gate is not part of this layer — if you need outbound targets restricted, add a hook.

## Built for long runs

- Every task runs in its own background process: **closing the app or the page doesn't stop it**; reopen to keep watching.
- State is written to disk at every step (`~/.wbloop/runs/<ID>/`). After a restart or a crash the task shows "Interrupted"; Continue resumes where it stopped (WorkBuddy continues its session).
- WorkBuddy is continued automatically after step limits, network drops or long silence, and waits and retries when rate-limited.
- When the ChatGPT quota runs out, GPT retries after 5 → 10 → 15 → 30 → 60 minutes, for up to 8 hours (configurable), and carries on when the quota is back. The remaining quota is always at the bottom left.
- The Mac doesn't idle-sleep while tasks run (closing the lid still sleeps); you get notifications when a task finishes, fails or needs you.
- If GPT's model isn't available on the account, the next available one is used and remembered.

## Safety

- **WorkBuddy has full read, write and execute rights in the working directory** ("bypass permissions" by default; sensitive commands go through the policy above). Use a dedicated project folder; the root folder and your whole home folder are refused, and one folder can have only one unfinished task.
- WorkBuddy only gets its coding tools (files, commands, sub-agents, task list, web, skills, MCP resources); tools that would hang or fail without a user (asking questions, plan mode, its own team/channel features, remote A2A) and the credit-hungry image/video generation are off. `wbloop config workbuddy.tools=all` turns everything on.
- **GPT cannot change your project**: it runs in the Codex sandbox with the project read-only; only its own scratch folder and the system temp folder are writable (for tests that write temp files). A project under /tmp makes it fully read-only. Side questions and reviews are read-only too.
- The check command, hooks and custom commands are yours and run as written (`zsh -c`) — only use commands you trust.
- Each round's changes are recorded in a separate git repository in `~/.wbloop/runs/<ID>/shadow.git`; **your project's own .git is never touched**, and rollbacks use only that shadow repository.
- The local service listens on 127.0.0.1 only, needs a random token and checks the Host header.

## Where things are

| Path | What |
|---|---|
| `~/.wbloop/config.json` | Settings (`wbloop config` shows and changes them) |
| `~/.wbloop/runs/<ID>/` | A task: state, event log, per-round instructions, tool records, diffs, check output, system prompts, approvals, team workspaces, shadow git |
| `~/.wbloop/hooks/`, `commands/`, `skills/`, `agents/` | Your global hooks, commands, skills, sub-agents |
| `~/.wbloop/ROLE.md`, `ROLE-<id>.md` | Global ROLE file; rules for one sub-agent |
| `~/.wbloop/mcp.json`, `loops.json` | MCP servers; scheduled loops |
| `~/.wbloop/notebooks/` | Project notebooks |
| `~/.wbloop/usage/` | Token usage per day |
| `~/.wbloop/templates.json`, `ui-state.json` | Your templates; small interface preferences |
| `~/.wbloop/workbuddy-home/` | Config and sessions of the WorkBuddy core for this program (separate from the desktop app's `~/.workbuddy`) |
| `~/.wbloop/logs/app-server.log` | Log of the service started by the app |

To remove everything: delete `~/.wbloop` and the `wbloop-cli.info` above. To clean up old tasks only: Settings → System & data → Clean up.

## FAQ

- **GPT says "model is not supported when using Codex with a ChatGPT account"**: that model isn't available on your plan. The program switches models by itself; it calls Codex with `--ignore-user-config` and an explicit model, because the default in `~/.codex/config.toml` may not work with a subscription login.
- **The GPT quota says "from the last session"**: the live reading needs chatgpt.com (`codex app-server`, account/rateLimits/read, no quota used); otherwise it falls back to the last Codex session's numbers.
- **The app can't reach ChatGPT**: apps don't inherit the terminal's `*_proxy` variables; the program reads the macOS system proxy instead. Check that it is on.
- **A different WorkBuddy model**: choose it in the parameters, or `wbloop config workbuddy.model=glm-5.3`. The list shows each model's multiplier, tags and the next discount window, as in the desktop app. Auto lets WorkBuddy choose.
- **Long builds or tests get interrupted**: 30 minutes without any output counts as stuck and WorkBuddy is continued; one call lasts at most 120 minutes. Both are in Settings → Long runs.
- **The old WBLoop icon in the Dock doesn't open**: the app is now `Oneiropolos.app`; drag the new one into the Dock.

## For developers

```
bin/wbloop.js      command line
src/loop.js        orchestrator: plan → (approve) → work (single or team) → audit → (review) → finish; retries, continuation,
                   interrupts, check command, schedule, wrap-up at limits, budget, hooks, recovery
src/sysprompts.js  system prompts of every role, overrides, ROLE.md;  src/prompts.js  the per-turn prompts
src/subagents.js   sub-agents and ROLE-<id>.md;  src/team.js  Team Mode workspaces, board and merge
src/hooks.js       hooks;  src/hook-gate.js  WorkBuddy's PreToolUse/PostToolUse gate;  src/safety.js  sensitive commands, approvals
src/skills.js  src/commands.js  src/mcp.js  src/loops.js (+ looper.js)  src/notebook.js  src/usage.js
src/codex.js       GPT: codex exec --json / resume, --output-schema, instructions file, MCP; quota via app-server
src/workbuddy.js   WorkBuddy: the bundled CLI in -p stream-json mode, its own sign-in, models, promotions, discount windows
src/snapshot.js    shadow-git snapshots, diffs, rollback
src/service.js     task creation and control, jobs (review, new prompt, side questions), export, settings data
src/server.js      local HTTP service + SSE;  src/i18n.js  server-side translations
public/js/         interface (ES modules): main, home, thread, panels, forms, composer, tools, overlay, brand, core,
                   i18n + locales/{en,zh,ja}.js (shared with the server)
app/               macOS shell (Swift + WKWebView), icon and build script
```

GPT always answers in the JSON Schema of `src/schema.js`: `verdict` (continue / done / ask_user / abort), `assessment`, `plan`, `issues`, `next_instruction`, `team`, `progress`, `question_for_user`.

Tests: `npm test` (Node's test runner; Codex and WorkBuddy are replaced by fakes).
