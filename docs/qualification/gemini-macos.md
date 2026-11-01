# Qualification record: Gemini (agy) on macOS

S5.6 live run, 2026-10-31, macOS (arm64), Node 22.19.0, agy 1.4.12 at `/Users/cia/.local/bin/agy` (launcher kind `native`), branch `s5-gemini`. One run of `tests/live/agy.live.test.mjs` on a throwaway Git repository with a scratch state root, plus the S5 verification command. agy reports no cost; token counts are from `result.usage` and the per-turn step sums (`--json` `usage`). The user's global `~/.gemini/antigravity-cli/settings.json` has `toolPermission: "always-proceed"` and an allow list of four `command(...)` rules; no settings were changed.

This is the adapter's live record (S5.6). The installed-route cells under Codex `--sandbox workspace-write` and `danger-full-access` are S6.0/S7 work and are not covered here.

## Verification (S5)

```
$ node plugins/council/scripts/council.mjs ask --to gemini --effort low -- Reply with pong </dev/null
[council] provider=gemini job=5q9msnvyqhv7p3v0 thread=7c47d8e1-b09f-4c98-9dce-80751c1266da
pong
…
council gemini ok · job 5q9msnvyqhv7p3v0 · gemini-4-argon/low · 7s · round 1/9
```

Exit 0. The model appended the contract's closing block (`Verification: not run`, `Open questions: none`, `Next: none`) after `pong`.

## Live file results

| Case | Command (abridged) | Exit | Footer / evidence | Wall | Tokens in/out (this turn) |
|---|---|---|---|---|---|
| version | `agy --version` | 0 | `1.4.12` | — | — |
| models | `agy models` | 0 | suffixed ids, `gemini-4-argon-low`, `gemini-3.8-flash-low` present (a `Fetching available models...` line precedes them; the parser ignores it) | — | — |
| setup | `setup --to gemini` | 0 | `gemini: /Users/cia/.local/bin/agy (native) · 1.4.12 · logged in · tiers consult=gemini-4-argon/high …`; warnings: the `always-proceed` line and the web-search line | — | — |
| models --refresh | `models --to gemini --refresh` | 0 | `gemini (refreshed …)`, `gemini-4-argon: low, medium, high`; catalog written under the state root | — | — |
| ask | `ask --effort low -- Reply with exactly: pong` | 0 | `council gemini ok · job 69396e1e70f06c2f · gemini-4-argon/low · 8s · round 1/9`; mutation coverage complete | 8.6 s | 8,061 / 5 |
| reply | `reply <job> --effort low -- Reply with exactly: pong2` | 0 | `round 2/9`, same conversation `b1b6a0a0-…`; conversation totals 10,754 / 11 (cumulative, as S1.2 recorded) | 18.8 s | 2,693 / 6 |
| review | `review --uncommitted --effort low --model flash` on an off-by-one edit | 10 | `Verdict: needs attention`, `u1-F1 BLOCKER sum.mjs:1 AGREE: Loop skips first element`; schema enforced through `--json-schema` | 4.8 s | 9,382 / 238 |
| effort 1 | `--model gemini-3.8-flash-low --effort high` | 2 | `--model gemini-3.8-flash-low conflicts with --effort high`; no agy call | — | — |
| effort 2 | `--model gemini-3.8-flash-low` (suffix alone) | 0 | `gemini-3.8-flash-low/low` | 4.0 s | 8,082 / 1 |
| effort 3 | `--model flash --effort xhigh` | 10 | `gemini-3.8-flash/high<=xhigh`; agy accepted the clamped `--effort high`; the model ran `ls -la`, denied by the read-only `command(*)` rule → `denied` (exit 10) | 9.4 s | 16,942 / 953 (914 thinking) |
| effort 4 | `--model flash --effort max` | not run | the file asserted exit 0 for effort 3 and stopped there; see below | — | — |
| cancel | `ask` (count to 400), then `cancel <job>` once events flowed | turn 1, cancel 0 | `cancelled · gemini · job pr4yneduajunupxi · the thread stays resumable`; turn footer `council gemini cancelled · … · error: cancelled`; `cleanupPending: false`; no process carried the job's `--settings` path afterwards | 3.3 s | — |

Paid agy turns: 7 (verification, ask, reply, review, effort 2, effort 3, the cancelled turn). Effort 1 made none.

## Findings

- **The fourth effort case was not reached.** The live file expected exit 0 for the `xhigh` clamp; the model at high effort tried a command and the read-only deny rule refused it, a correct `denied` (exit 10), so the assertion stopped the loop before `max`. The file now accepts 0 or 10 for both clamp cases and asserts the footer token. The `max` clamp is decided by council before agy is called (`resolveEffort`, the same path as `xhigh`, covered by tests/gemini.test.mjs against the fake); it was not re-run live, per the run-once rule.
- A read-only denial on an innocuous prompt is expected: Gemini read-only turns deny `command(*)`, and a model at high effort explores. Callers see `needs attention` with the denied command in `--json` `denied`.
- Mutation coverage was `complete` on every live turn (a Git workspace under the bounds).
- No language-server child was observed (as in S1.2); the group stop is proven against the fake (S5.5).
