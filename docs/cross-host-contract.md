# Cross-host contract

Frozen at S2.7 (2026-10-31), amended at S2.8 (review fixes; see docs/decisions.md). Council for Codex (this repository) and Council for Claude Code (the twin, github.com/gphcod/codex-agy-grok-plugin-for-claude, plan read at commit e89c98e) decide the same things in the same words by design (PLAN.md §0 rule 7). The first table lists the shared contracts and where each is implemented here; the second lists every labelled host difference. A change to a shared contract is made in both plans, or recorded here as a host difference, before either side commits it.

## Shared contracts

| Contract | Wording (both plans) | Here |
|---|---|---|
| Verbs | `ask`, `reply`, `review`, `task`, `wait`, `cancel`, `models`, `setup`; `reply <job\|thread>` and `reply --thread <job\|thread>` are aliases; `--last` picks this cwd's and this session's latest confirmed thread | core/args.mjs, council.mjs `resolveThread` |
| Provider lock | the provider is inherited and locked on `reply`; a conflicting `--to` exits 2; a bare native id matching more than one provider exits 2 and needs `--to`; a job id determines its provider | council.mjs, core/jobs.mjs `findJob` |
| Inheritance and explicit tier | model and effort are inherited unless `--model`, `--effort` or `--tier` is given explicitly; the explicit value wins for that turn and is persisted; an explicit `--tier` overrides the inherited settings | council.mjs `resolveSettings` |
| Effort edges | one vocabulary `low\|medium\|high\|xhigh\|max`; council clamps downward only, to the greatest offered effort at or below the request, or the lowest offered when the request is below all; the clamp shows as `<model>/<effort><=<requested>` and as `effort`/`requestedEffort` in `--json`; an effort-suffixed Gemini id is an explicit effort and only an argv `--effort` can conflict with it (exit 2); an unknown model passes through unclamped with `model unverified` | core/catalog.mjs, core/output.mjs |
| Round accounting | `round N/M` on threaded verbs: a new thread prints `1/M`, a reply or `task --thread` the incremented round, `--next-input` spends none; the budget is 9 unless `--rounds` or the host's rounds variable sets it, and only a budget set with `--rounds` is inherited | council.mjs `planTurn`, core/output.mjs |
| Footer | one stdout line `council <provider> <ok\|needs attention\|failed\|cancelled> · job <16 chars> · <model>/<effort>[<=requested] · <duration>[ · round N/M][ · edited N][ · unreviewed N][ · model unverified][ · full: <file>][ · error: <msg>][ · <recovery hint>]`; this host adds ` · batch i/n` (host differences) | core/output.mjs `footer` |
| Start line | stderr, suppressed under `--json`: `[council] provider=<p> job=<id> thread=<native id\|?>[ target=<review target>]` | core/output.mjs `startLine` |
| `--json` | `provider, job, thread, session, model, modelVerified, effort, requestedEffort, tier, round, rounds, verdict, findings, coverage, edited, failedCommands, costUsd, exit, answerFile` (and the answer, preview cap 24 KiB); this host adds `batch` (host differences) | core/output.mjs `resultJson` |
| Exit codes | 0 done, 10 needs attention, 20 still running, 1 failed/cancelled/busy/blocked, 2 invalid input | core/types.mjs `EXIT` |
| Request ids | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; one provider-neutral reservation keyed by host session, realpath(cwd) and the request id, created exclusively before any provider is resolved, then bound to the provider and job; a replay starts no provider process; changed input under the same id exits 2; `--json`, `--timeout`, `--deadline` and `--inactivity-timeout` are not part of the fingerprint; the job id is 16 characters derived from provider, host session, realpath(cwd) and the request id | core/jobs.mjs, council.mjs `replay` |
| State layout | `jobs/`, `claims/<provider>/<threadId>`, `threads/<provider>-<threadId>.json`, `catalog/`, `trash/`, and a request store (its path is a host difference); records carry `provider`, `session`, `threadId`; pruning keeps the newest 100 finished bodies and never a running, lost, cleanup-pending or claim-holding job | core/jobs.mjs, core/claims.mjs |
| Adapter shape | `id, binEnv, resolveLauncher, trustsCleanExit, ownsProcess, maxLineBytes, probe(launcher, env), catalog, buildTurn(request with env and launcher), parseEvent, reviewPlan, finalizeReview`, plus the optional `checkRequest(request, env)` (a refusal exits 2 before any job record), `beforeTurn(ctx)` and `afterTurn(ctx, outcome)`, each hook called once, `afterTurn` only after verified cleanup (deferred to the confirming `cancel`); ParsedEvent may carry `model`, ProbeResult `warnings[]` | core/types.mjs, core/lifecycle.mjs |
| Process ownership (S2.8) | text-only process rows need the adapter's evidence and the complete recorded invocation (recorded launcher or the provider's native binary); the leader's identity is recorded right after spawn; groups are followed only under a live owned leader; any other group member is adopted only by an identity persisted at spawn, a heartbeat or a stop/exit snapshot, others are unverified (unknown) unless the group id was provably reused; a program path with spaces that cannot be resolved is unknown; a missing provider module makes ownership unknown (no stop, no release) | core/execution.mjs, core/lifecycle.mjs |
| Fan-out | no coordinating process in 1.0; one call per provider, each with its own request id; follow-ups use `reply <job>`, never `--last` | skill (S6.1) |

## Host differences

| Difference | Council for Codex | Council for Claude Code |
|---|---|---|
| Providers | claude, gemini (agy), grok | codex, gemini (agy), grok |
| Host session variable | `CODEX_THREAD_ID` | the Claude Code session id |
| State root | `COUNCIL_CODEX_HOME`, default `~/.codex/council` | `COUNCIL_HOME`, default `~/.council` |
| Rounds variable | `COUNCIL_CODEX_ROUNDS` | the twin's own |
| Guard variables | five on every child: `COUNCIL_DEPTH`, `CLAUDE_PLUGIN_CODEX_DEPTH`, `GROK_CODEX_DEPTH`, `GROK_BUILD_DEPTH`, `AGY_BRIDGE_DEPTH` | four (A5.1 of the twin) |
| Blocking rule | Codex has no background tasks: one shell call per exchange blocks until the model answers; `wait <job>` only after a lost shell handle | background tasks and slash commands |
| Call forms | POSIX heredoc and PowerShell here-string ending `; exit $LASTEXITCODE`; `--prompt-file` for text over 64 KiB, or in PowerShell over 16 KiB or non-ASCII | slash commands with `splitLeading` on heredoc text |
| Preflight | the companion runs inside Codex's sandbox; the adapter's `preflight(ctx)` descriptors run before any submission; a blocked resource exits 1 `preflight_blocked` with its action line | none |
| Review input | every provider receives a hash-checked snapshot in batches of at most 180,000 bytes, continued with `reply --next-input`, with an identified findings ledger | codex reviews natively (`exec review`); batching only where needed |
| Review schema and result | one draft-07 schema with required finding `id` and optional `decision`; the normalized result carries `id`, `decision` and `coverage.pending` | the twin's schema without `id`/`decision` |
| Adapter interface | adds `preflight`, a collected-only `reviewPlan` (`native: false`) and a `finalizeReview` that takes the batch and the ledger | `reviewPlan` may be native |
| Held output | a lock nothing can observe is released only by `cancel <job> --confirm-ended` after the process table shows no owned process | no `--confirm-ended` |
| Claude provider | the Claude CLI is a provider here (native-only launcher on Windows, `--system-prompt-snapshot`, per-turn instructions in the input) | Claude is the host |
| Request store | `requests/<key>.json` | `claims/requests/` |
| Batched reviews | footer ` · batch i/n`, `--json` `batch` | no batch token or field |
