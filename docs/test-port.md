# Test-port table

For every test case this plan takes from the twin or a donor: the source (repository, commit, file, test name), the target test file, and the substitution (provider, host variable `COUNCIL_CODEX_HOME`, session env `CODEX_THREAD_ID`), or "dropped" with the reason. Filled in S1.8; later steps append their rows.

| Source repository | Commit | Source file | Source test | Target file | Substitution or dropped |
|---|---|---|---|---|---|
| twin (codex-agy-grok-plugin-for-claude) | e89c98e | PLAN.md S0.2 | runner: default and live sets disjoint; live name never matches default | tests/runner.test.mjs | ported as written; `--ratio` case added |
| twin | e89c98e | PLAN.md S1.6 | `gemini --effort xhigh` → high clamped | tests/catalog.test.mjs | ported; provider gemini |
| twin | e89c98e | PLAN.md S1.6 | `gemini-4-argon-high --effort medium` → UsageError | tests/catalog.test.mjs | ported |
| twin | e89c98e | PLAN.md S1.6 | `gemini-4-argon-high` alone → id unchanged, effort high | tests/catalog.test.mjs | ported |
| twin | e89c98e | PLAN.md S1.6 | `gemini-4-argon` verified against the listing | tests/catalog.test.mjs | ported; listing is `docs/spike/agy-models.txt` |
| twin | e89c98e | PLAN.md S1.6 | `grok --effort max` → xhigh clamped; `grok --effort low` → low | tests/catalog.test.mjs | ported |
| twin | e89c98e | PLAN.md S1.6 | `codex --effort ultra` on `gpt-6-luna` → UsageError; on `gpt-6.1-sol` → pass-through | — | dropped: Codex-provider and `ultra` cases |
| twin | e89c98e | PLAN.md S1.6 | unknown id → `verified: false` | tests/catalog.test.mjs | ported for all three providers |
| twin | e89c98e | PLAN.md S1.6 | refresh honours `COUNCIL_HOME` | tests/catalog.test.mjs | ported; host variable `COUNCIL_CODEX_HOME` (the test passes the root directly) |
| S1.7 (this plan) | — | PLAN.md S1.7 | `claude --model default`, `claude --effort max` (no clamp), `claude --model gpt-6.1-sol` → unverified, `claude --effort low` on sonnet | tests/catalog.test.mjs | new |
| CLAUDEX | be9fe54 | tests/schemas.test.mjs | every bundled schema is in use, inside the subset, and has valid and invalid fixtures | tests/schema.test.mjs | replaced: one draft-07 schema, `reviewProblem` validator cases (missing id, unknown severity, confidence range, extra property, decision values); the draft-07 subset checker (`checkSchema`) is not ported |
| CLAUDEX | be9fe54 | tests/fixtures/fake-claude.mjs, streams.json | scenarios success, denied, limit, structured, malformed-result, duplicate-result, missing, wrong-session | tests/fakes.test.mjs | ported as ok, denied (donor fixture), turn-limit, review-findings (regenerated in the S1.0 shape), review-malformed, duplicate-result, missing-result, wrong-session; consensus, retry, interrupted, fragmented, orphan, cancel-race dropped (CLAUDEX-only features or S2.4 null-adapter scenarios) |
| CLAUDEX | be9fe54 | tests/commands.test.mjs | `stream fixture ${scenario} exits ${code}` | tests/fakes.test.mjs (S1), S3.4 | exit codes asserted on the fakes now; the companion mapping follows in S3.4 |
| CLAUDEX | be9fe54 | tests/validate-plugin.mjs | manifest, skill size, description, terms, README, engines, line length | scripts/validate-plugin.mjs, tests/engines.test.mjs, tests/skill.test.mjs | ported; `^`-only engines parser extended to `<19`; line-length rule dropped (S0 scope); CLAUDE.md symlink check dropped |
| GROKX | 148bc55 | tests/skill.test.mjs | one skill is the whole model-facing surface | tests/skill.test.mjs | ported (council terms) |
| GROKX | 148bc55 | tests/skill.test.mjs | the skill states the Codex call rules | tests/skill.test.mjs | ported with the S0.5 term list |
| GROKX | 148bc55 | tests/skill.test.mjs | POSIX heredoc and PowerShell here-string templates run end to end | tests/e2e-codex-skill.mjs (S6.2) | deferred to S6.2 (needs the companion) |
| GROKX | 148bc55 | tests/skill.test.mjs | README puts install first | scripts/validate-plugin.mjs | ported as the install-block check |
| GROKX | 148bc55 | tests/launcher.test.mjs | models output gives the model list and the login state | tests/catalog.test.mjs (`parseModelListing("grok")`), S4.1 (login) | listing ported; login state in S4.1 |
| GROKX | 148bc55 | tests/fake-grok.mjs | scenario steps (catalogue, text, tool, end, grandchild, hang) | tests/fixtures/fake-grok.mjs, tests/fakes.test.mjs | reshaped into the COUNCIL_FAKE_SCENARIO set; `grandchild` → hold-pipes; `hang`/`spin` → S2.1 fake-child scenarios |
| GROKX | 148bc55 | tests/review.test.mjs | structured review output is validated before it is rendered | tests/schema.test.mjs | validator cases ported; rendering in S2.5 |
| GROKX | 148bc55 | tests/args.test.mjs | options matched by arity; `--` text; unknown option; framing | tests/core-args.test.mjs (S2.2) | planned; `splitLeading` has no counterpart (no slash commands) |
| GROKX | 148bc55 | tests/jobs.test.mjs, claims.test.mjs, requests.test.mjs, job-recovery.test.mjs | job ids, `--last` scoping by Codex thread, claims barrier, request-id replay | tests/core-jobs.test.mjs, core-claims.test.mjs (S2.3) | planned; session env `CODEX_THREAD_ID` unchanged (same host), state root `COUNCIL_CODEX_HOME` for `GROK_CODEX_PLUGIN_STATE`, provider added to claim keys |
| GROKX | 148bc55 | tests/reader.test.mjs, cancel.test.mjs, lifecycle-*.test.mjs, execution-ownership.test.mjs, windows-scan.test.mjs, stream-bounds.test.mjs | reader bounds, FORBIDDEN guard, cancel identity, ownership, PowerShell scan | tests/core-reader.test.mjs, core-lifecycle.test.mjs, core-execution.test.mjs (S2.4), tests/grok.test.mjs (S4.5) | planned; FORBIDDEN moves to the grok adapter test |
| GROKX, CLAUDEX | 148bc55, be9fe54 | tests/review-input.test.mjs (byte-identical) | eleven review-input cases | tests/core-review-input.test.mjs (S2.5) | planned, copied whole |
| GROKX, CLAUDEX | 148bc55, be9fe54 | tests/review-batches.test.mjs | 500 KB rollout, tampering, workspace change, failed/invalid responses, early major finding, identified resolution, unchanged findings, failed publication, binary input | tests/core-review.test.mjs (S2.5) | planned per S2.5 |
| CLAUDEX | be9fe54 | tests/events.test.mjs, turns.test.mjs | decoder splits, malformed events, duplicate/missing result, session mismatch | tests/claude.test.mjs (S3.4), core-reader (S2.4) | planned; provider claude |
| CLAUDEX | be9fe54 | tests/lifecycle.test.mjs, process.test.mjs, recovery.test.mjs, faults.test.mjs | owner loss, held output, Windows tree stop, storage faults | tests/core-lifecycle.test.mjs (S2.4) | planned; held-output lock and `cancel --confirm-ended`; Claude-host background-task cases none (CLAUDEX is Codex-hosted); `fork` cases dropped |
| CLAUDEX | be9fe54 | tests/stdin.test.mjs | stdin read to end, deadline, byte limit | tests/core-stdin.test.mjs (S2.2) | planned |
| CLAUDEX | be9fe54 | tests/e2e-codex-skill.mjs | call-form extraction and execution | tests/e2e-codex-skill.mjs (S6.2) | planned per S6.2 |
| AGYX | ba24910 | test/settings.test.mjs | `sessionSettings` filtering and merge cases | tests/gemini.test.mjs (S5.5) | planned; `edit_file(*)` deny added |
| AGYX | ba24910 | test/bridge.test.mjs | denial classification, malformed/missing/duplicate/empty/nonzero/failed-status, print_timeout, cancel, held pipes, orphan child, snapshot cases | tests/gemini.test.mjs (S5.5), core-lifecycle (S2.4) | planned; `release`, `prune`, `result RUN_ID --wait` cases dropped (replaced by `wait`, `cancel --confirm-ended`) |
| AGYX | ba24910 | test/fake-agy.mjs | scenarios success, denial, write-denial, partial, missing, malformed, duplicate, empty, failed-status, orphan, mutate, echo | tests/fixtures/fake-agy.mjs, tests/fakes.test.mjs | reshaped: ok, denied, denied-prompt, effort-error, effort-conflict, print-timeout (partial), review-*, task, web, slow, hold-pipes; missing/duplicate/empty/failed-status/orphan/mutate move to S2.1 fake-child or S5.5 |
| CODEXCC | 2.3.2 (cache) | (no tests shipped in the cache) | job pruning, 16-char ids, held-pipe wait | tests/core-jobs.test.mjs, core-lifecycle.test.mjs (S2.3, S2.4) | behaviour ported from `lib/jobs.mjs`, `lib/lifecycle.mjs`; cases written new |
| GEMINICC | 2.1.0 (cache) | — | — | — | dropped: no license file; behaviour reimplemented in S2.5 |

Dropped case classes (S1.8): Codex-provider cases and `ultra` (no Codex provider here); slash-command `splitLeading` cases (Codex has no slash commands); Claude-host background-task cases (`run_in_background`, `/council:*`); CLAUDEX `fork`, `--profile` consensus/architecture/verification cases; AGYX `release`/`prune`/`result --wait`.
