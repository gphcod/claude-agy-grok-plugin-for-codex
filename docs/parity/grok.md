# Parity record: grok_plugin_for_codex 1.1.0 → council (`--to grok`)

S4.7. Source: GROKX `/Users/cia/GitCode/grok_plugin_for_codex` at `v1.1.0` (`148bc55`): `plugins/grok/scripts/grok.mjs` and `lib/` (`args`, `recipes`, `reader`, `review`, `setup`, `output`, `launcher`, `lifecycle`, `execution`), `skills/grok/SKILL.md`, `README.md`. Target: `plugins/council` on branch `s4-grok` (`providers/grok.mjs` over the shared core). Status words: **same** (same behaviour, same spelling), **renamed** (same behaviour, other spelling), **intentionally different** (a deliberate change, with its reason and decision), **missing** (none at the gate).

## Verbs and flags

| GROKX | council | Status | Notes |
|---|---|---|---|
| `ask [-- text]` | `ask --to grok [-- text]` | renamed | `--to` is required (A3.3). New read-only session on the explore recipe; the advice template (`prompts/advice.md`) now travels in the prompt file before the text (decisions "S4") |
| `reply <job or session> [-- delta]` | `reply <job\|thread> [-- delta]`, `reply --thread <id>` | renamed | the positional and `--thread` are aliases; the session is resumed with `-r` in its recorded cwd |
| `reply` with a bare UUID council has never seen | — | intentionally different | GROKX resumed any UUID; council resumes only threads it recorded, since A7.3 forbids adopting a native thread across workspaces (decisions S2.6) |
| `reply --last` | `reply --last` | same | newest confirmed thread of this `CODEX_THREAD_ID` and realpath(cwd); an exact timestamp tie exits 2 (S2.8 F14) |
| `reply <job> --next-input` | `reply <job> --next-input` | same | next saved batch, then the synthesis pass; spends no round; takes no text (exit 2) |
| `review [-- focus]` | `review --to grok [--uncommitted] [-- focus]` | same | uncommitted changes, snapshot hashed, explore recipe, schema inline, no `--rules` |
| `review` on a clean tree falls back to the branch against the default branch (`master`/`trunk` discovery) | — | intentionally different | A5.2: bare `review` never falls back; a clean tree exits 2 `nothing to review`; use `--base <ref>` |
| `review --base <ref>` (`<oid>...HEAD`) | `review --base <ref>` | intentionally different | merge base with HEAD, the working tree and untracked files (A5.2), the same rule for all providers |
| — | `review --commit <sha>`, `review --adversarial` | intentionally different | added (A3.2): one commit (first parent for merges); the adversarial template |
| review run from a subdirectory | exit 2 before any job, naming the root and `--cwd <root>` | intentionally different | a Grok session works only in its cwd (`--add-dir` refused, S1.3); GROKX collected from the root but ran Grok in the subdirectory (decisions "S4") |
| `rescue [--thread id] [-- text]` | `task --to grok [--thread <id>] [-- text]` | renamed | write recipe (default agent, `--deny "Bash(git push*)"`, `--deny "Bash(rm -rf *)"`, Claude rules files on), `exec` tier by default, `prompts/task.md` in the prompt file; only when the user authorizes it (A3.5) |
| later read-only turn on a session that ran the default agent | same | same | RESUME_DENY recipe instead of explore; the thread record keeps `agent` (A7.6) |
| `wait [job] [--timeout s]` | `wait [job] [--timeout <s>]` | same | default 90 s; returns 20 without stopping anything; bare `wait` lists this session's jobs |
| `cancel [job] [--timeout s]` | `cancel [job] [--timeout <s>]` | same | stops the owned processes found by the exact `--prompt-file` operand, confirms cleanup; default 30 s |
| — | `cancel <job> --confirm-ended` **[user]** | intentionally different | added: releases a held-output lock only when the process table shows no owned process (A7.8) |
| `setup` | `setup [--to grok]` | same | binary, launcher kind, version, login, tiers, preflight, warnings: a tier model `grok models` does not list (GROKX setup.mjs:39-41), several grok executables on PATH without `COUNCIL_GROK_BIN`, not logged in |
| `setup` exits 1 when Grok is not ready | `setup` exits 0 and prints warnings, `preflight_blocked` with its action line | intentionally different | the core's `setup` reports every provider and never fails the call (S2.6); a turn verb fails with exit 1 `preflight_blocked` instead |
| — | `models [--to grok] [--refresh]`, `setup --live` | intentionally different | added (A3.2): the catalog and its refresh from `grok models`; one paid minimal ask per provider |
| `--tier consult\|exec\|deep` | `--tier consult\|exec\|deep` | same | grok-4.7/high, grok-4.7-build-fast/xhigh, grok-4.7/xhigh (A2, unchanged) |
| `--model <id>` | `--model <id\|alias>` | same | aliases `4.7`, `4.6`, `build-fast`; an unknown id passes through with `model unverified` |
| `--effort <e>` | `--effort low\|medium\|high\|xhigh\|max` | intentionally different | one vocabulary for all providers; `max` is clamped down to `xhigh` before launch and the footer says `grok-4.7/xhigh<=max` (A3.3); GROKX passed `max` to Grok, which refused it |
| `--web` | `--web` | same | omits `--disable-web-search`; persisted on the thread |
| `--rounds <n>`, `GROK_CODEX_ROUNDS` | `--rounds <n>`, `COUNCIL_CODEX_ROUNDS` | renamed | default 9; a budget set with `--rounds` is kept by the thread |
| `--request-id <id>` | `--request-id <id>` | same | a repeat replays the first result and starts no Grok process; changed input exits 2 |
| `--prompt-file <f>` | `--prompt-file <f>` | same | UTF-8, BOM dropped, the only text source when given |
| `--deadline`, `--inactivity-timeout`, `--timeout` | same | same | 14,400 s, 1,200 s, 90 s defaults (GROKX values) |
| `--json` | `--json` | intentionally different | still one JSON object, but with A3.4's key set: renamed and added fields, and `session` now means the host session, not Grok's (Output, below) |
| `--thread` on `rescue` | `--thread` on `task` | renamed | resumes the recorded session with the write recipe |
| stdin idle 10 s | stdin deadline 10 s | same | `COUNCIL_STDIN_DEADLINE_MS` in tests |

## Launch (A5.1)

| GROKX | council | Status | Notes |
|---|---|---|---|
| `--prompt-file <job>/prompt.md --output-format streaming-json --model --effort --no-auto-update` | same | same | |
| `--cwd <cwd>` | — (the child is spawned in the thread's cwd) | intentionally different | A5.1's argv has no `--cwd`; the lifecycle sets the process cwd, which Grok uses as the session folder |
| `recipe()` explore / RESUME_DENY / write | ported whole | same | `providers/grok.mjs` `recipe` |
| `compatEnv()` | ported whole | same | plus `GROK_BUILD_DEPTH` and `COUNCIL_DEPTH`; the core adds all five guard variables (A5.1) |
| `--rules "<contract on one line>"` | `--rules "<contract.md on one line>"` | same | text, not a path (decisions "S4"); contract.md is GROKX's contract with the provider-neutral tag (S2.5) |
| `--json-schema '<inline schema>'` on reviews and `--next-input` | same, also on a discussion reply on a review thread | intentionally different | the schema is council's unified draft-07 schema with required finding `id` and optional `decision` (A5.2); discussion replies are structured turns (S2.8 F9) |
| `--session-id <uuid>` new, `-r <id>` resume | same | same | the uuid is claimed before spawn |
| text with edge whitespace framed `<r-job>` | same | same | only the user's text; structured prompts unframed |
| `GROK_BINARY`, then PATH, then `~/.grok/bin/grok.exe` (Windows) | `COUNCIL_GROK_BIN`, then PATH, then `~/.grok/bin/grok.exe` | renamed | a `.cmd` shim runs its JavaScript entry through node, never cmd.exe (core launcher) |

## Events (GROKX reader → `parseEvent`)

| GROKX | council | Status | Notes |
|---|---|---|---|
| catalogue (`available_commands.tools`) against FORBIDDEN on read-only turns | same | same | fails closed; a turn whose mode is unknown is treated as read-only (core seam `state.adapter`) |
| a tool call or `end` before the catalogue was validated | same | same | fatal on read-only turns |
| forbidden or MCP (`server__tool`) call on a read-only turn | same | same | |
| edit paths from `search_replace`/`write` `tool_call_update` completions | same | same | footer `edited N` on tasks; a read-only review that edits is `incomplete` (core) |
| `end.sessionId` differing from the requested session | same | same | the core reader fails the turn |
| `end` without a session: answer kept, footer `session not confirmed; start a new ask` | answer and exit code kept, footer `session not confirmed: start a new ask`; `reply <job>`, `reply --last`, `task --thread` and the native id exit 2 with the hint; a resumed thread's record is marked `resumable: false` | renamed | review Q3 ruling (decisions S4.8, core `unconfirmed`) |
| stop reason other than `end_turn` fails; `cancelled` explained | `cancelled` (Grok's headless permission refusal) is a denial, exit 10, the answer kept or the refusal named; any other stop keeps the answer, structured output, usage and cost and fails with exit 1 `incomplete: Grok stopped with reason …` | intentionally different | review ruling (decisions S4.8); council's own `cancel` stops Grok by signal (no `end` event) and is unchanged |
| `max_turns_reached` | fails with `incomplete: Grok stopped: max turns reached`; the streamed text stays the answer | same | |
| `error` event recorded, failure only without `end` | same | same | message from Grok's stderr line |
| `total_cost_usd`, `usage` | `costUsd`, `usage` in `--json` | same | |
| `structuredOutput` | `structured`, else the complete answer parsed | same | `finalizeReview` prefers whichever passes the shared validator |
| — | `thought` events ignored; `end.modelUsage` (`grok-4.7-build`) never reported as the model | intentionally different | new in Grok 1.0.70 (S1.3); the footer keeps the requested id |
| JSONL line cap 1 MiB | `maxLineBytes` 1 MiB | same | |

## Output

| GROKX | council | Status | Notes |
|---|---|---|---|
| start line `[grok] job=… session=… [target=…]` on stdout | `[council] provider=grok job=… [target=…]` on stderr | renamed | A3.4, compact since 1.1.0; native session stays in state/JSON/`wait` |
| footer `-- grok <status>` | `council grok <ok\|needs attention\|failed\|cancelled>` | renamed | |
| `job <id>` | `job <16 chars>` | same | |
| `<model>@<effort>` | `<model>/<effort>[<=requested]` | renamed | the clamp is shown (A3.3) |
| elapsed | elapsed | same | |
| `$<cost>` | `--json` `costUsd` | intentionally different | cost leaves the footer (A3.4) |
| `edited N` (rescue) | `edited N` (task) | same | |
| `unreviewed N` | `unreviewed N` | same | counts unsupported input; pending saved batches are coverage, not unreviewed (S2.6) |
| `review <ref> · coverage <status> · pending N` | `batch i/n` in the footer, `coverage` in `--json` | intentionally different | A3.4 footer grammar |
| `prior blocking findings` | the answer's "Earlier review responses reported blocking findings that remain open: …" and `coverage.blocking` | intentionally different | identified ledger (A5.2) |
| `round N/M` on replies | `round N/M` on ask, reply, task | intentionally different | A3.4: threaded verbs print it; ask and a fresh task print `1/M` |
| `full: <file>` (24 KiB preview) | same | same | |
| `error: <msg>` | same | same | |
| — | `attention: <reason>` in the same slot on exit 10 (not on plain findings) | intentionally different | S7.1: a denial, an incomplete turn or open questions were invisible outside `meta.json` |
| `cleanup pending; next: cancel <job>; do not resume` | same | same | plus `thread locked; next: cancel <job> --confirm-ended …` (A7.8) |
| `next: reply <job>[ --next-input]` | `next: reply <job> --next-input` only while batches are pending | intentionally different | A3.4 hints only recovery and continuation |
| `--json` `session`, `requestedSession`, `aggregateVerdict`, `reviewRef`, `snapshotId`, `unreviewed` | `thread`, `requestedThread`, `session` (host session), `verdict`, `findings`, `coverage{…}`, `batch`, `modelVerified`, `requestedEffort`, `round`, `rounds`, `failedCommands`, `threadLocked` | intentionally different | A3.4 key set; `session` changes meaning (Grok's session id is `thread`) |
| exit codes 0/10/20/1/2 | same | same | malformed or missing review output is 10 `incomplete` (GROKX 1) — core decision S2.5 |

## Review input

| GROKX | council | Status | Notes |
|---|---|---|---|
| `review-input.mjs` snapshot, index, `--next-input`, synthesis | the same file, byte-identical (core) | same | |
| 256 KiB of indexed text inline per batch | 180,000 B per batch | intentionally different | A5.2; the S1.3 552 KB probe needed 2 batches under GROKX and needs more under council |
| verdict per batch, blocking batch keeps the review in attention | same, plus the identified findings ledger (`u1-F1`, `REJECT` by id resolves) | intentionally different | CLAUDEX ledger ported to the core (A5.2); tests/grok.test.mjs exercises it through fake-grok |
| `reviewPrompt` | `prompts/review.md` / `adversarial-review.md` via `buildBatchReviewPrompt` | intentionally different | provider-neutral templates (S2.5) |

## Safety, state and caveats

| GROKX | council | Status | Notes |
|---|---|---|---|
| read-only explore agent, FORBIDDEN guard, `--deny MCPTool(*)`, MCP calls fail | same | same | |
| Claude skills/agents/hooks/MCP off, rules off on read-only, no auto-update | same | same | `compatEnv` |
| nested call refused (`GROK_CODEX_DEPTH`) | refused when any of five guard variables is set | intentionally different | A5.1: covers council and all five donor plugins |
| cleanup by the exact `--prompt-file` operand; `cleanup pending` blocks the session | same | same | `ownsProcess` + core lifecycle; `trustsCleanExit` false for every launcher |
| Windows process scan (PowerShell, CLM, CimCmdlets) | core `execution.mjs` (ported) | same | Windows qualification is S7 |
| `workspace-write` sandbox on Windows: Grok "Not signed in" and `cleanup pending` | preflight: the login file `~/.grok/auth.json` (unless `GROK_API_KEY`), the state root and the process table are checked first; a blocked one exits 1 `preflight_blocked` with its action line and zero submissions | intentionally different | A2, A5.1; the installed-route cell is S7 |
| state `~/.grok/codex-plugin/state/v5` (`GROK_CODEX_PLUGIN_STATE`) | `~/.codex/council` (`COUNCIL_CODEX_HOME`) | renamed | no migration; S8 drains donor jobs |
| `CODEX_THREAD_ID` scopes `--last`, `wait`, `cancel` | same | same | |
| per-turn instructions | advice / task / review templates in the prompt file | intentionally different | contract.md: instructions arrive with the input (decisions "S4") |

No row is missing.
