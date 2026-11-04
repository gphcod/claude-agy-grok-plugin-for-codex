# 1.1.7 Gemini efficiency qualification — jef, 2026-11-04

Scope: approved good-faith command policy in the Codex-hosted combined plugin. Common inspection commands are allowed on read-only turns; requested tasks add command(*); explicit ask/deny rules and strict mode remain. No global provider permissions were changed.

## Verification

- `npm run validate`: 642 tests, 637 passed, 5 skipped, 0 failed; metadata validator passed for 1.1.7.
- `node --test tests/integration.test.mjs`: 15 passed, 0 failed.
- Live Gemini review: job `bf64l02f40noo3o9`, `gemini-3.8-flash`, low effort, exit 10 with the planted calc.js bug found; attention null, cleanup pending false. Exit 10 is the expected findings result, not a denial.
- Live Gemini task: job `le8op5wpbtqd9b0g`, same model/effort, exit 0, calc.js edited, attention null, cleanup pending false. Input 168122 and output 1086 tokens; price unavailable.
- Review usage: input 19034, output 336 tokens; price unavailable.
- Native agy sandbox rejected node/npm execution (operation not permitted), and a git checkout attempt could not create index.lock. The requested file correction succeeded, but executable test coverage is incomplete. This release does not claim unrestricted shell execution or full installed Codex-host qualification.

Environment: macOS 26.7.1, Node 24.21.0, agy 1.5.0, Codex CLI 0.166.0. Live checks used the source checkout. No claim is made that these were installed Codex skill calls.

## Review

Two independent gpt-6-luna / low reviewers examined the cross-host policy and implementation before merge. No substantive runtime defect was found. Requested PLAN/parity wording and finite-command-list clarifications were applied. Final cross-host review found no substantive residual defect and confirmed the native sandbox limitation must remain documented. No paid provider calls were made by reviewers.
