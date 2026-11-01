# Grok live record, macOS (S4.6)

Recorded 2026-10-31 on macOS 27.0.1 (arm64), Node 22.19.0, grok 1.0.70 (f50904eaee6c) [stable] (native, `/Users/cia/.grok/bin/grok`), branch `s4-grok`. Every paid turn ran once at `--effort low` with a one-line prompt, in a throwaway Git repository with its own `COUNCIL_CODEX_HOME`; the host's `CLAUDE*`/`CODEX*`/`GROK*`/`COUNCIL*`/`AGY*` variables were removed from the child environment (login stays in `~/.grok/auth.json` under `HOME`).

## S4 verification command

```
node plugins/council/scripts/council.mjs ask --to grok --effort low -- Reply with pong </dev/null
```

Run from a scratch directory with a scratch `COUNCIL_CODEX_HOME`. Exit 0. The answer began with `pong` (followed by the standing contract's outcome, `Verification:`, `Open questions:` and `Next:` lines, so `--rules` with the contract text reaches the system prompt). Footer:

```
council grok ok · job xn1fx1tlyrh6d8av · grok-4.7/low · 4s · round 1/9
```

The job recorded model `grok-4.7` (the requested id; `end.modelUsage` names `grok-4.7-build`), agent `explore`, cost $0.01283.

## tests/live/grok.live.test.mjs (one run)

| Case | Result | Evidence |
|---|---|---|
| `grok --version` | pass | `grok 1.0.70 (f50904eaee6c) [stable]` |
| `models --to grok`, then `models --to grok --refresh` | pass, exit 0 | static catalog, then `grok (refreshed …)` with `grok-4.7: low, medium, high, xhigh` |
| `setup --to grok` | pass, exit 0 | `/Users/cia/.grok/bin/grok (native) · grok 1.0.70 … · logged in · tiers consult=grok-4.7/high exec=grok-4.7-build-fast/xhigh deep=grok-4.7/xhigh · preflight ok`; no tier warning |
| `ask --effort low` | pass, exit 0 | answer `pong`; model `grok-4.7`; `wait <job>` footer `council grok ok · job … · grok-4.7/low · …`; cost $0.013666 |
| `reply <job>` | pass, exit 0 | same session (`-r`), `round 2/9`; answer `pong2`; cost $0.006288 |
| `review --uncommitted` (one-line off-by-one change) | pass, exit 10 | inline `--json-schema`, verdict `needs-attention`, one BLOCKER `u1-F1 sum.mjs:1`; coverage `complete` 1/1; cost $0.017534 |
| `cancel` of a running `ask` | pass | `cancel` exit 0 (`cancelled · grok · job …`); the turn ended exit 1 after 2 s, footer `council grok cancelled · … · error: cancelled` |

Cost reported by the streams: $0.037488 for ask, reply and review, plus $0.01283 for the verification ask; the cancelled turn reported none (no `end` event). Five paid submissions in all (verification ask, ask, reply, review, cancelled ask), $0.050 reported.

## Open for S7

- Windows launcher kinds (native `grok.exe`, any shim) and the `workspace-write` sandbox cell: S7.1/S7.2. `trustsCleanExit` stays false for every launcher (A5.1).
- The `preflight_blocked` outcome under Codex's `workspace-write` sandbox was tested only against the fake (hidden login file); the installed-route cell is S7's.
