# Handoff · Oneiropolos

Running notes for whoever picks this up next (human or agent). Newest first inside each section.
Repo: https://github.com/snozzz/oneiropolos — every module lands as its own commit so it can be reverted alone.

## Current round (2026-10-25)

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

Status: see the module log below.

## Module log

| Module | Commit | Notes |
| --- | --- | --- |
| Baseline (minimal home, purge overlay removed, codex.home) | 379e659 | uncommitted work from the previous session |

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

## Environment facts worth knowing

- The repo's `dist/Oneiropolos.app` runs the server straight from this checkout: UI files are served from disk
  (reload shows changes), server changes need the app's server restarted (View → Reload restarts nothing;
  quit and reopen).
- Test server without touching real data: `WBLOOP_HOME=<tmp> node bin/wbloop.js serve --port 47811`.
- A runner (`src/runner.js 20261025-152127-7f23`, pid 51695) was left alive after its task folder was deleted.
  Fixed in this round: runners now exit when their folder disappears.

## Open items / next steps

- (filled in as modules land)
