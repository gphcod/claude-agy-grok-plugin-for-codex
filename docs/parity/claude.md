# Parity record: claude_plugin_for_codex 0.5.0 → council (`--to claude`)

S3.6. Source: CLAUDEX `/Users/cia/GitCode/claude_plugin_for_codex` at `v0.5.0` (`be9fe54`), its `claude-companion.mjs` help and parser, `skills/claude/SKILL.md`, `README.md`, `docs/WINDOWS_LOCKED_SESSIONS.md`, `references/testing.md`. Target: `plugins/council` on branch `s3-claude`. Status words: **same** (same behaviour, same spelling), **renamed** (same behaviour, other spelling), **intentionally different** (a deliberate change, with its reason and decision), **missing** (none at the gate).

## Verbs and flags

| CLAUDEX | council | Status | Notes |
|---|---|---|---|
| `ask [prompt]` | `ask --to claude [-- text]` | renamed | `--to` is required (A3.3); read-only advice turn, `prompts/advice.md` (from CLAUDEX `profiles/advice.txt`) travels in the input |
| `ask --task` (read-only task profile, `profiles/task.txt`) | `task --to claude` | intentionally different | council's `task` may edit the working tree under the S1.1 launch (`acceptEdits`, eight tools, four Bash deny rules) and is started only when the user authorizes it (A3.2, A3.5); CLAUDEX's `--task` stayed read-only. `prompts/task.md` replaces `profiles/task.txt` (PLAN.md S3 "Not ported") |
| `ask --profile architecture\|verification\|consensus` | — | intentionally different | dropped: PLAN.md A1 "Not in 1.0: Claude `--profile` variants beyond advice/review/adversarial/task" |
| `review [focus]` (uncommitted) | `review --to claude [--uncommitted] [-- focus]` | same | bare `review` reviews uncommitted changes, reads no stdin without `--` (A3.1); snapshot, batches of ≤ 180,000 B and coverage from CLAUDEX's `review-input.mjs`, byte-identical |
| `review --base <ref>` | `review --base <ref>` | same | merge base with HEAD plus untracked files (A5.2) |
| — | `review --commit <sha>` | intentionally different | added: one commit, first-parent for merges (A5.2) |
| `review --adversarial` | `review --adversarial` | same | `prompts/adversarial-review.md` from CLAUDEX `profiles/adversarial.txt` |
| `review --with-context` (`review-context`, `adversarial-context` profiles) | — | intentionally different | dropped (PLAN.md S3.6): every review runs with the read tools `Read,Glob,Grep` and a two-turn cap (A3.3), so the separate context profile has no role; CLAUDEX's plain review ran with no tools |
| review output schema (CLAUDEX `review-output.schema.json`) | `schemas/review-output.schema.json` | intentionally different | one draft-07 schema for all providers with required finding `id` and optional `decision` (A5.2); still passed by `--json-schema`, answer from `structured_output` |
| `reply <handle> [delta]` | `reply <job\|thread> [-- delta]`, `reply --thread <id>` | renamed | handle is the 16-character job id (A3.3); the session uuid also works, as in CLAUDEX |
| `reply --last` | `reply --last` | same | scoped by realpath(cwd) and `CODEX_THREAD_ID` (A7.2) |
| `reply <handle> --next-input` | `reply <job> --next-input` | same | next saved batch, then synthesis; spends no round; takes no text (exit 2) |
| findings ledger (`review-findings.mjs`) | `core/findings.mjs` | same | identified `REJECT` resolves a finding; an early blocker survives a clean synthesis (tests/claude-entry.test.mjs) |
| `fork <handle> [prompt]` | — | intentionally different | dropped (A1, PLAN.md S3.6) |
| `wait <handle> [--wait-ms 25000]` | `wait [job] [--timeout <s>]` | renamed | seconds instead of milliseconds, default 90 s (GROKX); bare `wait` lists this session's jobs |
| `cancel <handle>` | `cancel [job]` | same | stops the owned process group, verifies cleanup; bare `cancel` takes this session's newest job needing cleanup |
| held-output lock: delete the named lock file by hand | `cancel <job> --confirm-ended` **[user]** | intentionally different | releases only when the process table shows no owner companion and no owned process (A7.8); no file is deleted by hand |
| `setup` | `setup [--to claude]` | same | binary, launcher kind, version, login, tiers, preflight, warnings (untested Claude version) |
| `setup --live` | `setup --live` | same | one minimal paid `ask` per provider |
| `setup --set <policy.json>` | `setup --set <policy.json>` | same | read roots → `--add-dir`, `web` → the web pair, `allowMcp` → no empty MCP config (S3.2) |
| `--model <alias/id>` | `--model <alias/id>` | same | aliases `fable`, `opus`, `sonnet`, `haiku`, `default`; unknown ids pass through (`model unverified`); `default` omits `--model` |
| `--effort <level>` (default `xhigh`) | `--effort <level>`, `--tier consult\|exec\|deep` | intentionally different | default from the tier (`consult` default/high, `exec` sonnet/high, `deep` default/xhigh, A2); the vocabulary is checked by council because the CLI ignores an unknown value (S1.1) |
| `--max-turns <n>` | `--max-turns <n>` | same | Claude-only; defaults by verb: review 2, ask/reply 20, task 30 (A3.3) |
| `--max-budget-usd <amount>` | `--max-budget-usd <amount>` | same | Claude-only |
| `--deadline-ms <ms>` | `--deadline <s>`, `--inactivity-timeout <s>` | renamed | seconds; inactivity timeout added (GROKX) |
| `--rounds <n>` | `--rounds <n>`, `COUNCIL_CODEX_ROUNDS` | same | 9 replies by default |
| `--request-id <id>` | `--request-id <id>` | same | replays without a second Claude launch; changed input under the same id exits 2 |
| `--json` | `--json` | intentionally different | council's A3.4 keys (`provider`, `job`, `thread`, `model`, `modelVerified`, `effort`, `costUsd`, `edited`, `coverage`, …) instead of CLAUDEX's envelope |
| `--cwd <directory>` | `--cwd <directory>` | same | |
| `--prompt-file <path>` | `--prompt-file <path>` | same | UTF-8; BOM and CRLF handled (S2.2) |
| `CLAUDE_COMPANION_EXECUTABLE` | `COUNCIL_CLAUDE_BIN` | renamed | same rule: PATH must give the native executable; a configured `.js/.mjs/.cjs` entry is allowed (A2) |
| `CLAUDE_COMPANION_STATE_ROOT` | `COUNCIL_CODEX_HOME` | renamed | state root `~/.codex/council` (A7.1) |
| `CLAUDE_COMPANION_TIMINGS` (phase timings incl. one `fsync` per durable write) | — | intentionally different | not ported: council measures framing bytes in `npm run measure` (S6.5); per-phase timing is out of scope for 1.0 |

## Launch and turn

| CLAUDEX | council | Status | Notes |
|---|---|---|---|
| `-p --input-format stream-json --output-format stream-json --verbose`, `--session-id`/`--resume` | same | same | `runtime.mjs:72-96`; `--fork-session` dropped with `fork` |
| `--system-prompt-snapshot on --append-system-prompt-file <profile>` | `… --append-system-prompt-file contract.md` | intentionally different | the system prompt is the mode-neutral standing contract on every launch; the per-verb instructions travel in the input because the snapshot keeps the first system prompt across resumes (S1.1, A5.1) |
| `--permission-mode dontAsk --permission-prompts none --setting-sources user --no-chrome`, hooks off, empty strict MCP | same on read-only turns | same | tasks use `acceptEdits` (above); hooks and MCP stay off on tasks |
| `--tools Read,Glob,Grep` (advice), `''` (review) | `Read,Glob,Grep` on every read-only turn | intentionally different | reviews may read the repository (see `--with-context`) |
| `--include-hook-events` when supported | — | intentionally different | hooks are disabled on every launch, so the stream carries no hook events |
| stdin `requestLine`, 8,000,000-byte cap | same | same | |
| interrupt `control_request` on cancel, then a kill after 3 s | SIGTERM to the group, SIGKILL after 3 s (A7.5) | intentionally different | the core's provider-neutral stop path; the live cancel took 882 ms (docs/qualification/claude-macos.md) |
| answer from `result.result` / validated `structured_output` | same | same | assistant text is never the answer (S3.3) |
| init and result `session_id` equal the assigned uuid; duplicate, missing, malformed result; `is_error`; non-success subtype → failure | same | same | exit 1 (S3.3, tests/claude-entry.test.mjs) |
| `permission_denied` events merged with `result.permission_denials` | same, plus the read-only tool-absent pattern | same | exit 10; an edit tool that errors on a read-only turn is a denial (S1.1 ruling Q1) |
| init `model` | footer and `--json` `model` when `default` was requested | same | CLAUDEX recorded it in the envelope; council prints it in the footer |
| `system/api_retry` category, `authentication_failed` invalidates the preflight cache | retries counted in `usage.retries` | intentionally different | a failed run does not invalidate the cold preflight cache; `setup` re-probes fresh |

## Footer, hints, exit codes

| CLAUDEX | council | Status | Notes |
|---|---|---|---|
| `[claude] k3f9 done 38s next: reply k3f9` | `council claude ok · job <16> · <model>/<effort> · <duration> · round N/M …` | intentionally different | A3.4 grammar shared by all providers; the model and effort actually used are always printed |
| `next:` hints | recovery hints (`next: reply <job> --next-input`, `cleanup pending; next: cancel <job>`, `thread locked; next: cancel <job> --confirm-ended …`) | renamed | |
| `action:` lines | `action:` line on `preflight_blocked`; recovery hints in the footer | renamed | hints never grant permission, as in CLAUDEX |
| exit 0/10/20/1/2 | 0/10/20/1/2 | same | invalid or missing review output is 10 `incomplete` in council (CLAUDEX: 1; decisions S2.5) |
| `preflight_blocked` with a one-line action | same | same | descriptors: state root, Claude storage, four cold probes, network (S3.1) |

## Caveats

| CLAUDEX caveat | council | Status | Notes |
|---|---|---|---|
| held-output lock (a process Claude started keeps its output open): manual lock-file deletion | `thread locked` after 12 s, released only by `cancel --confirm-ended` **[user]** | intentionally different | A7.8 |
| Windows: a finished turn sometimes keeps its session locked (`docs/WINDOWS_LOCKED_SESSIONS.md`, node-script launchers; native `claude.exe` trusted) | `trustsCleanExit` false for every launcher until S7 qualifies one; a lock is cleared by `cancel` | intentionally different | the same symptom is possible on Windows (post-exit scan); qualification in S7.2 decides which launcher kind is trusted |
| `fsync` cost per durable write (`references/testing.md`) | `writeFileAtomic` per record; `fsync` only in the review-input snapshot | intentionally different | council does not fsync job records; S6.5 measures the per-call cost |
| a new policy needs a new conversation | the policy in force applies to every launch, resumes included; the thread record keeps the version it last ran under | intentionally different | council enforces the current verb's and policy's permissions on every launch (A5.1), so a resume never keeps a wider policy than the stored one |
| denials need user approval, not a retry | exit 10 `needs attention` | same | the skill (S6.1) carries the rule |

No row is **missing**.
