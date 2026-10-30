# Handoff · Oneiropolos

Running notes for whoever picks this up next (human or agent). Newest first inside each section.
Repo: https://github.com/snozzz/oneiropolos — every module lands as its own commit so it can be reverted alone.

## Follow-up (2026-10-30) · 0.5.1

Asked for (after looking at 0.5.0): the lead card still showed the compass, not GPT's chibi; the sidebar should list
every signed-in account instead of the lead/executor pair; the chibis should stand on their own in the blank beside
the conversation and move down with it; a good animation for "hand over to WorkBuddy".

- Lead cards (and the reviewer) show the chibi face of the engine that answered (`setSpeaker` swaps face and figure on
  `gpt.start`/`wb.start`); faces also in the GPT and WorkBuddy panels. Role emblems stay in the help diagram, the
  "+" menu and the user bubble.
- Figures (`chibiFigure`, `.fig-rail` in `public/style.css`): a rail beside each message — inside the lead card,
  extended over its header/footer rows, and right of the executor's block — holds a sticky figure, so it stays in view
  while its message scrolls by. `.chat-scroll` is a size container: from 960 px wide the lead figure shows and the
  executor's block keeps 160 px on the right for hers; from 1120 px hers stands outside the column. A rail shorter
  than 95 px hides its figure. `.live` (lead thinking / executor working) bobs it; live cards walk in (`.enter`).
- Handoff (`relay`, `playHandoff` in `public/js/thread.js`): lead face · dotted line with a paper plane · executor
  face. Live: the lead's figure throws, the plane arcs over, the executor's face catches it (pop + ring), the
  instruction unfolds. Pointing at the relay replays it. `prefers-reduced-motion` turns all of it off.
- Sidebar (`renderAccounts` in `public/js/main.js`): one row per signed-in engine with its face, GPT's quota or the
  account name; the tooltip names the role it plays next; "Not signed in · Sign in" when none.
- Verified: screenshots at 900 / 1280 / 1500 px, light and dark; animation frames (offscreen WKWebView with the
  snapshot tool's animation-off style removed, animations paused at fixed times); a live replay (events appended to a
  copied task while the page is open) — handoff played, figures entered, no `.live` left after done. 60 tests pass.

## Current round (2026-10-29) · 0.5.0

Asked for:

1. When the lead is not GPT, parts of the page still said "GPT".
2. The planner (lead) emblem was ugly; the worker's hammer is fine.
3. Chibi (Q版) characters for the executor engines (DeepSeek = the whale girl "大肥鱼", Claude = the orange young lady …).
4. Take the best of [pi](https://github.com/earendil-works/pi), drop the rest; don't over-script the models, let them use their full ability.
5. Prompt-cache hit rate: how each round works today, and save as many tokens as possible.
6. A task-mode category to switch the lead off (single tasks may not need it).
7. A CLI version (English first) where the user, the lead and the executor coexist well.

Status: all seven done; see the module log. Open items at the end.

| Module | Commit | Notes |
| --- | --- | --- |
| Tokens: exact WorkBuddy usage, cache hit rate, context cap | 632d8b0 | `normalizeUsage`, per-request sums in `streamjson.js`; `loop.sessionCapK`; `test/usage-accounting`, `test/loop-session-cap` |
| Names follow the engines | 44d459b | cards name the engine of each turn (`gpt.start`/`wb.start` carry `engine`); usage panel by role; prompts say "the Lead"/"the Executor"; zh calls the lead 指导 |
| Lead emblem: Daedalus' compass | 5c92b71 | `EMBLEM.gpt` in `public/js/brand.js` |
| Prompts: native system prompt + short brief | eb824d1 | `src/sysprompts.js` rewritten; `buildSystemPrompt` returns `mode` append/replace |
| Context cap in Settings, shorter tool summary | 1fab61f | Defaults → Flow → "Fresh session above" |
| Lead on/off | 53475ae | `loop.useLead`; `doSolo*` phases in `src/loop.js`; "+" → Lead; `test/loop-solo` |
| Chibi faces | d860dd6 | `public/chibi/<engine>.png` (384px) and `-face.png` (96px); `chibiFace()` |
| CLI `onei` | dc8f773, ac66c63 | `src/tui.js`, `bin/onei.js`, `test/tui.test.js`; linked as `~/.local/bin/onei` |
| Export names engines | c658437 | Markdown export header and turn titles |
| Docs, version 0.5.0 | (this commit) | README en/zh: onei, Lead on/off, prompts and tokens |

### How a round spends tokens (the analysis behind item 5)

- Plan: one lead turn (new session) — its native system prompt + our brief + the planner prompt; it investigates with tools (each tool call = one more request that re-sends the whole session).
- Work round N: the executor resumes its session (`--resume`), gets the instruction, and runs a tool loop. Every request re-sends system prompt + tools + all earlier rounds of this session.
- Audit N: the lead resumes its thread with the round's report, tool summary (last 40 commands), diff (≤ 48 KB) and check output; it may read files itself.
- Review: a fresh lead session with the whole diff since the start.
- So cost ≈ (number of requests) × (session size). Cache hits make the repeated part cheap (Claude Code: 1-hour cache; DeepSeek/WorkBuddy and OpenAI: automatic prefix caching), but the size still matters. What was done:
  1. **Accounting was wrong.** The CodeBuddy core inside WorkBuddy reports `result.usage` summed over the whole resumed session, and counts cached tokens inside `input_tokens`; we summed those per call *and* added the cache again. One task showed 5.8 B tokens and a 44 % hit rate; per request the hit rate is ~98 %. Verified with a real 3-call session (34 k → 69 k → 87 k cumulative). Claude Code (`result.usage` per invocation, input excludes cache) and Codex (`turn.completed` per turn, input includes cache) were right. Now WorkBuddy usage is summed from the per-request `assistant` messages. Older records in `~/.wbloop/usage` stay inflated.
  2. **Stable prefix.** The briefs have no date or per-call text, so the system prompt is byte-identical for the whole task. Claude Code also snapshots its system prompt per conversation.
  3. **Smaller prefix.** Briefs are ~1–2 k characters instead of the snow-cli prompts; the engines' own prompts stay (they were being replaced anyway, but the tool definitions dominate and are cached).
  4. **Session cap.** Every engine now reports the size of its last prompt (`contextTokens`; for Codex estimated as turn input ÷ requests). Past `loop.sessionCapK` (100 k) the executor restarts at the next round with a handover note (instructions are self-contained by design), and the lead continues from `recapPrompt`. This bounds the per-request cost on long tasks, where the old sessions grew to 150 k+.
  5. Cache hit rate of both roles is shown in the task's plan popover and in `onei`.
- Measured after the changes (tiny goal, real engines): Claude lead + GPT exec 53 s; GPT lead + WorkBuddy exec 42 s, executor cache 72 %, lead 73 % (first calls write the cache); lead off with WorkBuddy 13 s, no lead calls.

### Design decisions this round

- **pi, taken**: minimal prompts that trust the model; keep the harness the vendor tuned (Claude Code / Codex / CodeBuddy prompts and tools) and only append what is particular to this loop; no date in prompts (cache); project context comes from the engines' own AGENTS.md/CLAUDE.md loading. **Left out**: pi's own agent runtime and provider layer (we drive the vendors' CLIs, which keep subscription logins), its extension system, and its "no permission system" stance (the lead stays sandboxed, the gate stays).
- **Prompt modes**: built-in briefs are appended (Claude/WorkBuddy `--append-system-prompt`, Codex `-c developer_instructions=…`, DeepSeek persona suffix). A custom prompt or an override ROLE.md still replaces the engine prompt (`--system-prompt-file`, `model_instructions_file`).
- **Lead off** keeps the round structure (snapshots, diff, check, rollback) and only removes the lead's turns. The goal is sent verbatim; the executor brief says it works alone and must check its own work. Turning the lead on mid-task starts its thread from a recap.
- **Chibis are original art** generated with Codex's image tool (`codex exec` + its image tool, the PNG copied into the working dir), not fan art from the web: fan art belongs to its artists and this repo is public. Community references followed: DeepSeek's whale girl (blue hair, whale tail, navy maid dress, loves white rice), Claude's orange young lady (the user's description), GPT a monochrome scholar with a knot hairpin, WorkBuddy's mint cat mascot with a screen face.
- **CLI design**: one scrolling transcript (scrollback stays usable) instead of a full-screen TUI; three voices with a glyph each (› you, ◇ lead, ◆ executor); the lead's verdict, plan checklist and hand-off; the executor's tools as dim one-liners and its report; one status line (spinner, who/what, elapsed, tokens, cache) above the input. The CLI is only a client of the task files, so tasks survive leaving. Enter = message for the next step, Esc = interrupt with the typed text, ctrl+c twice = leave. No dependencies (readline + ANSI); width-aware for CJK. `/lead` and `/exec` save the defaults (like the app's settings); `/mode`, `/team`, `/check` apply to the next task only.

### Open items / next steps (this round)

- Codex calls use `~/.codex` unless Accounts → Advanced sets a Codex home, so the user's personal `~/.codex/AGENTS.md` (a 120-line routing policy, in Chinese) is loaded into every GPT turn; that is why GPT answers in Chinese to English goals. Other engines use their own homes. An isolated Codex home would need its own `codex login`.
- `onei` is English only; i18n can reuse the locale files later. A `--print` (non-interactive) mode is `wbloop run`.
- DeepSeek still has not run a real task (the user has not clicked its sign-in yet).
- The session cap for Codex uses an estimate (turn input ÷ requests); Codex also auto-compacts on its own.

## Earlier round (2026-10-25)

Windows release 0.4.2 (0.4.1 was the initial source tag):

- Added `app/windows/` Electron shell, native folder picker, Ctrl shortcuts, external links, and an NSIS installer plus ZIP with a bundled Node.js 24 runtime. Existing Swift build remains available.
- Ported PATH/CLI discovery (including npm shims), check commands/hooks (cmd.exe), process-tree cancellation, runner detection, system proxy, Windows toast notifications/idle sleep prevention, Team Mode copies, and Explorer integration.
- Finds WorkBuddy and DeepSeek Harness from Windows uninstall registry entries, including custom install locations. WorkBuddy's separate auth file is under LocalAppData/CodeBuddyExtension/Data/Public/auth.
- Claude and WorkBuddy leads on native Windows cannot run shell tools; the configured check command still runs independently. This preserves their read-only role without relying on unavailable Unix sandboxes or Unix command filters.
- `npm ci && npm test && npm run build:windows`; artifacts and SHA256SUMS.txt in dist/windows. Windows build workflow builds/publishes on version tags and also supports manual builds. Binaries are unsigned.
- Verified on Windows 11 x64: all 46 tests pass; packaged app launches with its bundled Node; native folder dialog returns the chosen Windows path; Ctrl shortcuts render correctly; real installed WorkBuddy --version and DeepSeek --help both exit 0. No real paid model task or sign-in was performed.
- User asked to remove the Windows File / Edit / View / Help menu bar; 0.4.2 removes it and handles Ctrl shortcuts directly. Native title bar and in-app controls remain.
- Release assets: Oneiropolos-0.4.2-windows-x64-setup.exe, Oneiropolos-0.4.2-windows-x64.zip, SHA256SUMS.txt. Local QA uses isolated homes under dist/.

Asked for:

1. Lead (plans + audits) and executor can each be any engine: ChatGPT (Codex), Claude (Claude Code), DeepSeek
   (official DeepSeek Harness), WorkBuddy.
2. Every engine signs in from the app ("auth sign in", like snow-cli): one Accounts page, a Sign in button each.
3. Shorter hints — no more "Leave GPT a message, it takes effect at the next audit" style text.
4. Settings dialog must not jump in size when switching sections.
5. Right-click in the sidebar shows an app menu (pin / rename / …), never the WebKit menu (Back, Reload,
   Inspect Element).
6. Plainer, calmer UI polish.
7. Goal box placeholder: "Write your goal, then take a nap."

Status: all seven done (2026-10-25); see the module log. Open items at the end.

## Module log

| Module | Commit | Notes |
| --- | --- | --- |
| Baseline (minimal home, purge overlay removed, codex.home) | 379e659 | uncommitted work from the previous session |
| Settings dialog: fixed size | 19edc7c | `.modal-card.tabs` fixed height; only the pane scrolls |
| Sidebar context menu, pin, rename; no WebKit menu | 0dba213 | `public/js/ctxmenu.js`, `meta.json` per task, `AppWebView` in `app/main.swift` |
| Runner exits when its task folder is deleted | 6ffa3f7 | `test/loop-orphan.test.js` |
| Engines (any engine in either role) | 420ab50 | `src/engines/*`, `config.roles`, `{lead}`/`{exec}` in texts, `/api/accounts` |
| Accounts pane + role engine picker | a8234d6 | `public/js/engines.js`, Settings → Accounts |
| Texts: {lead}/{exec}, shorter hints, nap placeholder | ffa3a56 | placeholder "Write your goal, then take a nap." |
| UI polish (quieter header/cards) | 14444a4 | |
| CLI: --lead/--exec, login/logout any engine, doctor | e55d41f | |
| Docs (README en/zh) | cb3136d | |
| DeepSeek: unattended permission presets | dc7267a | fixes "1 entry did not activate" (permission service) |
| DeepSeek: stale sign-in host cleanup | fe455c3 | |
| Version 0.4.0, app rebuilt and relaunched | (this commit) | |

## Design decisions

- **Engines** live in `src/engines/`. Each engine knows how to find its CLI, report sign-in state, sign in/out,
  list models, and run one turn as `lead` (read-only, JSON verdict) or `executor` (edits files).
  - ChatGPT → `codex exec` (existing). Executor uses `-s workspace-write`.
  - Claude → `claude -p --output-format stream-json` (same stream format as WorkBuddy's CodeBuddy core, so the
    parser is shared). Own config dir `~/.wbloop/claude-home` (`CLAUDE_CONFIG_DIR`), sign-in via `claude auth login`.
  - DeepSeek → the official DeepSeek Harness CLI, `dsh --profile headless --json`, launched from the signed
    `app.asar` entry (NOT the `runtime/cli/bin/dsh` launcher, which a local patch has modified) with its own
    `DSH_HOME=~/.wbloop/dsh-home`. Sign-in uses DeepSeek's own browser flow (`dsh web` in that home) or an API key.
  - WorkBuddy → bundled CodeBuddy core (existing), login file `wbloop-cli.info`.
- Every engine keeps its login separate from the user's own installs (same rule WorkBuddy and codex-home
  already followed).

## Verified for real (2026-10-25)

- Claude Haiku as lead and executor: tiny goal done in 37 s, audit checked the file itself.
- Claude lead → ChatGPT (gpt-5.6-luna) executor: done in 45 s.
- DeepSeek executor without sign-in: the real DSH boots our patch and fails as `auth` (task pauses for sign-in).
- Sign-in APIs reach the real pages: Claude `claude.com/cai/oauth/authorize`, DeepSeek
  `platform.deepseek.com/dsh/authorize` (started via the DSH web host's `account/startSignIn`); cancel leaves no
  processes behind.
- Claude Code's sandbox blocks writes outside the lead's scratch dir (tested with a non-temp folder; /tmp is always
  writable for it).
- WorkBuddy (deepseek-v4.1-flash) lead → Claude Haiku executor: done in 27 s (verdict via CodeBuddy `--json-schema`).
- Not yet run for real: a DeepSeek task after signing in. The sign-in page was reached (it shows the user's DeepSeek
  account and a 登录 button that grants this client model access); it was left for the user to click.

## Environment facts worth knowing

- The repo's `dist/Oneiropolos.app` runs the server straight from this checkout: UI files are served from disk
  (reload shows changes), server changes need the app's server restarted (View → Reload restarts nothing;
  quit and reopen).
- Test server without touching real data: `WBLOOP_HOME=<tmp> node bin/wbloop.js serve --port 47811`.
- A runner (`src/runner.js 20261025-152127-7f23`, pid 51695) was left alive after its task folder was deleted.
  Fixed in this round: runners now exit when their folder disappears.

## Open items / next steps

- **User to do**: Settings → Accounts → DeepSeek → Sign in (one click on DeepSeek's page); Claude → Sign in (or
  Advanced → Claude folder `~/.claude` to share the usual Claude Code login). Then a real DeepSeek task.
- The "[Image #2]" reference for the right-click menu never arrived; the menu follows Claude/ChatGPT desktop
  (Pin, Rename, Open in Finder, Export, Pause/Stop/Continue, Delete). Adjust if the screenshot shows otherwise.
- Known limits: ChatGPT and DeepSeek executors have no tool hooks, so the sensitive-command policy can't ask the
  user there (their sandbox keeps writes in the working dir instead). DeepSeek executors only write inside the working
  directory (no extra writable roots), so Team Mode teammates on DeepSeek can't post to the team board.
- If the app's server dies during a Claude sign-in, `claude auth login` lingers until its own timeout.
- Unused locale keys from the old login panels (`run.wbLogin`, `run.noticeDone`, …) can be removed in a cleanup.
