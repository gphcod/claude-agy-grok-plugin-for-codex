# Shared core manifest

Pinned at S2.7 (2026-10-31); `reader.mjs`, `jobs.mjs` and `execution.mjs` re-pinned at S2.8 (review fixes F1, F2, F3, F7, F10, F15, F19; the same changes are made in the twin); `execution.mjs` again at S2.9 and S2.11; `reader.mjs` again at S4.8 (`unconfirmed`, data kept on a fatal event; the twin's 9a9fb24 makes the equivalent change in its own reader) and S4.9 (a fatal event keeps `unconfirmed`). `execution.mjs` again after milestone 4 (macOS process stamps queried under `TZ=UTC` and read as UTC; the twin's a43d227 makes the same change). Two tables: the host-neutral modules intended to stay byte-identical with the twin (Council for Claude Code, github.com/gphcod/codex-agy-grok-plugin-for-claude) with their hashes and the regression tests that pin their behaviour, and the host-adapted modules with the reason each differs. `npm run core:check` (scripts/core-check.mjs) verifies the local pins on every run and compares with `COUNCIL_CC_ROOT` only when that checkout contains an implemented core with a pinned manifest of its own; otherwise it prints `comparison deferred`. A change to a pinned module needs a docs/decisions.md entry, a new pin here, and the same change (or a recorded host difference) in the twin.

## Host-neutral modules

| Module | SHA-256 | Shared regression tests | Notes |
|---|---|---|---|
| `claims.mjs` | 0917dd4ebae389fc62091ad6d4cadde02f3aca0f87d09929aea5efa2df64983f | tests/core-claims.test.mjs, tests/core-release-recovery.test.mjs | claims/<provider>/<threadId>; GROKX claims + CODEXCC claimHeld; busy release recovery |
| `heartbeat.mjs` | 9cd21526c25398ddd24580590819aa4dda6d1b908d01ff1313652912bf00a374 | tests/core-locks.test.mjs (heartbeat helpers), tests/core-jobs.test.mjs | extracted from GROKX jobs/lifecycle |
| `reader.mjs` | 9b1f8675cdb5d1b212aa8e47f950d2b1a04c350959da576524b1ccbd36248dad | tests/core-reader.test.mjs, tests/core-review-fixes.test.mjs | generic line reader over adapter.parseEvent |
| `tiers.mjs` | 3a3749fcfc0c8fbea3a58dc0411f036d9725a06ba7efa2a06241bd9d9057ab90 | tests/core-catalog.test.mjs | tier table per host lives in tiers.json, not in the module |
| `fs.mjs` | defe8d47430cb9c324ac86f464ca7e5b39c34fe8f38ded230c098d6b799ef6e2 | tests/core-jobs.test.mjs, tests/core-release-recovery.test.mjs | derived from grok_plugin_for_codex 1.1.0 lib/fs.mjs; strict state reads and bounded lock retries |
| `review-input.mjs` | 2a6be74ac43f554bcb9b9a3345f137db41e1262cc6c39449a12595b2403a3128 | tests/core-review-input.test.mjs, tests/core-review.test.mjs | byte-identical to grok_plugin_for_codex 1.1.0 and claude_plugin_for_codex 0.5.0 |
| `findings.mjs` | 65a8c78a1e56127161c195bae4243445535230dc8f89d305bef5d7ce4d70e288 | tests/core-findings.test.mjs, tests/core-review.test.mjs | identified ledger, critical/high blockers; single-batch short-id decisions |
| `jobs.mjs` | 5618775308b171206269fcbb2a0a4d6146226686bde3b13e418f21c77c861147 | tests/core-jobs.test.mjs, tests/core-requests.test.mjs, tests/core-review-fixes.test.mjs, tests/core-release-recovery.test.mjs | reads its state-root variable from host.mjs; snapshot dependencies retained during pruning |
| `execution.mjs` | 3320d713d18e44d9cc248da1bdca3d53d97560c07254b4644eda0044987ba41c | tests/core-execution.test.mjs, tests/core-windows.test.mjs, tests/core-cancel.test.mjs, tests/core-review-fixes.test.mjs, tests/core-snapshot-tz.test.mjs | reads its guard variables and binary names from host.mjs |

`jobs.mjs` and `execution.mjs` are host-neutral because every host constant they use comes from `host.mjs`; they stay in this table only while the twin's copies do the same.

## Host-adapted modules

| Module | Why it differs from the twin |
|---|---|
| `host.mjs` | the host constants themselves: state root (`COUNCIL_CODEX_HOME`, `~/.codex/council`), session variable (`CODEX_THREAD_ID`), rounds variable, the six guard variables, the binaries (claude, agy, grok), PowerShell rules |
| `preflight.mjs` | Codex runs the companion inside its sandbox; preflight descriptors, `preflight_blocked` and the Claude policy store (`setup --set`) exist on this host only |
| `args.mjs` | no slash commands, so no `splitLeading`; Codex-only flags (`--prompt-file`, `--confirm-ended`, `--allow-command`, `--max-turns`, `--live`, `--set`) |
| `stdin.mjs` | the Codex call forms (heredoc, PowerShell here-string, `--prompt-file`) and the no-stdin rule for control verbs, bare review and `--next-input` |
| `lifecycle.mjs` | the held-output lock released only by `cancel --confirm-ended` (A7.8), the SIGTERM grace step, and 1.1.0 recovery-job announcement at spawn before native thread discovery; the twin has no `--confirm-ended` |
| `output.mjs` | the footer token `batch i/n`, the `thread locked` hint, 1.1.0 compact stderr without native thread UUID, and native `usage` in JSON (the twin has `unreviewed N` too, so that token is shared) |
| `launcher.mjs` | Claude's native-only PATH rule with the configured-JS exception; the twin launches codex instead of claude |
| `git.mjs` | collection for batched snapshots (`--commit` via diff-tree, first-parent merges, shallow-history exit 2); the twin hands `--base/--commit/--uncommitted` to codex's native review |
| `review.mjs` | the batch prompt, ledger reconciliation and the normalized result carrying `id`, `decision` and `coverage.pending` |
| `review-validate.mjs` | the draft-07 schema with required `id` and optional `decision` (A5.2) |
| `catalog.mjs` | Claude has no listing (`listing: false`, `default` → no flag); the twin's Codex catalog has `ultra` |
| `snapshot.mjs` | moved out of the Gemini adapter at S7.1 so every task counts working-tree changes; the twin makes the same change, not compared byte for byte yet |
| `types.mjs` | the adapter interface adds `preflight`, a collected-only `reviewPlan` and a `finalizeReview` that takes the batch and ledger; `checkRequest`, the request's `launcher`, `env` on `probe`, ParsedEvent `model` and ProbeResult `warnings` (S2.8) are shared with the twin |

## core:check result

At S2.7 and again at S2.8: `local pins: 9 host-neutral modules match docs/shared-core.md` and `comparison deferred` (the twin's core is not implemented and pinned at a commit this repository may read). S6.5 records the result again.

S6.5 (2026-11-01, branch `s6`): `npm run core:check` printed `local pins: 9 host-neutral modules match docs/shared-core.md` and `comparison deferred`, exit 0. `COUNCIL_CC_ROOT` was not set: the twin's core is not pinned for comparison at a commit this repository may read, so no byte comparison was made and none is claimed.

1.1.1 updates the local reader pin for additive transient-failure metadata on fatal events. This is a local integrity pin, not a new claim that the twin reader is byte-identical. The Gemini service classifier is compared directly in recovery qualification.
