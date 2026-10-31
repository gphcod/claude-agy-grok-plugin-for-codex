---
name: council
description: Ask Claude Code, Gemini or Grok for a second opinion, a review or an authorized task. Use when the user names one of them, or a hard question needs an independent view.
---

Stub (S0). The full skill is written in S6; the terms below are the contract it must keep.

One shell call, absolute paths; `<plugin>` is two folders above. Flags precede `--`.

POSIX shell:
```
node "<plugin>/scripts/council.mjs" ask --to grok --tier consult -- <<'COUNCIL_EOF'
<text>
COUNCIL_EOF
```
PowerShell:
```
@'
<text>
'@ | node "<plugin>\scripts\council.mjs" ask --to grok --tier consult --; exit $LASTEXITCODE
```
Change a delimiter occurring alone in the text. Text over 64 KiB, or in PowerShell over 16 KiB or non-ASCII, goes in a UTF-8 file as `--prompt-file <path>`.

## Verbs
- `ask --to <claude|gemini|grok>`: new read-only thread. `reply <job> [--next-input]` or `reply --last`: read-only delta; `--next-input` sends the next saved review batch.
- `review --to <p> [--base <ref> | --commit <sha> | --uncommitted] [--adversarial]`: hash-checked batched review.
- `task --to <p>`: edits, only when the user authorizes them. `wait [job]`, `cancel [job]`, `models`, `setup`.
- Without a named model: `ask`/`reply`/`review` only, pass `--tier consult` explicitly, never `task`.
- Give reviews, tasks and deep calls `--request-id <new word>`; a retry with the same id returns the first result, never a second run.

## Running and results
A call blocks until the model answers. If the shell yields, keep collecting that same shell with the longest wait allowed; `wait <job>` only after losing it; never resubmit.
Exit 0 done, 10 needs attention, 20 still running, 1 failed/cancelled/busy/preflight_blocked, 2 bad arguments.
Footer: `council <provider> ok · job <id> · <model>/<effort> · <time> · round N/N`. Summarize or act; never repeat it verbatim. `unreviewed N` means the review left changes out and does not approve them. `preflight_blocked` names the blocked resource; it grants no escalation.
