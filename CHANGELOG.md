# Changelog

## 1.1.2 (2026-11-02 Pacific)

- Publish request binding and preparation as complete immutable stage files instead of overwriting an opened Windows reservation. Keep the provider-neutral claim, job IDs, fingerprints and exactly-once replay.
- Read legacy inline requests; mark new-format roots as unsupported tombstones for older clients so a downgrade cannot mistake completed work for abandoned preparation. Reject damaged stage records without launching a provider.
- Add real Windows held-file tests and generation/immutability regressions. Stage files increase metadata file count; healthy framing and provider prompts are unchanged.

## 1.1.1 (2026-11-02 Pacific)

- Classify native Gemini `UNAVAILABLE (code 503)` as a temporary service failure, retaining usage and the original failed job.
- Add structured `retry` metadata and a clear footer hint. Host guidance permits one fresh read-only call after 2 seconds only without visible partial output/tool activity, recorded edits or uncertain cleanup. No automatic task retry or internal provider relaunch; same-id replay still returns the original failure.
- Save partial Gemini streams as a separate unfinished draft with a recovery pointer; never approve a failed turn or let a preceding denial mask a 503. A draft-save error keeps the native failure.
- Test the recorded failure, ask/reply/review replay and fresh-id recovery, permanent errors, partial/STARTED-tool gates, cleanup, thread/mutation uncertainty, task exclusions and draft persistence. The service classifier is shared byte-for-byte with the Claude-hosted plugin.

## 1.1.0 (2026-11-02)

- Explicit bounded yield guidance covers nested exec/wait wrappers as well as shell collection. Fifteen host probes compare collection counts and cached host input with both the prior guidance and claude_plugin_for_codex 0.4.2; all calls are collected without resubmission. The final skill is 2,963 B.

- Compact startup metadata retains provider and recovery job, omits the repeated native thread UUID and announces Gemini jobs before their first event. The stdout footer and native ids in state/JSON remain available.
- Shorter advice/review/task templates remove provenance and repeated instructions. Advice and task turns retain the standing contract; Grok structured turns retain their existing schema-based recipe. Per-launch permissions are unchanged. The skill description is 128 B, down from 168 B; Gemini now follows the same ask-before-higher-effort rule as its medium consultation default.
- Split the companion into CLI dispatch, planning, shared configuration and catalog/setup modules. Reuse speculative reply resolution while always refreshing history under admission.
- Warm sandbox checks no longer rewrite unchanged probe caches. Replay waiters query the reservation owner's pid; cleanup and process preflight still enumerate the full table.
- Claude now refuses unavailable process-table access before starting billable work. Its added Windows query costs about 0.7 s per fake call in the matched run; no general latency improvement is claimed. JSON results add provider-native usage alongside the existing `costUsd`; the benchmark reads that cost from the durable `cost` field.
- Add an interleaved offline benchmark with identical pinned fakes, default models, 100 retained jobs, provider-input/framing bytes, first-handle timing, wall-time quantiles and process/fsync counts.

## 1.0.0 (2026-11-02)

First release of Council for Codex: one Codex plugin, `council`, that calls Claude Code (`claude` 2.1.314), Gemini (`agy` 1.4.12) and Grok (`grok` 1.0.70). It replaces claude_plugin_for_codex 0.5.0, grok_plugin_for_codex 1.1.0 and gemini-plugin-for-codex 0.1.2.

### Release review fixes (2026-11-02)

- Default consultation models are explicitly Claude Opus 5.5/high, Grok 4.7/high and Gemini 4 Argon/medium.
- Help exits before reading input or starting a paid turn; unknown single-dash flags are rejected.
- New turns reject a changed conversation id instead of completing under another thread's claim.
- Claude reviews allow 20 turns for context reads; Claude and Gemini receive the repository root and saved-input read scope on every review and discussion turn.
- Single-batch finding decisions resolve short ids by unique location, and throwing review finalizers finish as recoverable failures.
- Pruning preserves snapshots referenced by retained discussions and retires obsolete pending batch state.
- Model refresh and live setup support partial CLI installations; live setup emits one JSON document and failures take precedence over attention.
- Metadata reads retry Windows locks and fail closed on existing corrupt records; claim release retries locks, preserves ownership evidence, and keeps an already published provider result consistent with replay.
- Corrupt unrelated metadata leaves new work usable: pruning skips an unreadable state inventory, and errors identify the affected record and recovery options.
- A resumed task records Grok's default agent before launch, and pending review continuation no longer hides unknown task mutation coverage.
- Rejected state directories are never created, and state inside the installed plugin is refused.

### macOS (checked 2026-11-01, `docs/qualification/macos-check.md`)

- A clean exit now waits up to 5 s for process-group members that are still exiting, so a provider's short-lived helpers no longer fail a finished turn with `cleanup pending`. Nothing signals them; any that outlast the wait still leave cleanup pending.
- agy runs with `PWD` set to the real working directory. agy takes its workspace root from `PWD`, so a folder reached through a symlink (`/tmp` on macOS) had every read and edit denied in headless mode.
- A Gemini review may read its saved review input under the state root; headless agy denied that as outside the workspace, which left reviews of several files with nothing reviewed.

### PowerShell (1.0.0-rc.4)

- A text line starting with a curly quote and `@` ends a PowerShell here-string too, so the skill sends it through `--prompt-file`.

### Windows (checked 2026-11-01, `docs/qualification/windows.md`)

- Gemini (agy) runs on Windows; the refusal stays behind `WINDOWS_QUALIFIED`.
- Requires Node 22.19.0 or later; Node 18 is no longer supported.
- `git rev-parse --show-toplevel` output is made native, so repository roots compare equal to other paths.
- PowerShell and taskkill run from their system paths, so a narrow or planted PATH cannot break cleanup.
- `cancel` no longer records a recovery on a job its owner finished during a slow process query.
- Guard variables are the union of every replaced plugin's, so a call inside a council child cannot start one of them.
- The test runner stops leftover fixture processes, retries removing its temp root and fails the run if it cannot.
- On Windows, the Gemini network preflight treats a TLS refusal of its stand-in target as a reachable network; Claude's real endpoint stays strict.

### Added

- One `$council` skill (2,965 B, description 168 B) with the POSIX heredoc and PowerShell here-string call forms, the `--prompt-file` and no-stdin rules, verbs, tiers, the policy on effort and tasks, a parallel fan-out, `--request-id` rules, footer, exit codes and the discussion protocol.
- Verbs `ask`, `reply` (`<job|thread>`, `--thread`, `--last`, `--next-input`), `review` (`--uncommitted`, `--base`, `--commit`, `--adversarial`), `task` (`--thread`, Gemini `--allow-command`), `wait`, `cancel` (`--confirm-ended`), `models` (`--refresh`) and `setup` (`--live`, `--set`), each with `--to claude|gemini|grok`.
- Per-call provider, model (aliases, pass-through with `model unverified`) and effort (one vocabulary, clamped downward and shown in the footer); tiers `consult`, `exec`, `deep` per provider, the Claude exec tier `sonnet`.
- Structured reviews for every provider from a hash-checked snapshot, delivered in batches of at most 180,000 B with a synthesis pass, one draft-07 schema with finding ids and `AGREE`/`CHANGE`/`REJECT` decisions, and an identified findings ledger.
- Request ids that replay without a second CLI start; a provider-neutral reservation taken before the provider resolves.
- One footer grammar (`council <provider> <status> · job <id> · <model>/<effort> · <duration> …`), a `--json` object, a 24 KiB answer preview with `full: <file>`, exit codes 0/10/20/1/2.
- Sandbox preflight per provider and resource with `preflight_blocked` and one action line, cached cold probes (Claude four, agy two, grok two) and zero probes on a warm call.
- State under `~/.codex/council/` (`COUNCIL_CODEX_HOME`): jobs, provider-namespaced thread claims and records, request records, catalog, preflight cache; pruning past 100 finished jobs; recovery of lost and cleanup-pending jobs by `cancel`; the held-output `thread locked` state released only by `cancel --confirm-ended` after a process-table check.
- The six guard variables on every provider child, probe and preflight probe; admission refuses when any is set.
- The unconfirmed-session rule: a turn whose provider never confirmed its thread keeps its answer and exit code, but the thread is not resumable (`reply`, `reply --last`, `task --thread` exit 2).
- `npm run test:e2e` (the skill's call forms against the three fakes), `npm run measure` (framing bytes and skill size), `npm run core:check` (shared-core pins), `scripts/validate-plugin.mjs --installed <dir>`.

### Changed, compared with the replaced plugins

- A clean or malformed review is judged by council: missing or invalid review output is exit 10 `incomplete` and keeps the output received (the donors exited 1); a review with findings, pending or unreviewed coverage is exit 10.
- Every denial is exit 10, including a Claude turn the CLI itself fails because of a denial and Grok's `cancelled` stop.
- Gemini `print_timeout` is exit 1 and keeps the answer (was 10); a partial or unavailable Gemini workspace snapshot is `coverage unknown` instead of exit 10.
- Bare `review` never falls back to the default branch; `--base` reviews from the merge base; a Grok review from a subdirectory exits 2 naming the repository root.
- `claude_plugin_for_codex` `fork`, `--profile` variants and `--with-context`, and gemini-plugin-for-codex caller `--settings` and `--inline-bytes`, are not carried over. See `docs/parity/` for every row.

### Fixed before release (S7.1 macOS matrix)

- A turn that exits 10 says why: the footer's `attention: <reason>` and `--json` `attention` (a denied action, an incomplete turn, open questions in the answer, an incomplete or malformed review).
- `edited N` on a task counts working-tree changes from a Git snapshot around the turn, so edits made through a shell count.
- The locked-thread refusal leads with its actions, so the footer's 200 B clip cannot drop them.

### Known limitations

- Gemini read-only turns can search the web (agy's deny rule does not block it); `--web` is refused for Gemini.
- No launcher kind is trusted to exit cleanly yet; every clean exit is followed by a process-table scan.
