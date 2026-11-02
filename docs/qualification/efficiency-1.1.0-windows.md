# 1.1.0 Windows efficiency and communication qualification

The owner authorized benchmarking, implementation, paid Claude/Gemini/Grok testing, release on main, installation and a handbook ranking update on 2026-11-02. This record covers the Codex-hosted **claude-agy-grok-plugin-for-codex**. The separate Claude-hosted **codex-agy-grok-plugin-for-claude** is unchanged by this work.

## Scope and method

Windows 11 Enterprise 25H2 x64 (build 26200), Node 22.19.0, Git 2.51.0.windows.1, Claude Code 2.1.314, agy 1.4.12 and Grok 1.0.70. Consultation defaults remain Claude Opus 5.5/high, Gemini 4 Argon/medium and Grok 4.7/high. No GitHub Actions were used.

The matched offline benchmark compares immutable v1.0.0 (`6bcc1194a30553124f64e9dafa24ade44739f0f2`) with the candidate payload. Both arms use the baseline's exact fake CLIs, one identical Git change, the same default models/efforts and 100 seeded completed jobs. Each provider executes ask, reply, review and discussion. Arm order alternates across ten samples: 240 calls total, ten per arm/provider/workload. Results use nearest-rank median and p95. A payload hash before and after the run rejects source changes during measurement.

Provider-input bytes count submitted text plus separately carried contract/schema, excluding protocol envelopes and hidden native-CLI context. Framing includes stderr startup and the stdout footer, with newlines. These are byte counts, not tokens. Native live counters and cost are reported separately and are not pooled across different providers or workloads. The tracer is opt-in benchmark code, outside the shipped plugin; it records operation categories and counters without prompts or argv contents.

## Model review and adjudication

All three providers reviewed the plan through the installed 1.0.0 plugin and the implementation through the candidate plugin, with the defaults above. The candidate reviews found **zero BLOCKER and zero MAJOR** defects. The native review jobs were Claude `8b4e41636d08c4fc`, Gemini `591c2bc44be5fed2` and Grok `b7ec19d0f0965fc6`. Grok exited 10 because it asked whether a policy change was intentional; its verdict still reported no blocking defect.

| Finding | Disposition |
|---|---|
| Claude/Grok plan: removing or caching process capability preflight would permit work without reliable cleanup | Accepted. Fresh full-table capability checks and post-exit ownership scans remain. Claude gains its previously missing capability descriptor, accepting the extra scan cost. Gemini's suggested capability caching was rejected. |
| Claude F1 / Gemini F1: benchmark reads the wrong stored cost field; candidate documentation incorrectly calls `cost` legacy | Accepted. The lifecycle's existing durable field is `cost`; public `costUsd` already worked in 1.0.0. Revert the unnecessary fallback, fix benchmark accounting and claims. Native `usage` is the actual JSON addition. |
| Claude F2 / Gemini F3: stale README version and absent qualification record | Accepted. Version, installation pin and this record align with 1.1.0. |
| Claude F3 / Grok F2: PATH denial cannot block Linux `/proc`; probe assertion is incomplete | Accepted. Skip that executable-denial case on Linux and assert both zero probes and zero paid submissions on Windows/macOS. Linux remains optional and unqualified. |
| Claude F4: claiming contract delivery on every turn is inaccurate | Accepted. Advice/task calls retain the standing contract; Grok structured review/discussion keeps the pre-existing schema recipe without `--rules`. No permission recipe was weakened. |
| Claude F5: early Gemini job handle gets a permanent-looking reply error before native init | Accepted. In-flight unconfirmed jobs now point to `wait <job>` or `cancel <job>`; a regression verifies no provider launch. |
| Claude F6 / Gemini F2: tracer fails to classify macOS `ps` | Accepted. Classify `ps`, PowerShell and pwsh as process queries. This qualification does not claim a macOS run. |
| Claude F7: shared-core host differences omit new output and lifecycle behavior | Accepted. Document compact startup, early job announcement and JSON usage. All nine local neutral pins remain unchanged. |
| Grok F1: PLAN still exempts Gemini from asking before higher effort | Accepted as documentation drift. Removing the exemption is intentional after the owner's medium consultation default; skill, README, PLAN and decision record agree. |

The CLI split retains public entry exports and one execution path, including injected `setup --live`. Reply planning reuses speculative resolution but refreshes the latest history under the claim. Replay liveness checks query the current owner pid; they do not reuse identity evidence. Unchanged probe caches avoid a rewrite while every cheap sandbox check still runs.

## Automated and live checks

- `npm run validate`: 555 tests, **519 passed, 36 platform skips, zero failures**; plugin metadata, 2,908 B skill and 128 B description pass validation.
- `npm run core:check`: nine unchanged local pins pass; cross-repository comparison is deferred.
- A copied-payload control check replaces unrelated adapters with throwing modules. `wait --json` loads no provider; cancelling a finished Claude job loads only Claude, with no paid launch.
- Each provider's live structured review identifies a planted `calc.js` loop bug with complete coverage and exit 10. A separate authorized task creates only `smoke.txt`, reports one edited file and exits 0. A reply on that task's native thread re-applies read-only permissions and leaves both files unchanged. Claude/Gemini replies exit 10; Grok declines the edit and exits 0. An unchanged file verifies the invariant; a tool-level denial is not claimed when the model declines without calling a tool.
- Every live result's model/effort matches the consultation defaults. JSON `usage` and `costUsd` agree with durable metadata; cleanup is confirmed. Three functional calls and one exploratory ask pair per provider total 15 successful live calls, separate from the model reviews.

The exploratory pair uses identical tool-free asks in the same scratch workspace, with baseline/candidate order reversed for Gemini. It is **one pair per provider**, not a statistical token or price benchmark. Input totals below include cache creation/read tokens for Claude, input plus cache-read for Grok, and input for Gemini (zero cache tokens in both Gemini samples). Native counters are retained without merging their incompatible schemas.

| Provider | v1.0.0 native input | 1.1.0 native input | Difference |
|---|---|---|---|
| Claude Opus 5.5/high | 8,694 | 8,576 | −118 (1.36%) |
| Gemini 4 Argon/medium | 12,119 | 12,035 | −84 (0.69%) |
| Grok 4.7/high | 8,137 | 8,063 | −74 (0.91%) |

Cache allocation and output lengths differed between arms. The smaller native input agrees with trimming the submitted instructions, but these samples do not isolate billed cost or latency. They do not support claiming a 19% reduction in the complete native context: that percentage applies only to the wrapper-controlled advice text bytes in the offline benchmark.

During development, one full-suite attempt exposed an outdated Claude descriptor expectation, which was corrected. A later attempt had an empty first result in the F19 replay test; its cause was not established. An explicit first-call status/error diagnostic was added. The focused 49-pass/3-skip run and final 519-pass full run both pass that case; no runtime fix or reproduced cause is claimed for the transient failure.

## Release limits

Windows is the platform qualified for this payload. Earlier macOS records remain historical; the final 1.1.0 payload has not been qualified on macOS. The Windows native launchers are exercised; the npm Grok shim is not newly qualified. Cross-repository core comparison, older donor-test inventory reconciliation and Codex desktop completion-delivery measurement remain separate work. Neither fewer submitted bytes nor exploratory live usage establishes a universal reduction in billed tokens, model response time or maintenance hours.
