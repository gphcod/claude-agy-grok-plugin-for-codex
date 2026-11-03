# Codex-hosted 1.1.4: default-agent recovery window

Owner date: 2026-11-03 Pacific. [Structured evidence](../measurements/agent-recovery-1.1.4-windows.json), [matched benchmark](../measurements/benchmark-1.1.4-windows.json), [live record](../measurements/live-1.1.4-windows.json). Baseline v1.1.3 is 96db870d46d1856ead62b62d99dc8d84f6d488c9. Frozen runtime/test commit: 7d253fe0ede93fdd9cacd0c788140362c43f0f38. All 42 plugin files hash to 0b62b03c9a4f55849f7218609d98e76de9cc8a8a096e744389200c527dd22942; later qualification commits change no plugin bytes.

Only **Codex 6.1 Sol/xhigh** and **Grok 4.7/high** were called for review, on the plan and on the diff. There was no native Gemini/Argon call, by the owner's choice. The design reasons are in `docs/decisions.md`.

## The fault

A companion that dies between the durable job save and the post-spawn agent save leaves the thread record on `explore`. While the job is retained, its own `agent` field hides this. Once the recovered job is pruned, a read-only reply by native id builds `--agent explore` for a session that ran the default agent, which the adapter's notes say a session cannot accept.

Reproduced on v1.1.3 before any change: through `cancelManaged`, pruning and `resolveThread`, the result was `{ prev: null, record: "explore" }`. The kill was simulated at that boundary and the provider was a fake. A real `task` was not used.

## The fix

| Change | Where | Check |
|---|---|---|
| Recovery sets a one-way `.default-agent` marker before the job stops blocking its thread, and never writes the record. A proven no-start and a spawn never attempted do not mark; an unknown start does. | `lifecycle.mjs`, `jobs.mjs` | Window, job-selection, `--confirm-ended` and delayed-second-canceller tests |
| A marker that cannot be written makes `cancel` exit 1 and keeps the claim; running it again retries. | `lifecycle.mjs` | Write and directory failures |
| The lookup is a checked stat with the module's 5 s retry, so a lock never reads as absent, and a persistent failure stops the reply. | `jobs.mjs` | EBUSY, EPERM and EACCES |
| A reply reads the record fresh under the claim for its agent, settings and refusals. The record's `default` outranks an older retained job. | `plan.mjs` | Recovery between resolution and admission; older retained job |

## Reviews

- **Plan.** Codex required the fresh read under the claim rather than a recheck that kept the old snapshot, which was accepted. Grok agreed with the plan.
- **Diff.** Codex reported no BLOCKER or MAJOR findings. Its verdict reads `incomplete`, as a clean native review always does, and it exited 10 because its read-only sandbox denied filesystem-backed test runs. Those runs are the ones recorded below. Grok approved with no findings.
- **Rejected as out of scope.** The post-spawn save is unchanged. A read or write failure there still stops the started provider through the launch catch, which fails closed and already existed.

## Verification

- `npm run validate`: **622 total, 586 pass, 36 platform skips, zero failures**, from Git Bash (281.298 s) and from PowerShell (281.309 s), Windows 11 / Node 22.19.0. This includes 15 new tests in `tests/core-agent-recovery.test.mjs`.
- Fault injection: nine deliberate faults against the new tests. One, marking a job whose spawn was never attempted, got through at first because a test case set two fields at once. A separate case was added and all nine are now caught.
- Nine local neutral-core pins pass. `jobs.mjs` is re-pinned to df9b014cb31ad77971eedec17727cbe87569951dc6612419c3ec07cfa4dc3408. The shared service and request-publication helpers remain byte-identical to the Claude-hosted rc.10.
- Matched offline benchmark, 240 calls against v1.1.3 with fake CLIs: the 12 median differences range from -3.0% to +2.6%, with no consistent direction. The overall median is 2,034 ms for v1.1.3 and 2,024 ms for 1.1.4. Framing, fsyncs, inventory reads and metadata reads are identical. Review input shows +3 B, and the same +3 B appears when both arms run identical 1.1.4 code, so it comes from the harness and not the plugin. This is a byte and latency check, not a native-token or cost benchmark.
- Live Grok 4.7/high, seven submitted turns in a scratch state root, with model and effort verified in job metadata:
  - A healthy thread stayed on `--agent explore` through a reply by job id and a reply by native id, at rounds 2 and 3, with no marker.
  - A companion killed during a read-only ask: the reply was refused as busy, `cancel` succeeded, no marker was set, and the reply resumed the same thread on explore at round 2.
  - A marker placed by hand on that healthy thread: the reply dropped `--agent explore`, recorded `default`, and the real CLI accepted the deny recipe at round 4. This shows the marked command line is accepted. **That session really ran explore, so it is not a session that ran the default agent.**
- Runtime **5,338 lines / 31 files**, largest module 567 lines, CLI 267 lines; test source **12,387 lines / 83 files**. Compared with 1.1.3, runtime grows 37 lines and tests 232 lines. Skill **2,987 B**, description **128 B**; defaults, contracts and permissions are unchanged.

## Not verified

- A live Grok `task` was not run, because `task` needs the owner's separate go-ahead. So the real provider's handling of a session that truly ran the default agent, and the kill at the exact spawn boundary with a real CLI, remain untested. The second is covered only by a fake provider through the real entry.
- A job already recovered under 1.1.3 or earlier is not corrected, because reconciliation happens at recovery. A later reply there still requests `--agent explore`. That stays a read-only turn; what Grok does with it was not run.
- One unexplained event: the first scripted live attempt got no job id and left an empty state root. Its output was not captured, because the script threw before printing it. It did not recur in three later starts: the full rerun, a direct call and a background probe. The cause is unknown. The failed call happened before any job existed, so it did not reach the changed recovery code.
- Exact-payload macOS, desktop discovery/wake and the Windows npm Grok shim remain unqualified; Linux is optional.
