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
| Claude confirmation F8: a direct resolver test cannot prove the entry launches nothing | Accepted. The case now also invokes the real entry with the fake agy launcher, asserts exit 2 and the wait/cancel message, and checks zero probes/submissions. The strengthened three-case efficiency file passes. |

The CLI split retains public entry exports and one execution path, including injected `setup --live`. Reply planning reuses speculative resolution but refreshes the latest history under the claim. Replay liveness checks query the current owner pid; they do not reuse identity evidence. Unchanged probe caches avoid a rewrite while every cheap sandbox check still runs.

All three default-effort confirmation replies recommend shipping: Claude job `23f4348c4524d49d`, Gemini `c9e9f30d1960ed43` and Grok `cf6fd4774586bb82`, each exit 0. They statically inspected the fixes and distinguished the supplied test/measurement results from checks they ran themselves. Claude's extra F8 accuracy finding above was accepted after confirmation. Its suggestion to state Claude's latency cost in the changelog was also adopted.

## Matched results

[Raw 240-call benchmark](../measurements/benchmark-1.1.0-windows.json), [live workflow/native counter record](../measurements/live-1.1.0-windows.json). The offline benchmark payload SHA-256 is `5e01a74cf5c661a86ff2495cf383f9ae128b7e0135cd41b9faad94c778b66fec`, measured at implementation commit `10073072244b84342326fd6069c0784078268831`. Both input payloads remained unchanged during measurement. No other tests or paid provider jobs ran alongside the matched benchmark; ordinary desktop/OS activity was not controlled.

| Provider | Default ask framing, 1.0.0 → 1.1.0 | Advice input bytes, 1.0.0 → 1.1.0 | First job handle median |
|---|---|---|---|
| claude | 176 → 132 | 1882 → 1527 | 518.7 → 1259.6 ms |
| gemini | 177 → 133 | 1883 → 1528 | 1498.8 → 1400.9 ms |
| grok | 165 → 121 | 1881 → 1526 | 1094.7 → 1106.4 ms |

Framing saves 44 B (24.9–26.7%) per ordinary call. Advice/reply input saves 355 B (18.9% of the wrapper-controlled text); review input saves 55 B and structured discussion input is unchanged. At this benchmark stage the description falls 168 → 128 B and the skill 2,965 → 2,908 B; the later host-guidance section records the final skill size. Native ids remain in JSON/state/wait and the recovery job remains on stderr. Gemini's announcement now precedes native init by construction; the immediate-init fake does not model a delayed native init.

Warm reply/discussion inventory scans fall **5 → 3**, and job metadata reads **510 → 305** (40.2% fewer) at the seeded history size. Warm preflight cache writes fall **1 → 0**; cold asks still write once. All fresh sandbox descriptors still run. Fsync counts are unchanged: zero on ask/reply/discussion, two on review input publication. There is no claimed fsync saving.

The CLI falls **605 → 263 lines**, the largest module **605 → 551**, and total runtime source grows **5,008 → 5,047 lines**, from 26 to 29 files. This improves responsibility boundaries without claiming smaller total source.

Whole-process milliseconds, median / p95, ten samples per cell:

| Provider/workload | 1.0.0 | 1.1.0 |
|---|---|---|
| claude ask | 1345.2 / 1474.3 | 2096.9 / 2293.5 |
| claude reply | 1116.9 / 1147.9 | 1813.5 / 1936.4 |
| claude review | 1268.4 / 1544.9 | 2062.9 / 2114.4 |
| claude discussion | 1124.1 / 1175.3 | 1800.1 / 1987.7 |
| gemini ask | 2530.6 / 2716.9 | 2503.4 / 2608.4 |
| gemini reply | 2412.4 / 2464.9 | 2536.9 / 2850.3 |
| gemini review | 2580.3 / 2643.5 | 2931.2 / 3264.0 |
| gemini discussion | 2439.1 / 2486.4 | 2454.3 / 2982.7 |
| grok ask | 1918.3 / 2053.3 | 1927.5 / 3271.3 |
| grok reply | 1833.9 / 2451.2 | 1809.2 / 1887.0 |
| grok review | 2111.5 / 2137.3 | 2265.1 / 2465.1 |
| grok discussion | 1845.7 / 1920.6 | 1873.7 / 1902.4 |

**No general latency improvement is established.** Claude's process-query count rises from one to two per call, adding its missing capability preflight; child starts rise by one. Gemini and Grok keep two queries and unchanged child counts, but their timings are mixed and some medians/p95s worsen despite fewer reads/writes. This run is not evidence of a universal speedup. Fresh preflight and post-exit ownership evidence were retained rather than removed to meet a timing target. At n=10, nearest-rank p95 is the largest sample; this is a local wrapper-overhead benchmark, not a model-latency or cross-plugin study.

## Automated and live checks

- Final `npm run validate` after the completed collection guidance and shared fixture: **555 tests, 519 passed, 36 platform skips, zero failures**, 266,999 ms. Plugin metadata, the 2,963 B skill and 128 B description pass. The earlier measured implementation also passed the full suite.
- Focused skill/manifest/engines/efficiency checks pass **14/14** after the wording guard is updated; Skill Creator's frontmatter validator passes. The later guide is additionally exercised by the fifteen shared-fixture host probes.
- `npm run test:e2e`: **31/31 passed**, no skips, through sh, Windows PowerShell and pwsh.
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

## Host collection guidance, after higher-effort review

The owner requested Gemini 4 Argon/high and Claude Opus 5.5/xhigh (Extra) ideas. Opus identified avoidable nested polling. Argon's first advisory reported attention because the coordinator edited three files during its read-only turn; Opus's first advisory was denied an out-of-workspace Glob. Neither wrote repository files. Later probes use frozen isolated copies.

The final 2,963 B skill names maximum permitted `yield_time_ms` (up to 60,000 ms) on shell/collection calls and **outer exec/wait wrappers**. The narrower shell-only draft left nested polling and was not adopted. Description 128 B; defaults, permissions and no-resubmission rules remain. A follow-up by Argon supports the communication rank move with disclosures; Opus agrees conditionally on matched provider/fake/latency, rechecked Token 2, a release pin and stated limitations. The shared-fixture study below resolves the matched-control condition. At 2,963 B the skill still beats the other ranked skills' sizes; the 128 B description and 121–133 B framing preserve Token 2 under the existing static method.

An initial exploratory comparison used a separate legacy fixture. It is not used for ranking: all three arms were rerun with one shared fixture. [Canonical host evidence](../measurements/host-collection-1.1.0-windows.json) records its source and stream hashes.

Five samples per arm on Windows 11, Codex CLI 0.166.0 and GPT-6.1 Sol/medium; three isolated hosts run concurrently per sample with rotating launch order. Every arm uses the **same Claude fixture executable, recorded success stream and 120-second delay**, pinned by SHA-256. The two 1.1.0 arms use the same companion; the legacy companion is pinned v0.4.2. Every host reads its exact skill, makes one read-only ask and collects the result. No real Claude calls are made. This is explicit-file skill use, not automatic discovery or desktop-wake testing.

| Guidance | Median collection calls | Median tool calls after skill read | Host total median / p95 | Exchange median | Median host input tokens |
|---|---|---|---|---|---|
| 1.1.0 before explicit guidance | 6 | 7 | 136.686 / 137.486 s | 123.830 s | 150,987 |
| 1.1.0 final guidance | 2 | 3 | 137.309 / 163.899 s | 123.731 s | 82,899 |
| claude_plugin_for_codex 0.4.2 | 7 | 8 | 135.836 / 137.180 s | 123.149 s | 190,803 |

All fifteen results are collected once, with one fake submission each and no resubmission. Median collection calls fall **66.7%** against prior guidance and **71.4%** against legacy. Workload tool calls fall 7/8 → 3. Median host input falls 45.1%/56.6%, including repeated cached context; these are not provider-token or billed-cost savings.

The predeclared gate for this shared-fixture study requires at least 50% fewer median collection calls than both controls and total/exchange medians within a **2% non-inferiority tolerance**. It passes locally, without proving universal timing. The final guidance's slowest total sample is 163.899 s, against 137.486/137.180 s for the controls. Its companion exchange is still about 124 s; the additional time lies outside that recorded exchange and its cause was not established. At n=5 p95 is the slowest sample. This tail result prevents a claim of generally faster completion.

The source of this improvement is portable host skill guidance, not CLI enforcement. A legacy skill could adopt it; re-measure if skills or the host change. Short sub-yield turns are not measured here and the legacy native-Claude fast path remains cheaper. Exact 1.1.0 macOS and Codex desktop wake remain unqualified. Those limits accompany the editorial Communication 3 / overall third-place tie. Host-loop input is not double-counted to award Token 1.

The final payload SHA-256 is `30ae9c682a6a0a42907ca5bd3a7cde5dd5b7f580bb92ce4848cde113856905cf`. All 40 plugin files were compared against measured commit `1007307`: **only SKILL.md differs**; the other 39, including all CLI, prompt and permission files, are byte-identical. The earlier 240-call runtime benchmark and fifteen native provider checks describe that unchanged runtime; this study qualifies the later host guidance. Their earlier size/hash metadata is retained.

Persistent PowerShell workers, a fan-out dispatcher, scan bypass and WMI substitutions require separate ownership/teardown, output-cap, process-tree or constrained-language evidence. They remain outside this release; no safety scan is removed for a ranking target.

## Release limits

Windows is the platform qualified for this payload. Earlier macOS records remain historical; the final 1.1.0 payload has not been qualified on macOS. The Windows native launchers are exercised; the npm Grok shim is not newly qualified. Cross-repository core comparison, older donor-test inventory reconciliation and Codex desktop completion-delivery measurement remain separate work. Neither fewer submitted bytes nor exploratory live usage establishes a universal reduction in billed tokens, model response time or maintenance hours.
