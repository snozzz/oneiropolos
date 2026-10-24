# Example ruleset for the purge slot

Copy this file to `~/.wbloop/purge.md` (or anywhere, then point `purge.file` at it) and switch the slot on:

```bash
wbloop config purge.enabled=true                      # default slot: ~/.wbloop/purge.md
wbloop config purge.enabled=true purge.file=/path/to/ruleset.md
wbloop config purge.mode=replace                      # drop the built-in prompt instead of appending
wbloop config purge.roles='["lead","reviewer"]'       # who receives it
wbloop config purge.enabled=false                     # back to the stock prompt
```

The app ships no ruleset content: this file only shows the shape of one. What you put here is yours, and it is
composed verbatim into the system prompt of the roles you picked — `~/.wbloop/runs/<id>/prompts/lead.md` keeps a
copy of exactly what was sent, so a transcript can always be traced back to the text that produced it.

## Scope

- Work only inside the local lab: loopback (127.0.0.0/8, ::1) and RFC1918 (10/8, 172.16/12, 192.168/16).
- Resolve every hostname first; if any answer is public, stop and report it instead of continuing.
- Never point a check at a third-party service, a bank, a government site, or anything you do not own.

## Evidence

- For each finding: the command, the raw output, the file and line, and one concrete mitigation.
- Say "not reproduced" when you cannot reproduce it; do not fill gaps with plausible-sounding detail.
- Keep every command idempotent, and clean up anything you start.
