# Handoff · Oneiropolos

Running notes for whoever picks this up next (human or agent). Newest first inside each section.
Repo: https://github.com/snozzz/oneiropolos — every module lands as its own commit so it can be reverted alone.

## Current round (2026-10-25)

Windows release 0.4.1:

- Added `app/windows/` Electron shell, native folder picker, Ctrl shortcuts, external links, and an NSIS installer plus ZIP with a bundled Node.js 24 runtime. Existing Swift build remains available.
- Ported PATH/CLI discovery (including npm shims), check commands/hooks (cmd.exe), process-tree cancellation, runner detection, system proxy, Windows toast notifications/idle sleep prevention, Team Mode copies, and Explorer integration.
- Finds WorkBuddy and DeepSeek Harness from Windows uninstall registry entries, including custom install locations. WorkBuddy's separate auth file is under LocalAppData/CodeBuddyExtension/Data/Public/auth.
- Claude and WorkBuddy leads on native Windows cannot run shell tools; the configured check command still runs independently. This preserves their read-only role without relying on unavailable Unix sandboxes or Unix command filters.
- `npm ci && npm test && npm run build:windows`; artifacts and SHA256SUMS.txt in dist/windows. Manual Windows build workflow added. Binaries are unsigned.
- Verified on Windows 11 x64: all 46 tests pass; packaged app launches with its bundled Node; native folder dialog returns the chosen Windows path; Ctrl shortcuts render correctly; real installed WorkBuddy --version and DeepSeek --help both exit 0. No real paid model task or sign-in was performed.
- Release assets: Oneiropolos-0.4.1-windows-x64-setup.exe, Oneiropolos-0.4.1-windows-x64.zip, SHA256SUMS.txt. Local QA uses isolated homes under dist/.

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
