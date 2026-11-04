# Parity record: Gemini (agy)

S5.7. Donor: gemini-plugin-for-codex 0.1.2 (AGYX), `skills/agy/scripts/agy.mjs` and `lib/` at tag `v0.1.2`, and its `references/operations.md`. Council: `plugins/council/scripts/lib/providers/gemini.mjs` over the shared core. Status words: **same**, **renamed** (same behaviour, other name or form), **intentionally different** (a decided change, with its reason), **missing** (none at the gate).

## Commands and options

| AGYX | Council | Status | Notes |
|---|---|---|---|
| `ask` (no `--edit`): a read-only "review"-mode turn | `ask --to gemini`, `reply`, `review --to gemini` | intentionally different | AGYX had one verb; council splits question, discussion and structured review (A3.2). All three run the read-only settings file |
| `ask --edit` | `task --to gemini` | renamed | `--mode accept-edits` only on tasks, as AGYX |
| `ask --conversation ID` | `reply <job\|thread>`, `task --thread <job\|thread>` | renamed | `--conversation <id>` on every resume; council only resumes ids it recorded (A7.3, decisions S2.6) |
| `--allow-command EXACT` (with `--edit` only) | `--allow-command EXACT` on `task --to gemini` only | intentionally different | Same `command(X)`/`unsandboxed(X)` pair. Added: the task's `toolPermission` becomes `request-review` unless the global value is `strict` (S1.9 Q2: the pair restricts nothing under `always-proceed`); values with parentheses, line breaks or no text exit 2 (decisions S5.1). Elsewhere exit 2 (AGYX: usage error, also exit 2) |
| `--settings JSON` (caller-supplied session settings, merged) | — | intentionally different | No caller settings: the settings file is built only from the user's global lists and council's rules (A5.1). The one AGYX use, extra deny rules, is served by the global file |
| `--model ID`, `--effort VALUE` | `--model`, `--effort`, `--tier` | intentionally different | Council resolves aliases (`argon`, `flash`), clamps effort downward against the catalog (`xhigh` → `high<=xhigh` in the footer), rejects a suffix conflict with exit 2 before any call, and passes a suffixed id alone (A3.3). AGYX forwarded both flags and let agy fail |
| `--timeout SECONDS` (1..86400, default 600) | `--deadline <s>` (default 14400), `--inactivity-timeout <s>` | renamed | `--print-timeout` is the deadline less min(3 s, a third), as AGYX derived it from its timeout |
| `--request-id KEY` | `--request-id <id>` | same | Council's id grammar also allows `:` and must start with a letter or digit; a replay starts no agy (A7.4); changed input under the same id exits 2 |
| `--prompt-file PATH`, stdin | `--prompt-file`, heredoc / here-string stdin | same | AGYX capped input at 2 MiB; council's core caps follow A3.1 |
| `--inline-bytes N` (inline answer cap, default 16 KiB) | fixed 24 KiB answer cap with `full: <file>` | intentionally different | A1/A3.4: one cap for every provider |
| `--cwd PATH` | `--cwd` | same | |
| `result RUN_ID [--wait 0..600]` | `wait <job> [--timeout <s>]` | renamed | Collector only, never a new agy call; returns 20 at expiry (A3.2) |
| `cancel RUN_ID` | `cancel <job>` | same | Council stops the child's process group (SIGTERM, then identified rows by SIGKILL) through creation-time-verified identities (A7.5); live run: `cancelled`, no process left with the job's `--settings` path |
| `release --cwd PATH --confirm-ended` | `cancel <job> --confirm-ended` **[user]** | renamed | Releases a held-output lock only when the process table shows no owned process; refuses (exit 10) otherwise (A7.8). Per job, not per workspace |
| `prune [--cwd PATH]` | automatic pruning past 100 finished jobs (A7.7) | intentionally different | No verb; running, lost, cleanup-pending, claim-holding and review-input-pending jobs are never pruned |
| `AGY_STATE_DIR` (default `~/.cache/codex-agy`) | `COUNCIL_CODEX_HOME` (default `~/.codex/council`) | renamed | |
| `AGY_BRIDGE_DEPTH` recursion guard | the five guard variables on every child, admission refuses any (A5.1) | same | `AGY_BRIDGE_DEPTH` is among them, so neither plugin can nest through the other |

## Launch and settings

| AGYX | Council | Status | Notes |
|---|---|---|---|
| `--input-format stream-json --output-format stream-json --disable-slash-commands --print-timeout <n>s` | same | same | |
| no `--sandbox` | `--sandbox` on every turn | intentionally different | A2/A5.1 read-only enforcement |
| one NDJSON `{"event":"user","message":{"content"}}` on stdin | same, content = `contract.md`, the turn's instructions, the text | intentionally different | AGYX sent the bare prompt; council prepends its standing contract and the per-turn template (A5.1) |
| `--settings <private file>` on review turns and on edits with grants; plain edits used the global profile | `--settings <job-dir>/settings.json` on every turn | intentionally different | Every turn: the operand is the ownership evidence (A5.1); a task without `--allow-command` carries the global lists and toolPermission unchanged, so it behaves as the global profile |
| `configuredPolicy`: only `permissions` lists and `toolPermission` from `~/.gemini/antigravity-cli/settings.json`, 2 MiB cap, invalid JSON stops the call | same | same | Read per call from the call's `HOME`; a broken file fails the turn before any agy call and `setup` warns |
| review deny list `write_file(*)`, `command(*)`, `unsandboxed(*)`, `mcp(*)`, `execute_url(*)` | `write_file(*)`, `edit_file(*)`, `unsandboxed(*)`, `mcp(*)`, `execute_url(*)`; inspection commands allowed | intentionally different | gemini-plugin-cc's rule, added at the final self-review (PLAN Part C); AGYX observed `edit_file` guarded by `write_file(*)` live, the explicit rule removes the dependence on that alias |
| review allow filtered to `read_file(...)`/`read_url(...)`, `agentMode: ""`, `toolPermission` strict or request-review | same | same | |
| global deny/ask arrays merged before rules are added | same | same | Session arrays replace the global ones (S1.2, the twin's scratch-HOME probe) |
| `--json-schema` not used (review answers were prose) | `--json-schema <path>` on reviews and review discussions | intentionally different | One schema for all providers (A5.2); agy enforces it through `finish` (S1.2) |
| Windows `ask` refused ("unqualified") | Gemini turn verbs run on `win32` | intentionally different | Checked in `docs/qualification/windows.md` |
| `agy.exe`/`agy` from PATH | `COUNCIL_AGY_BIN`, else PATH | renamed | |

## Results and exit codes

| AGYX | Council | Status | Notes |
|---|---|---|---|
| 0 completed | 0 ok | same | |
| 0 warning: only write denials on a review turn | 10 needs attention | intentionally different | Council treats every denial as attention (A3.4) |
| 10 incomplete: any denial on an edit turn, a non-write denial on review | 10 (`denied`) | same | Both denial signatures: the A2 tool-step regex and a non-empty `result.denied_actions`, the latter checked before the empty-response rule |
| 10 incomplete: `print_timeout` | 1 failed, error agy's `[agy] print timeout …` line; the answer agy gave (its response, else the streamed text) is kept and printed | intentionally different | PLAN A3.3/A5.1: a timed-out turn is a failure, never attention or running |
| 10 incomplete: workspace changed during review | 10 (`incomplete`) | same | Any read-only verb (ask, reply, review) |
| 10 incomplete: partial Git snapshot on review | 0, footer hint `coverage unknown` (`mutationCoverage: "unknown"` in the job record) | intentionally different | PLAN S5.3: an unavailable snapshot reports unknown coverage; a detected change is still 10 (decisions S5.3) |
| 0 warning: outside Git (`coverage=unchecked` in the status prefix) | 0, footer hint `coverage unknown` | intentionally different | Council has no `warning` state; the footer hint names the unverified workspace check (milestone 3 review Q6) |
| 1 failed: missing or malformed result, status ≠ SUCCESS, empty response, non-zero exit | 1 | same | Plus a duplicate result, a malformed line, a frame or partial answer over 4 MiB. A deny-rule denial earlier in the stream turns an empty result into `denied` (exit 10) with the denial as the answer; a status ≠ SUCCESS result after a denial is parsed the same way and also exits 10 with the denial answer, although agy itself exits 1: a completed turn with a recorded denial is attention despite a non-zero exit (core cabec41) |
| stderr "operation not permitted / readonly database / read-only file system / permission denied", or a permission/approval notice, with no denial → incomplete | 10 (`incomplete`) | same | Ported into `afterTurn` (`hostNotice`) |
| 20 running / unknown (cleanup unverified) | 20 from `wait` only; an unverified cleanup is exit 1 with `cleanup pending; next: cancel <job>` | intentionally different | A3.4: 20 means "still running"; an unverified cleanup is a failure that names its recovery |
| 2 usage | 2 | same | |

## Output

| AGYX | Council | Status | Notes |
|---|---|---|---|
| start line `agy run=<id>` | `[council] provider=gemini job=<id>` on stderr | renamed | Since 1.1.0, printed at spawn before agy's first event; native conversation stays in state/JSON/`wait` |
| status prefix `agy <state> denied=N coverage=… changed=N run=… conv=…`, denial lines, `changed:` list, `evidence=` | footer (A3.4) and `--json`; denials, mutation coverage and changed paths in the job record (`meta.json`) | intentionally different | One footer grammar for every provider; `edited N` on tasks |
| answer: `result.response`, else the streamed partial | `result.response`; `structured_output` on reviews | intentionally different | A print-timeout partial is not returned as an answer (exit 1) |
| `usageDelta` against the previous run's cumulative usage | `usage`: this turn's step sums, with `usage.conversation` from `result.usage` | intentionally different | No cross-run lookup needed |
| artifacts `before.json`, `after.json`, `result.json`, `answer.md`, `stderr.log`, `native-settings.json` | `snapshot-before.json`, `snapshot-after.json`, `events.jsonl`, `answer.md`, `settings.json`, `meta.json` | renamed | stderr keeps only a 4 KiB tail in memory for the host-denial check |

## Limits

| AGYX | Council | Status |
|---|---|---|
| frame 4 MiB, partial answer 4 MiB | `maxLineBytes` 4 MiB, partial 4 MiB | same |
| total native stdout 8 MiB, stderr 4 MiB | no total stdout cap (events are spooled to disk); stderr tail 4 KiB | intentionally different |
| snapshots: 500 changed files, 4 MiB captured, 2.5 s per git call | 5,000 changed files, otherwise the same bounds; moved to `core/snapshot.mjs`; a file past the byte budget compares by size, mtime and mode; the executable bit is compared; `--no-renames`; a listing with a non-UTF-8 name or past the cap gives no edited paths | intentionally different | S7.1: every task now uses them, whatever the provider |
| input 2 MiB | the core's input limits (A3.1) | intentionally different |

## Caveats carried over

- Web search cannot be denied on read-only turns (S1.2); `--web` exits 2 for Gemini and `setup` prints the trade-off.
- A task without `--allow-command` runs under the user's global `toolPermission`; under `always-proceed` it can run any command. `setup` warns when the global value is `always-proceed`.
- Project-specific agy policies and alternate settings locations are not merged (only the global file is read), as in AGYX.
- Local cleanup covers observed local processes only; remote backend work is not cancelled by stopping agy.
- agy's language server was not observed on 1.4.12 (S1.2); the group stop covers it when present.
- Gemini on Windows is checked (`docs/qualification/windows.md`).

## Efficient command defaults (1.1.7)

Read-only calls add the finite `READ_ONLY_COMMANDS` inspection prefixes. Requested tasks add `command(*)`. Both preserve configured ask/deny rules and strict mode. This supersedes earlier blanket command-denial policy; these are good-faith workflow defaults, not shell containment.
