---
name: council
description: Ask Claude Code, Gemini or Grok for a second opinion, a review or an authorized task. Use when the user names one of them, or a hard question needs an independent view.
---

One shell call, absolute paths; `<plugin>` is two folders above. Flags precede `--`; no `|| true`.

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
Change a delimiter found alone in the text. Text over 64 KiB, or in PowerShell over 16 KiB, non-ASCII or with a line starting `'@`: UTF-8 file as `--prompt-file <path>`, no `--`, stdin `</dev/null` (`$null |`). Bare `review`, `reply <job> --next-input`, `wait`, `cancel`, `models`, `setup` take no text: no `--`, heredoc or pipe.

## Verbs
- `ask --to claude|gemini|grok`: new read-only thread. `reply <job>` or `reply --last`: read-only delta, same provider.
- `review --to <p> [--base <ref>|--commit <sha>|--uncommitted] [--adversarial]`, text = focus. `reply <job> --next-input`: next saved batch, then synthesis.
- `task --to <p> [--thread <job>]`: edits files. `--allow-command <exact>`: gemini tasks only.
- `wait [job]`, `cancel [job]`, `models`, `setup`. `--web`: search (not gemini). `--model`, `--effort` (low to max).

## Policy
Tiers consult/exec/deep: claude default/high, sonnet/high, default/xhigh; grok 4.7/high, build-fast/xhigh, 4.7/xhigh; gemini argon/high, flash/high, argon/high.
User named no model: `ask`/`reply`/`review` only with `--tier consult`; ask once before higher effort (not for gemini). Named model or family: tier by complexity; explicit `--model`/`--effort` win. `task` only when the user authorizes edits; `cancel --confirm-ended` only on the user's word.
Each review, task, deep, xhigh or max call gets `--request-id <new word>`; a retry with the same id and text replays the first result.
Fan-out: one `ask` per provider in sequence, same brief, own `--request-id`; follow up by `reply <job>`, never `--last`.

## Discussion
Findings F1, F2 tagged BLOCKER/MAJOR/MINOR with file:line. Replies send only `F1 AGREE`, `F2 CHANGE: ...`, `F3 REJECT: ...` and new facts. Stop when nothing changes or at `round N/N` (9 replies unless `--rounds`). Unresolved REJECT is disagreement. Rule each finding accepted, rejected or needs-user-waiver.

## Results
Calls block. If the shell yields, keep collecting the same shell with the longest wait allowed; `wait <job>` only after losing it; never resubmit.
Exit 0 done, 10 needs attention, 20 still running, 1 failed/cancelled/busy/preflight_blocked, 2 bad arguments.
Footer: `council <provider> ok · job <id> · <model>/<effort> · … · round N/N`. Summarize or act, following `next:`; never repeat it verbatim. `unreviewed N`: left out, not approved. Denials need the user, not a retry. `preflight_blocked` names the resource; it grants no escalation.
