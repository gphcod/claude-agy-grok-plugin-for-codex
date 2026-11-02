# Changelog

## 1.0.0 (unreleased; 1.0.0-rc.3 candidate)

First release of Council for Codex: one Codex plugin, `council`, that calls Claude Code (`claude` 2.1.314), Gemini (`agy` 1.4.12) and Grok (`grok` 1.0.70). It replaces claude_plugin_for_codex 0.5.0, grok_plugin_for_codex 1.1.0 and gemini-plugin-for-codex 0.1.2.

### macOS (checked 2026-11-01, `docs/qualification/macos-check.md`)

- A clean exit now waits up to 5 s for process-group members that are still exiting, so a provider's short-lived helpers no longer fail a finished turn with `cleanup pending`. Nothing signals them; any that outlast the wait still leave cleanup pending.
- agy runs with `PWD` set to the real working directory. agy takes its workspace root from `PWD`, so a folder reached through a symlink (`/tmp` on macOS) had every read and edit denied in headless mode.
- A Gemini review may read its saved review input under the state root; headless agy denied that as outside the workspace, which left reviews of several files with nothing reviewed.

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

- One `$council` skill (2,998 B, description 168 B) with the POSIX heredoc and PowerShell here-string call forms, the `--prompt-file` and no-stdin rules, verbs, tiers, the policy on effort and tasks, a parallel fan-out, `--request-id` rules, footer, exit codes and the discussion protocol.
- Verbs `ask`, `reply` (`<job|thread>`, `--thread`, `--last`, `--next-input`), `review` (`--uncommitted`, `--base`, `--commit`, `--adversarial`), `task` (`--thread`, Gemini `--allow-command`), `wait`, `cancel` (`--confirm-ended`), `models` (`--refresh`) and `setup` (`--live`, `--set`), each with `--to claude|gemini|grok`.
- Per-call provider, model (aliases, pass-through with `model unverified`) and effort (one vocabulary, clamped downward and shown in the footer); tiers `consult`, `exec`, `deep` per provider, the Claude exec tier `sonnet`.
- Structured reviews for every provider from a hash-checked snapshot, delivered in batches of at most 180,000 B with a synthesis pass, one draft-07 schema with finding ids and `AGREE`/`CHANGE`/`REJECT` decisions, and an identified findings ledger.
- Request ids that replay without a second CLI start; a provider-neutral reservation taken before the provider resolves.
- One footer grammar (`council <provider> <status> · job <id> · <model>/<effort> · <duration> …`), a `--json` object, a 24 KiB answer preview with `full: <file>`, exit codes 0/10/20/1/2.
- Sandbox preflight per provider and resource with `preflight_blocked` and one action line, cached cold probes (Claude four, agy two, grok two) and zero probes on a warm call.
- State under `~/.codex/council/` (`COUNCIL_CODEX_HOME`): jobs, provider-namespaced thread claims and records, request records, catalog, preflight cache; pruning past 100 finished jobs; recovery of lost and cleanup-pending jobs by `cancel`; the held-output `thread locked` state released only by `cancel --confirm-ended` after a process-table check.
- The five guard variables on every provider child, probe and preflight probe; admission refuses when any is set.
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
