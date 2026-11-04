---
name: council
description: Second opinions, reviews or authorized tasks via Claude Code, Gemini or Grok. Use when the user names one or needs another view.
---

Absolute paths; `<plugin>` is two folders above. Flags precede `--`; no `|| true`.

POSIX:
```sh
node "<plugin>/scripts/council.mjs" <verb> --to <provider> [flags] -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```
PowerShell:
```powershell
@'
<text>
'@ | node "<plugin>\scripts\council.mjs" <verb> --to <provider> [flags] --; exit $LASTEXITCODE
```
Use another delimiter if a text line equals it. Text over 64 KiB, or in PowerShell over 16 KiB, non-ASCII or with a line starting a quote (even curly) then `@`: UTF-8 file as `--prompt-file <path>`, no `--`, stdin `</dev/null` (`$null |`). Bare `review`, `reply <job> --next-input`, `wait`, `cancel`, `models`, `setup` take no text: no `--`, heredoc or pipe.

## Verbs
- `ask --to claude|gemini|grok`: new read-only thread. `reply <job>` or `reply --last`: read-only delta, same provider.
- `review --to <p> [--base <ref>|--commit <sha>|--uncommitted] [--adversarial]`, text = focus. `reply <job> --next-input`: next saved batch.
- `task --to <p> [--thread <job>]`: edits files; gemini takes `--allow-command <exact>`.
- `wait` lists this session's jobs; `wait <job>`, `cancel [job]` (no `--to`), `models`, `setup`. `--web` (not gemini), `--model`, `--effort`.

## Policy
Tiers consult/exec/deep: claude claude-opus-5-5/high sonnet/high claude-opus-5-5/xhigh; grok 4.7/high build-fast/xhigh 4.7/xhigh; gemini argon/medium flash/high argon/high.
No model named: only `ask`/`reply`/`review`, `--tier consult`; ask once before higher effort. Named model: tier by complexity; explicit flags win. `task` only when the user authorizes edits, at default tier exec; `cancel --confirm-ended` only on the user's word.
Each review, task, exec, deep, xhigh or max call gets `--request-id <new word>`; retrying the identical call, flags included, replays the first result.
Fan-out: parallel `ask`s, same brief, one/provider with own `--request-id`; follow `reply <job>`, never `--last`.
F1/F2 findings: BLOCKER/MAJOR/MINOR, file:line. Replies: `F1 AGREE`, `F2 CHANGE: ...`, `F3 REJECT: ...` and new facts. Stop on no change or `round N/N`. Unresolved REJECT is disagreement. Mark each accepted, rejected or needs-user-waiver.

## Results
Max `yield_time_ms` (60000) for shells, collection and outer `exec`/`wait` wrappers. Collect the same shell to exit; `wait <job>` only if lost; never resubmit.
Exit 0 done, 10 attention (findings or `attention:`: denial, incomplete, open questions), 20 still running, 1 failed/cancelled/busy/preflight_blocked, 2 bad arguments.
Summarize; never echo. Follow `next:`/`new ask`. `unreviewed N`: not approved. Denials need the user, not a retry. `preflight_blocked` grants no escalation.
Only footer `· temporary 503; next: repeat once` or JSON `retry.eligible=true` permits one retry per user request: after 2s, fresh request id; then stop. Never auto-retry tasks.
